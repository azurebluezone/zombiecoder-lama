import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { Config } from "./config.ts";
import type { EngineState, MmapStatus, ModelRow, OsInfo, ToolCall } from "./types.ts";
import type { Store } from "./db.ts";
import { request } from "./transport.ts";
import { serviceAction, servicePid } from "./service.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function isAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function splitArgs(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of value.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

export function resolveBinary(cfg: Config): { command: string; prefix: string[] } {
  // LAMA_LLAMA_BIN is an explicit override: if it is set, only that path/name is accepted.
  // Otherwise accept both stock layouts — the current release ships the unified `llama`
  // binary (with the `serve` subcommand) and older trees ship `llama-server`.
  const explicit = Boolean(cfg.llamaBin);
  const names = process.platform === "win32" ? ["llama.exe", "llama-server.exe"] : ["llama", "llama-server"];
  // No absolute path in .env: a bare name is resolved from PATH, then from the per-user
  // install location the stock release script uses (`~/.local/bin` on POSIX,
  // `%LOCALAPPDATA%\llama` on Windows).
  const homeBin =
    process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "llama")
      : path.join(os.homedir(), ".local", "bin");
  // `npm run install:llama` links the stock binary into <root>/bin, so a fresh install is
  // found without adding anything to PATH.
  const projectBin = path.join(cfg.root, "bin");
  const candidates = explicit
    ? [cfg.llamaBin]
    : [...names, ...names.map((name) => path.join(projectBin, name)), ...names.map((name) => path.join(homeBin, name))];
  const locate = (candidate: string): string | null =>
    candidate.includes(path.sep) || candidate.endsWith(".exe")
      ? fs.existsSync(candidate)
        ? candidate
        : null
      : (() => {
          const result = spawnSync(process.platform === "win32" ? "where" : "which", [candidate], {
            encoding: "utf8",
            timeout: 5000,
          });
          return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] || null : null;
        })();
  const found = candidates.map(locate).find((value): value is string => Boolean(value));
  if (!found) {
    throw new Error(
      `llama binary not found (tried ${candidates.join(", ")}). Run \`npm run install:llama\`, add it to PATH, or set LAMA_LLAMA_BIN to the stock binary path.`,
    );
  }
  const base = path.basename(found).toLowerCase();
  return { command: found, prefix: base === "llama" || base === "llama.exe" ? ["serve"] : [] };
}

export function buildEngineArgs(
  cfg: Config,
  model: ModelRow,
  options: { forceLoadMode?: string; tls?: boolean } = {},
): { command: string; args: string[]; logFile: string } {
  if (!model.path) throw new Error(`model ${model.id} has no path`);
  const modelPath = path.resolve(model.path);
  if (!fs.existsSync(modelPath)) throw new Error(`model file not found: ${modelPath}`);
  const binary = resolveBinary(cfg);
  const loadMode = options.forceLoadMode ?? model.load_mode ?? cfg.loadMode;
  const host = process.env.LAMA_ENGINE_HOST || cfg.engineHost;
  const port = String(process.env.LAMA_ENGINE_PORT || cfg.enginePort);
  // Empty socket path means "no UDS on this OS"; the TCP listener still works.
  const uds = (process.env.LAMA_UDS_SOCK ?? cfg.udsPath).trim();
  if (uds) fs.mkdirSync(path.dirname(uds), { recursive: true, mode: 0o700 });

  const args = [
    ...binary.prefix,
    "--model",
    modelPath,
    "--alias",
    model.model_id,
    "--host",
    uds ? `${host},${uds}` : host,
    "--port",
    port,
    "--ctx-size",
    String(model.context ?? 4096),
    "--n-predict",
    String(model.max_tokens ?? 1024),
    "--threads",
    String(Number(process.env.LAMA_THREADS) || Math.max(1, os.cpus().length - 1)),
    "--parallel",
    String(Number(process.env.LAMA_PARALLEL) || 1),
    "--jinja",
    "--no-webui",
    "--metrics",
  ];

  if (loadMode && loadMode !== "auto") args.push("--load-mode", loadMode);
  const tls = options.tls ?? process.env.LAMA_TLS === "1";
  if (tls) {
    if (!fs.existsSync(cfg.tlsKey) || !fs.existsSync(cfg.tlsCert)) {
      throw new Error(`TLS requested but key/cert missing: ${cfg.tlsKey}, ${cfg.tlsCert}`);
    }
    args.push("--ssl-key-file", cfg.tlsKey, "--ssl-cert-file", cfg.tlsCert);
  }
  if (cfg.engineApiKey) args.push("--api-key", cfg.engineApiKey);
  const extra = process.env.LAMA_LLAMA_ARGS || "";
  if (extra.trim()) args.push(...splitArgs(extra));
  const mcpConfig = path.join(cfg.dataDir, "mcp-servers.generated.json");
  if (fs.existsSync(mcpConfig) && fs.statSync(mcpConfig).size > 24) {
    args.push("--mcp-servers-config", mcpConfig);
  }

  return {
    command: binary.command,
    args,
    logFile: path.join(cfg.logsDir, `engine-${model.id}.log`),
  };
}

export function mmapStatus(pid: number | null, modelPath: string | null): MmapStatus {
  if (!pid || !modelPath) {
    return { mapped: false, perms: null, bytes: null, source: "unavailable", detail: "no pid/model" };
  }
  if (process.platform !== "linux") {
    return {
      mapped: false,
      perms: null,
      bytes: null,
      source: "unavailable",
      detail: `mmap proof is implemented for /proc on Linux; ${process.platform} needs a platform-specific probe`,
    };
  }
  try {
    const maps = fs.readFileSync(`/proc/${pid}/maps`, "utf8");
    const base = path.basename(modelPath);
    let bytes = 0;
    let perms: string | null = null;
    for (const line of maps.split(/\r?\n/)) {
      if (!line.includes(base)) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const range = parts[0] ?? "";
      const [start, end] = range.split("-").map((value) => Number.parseInt(value, 16));
      if (!start || !end) continue;
      bytes += Math.max(0, end - start);
      perms = perms ?? (parts[1] ?? null);
    }
    return {
      mapped: bytes > 0,
      perms,
      bytes,
      source: "proc-maps",
      detail: bytes > 0 ? `${base} present in /proc/${pid}/maps` : `${base} not found in /proc/${pid}/maps`,
    };
  } catch (error) {
    return {
      mapped: false,
      perms: null,
      bytes: null,
      source: "unavailable",
      detail: (error as NodeJS.ErrnoException).code === "EACCES" ? "permission denied reading /proc maps" : (error as Error).message,
    };
  }
}

export class EngineManager {
  private readonly store: Store;
  private readonly cfg: Config;
  private readonly os: OsInfo;
  private timer: NodeJS.Timeout | null = null;

  constructor(store: Store, cfg: Config, os: OsInfo) {
    this.store = store;
    this.cfg = cfg;
    this.os = os;
  }

  private transport(preferUds = false): { protocol: "http" | "https" | "uds"; host: string | null; port: number | null; socket_path: string | null } {
    if (preferUds && this.cfg.udsPath) {
      return { protocol: "uds", host: null, port: null, socket_path: this.cfg.udsPath };
    }
    const https = process.env.LAMA_TLS === "1";
    return {
      protocol: https ? "https" : "http",
      host: this.cfg.engineHost,
      port: this.cfg.enginePort,
      socket_path: null,
    };
  }

  async health(): Promise<{ ok: boolean; status: number | null; detail: string }> {
    for (const preferUds of [false, true]) {
      try {
        const res = await request(this.transport(preferUds), "/health", {
          timeoutMs: 3000,
          allowSelfSigned: process.env.LAMA_TLS_INSECURE === "1",
        });
        if (res.status === 200) return { ok: true, status: 200, detail: "health 200" };
        return { ok: false, status: res.status, detail: `health ${res.status}` };
      } catch (error) {
        if (preferUds) return { ok: false, status: null, detail: (error as Error).message };
      }
    }
    return { ok: false, status: null, detail: "unreachable" };
  }

  async props(): Promise<Record<string, unknown> | null> {
    for (const preferUds of [false, true]) {
      try {
        const res = await request(this.transport(preferUds), "/props", {
          timeoutMs: 3000,
          allowSelfSigned: process.env.LAMA_TLS_INSECURE === "1",
        });
        if (res.status === 200) return JSON.parse(res.text) as Record<string, unknown>;
      } catch {
        // try the next transport
      }
    }
    return null;
  }

  binaryVersion(): string | null {
    try {
      const binary = resolveBinary(this.cfg);
      const result = spawnSync(binary.command, [...binary.prefix, "--version"], { encoding: "utf8", timeout: 10_000 });
      if (result.status === 0) return (result.stdout || result.stderr).trim().split(/\r?\n/)[0] ?? null;
      const version = spawnSync(binary.command, [...binary.prefix, "version"], { encoding: "utf8", timeout: 10_000 });
      return version.status === 0 ? (version.stdout || version.stderr).trim().split(/\r?\n/)[0] ?? null : null;
    } catch {
      return null;
    }
  }

  private lock(): void {
    fs.mkdirSync(this.cfg.dataDir, { recursive: true, mode: 0o700 });
    const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
    try {
      const fd = fs.openSync(this.cfg.lockFile, "wx", 0o600);
      fs.writeFileSync(fd, payload);
      fs.closeSync(fd);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      const current = JSON.parse(fs.readFileSync(this.cfg.lockFile, "utf8")) as { pid?: number };
      if (current.pid && current.pid !== process.pid && isAlive(current.pid)) {
        throw new Error(`engine is already managed by pid ${current.pid}`);
      }
    } catch (error) {
      if ((error as Error).message.startsWith("engine is already")) throw error;
    }
    fs.rmSync(this.cfg.lockFile, { force: true });
    const fd = fs.openSync(this.cfg.lockFile, "wx", 0o600);
    fs.writeFileSync(fd, payload);
    fs.closeSync(fd);
  }

  private unlock(): void {
    try {
      const current = JSON.parse(fs.readFileSync(this.cfg.lockFile, "utf8")) as { pid?: number };
      if (!current.pid || current.pid === process.pid) fs.rmSync(this.cfg.lockFile, { force: true });
    } catch {
      fs.rmSync(this.cfg.lockFile, { force: true });
    }
  }

  private serviceMode(): "none" | "user" | "system" {
    const fromDb = this.store.setting("service_mode");
    if (fromDb === "user" || fromDb === "system" || fromDb === "none") return fromDb;
    return this.cfg.serviceMode;
  }

  async status(): Promise<EngineState> {
    const state = this.store.engineState();
    const pid = state.pid && isAlive(state.pid) ? state.pid : null;
    const health = await this.health();
    const model = state.model_id ? this.store.getModel(state.model_id) : undefined;
    return {
      ...state,
      pid,
      status: health.ok ? "running" : pid ? "starting" : "stopped",
      mmap: pid ? mmapStatus(pid, model?.path ?? null) : null,
    };
  }

  async start(modelId: string, ttlHours?: number | null): Promise<EngineState> {
    const model = this.store.getModel(modelId);
    if (!model) throw new Error(`unknown model: ${modelId}`);
    if (!model.path) throw new Error(`model ${modelId} has no file path`);
    const current = await this.status();
    if (current.status === "running") await this.stop();
    this.lock();
    const hours = ttlHours === undefined ? model.ttl_hours : ttlHours;
    const expiresAt = hours && hours > 0 ? new Date(Date.now() + hours * 3600_000).toISOString() : null;
    const base: Omit<EngineState, "updated_at" | "mmap"> = {
      model_id: model.id,
      pid: null,
      status: "starting",
      started_at: new Date().toISOString(),
      expires_at: expiresAt,
      load_mode: model.load_mode,
      socket_path: this.cfg.udsPath,
      port: this.cfg.enginePort,
      build: this.binaryVersion(),
      last_error: null,
    };
    this.store.setEngineState(base);
    this.store.audit("engine.start", model.id, `load_mode=${model.load_mode} ttl=${hours ?? "none"}`);

    try {
      const mode = this.serviceMode();
      if (mode === "user" || mode === "system") {
        const result = serviceAction(this.os, mode, "restart");
        if (!result.ok) throw new Error(`systemctl restart failed: ${result.detail}`);
      } else {
        const { command, args, logFile } = buildEngineArgs(this.cfg, model);
        fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
        const out = fs.openSync(logFile, "a", 0o600);
        const child = spawn(command, args, {
          detached: true,
          stdio: ["ignore", out, out],
          env: process.env,
        });
        child.unref();
        fs.closeSync(out);
        if (!child.pid) throw new Error("failed to spawn llama-server");
        this.store.setEngineState({ ...base, pid: child.pid });
      }

      const deadline = Date.now() + 180_000;
      let last = "not started";
      while (Date.now() < deadline) {
        const health = await this.health();
        if (health.ok) {
          // /tmp/llama-<uid>/ is 0700 (created above); the socket itself must stay 0660
          // so only this user (and root) can connect, even though /tmp is world-writable.
          if (this.cfg.udsPath) {
            try {
              fs.chmodSync(path.dirname(this.cfg.udsPath), 0o700);
              fs.chmodSync(this.cfg.udsPath, 0o660);
            } catch {
              // engine may not have created the socket yet on exotic platforms
            }
          }
          const state = this.store.engineState();
          const pid = state.pid && isAlive(state.pid) ? state.pid : null;
          const running: Omit<EngineState, "updated_at" | "mmap"> = {
            ...base,
            pid,
            status: "running",
            build: this.binaryVersion(),
          };
          this.store.setEngineState(running);
          this.store.audit("engine.running", model.id, `pid=${pid ?? "unknown"}`);
          return this.status();
        }
        last = health.detail;
        await sleep(1000);
      }
      throw new Error(`engine did not become healthy within 180s: ${last}`);
    } catch (error) {
      await this.stop();
      this.store.setEngineState({ ...base, status: "error", last_error: (error as Error).message });
      this.store.audit("engine.error", model.id, (error as Error).message);
      throw error;
    }
  }

  async stop(): Promise<EngineState> {
    const state = this.store.engineState();
    const mode = this.serviceMode();
    if (mode === "user" || mode === "system") {
      serviceAction(this.os, mode, "stop");
    }
    const pid = state.pid && isAlive(state.pid) ? state.pid : null;
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && isAlive(pid)) await sleep(250);
      if (isAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    if (this.cfg.udsPath) {
      try {
        fs.rmSync(this.cfg.udsPath, { force: true });
      } catch {
        // socket removal is best effort
      }
    }
    this.store.setEngineState({
      model_id: null,
      pid: null,
      status: "stopped",
      started_at: null,
      expires_at: null,
      load_mode: state.load_mode,
      socket_path: null,
      port: this.cfg.enginePort,
      build: state.build,
      last_error: null,
    });
    this.store.audit("engine.stop", state.model_id ?? "", `pid=${pid ?? "none"}`);
    this.unlock();
    return this.status();
  }

  async reload(modelId?: string, ttlHours?: number | null): Promise<EngineState> {
    const state = this.store.engineState();
    const target = modelId ?? state.model_id;
    if (!target) throw new Error("no model selected for reload");
    await this.stop();
    return this.start(target, ttlHours);
  }

  startExpiryLoop(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void (async () => {
        const state = this.store.engineState();
        if (state.status !== "running" || !state.expires_at) return;
        if (Date.parse(state.expires_at) > Date.now()) return;
        this.store.audit("engine.expire", state.model_id ?? "", state.expires_at);
        await this.stop();
      })().catch(() => {
        // expiry failures must never crash the admin server
      });
    }, 30_000);
    this.timer.unref();
  }

  stopExpiryLoop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runForeground(): Promise<never> {
    // Supervisor mode: this process is the systemd unit body. It stays alive,
    // waits for the manager to select a model in engine_state, spawns the stock
    // binary, and idles again when that child exits. No model selected at boot
    // means "idle", not "crash loop".
    let stopping = false;
    let current: ReturnType<typeof spawn> | null = null;
    const forward = (signal: NodeJS.Signals): void => {
      stopping = true;
      if (current?.pid) {
        try {
          current.kill(signal);
        } catch {
          // child already exited
        }
      }
    };
    process.on("SIGTERM", () => forward("SIGTERM"));
    process.on("SIGINT", () => forward("SIGINT"));

    while (!stopping) {
      const state = this.store.engineState();
      if (!state.model_id) {
        await sleep(3000);
        continue;
      }
      const model = this.store.getModel(state.model_id);
      if (!model || !model.path) {
        process.stderr.write(`engine-run: model ${state.model_id} has no file path; idle\n`);
        await sleep(3000);
        continue;
      }
      const { command, args } = buildEngineArgs(this.cfg, model);
      // A killed engine leaves its socket file behind; llama.cpp refuses to bind over it.
      if (this.cfg.udsPath) {
        try {
          if (fs.existsSync(this.cfg.udsPath) && fs.statSync(this.cfg.udsPath).isSocket()) {
            fs.rmSync(this.cfg.udsPath, { force: true });
          }
        } catch {
          // best effort; bind failure is reported by the engine itself
        }
      }
      this.store.audit("engine.foreground", model.id, `${command} ${args.join(" ")}`);
      const child = spawn(command, args, { stdio: "inherit", env: process.env });
      current = child;
      if (child.pid) this.store.setEngineState({ ...state, pid: child.pid, status: "starting" });
      // The engine creates the socket with the ambient umask; tighten it as soon as it
      // appears, because the unit can be started by systemd without going through start().
      if (this.cfg.udsPath) {
        const deadline = Date.now() + 15_000;
        while (!stopping && Date.now() < deadline && !fs.existsSync(this.cfg.udsPath)) {
          await sleep(200);
        }
        try {
          fs.chmodSync(path.dirname(this.cfg.udsPath), 0o700);
          fs.chmodSync(this.cfg.udsPath, 0o660);
        } catch {
          // socket or dir missing; the bind error already surfaced in the engine log
        }
      }
      const code = await new Promise<number>((resolve) => {
        child.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
      });
      current = null;
      this.store.setEngineState({
        ...state,
        pid: null,
        status: code === 0 ? "stopped" : "error",
        last_error: code === 0 ? null : `engine exited with ${code}`,
      });
      if (stopping) break;
      if (code === 0) {
        await sleep(1000);
        continue;
      }
      // Non-zero exit: wait for the manager to write a new state before retrying.
      // A blind retry loop would respawn a broken engine forever and bury the error.
      const failedAt = this.store.engineState().updated_at;
      for (;;) {
        if (stopping) break;
        await sleep(2000);
        if (this.store.engineState().updated_at !== failedAt) break;
      }
    }
    process.exit(0);
  }
}

export function toolCallSummary(calls: ToolCall[]): string {
  return calls.map((call) => `${call.name}(${Object.keys(call.arguments).join(",")})`).join(", ");
}
