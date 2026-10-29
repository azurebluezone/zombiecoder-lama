import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { Config } from "./config.ts";
import type { Accel, OsInfo, ReleaseAsset, ReleaseInfo } from "./types.ts";
import { assetName, pickAssets } from "./os.ts";

const REPO = "ggml-org/llama.cpp";

function run(command: string, args: string[], timeout = 120_000): { status: number; text: string } {
  const result = spawnSync(command, args, { encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 });
  return { status: result.status ?? 1, text: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "lama-clean-installer",
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

export async function resolveRelease(build?: string | null): Promise<ReleaseInfo> {
  const url = build
    ? `https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(build)}`
    : `https://api.github.com/repos/${REPO}/releases?per_page=20`;
  const response = await fetch(url, { headers: githubHeaders(), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`GitHub release lookup failed: HTTP ${response.status} ${response.statusText}`);
  const data = (await response.json()) as unknown;
  const releases = Array.isArray(data) ? data : [data];
  const release = releases.find((item): item is Record<string, unknown> => {
    if (!item || typeof item !== "object") return false;
    const tag = (item as Record<string, unknown>).tag_name;
    return typeof tag === "string" && /^b\d+$/.test(tag);
  });
  if (!release) throw new Error("no build release (b<number>) found");
  const tag = String(release.tag_name);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  return {
    tag,
    build: Number(tag.slice(1)),
    assets: assets
      .filter((asset): asset is Record<string, unknown> => Boolean(asset && typeof asset === "object"))
      .map((asset) => ({
        name: String(asset.name),
        url: String(asset.browser_download_url),
        size: Number(asset.size ?? 0),
        digest: typeof asset.digest === "string" ? asset.digest : null,
      }))
      .filter((asset) => asset.name && asset.url),
  };
}

async function downloadFile(asset: ReleaseAsset, dest: string): Promise<string> {
  const response = await fetch(asset.url, {
    headers: { "user-agent": "lama-clean-installer" },
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (!response.ok || !response.body) throw new Error(`download ${asset.name} failed: HTTP ${response.status}`);
  const hash = createHash("sha256");
  const out = fs.createWriteStream(dest, { mode: 0o600 });
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      hash.update(buffer);
      if (!out.write(buffer)) {
        await new Promise<void>((resolve) => out.once("drain", () => resolve()));
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      out.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
  }
  const digest = hash.digest("hex");
  const expected = asset.digest?.replace(/^sha256:/i, "");
  if (expected && expected !== digest) {
    fs.rmSync(dest, { force: true });
    throw new Error(`checksum mismatch for ${asset.name}: expected ${expected}, got ${digest}`);
  }
  return digest;
}

function extract(archive: string, dest: string, os: OsInfo): void {
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  const tar = run("tar", ["-xf", archive, "-C", dest], 10 * 60_000);
  if (tar.status === 0) return;
  if (archive.toLowerCase().endsWith(".zip")) {
    const unzip = run("unzip", ["-q", archive, "-d", dest], 10 * 60_000);
    if (unzip.status === 0) return;
    if (os.platform === "win32") {
      const ps = run(
        "powershell.exe",
        ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`],
        10 * 60_000,
      );
      if (ps.status === 0) return;
      throw new Error(`extract failed: tar: ${tar.text.slice(0, 300)}; unzip: ${unzip.text.slice(0, 300)}; powershell: ${ps.text.slice(0, 300)}`);
    }
  }
  throw new Error(`extract failed: ${tar.text.slice(0, 500)}`);
}

export function findBinary(root: string): string | null {
  const wanted = new Set(["llama-server", "llama-server.exe", "llama", "llama.exe"]);
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(item.dir, entry.name);
      if (entry.isFile() && wanted.has(entry.name)) return full;
      if (entry.isDirectory() && item.depth < 6) queue.push({ dir: full, depth: item.depth + 1 });
    }
  }
  return null;
}

export function binaryVersion(binary: string): string | null {
  for (const args of [["--version"], ["version"]]) {
    const result = run(binary, args, 15_000);
    if (result.status === 0 && result.text) return result.text.split(/\r?\n/)[0] ?? null;
  }
  return null;
}

export interface InstallResult {
  tag: string;
  binary: string;
  link: string;
  version: string | null;
  assets: string[];
  checksums: Record<string, string>;
}

export async function installLlama(
  cfg: Config,
  os: OsInfo,
  options: { build?: string | null; accel?: Accel; force?: boolean; onLog?: (line: string) => void } = {},
): Promise<InstallResult> {
  const log = options.onLog ?? ((line: string) => process.stderr.write(`${line}\n`));
  const release = await resolveRelease(options.build ?? cfg.build);
  const accel = options.accel ?? (cfg.accel as Accel);
  const selected = pickAssets(release, os, accel);
  const installDir = path.join(cfg.root, "bin", "llama", release.tag);
  const metadataPath = path.join(installDir, "install.json");

  if (!options.force && fs.existsSync(installDir)) {
    // A release may ship the unified `llama` binary instead of `llama-server`; accept either.
    const existing = findBinary(installDir);
    if (existing) {
      const version = binaryVersion(existing);
      log(`already installed: ${release.tag} (${version ?? "version unknown"})`);
      return {
        tag: release.tag,
        binary: existing,
        link: path.join(cfg.root, "bin", process.platform === "win32" ? "llama-server.exe" : "llama-server"),
        version,
        assets: [selected.primary.name, ...selected.extras.map((asset) => asset.name)],
        checksums: {},
      };
    }
  }

  const temp = path.join(cfg.dataDir, "install", `${release.tag}-${randomBytes(4).toString("hex")}`);
  fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
  const checksums: Record<string, string> = {};
  try {
    for (const asset of [selected.primary, ...selected.extras]) {
      log(`downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MiB)`);
      const file = path.join(temp, asset.name);
      checksums[asset.name] = await downloadFile(asset, file);
      log(`  sha256 ${checksums[asset.name]}`);
    }
    for (const asset of [selected.primary, ...selected.extras]) {
      log(`extracting ${asset.name}`);
      extract(path.join(temp, asset.name), temp, os);
    }
    const found = findBinary(temp);
    if (!found) throw new Error("archive contains no llama-server/llama binary");
    fs.mkdirSync(installDir, { recursive: true, mode: 0o700 });
    if (options.force && fs.existsSync(installDir)) fs.rmSync(installDir, { recursive: true, force: true });
    fs.cpSync(temp, installDir, { recursive: true, force: true });
    const installed = findBinary(installDir);
    if (!installed) throw new Error("installed tree has no binary");
    const finalBinary = path.join(installDir, path.basename(installed));
    fs.chmodSync(finalBinary, 0o755);
    const link = path.join(cfg.root, "bin", process.platform === "win32" ? "llama-server.exe" : "llama-server");
    fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
    if (fs.existsSync(link)) fs.rmSync(link, { force: true });
    if (process.platform === "win32") fs.copyFileSync(finalBinary, link);
    else fs.symlinkSync(finalBinary, link, "file");
    const version = binaryVersion(finalBinary);
    fs.writeFileSync(
      metadataPath,
      `${JSON.stringify({ tag: release.tag, asset: selected.primary.name, assets: [selected.primary.name, ...selected.extras.map((a) => a.name)], checksums, installed_at: new Date().toISOString(), binary: finalBinary, link, version }, null, 2)}\n`,
      { mode: 0o600 },
    );
    log(`installed ${release.tag} -> ${finalBinary}`);
    return {
      tag: release.tag,
      binary: finalBinary,
      link,
      version,
      assets: [selected.primary.name, ...selected.extras.map((asset) => asset.name)],
      checksums,
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export function tlsSupport(binary: string, os: OsInfo): { supported: boolean | null; detail: string } {
  if (os.platform === "linux") {
    const result = run("ldd", [binary], 15_000);
    if (result.status !== 0) return { supported: null, detail: result.text.slice(0, 300) };
    if (/not a dynamic executable/i.test(result.text)) {
      return {
        supported: null,
        detail: "binary is statically linked; OpenSSL support cannot be read from ldd — probe TLS at runtime",
      };
    }
    const linked = /libssl|libcrypto/i.test(result.text);
    return {
      supported: linked,
      detail: linked ? "libssl/libcrypto linked" : "no libssl/libcrypto in ldd output; engine-native TLS may be unavailable",
    };
  }
  if (os.platform === "darwin") {
    const result = run("otool", ["-L", binary], 15_000);
    if (result.status !== 0) return { supported: null, detail: result.text.slice(0, 300) };
    const linked = /libssl|libcrypto/i.test(result.text);
    return { supported: linked, detail: linked ? "libssl/libcrypto linked" : "no libssl/libcrypto in otool output" };
  }
  return { supported: null, detail: "TLS linkage check is not implemented on Windows; probe --ssl-cert-file at runtime" };
}

export function ensureTls(cfg: Config): { ok: boolean; detail: string; generated: boolean } {
  const key = cfg.tlsKey;
  const cert = cfg.tlsCert;
  if (fs.existsSync(key) && fs.existsSync(cert)) {
    const certCheck = run("openssl", ["x509", "-checkend", "0", "-noout", "-in", cert], 10_000);
    if (certCheck.status !== 0) return { ok: false, detail: `certificate is expired or unreadable: ${certCheck.text}`, generated: false };
    // Compare public keys instead of moduli: `openssl pkey -modulus` is rejected by OpenSSL 3.
    const certPub = run("openssl", ["x509", "-noout", "-pubkey", "-in", cert], 10_000);
    const keyPub = run("openssl", ["pkey", "-pubout", "-in", key], 10_000);
    if (certPub.status === 0 && keyPub.status === 0 && certPub.text.replace(/\s+/g, "") !== keyPub.text.replace(/\s+/g, "")) {
      return { ok: false, detail: "certificate and key do not match", generated: false };
    }
    return { ok: true, detail: "certificate and key exist, are unexpired and match", generated: false };
  }
  fs.mkdirSync(cfg.certsDir, { recursive: true, mode: 0o700 });
  const result = run(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "3650",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    30_000,
  );
  if (result.status !== 0) return { ok: false, detail: `openssl failed: ${result.text.slice(0, 500)}`, generated: false };
  fs.chmodSync(key, 0o600);
  fs.chmodSync(cert, 0o644);
  return { ok: true, detail: "self-signed certificate generated", generated: true };
}

export function describeAssets(tag: string, os: OsInfo, accel: Accel): { primary: string; extras: string[] } {
  return assetName(tag, os, accel);
}
