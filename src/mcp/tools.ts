import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import net from "node:net";
import dns from "node:dns/promises";
import { spawnSync } from "node:child_process";

const MAX_BYTES = 1024 * 1024;
const SECRET_PATTERN = /(^|[/\\])(\.ssh|\.gnupg)([/\\]|$)|(^|[/\\])\.env($|\.)|\.pem$|\.key$|(^|[/\\])id_(rsa|ed25519)($|\.)/i;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MCP_TOOLS: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a UTF-8 text file inside the configured workspace. Refuses secrets and paths outside the workspace.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to the workspace" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Write a UTF-8 text file inside the configured workspace. Refuses paths outside the workspace and secrets.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace" },
        content: { type: "string", description: "File content, at most 1 MiB" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "list_dir",
    description: "List entries in a directory inside the workspace.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Directory relative to the workspace (default: .)" } },
      additionalProperties: false,
    },
  },
  {
    name: "run_shell",
    description:
      "Run one read-only command from an allow-list without a shell. Metacharacters, interpreters and write flags are refused.",
    inputSchema: {
      type: "object",
      properties: { cmd: { type: "string", description: "Command line, e.g. 'ls -la models'" } },
      required: ["cmd"],
      additionalProperties: false,
    },
  },
  {
    name: "http_fetch",
    description: "Fetch an HTTP/HTTPS URL and return status, headers and up to 1 MiB of text.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string", enum: ["GET", "HEAD"] },
        headers: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
];

/** Short, human explanation shown in the MCP matrix (not in the integration docs). */
export const TOOL_USE_CASES: Record<string, string> = {
  read_file: "Read a workspace file before editing or to gather evidence.",
  write_file: "Write or update a workspace file; refuses secrets and paths outside the workspace.",
  list_dir: "Inspect a workspace directory before choosing a file.",
  run_shell: "Run one read-only allow-listed command (ls, wc, head, git status) without a shell.",
  http_fetch: "Fetch an HTTP/HTTPS URL for read-only checks such as /health or /v1/models.",
};

export function workspaceRoot(): string {
  return path.resolve(process.env.LAMA_WORKSPACE || process.cwd());
}

/**
 * Capability gates. Reading inside the workspace stays on by default; anything
 * that can change the host (write, shell) must be switched on explicitly, so an
 * admin token alone is never host access.
 */
const ON = /^(1|true|yes|on)$/i;
function enabled(name: string): boolean {
  return ON.test(String(process.env[name] ?? "").trim());
}

function requireCapability(name: string, tool: string): void {
  if (enabled(name)) return;
  throw new Error(`${tool} is disabled by default; set ${name}=1 to enable it`);
}

function assertSafeRelative(input: unknown): string {
  const raw = typeof input === "string" && input.trim() ? input.trim() : ".";
  if (raw.includes("\0")) throw new Error("path contains NUL");
  if (SECRET_PATTERN.test(raw)) throw new Error("refusing a secret-looking path");
  const root = workspaceRoot();
  const target = path.resolve(root, raw);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("path escapes the workspace");
  return target;
}

async function resolveExisting(input: unknown): Promise<string> {
  const target = assertSafeRelative(input);
  const real = await fs.realpath(target);
  const root = await fs.realpath(workspaceRoot());
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error("resolved path escapes the workspace");
  return real;
}

async function readFileTool(args: Record<string, unknown>): Promise<unknown> {
  const target = await resolveExisting(args.path);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error("not a regular file");
  if (stat.size > MAX_BYTES) throw new Error(`file is larger than ${MAX_BYTES} bytes`);
  return { path: target, content: await fs.readFile(target, "utf8") };
}

async function writeFileTool(args: Record<string, unknown>): Promise<unknown> {
  requireCapability("LAMA_TOOLS_ALLOW_WRITE", "write_file");
  const rawPath = assertSafeRelative(args.path);
  const content = typeof args.content === "string" ? args.content : "";
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error(`content is larger than ${MAX_BYTES} bytes`);
  await fs.mkdir(path.dirname(rawPath), { recursive: true, mode: 0o700 });
  const parent = await fs.realpath(path.dirname(rawPath));
  const root = await fs.realpath(workspaceRoot());
  if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error("parent escapes the workspace");
  await fs.writeFile(rawPath, content, { encoding: "utf8", mode: 0o600 });
  return { path: rawPath, bytes: Buffer.byteLength(content) };
}

async function listDirTool(args: Record<string, unknown>): Promise<unknown> {
  const target = await resolveExisting(args.path ?? ".");
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) throw new Error("not a directory");
  const entries = await fs.readdir(target, { withFileTypes: true });
  return {
    path: target,
    entries: entries.slice(0, 500).map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
    })),
  };
}

const SHELL_ALLOWLIST = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "stat",
  "file",
  "du",
  "df",
  "uname",
  "date",
  "pwd",
  "which",
  "rg",
  "grep",
  "find",
]);

/** Flags that run another program or write a file even though the binary is "read-only". */
const DANGEROUS_FLAGS: Record<string, RegExp> = {
  rg: /^(--pre|--pre-glob|--hostname-bin)(=|$)/i,
  find: /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fls|fprintf)(=|$)/i,
  file: /^(-f|--files-from|-C|--compile)(=|$)/i,
  tar: /^--to-command(=|$)/i,
};

/**
 * A relative name such as "notes" stays inside the workspace by construction.
 * An absolute path, a ".." segment or "~" can leave it, so resolve and check.
 * Existing symlinks are followed, because "link -> /etc/passwd" would otherwise
 * pass a purely lexical check.
 */
function confineShellArg(arg: string, root: string): void {
  if (!arg || arg.startsWith("-")) return;
  const looksLikePath =
    arg.includes("/") || arg === "." || arg === ".." || arg.startsWith("~") || /^[A-Za-z]:[\\/]/.test(arg);
  if (!looksLikePath) return;
  if (arg.startsWith("~")) throw new Error("home-relative paths are refused");
  const target = path.resolve(root, arg);
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path ${arg} escapes the workspace`);
  try {
    const real = fsSync.realpathSync(target);
    const realRoot = fsSync.realpathSync(root);
    const realRel = path.relative(realRoot, real);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) throw new Error(`path ${arg} resolves outside the workspace`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function splitCommand(input: string): string[] {
  if (/[;&|$><`\\\n\r]/.test(input)) throw new Error("shell metacharacters are refused");
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of input.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (quote) throw new Error("unterminated quote");
  if (current) out.push(current);
  return out;
}

function runShellTool(args: Record<string, unknown>): unknown {
  const line = typeof args.cmd === "string" ? args.cmd : "";
  const parts = splitCommand(line);
  if (parts.length === 0) throw new Error("empty command");
  const binary = parts[0] ?? "";
  if (!SHELL_ALLOWLIST.has(binary)) throw new Error(`command ${binary} is not in the allow-list`);
  const root = workspaceRoot();
  const danger = DANGEROUS_FLAGS[binary];
  for (const arg of parts.slice(1)) {
    if (/(^|[/\\])(\.ssh|\.gnupg|\.env|id_rsa|id_ed25519)/i.test(arg)) throw new Error("refusing a secret-looking path");
    if (danger?.test(arg)) throw new Error(`${binary} ${arg} is refused: it runs or writes another program`);
    if (binary === "sed" && /^-i/.test(arg)) throw new Error("in-place edits are refused");
    confineShellArg(arg, root);
  }
  requireCapability("LAMA_TOOLS_ALLOW_SHELL", "run_shell");
  const result = spawnSync(binary, parts.slice(1), {
    cwd: root,
    shell: false,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: MAX_BYTES,
  });
  return {
    command: parts,
    status: result.status,
    signal: result.signal,
    stdout: (result.stdout ?? "").slice(0, MAX_BYTES),
    stderr: (result.stderr ?? "").slice(0, 16_384),
  };
}

const FETCH_PORTS = new Set(
  (process.env.LAMA_FETCH_PORTS || "80,443")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0 && value < 65536),
);

function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  if (net.isIPv4(bare)) {
    const [a = 0, b = 0] = bare.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local + cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast + reserved
    );
  }
  if (net.isIPv6(bare)) {
    const v = bare.toLowerCase();
    if (v === "::" || v === "::1") return true;
    if (v.startsWith("fe80") || v.startsWith("fc") || v.startsWith("fd")) return true;
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
    return false;
  }
  return true; // unparseable: refuse rather than guess
}

/**
 * SSRF guard: the tool runs next to the engine and the admin, so a plain
 * "fetch this URL" can reach 127.0.0.1:9933, a cloud metadata endpoint, or any
 * RFC1918 host. Resolve first, refuse private answers, refuse redirects.
 */
async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http/https is allowed");
  if (url.username || url.password) throw new Error("credentials in the URL are refused");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!FETCH_PORTS.has(port)) throw new Error(`port ${port} is not allowed (LAMA_FETCH_PORTS)`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/(^|\.)(localhost|local|internal)$/i.test(host) || /^metadata\./i.test(host)) {
    throw new Error(`refusing local hostname ${host}`);
  }
  let addresses: string[];
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await dns.lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
    } catch {
      throw new Error(`cannot resolve ${host}`);
    }
  }
  if (addresses.length === 0) throw new Error(`cannot resolve ${host}`);
  for (const address of addresses) {
    if (isPrivateAddress(address)) throw new Error(`refusing private address ${address} for ${host}`);
  }
  return url;
}

async function readCapped(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const take = Math.min(value.length, limit - total);
    if (take > 0) {
      chunks.push(value.subarray(0, take));
      total += take;
    }
    if (total >= limit) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

async function httpFetchTool(args: Record<string, unknown>): Promise<unknown> {
  const raw = typeof args.url === "string" ? args.url : "";
  const url = await assertPublicUrl(raw);
  const method = args.method === "HEAD" ? "HEAD" : "GET";
  const headers: Record<string, string> = {};
  if (args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)) {
    for (const [key, value] of Object.entries(args.headers as Record<string, unknown>)) {
      if (typeof value !== "string") continue;
      if (/^(host|connection|content-length|transfer-encoding)$/i.test(key)) continue;
      headers[key] = value;
    }
  }
  const response = await fetch(url, {
    method,
    headers,
    redirect: "manual", // a 302 to 127.0.0.1 must not become a second, unchecked request
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? "";
    throw new Error(`redirect refused (${response.status} -> ${location}); fetch the final URL directly`);
  }
  const text = method === "HEAD" ? "" : await readCapped(response, MAX_BYTES);
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: text,
  };
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "read_file":
      return readFileTool(args);
    case "write_file":
      return writeFileTool(args);
    case "list_dir":
      return listDirTool(args);
    case "run_shell":
      return runShellTool(args);
    case "http_fetch":
      return httpFetchTool(args);
    default:
      throw new Error(`unknown tool ${name}`);
  }
}
