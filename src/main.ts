#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig, ensureDirs } from "./config.ts";
import { detectOs } from "./os.ts";
import { Store, retryDatabaseLocked, seedStore } from "./db.ts";
import { EngineManager, resolveBinary, mmapStatus } from "./engine.ts";
import { createAdminServer, listenAdminServer, adminHealth } from "./admin.ts";
import { installLlama, ensureTls, tlsSupport, binaryVersion } from "./installer.ts";
import { writeEngineMcpConfig } from "./mcp/config.ts";
import { applySeeds } from "./seed.ts";
import { ensureIdentityFile } from "./identity.ts";
import { syncSystemPrompt } from "./prompt.ts";
import { disableService, installService, serviceAction, serviceAvailable } from "./service.ts";
import type { UnitKind } from "./service.ts";
import { clearToken, downloadFile, fetchRange, getToken, listGgufFiles, maskToken, resolveUrl, setToken } from "./hf.ts";

function usage(): void {
  process.stdout.write(`lama-clean — stock llama.cpp lifecycle manager

Usage:
  node src/main.ts setup [--service user|system]
  node src/main.ts install [--build bNNNNN] [--accel cpu|cuda|vulkan|rocm|openvino|sycl] [--force]
  node src/main.ts tls [--check]
  node src/main.ts doctor [--json]
  node src/main.ts serve
  node src/main.ts engine-run
  node src/main.ts engine load <model-id|alias> [--ttl HOURS]
  node src/main.ts engine unload
  node src/main.ts engine reload [model-id|alias] [--ttl HOURS]
  node src/main.ts engine status
  node src/main.ts service install user|system [--kind engine|manager|status|admin] [--start|--no-start]
  node src/main.ts service start|stop|restart|status user|system [--kind ...]
  node src/main.ts service disable user|system [--kind ...] [--stop]
  node src/main.ts seed
  node src/main.ts model add <file.gguf> [--id NAME] [--ctx N]
  node src/main.ts model list|remove <id>
  node src/main.ts mcp
  node src/main.ts hf token set [hf_...]   (reads stdin when no argument)
  node src/main.ts hf token status|clear
  node src/main.ts hf files <owner/repo>
  node src/main.ts hf download <owner/repo> [--file NAME]
  node src/main.ts hf smoke

Environment: .env next to package.json; process.env wins.
`);
}

function ensureAdminToken(cfg: ReturnType<typeof loadConfig>): string {
  if (cfg.adminToken) return cfg.adminToken;
  if (process.env.LAMA_ADMIN_TOKEN) return process.env.LAMA_ADMIN_TOKEN;
  const token = randomBytes(32).toString("base64url");
  fs.appendFileSync(cfg.envFile, `LAMA_ADMIN_TOKEN=${token}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(cfg.envFile, 0o600);
  } catch {
    // chmod is not available on every platform
  }
  cfg.adminToken = token;
  return token;
}

function setupEnvFile(cfg: ReturnType<typeof loadConfig>): void {
  if (!fs.existsSync(cfg.envFile)) {
    // Portable by design: no absolute paths, no comments. Every path is derived from the
    // project root at runtime, so the same file works in any folder, on any user, on any OS.
    const content = `LAMA_ENGINE_HOST=${cfg.engineHost}
LAMA_ENGINE_PORT=${cfg.enginePort}
LAMA_ADMIN_HOST=${cfg.adminHost}
LAMA_ADMIN_PORT=${cfg.adminPort}
LAMA_LOAD_MODE=${cfg.loadMode}
LAMA_ACCEL=${cfg.accel}
LAMA_SERVICE_MODE=${cfg.serviceMode}
LAMA_TLS=0
LAMA_DEFAULT_TTL_HOURS=${cfg.defaultTtlHours}
`;
    fs.writeFileSync(cfg.envFile, content, { mode: 0o600 });
  } else {
    try {
      fs.chmodSync(cfg.envFile, 0o600);
    } catch {
      // best effort
    }
  }
  ensureAdminToken(cfg);
}

async function main(): Promise<void> {
  // `node src/main.ts doctor | head -3` closes the pipe early; without this the
  // process dies with an EPIPE stack trace instead of a clean exit.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    usage();
    return;
  }

  const cfg = loadConfig();
  const os = detectOs();
  ensureDirs(cfg);
  // The manifest is immutable: create it if missing and force 0444 on every boot.
  ensureIdentityFile(cfg.root);
  // At boot lama-admin and lama-engine both run this bootstrap against one SQLite file.
  // A transient lock must delay the start, not fail the unit (that was the reset-time
  // "lama: database is locked" crash loop).
  let retries = 0;
  const boot = retryDatabaseLocked(
    () => {
      const opened = new Store(cfg.dbFile);
      seedStore(opened, cfg, os);
      syncSystemPrompt(opened, cfg);
      const report = applySeeds(opened, cfg, os);
      writeEngineMcpConfig(opened, cfg);
      return { store: opened, report };
    },
    {
      onRetry: (attempt, delay) => {
        retries = attempt;
        // Informational, not an error: another lama process holds the SQLite write lock.
        // The raw SQLite message is only surfaced if every retry is exhausted.
        process.stderr.write(`lama: manager.db busy at boot (another process holds the SQLite lock) — attempt ${attempt}, retrying in ${delay}ms\n`);
      },
    },
  );
  if (retries) process.stderr.write(`lama: database lock cleared after ${retries} retr${retries === 1 ? "y" : "ies"}\n`);
  const store = boot.store;
  const seedReport = boot.report;
  const engine = new EngineManager(store, cfg, os);

  if (command === "setup") {
    setupEnvFile(cfg);
    const identityFile = ensureIdentityFile(cfg.root);
    const seedReport = applySeeds(store, cfg, os);
    const result = {
      config: cfg.envFile,
      identity: identityFile,
      db: cfg.dbFile,
      models: cfg.modelsDir,
      uds: cfg.udsPath,
      admin: `http://${cfg.adminHost}:${cfg.adminPort}`,
      seeds: { files: seedReport.files.length, counts: seedReport.counts, warnings: seedReport.warnings },
    };
    if (rest.includes("--service")) {
      const index = rest.indexOf("--service");
      const mode = rest[index + 1] === "system" ? "system" : "user";
      const service = installService(cfg, os, mode);
      process.stdout.write(`${JSON.stringify({ ...result, service }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`admin token: see ${cfg.envFile} (LAMA_ADMIN_TOKEN)\n`);
    return;
  }

  if (command === "seed") {
    const report = applySeeds(store, cfg, os);
    const sync = writeEngineMcpConfig(store, cfg);
    process.stdout.write(
      `${JSON.stringify(
        { db: cfg.dbFile, identity: report.identity, counts: report.counts, skipped: report.skipped, warnings: report.warnings, models: store.listModels().length, mcp: sync, build: engine.binaryVersion() },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (command === "install") {
    const buildIndex = rest.indexOf("--build");
    const accelIndex = rest.indexOf("--accel");
    const build = buildIndex >= 0 ? rest[buildIndex + 1] : cfg.build;
    const accel = (accelIndex >= 0 ? rest[accelIndex + 1] : cfg.accel) as "cpu" | "cuda" | "vulkan" | "rocm" | "openvino" | "sycl";
    const result = await installLlama(cfg, os, { build: build ?? null, accel, force: rest.includes("--force") });
    const provider = store.getProvider("llamacpp");
    if (provider) {
      store.upsertProvider({ ...provider, base_url: cfg.engineUrl, build: result.tag, config_json: JSON.stringify({ binary: result.binary, load_mode: cfg.loadMode, accel }) });
    }
    store.audit("install", result.tag, result.binary, "cli");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "tls") {
    if (rest.includes("--check")) {
      const result = ensureTls(cfg);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    const result = ensureTls(cfg);
    const support = resolveBinary(cfg);
    const linked = tlsSupport(support.command, os);
    process.stdout.write(`${JSON.stringify({ ...result, linkage: linked }, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "doctor") {
    let binary: string | null = null;
    let version: string | null = null;
    let linkage: { supported: boolean | null; detail: string } = { supported: null, detail: "binary not found" };
    try {
      const resolved = resolveBinary(cfg);
      binary = resolved.command;
      version = binaryVersion(binary);
      linkage = tlsSupport(binary, os);
    } catch (error) {
      linkage = { supported: null, detail: (error as Error).message };
    }
    const status = await engine.status();
    const admin = await adminHealth(cfg.adminHost, cfg.adminPort);
    const report = {
      labels: {
        os: "SOURCE_VERIFIED",
        db: "SOURCE_VERIFIED",
        binary: binary ? "LIVE_PROBE_PASSED" : "NOT_TESTED",
        tls: linkage.supported === null ? "UNVERIFIED" : "SOURCE_VERIFIED",
        engine: status.status === "running" ? "LIVE_PROBE_PASSED" : "NOT_TESTED",
        admin: admin.up ? "LIVE_PROBE_PASSED" : "NOT_TESTED",
      },
      os,
      paths: { root: cfg.root, db: cfg.dbFile, models: cfg.modelsDir, uds: cfg.udsPath, admin: `http://${cfg.adminHost}:${cfg.adminPort}` },
      binary: { path: binary, version, tls: linkage },
      service: { mode: store.setting("service_mode") ?? cfg.serviceMode, available: serviceAvailable(os) },
      engine: status,
      admin: { url: `http://${cfg.adminHost}:${cfg.adminPort}`, up: admin.up, detail: admin.detail },
      counts: { models: store.listModels().length, mcp: store.listMcp().length, transports: store.listTransports().length, documents: store.listDocuments().length, prompts: store.listPrompts().length },
      warnings: cfg.warnings,
    };
    if (rest.includes("--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      process.stdout.write(`os        ${os.platform}/${os.arch} ${os.distro} ${os.distroVersion} glibc=${os.glibc ?? "n/a"}\n`);
      process.stdout.write(`binary    ${binary ?? "NOT FOUND"} ${version ?? ""}\n`);
      process.stdout.write(`tls       ${linkage.supported === null ? "unknown" : linkage.supported ? "linked" : "not linked"} — ${linkage.detail}\n`);
      process.stdout.write(`engine    ${status.status} pid=${status.pid ?? "-"} mmap=${status.mmap?.mapped ? "yes" : "no"}\n`);
      process.stdout.write(`db        ${cfg.dbFile} models=${report.counts.models} mcp=${report.counts.mcp} docs=${report.counts.documents}\n`);
      process.stdout.write(`admin     http://${cfg.adminHost}:${cfg.adminPort} ${admin.up ? "up" : "down"} — ${admin.detail}\n`);
      if (cfg.warnings.length) process.stdout.write(`warnings  ${cfg.warnings.join("; ")}\n`);
    }
    if (!binary) process.exitCode = 1;
    return;
  }

  if (command === "serve") {
    if (!cfg.adminToken && cfg.adminHost !== "127.0.0.1" && cfg.adminHost !== "localhost" && cfg.adminHost !== "::1") {
      throw new Error("refusing to serve the admin API without LAMA_ADMIN_TOKEN on a non-loopback host");
    }
    const server = createAdminServer({ store, cfg, os, engine });
    try {
      await listenAdminServer(server, cfg.adminHost, cfg.adminPort);
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      const owner = failure.code === "EADDRINUSE" ? await adminHealth(cfg.adminHost, cfg.adminPort) : { up: false, detail: "" };
      if (owner.up) {
        // Idempotent: a second unit (or a manual run) must not crash-loop the journal.
        process.stderr.write(`lama: admin already running at http://${cfg.adminHost}:${cfg.adminPort} (${owner.detail}); nothing to do\n`);
        return;
      }
      process.stderr.write(`lama: ${failure.message}\n`);
      if (owner.detail) process.stderr.write(`lama: the port answers, but not as lama-admin — ${owner.detail}\n`);
      process.exit(1);
    }
    process.stdout.write(`lama admin: http://${cfg.adminHost}:${cfg.adminPort}\n`);
    process.stdout.write(`engine: ${cfg.engineUrl} (UDS ${cfg.udsPath})\n`);
    if (!cfg.adminToken) process.stdout.write("warning: LAMA_ADMIN_TOKEN is empty; loopback only\n");
    engine.startExpiryLoop();
    const close = (): void => {
      engine.stopExpiryLoop();
      server.close(() => process.exit(0));
    };
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
    return;
  }

  if (command === "engine-run") {
    await engine.runForeground();
    return;
  }

  if (command === "engine") {
    const action = rest[0];
    if (action === "load") {
      const modelId = rest[1];
      if (!modelId) throw new Error("engine load needs a model id");
      const ttlIndex = rest.indexOf("--ttl");
      const ttl = ttlIndex >= 0 ? Number(rest[ttlIndex + 1]) : undefined;
      process.stdout.write(`${JSON.stringify(await engine.start(modelId, ttl), null, 2)}\n`);
      return;
    }
    if (action === "unload") {
      process.stdout.write(`${JSON.stringify(await engine.stop(), null, 2)}\n`);
      return;
    }
    if (action === "reload") {
      const ttlIndex = rest.indexOf("--ttl");
      const ttl = ttlIndex >= 0 ? Number(rest[ttlIndex + 1]) : undefined;
      process.stdout.write(`${JSON.stringify(await engine.reload(rest[1], ttl), null, 2)}\n`);
      return;
    }
    if (action === "status") {
      process.stdout.write(`${JSON.stringify(await engine.status(), null, 2)}\n`);
      return;
    }
    throw new Error("engine action must be load, unload, reload or status");
  }

  if (command === "service") {
    const action = rest[0];
    const mode = rest.includes("system") ? "system" : "user";
    const kindIndex = rest.indexOf("--kind");
    const requested = kindIndex >= 0 ? rest[kindIndex + 1] : undefined;
    const KINDS = new Set(["engine", "manager", "status", "admin"]);
    const kind = (requested && KINDS.has(requested) ? requested : rest.includes("--admin") ? "admin" : "engine") as UnitKind;
    if (action === "install") {
      // engine/manager/status are resident; the admin unit is never started by an
      // install, because the admin must stay an on-demand client.
      const start = rest.includes("--no-start") ? false : rest.includes("--start") ? true : undefined;
      const result = installService(cfg, os, mode, kind, start === undefined ? {} : { start });
      store.audit("service.install", `${kind}/${mode}`, result.detail, "cli");
      process.stdout.write(`${JSON.stringify({ kind, mode, ...result }, null, 2)}\n`);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (action === "disable") {
      const result = disableService(os, mode, kind, { stop: rest.includes("--stop") });
      store.audit("service.disable", `${kind}/${mode}`, result.detail, "cli");
      process.stdout.write(`${JSON.stringify({ kind, mode, action, ...result }, null, 2)}\n`);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (action === "start" || action === "stop" || action === "restart" || action === "status") {
      const result = serviceAction(os, mode, action, kind);
      store.audit(`service.${action}`, `${kind}/${mode}`, result.detail, "cli");
      process.stdout.write(`${JSON.stringify({ kind, mode, action, ...result }, null, 2)}\n`);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    throw new Error("service action must be install, disable, start, stop, restart or status");
  }

  if (command === "model") {
    const action = rest[0] ?? "list";
    if (action === "list") {
      const rows = store.listModels().map((row) => ({
        id: row.id,
        alias: row.model_id,
        path: row.path,
        context: row.context,
        enabled: row.enabled,
      }));
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      return;
    }
    if (action === "add") {
      const file = rest[1];
      if (!file) throw new Error("model add needs a .gguf path");
      const abs = path.resolve(cfg.root, file);
      if (!fs.existsSync(abs)) throw new Error(`no such file: ${abs}`);
      if (!abs.toLowerCase().endsWith(".gguf")) throw new Error("only .gguf files can be registered");
      const idIndex = rest.indexOf("--id");
      const ctxIndex = rest.indexOf("--ctx");
      const alias = slug(idIndex >= 0 ? (rest[idIndex + 1] ?? "") : path.basename(abs).replace(/\.gguf$/i, ""));
      if (!alias) throw new Error("model add needs a non-empty --id");
      const context = ctxIndex >= 0 ? Number(rest[ctxIndex + 1]) : 4096;
      if (!Number.isInteger(context) || context < 256) throw new Error("--ctx must be an integer >= 256");
      const existing = store.getModel(alias);
      store.upsertModel({
        id: alias,
        provider_id: "llamacpp",
        name: existing?.name ?? path.basename(abs).replace(/\.gguf$/i, ""),
        model_id: alias,
        path: abs,
        context,
        max_tokens: existing?.max_tokens ?? 1024,
        temperature: existing?.temperature ?? 0.7,
        quant: existing?.quant ?? null,
        load_mode: existing?.load_mode ?? "auto",
        ttl_hours: existing?.ttl_hours ?? cfg.defaultTtlHours,
        enabled: 1,
        metadata_json: existing?.metadata_json ?? "{}",
      });
      store.audit("model.add", alias, abs, "cli");
      process.stdout.write(`${JSON.stringify(store.getModel(alias), null, 2)}\n`);
      return;
    }
    if (action === "remove") {
      const id = rest[1];
      if (!id) throw new Error("model remove needs an id");
      if (store.engineState().model_id === id) throw new Error("unload the engine before removing the active model");
      store.deleteModel(id);
      store.audit("model.remove", id, "", "cli");
      process.stdout.write(`${JSON.stringify({ removed: id }, null, 2)}\n`);
      return;
    }
    throw new Error("model action must be add, list or remove");
  }

  if (command === "mcp") {
    await import("./mcp/server.ts");
    return;
  }

  if (command === "hf") {
    const action = rest[0];
    if (action === "token") {
      const sub = rest[1];
      if (sub === "set") {
        let token = rest[2]?.trim() ?? "";
        if (!token && !process.stdin.isTTY) {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
          token = Buffer.concat(chunks).toString("utf8").trim();
        }
        if (!token) throw new Error("hf token set needs a token (argument or stdin)");
        setToken(store, token);
        store.audit("hf.token.set", maskToken(token), "cli");
        process.stdout.write(`${JSON.stringify({ set: true, preview: maskToken(token) }, null, 2)}\n`);
        return;
      }
      if (sub === "status") {
        const token = getToken(store);
        process.stdout.write(`${JSON.stringify({ set: Boolean(token), preview: token ? maskToken(token) : null }, null, 2)}\n`);
        return;
      }
      if (sub === "clear") {
        clearToken(store);
        store.audit("hf.token.clear", "", "cli");
        process.stdout.write(`${JSON.stringify({ set: false }, null, 2)}\n`);
        return;
      }
      throw new Error("hf token action must be set, status or clear");
    }

    if (action === "files") {
      const repo = rest[1];
      if (!repo) throw new Error("hf files needs a repo id, e.g. Qwen/Qwen2.5-0.5B-Instruct-GGUF");
      const files = await listGgufFiles(repo, getToken(store));
      process.stdout.write(`${JSON.stringify({ repo, files }, null, 2)}\n`);
      return;
    }

    if (action === "download") {
      const repo = rest[1];
      if (!repo) throw new Error("hf download needs a repo id, e.g. Qwen/Qwen2.5-0.5B-Instruct-GGUF");
      const token = getToken(store);
      const fileIndex = rest.indexOf("--file");
      let file = fileIndex >= 0 ? (rest[fileIndex + 1] ?? "") : "";
      if (!file) {
        const files = await listGgufFiles(repo, token);
        const first = files[0];
        if (files.length === 1 && first) file = first.path;
        else throw new Error(`${repo} has ${files.length} GGUF files; pass --file <name> (see: node src/main.ts hf files ${repo})`);
      }
      let lastWrite = 0;
      const result = await downloadFile(repo, file, cfg.modelsDir, token, (done, total) => {
        const stamp = Date.now();
        if (stamp - lastWrite < 1000 || !total) return;
        lastWrite = stamp;
        process.stderr.write(`\rdownloading ${(done / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MiB`);
      });
      process.stderr.write("\n");
      store.audit("hf.download", `${repo}/${file}`, result.path, "cli");
      process.stdout.write(`${JSON.stringify({ repo, file, ...result }, null, 2)}\n`);
      return;
    }

    if (action === "smoke") {
      const token = getToken(store);
      const report: Record<string, unknown> = {
        migration: 0,
        hf_reachable: false,
        gguf_files: 0,
        range_bytes: 0,
        token: { set: Boolean(token), preview: token ? maskToken(token) : null },
      };
      const migration = store.one<{ v: number | null }>("SELECT MAX(version) AS v FROM lama_manager_migrations");
      report.migration = migration?.v ?? 0;
      const repo = "Qwen/Qwen2.5-0.5B-Instruct-GGUF";
      try {
        const files = await listGgufFiles(repo, token);
        report.hf_reachable = true;
        report.gguf_files = files.length;
        if (files.length > 0) {
          const first = files[0]!;
          report.sample_file = first.path;
          report.range_bytes = await fetchRange(resolveUrl(repo, first.path), token, 1024);
        }
      } catch (error) {
        report.error = error instanceof Error ? error.message : String(error);
      }
      const pass =
        report.migration === 4 &&
        report.hf_reachable === true &&
        Number(report.gguf_files) >= 1 &&
        report.range_bytes === 1024;
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(pass ? "HF_CLI_PASS\n" : "HF_CLI_FAIL\n");
      if (!pass) process.exitCode = 1;
      return;
    }

    throw new Error("hf action must be token, files, download or smoke");
  }

  usage();
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`lama: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}
