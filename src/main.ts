#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig, ensureDirs } from "./config.ts";
import { detectOs } from "./os.ts";
import { Store, seedStore } from "./db.ts";
import { EngineManager, resolveBinary, mmapStatus } from "./engine.ts";
import { createAdminServer } from "./admin.ts";
import { installLlama, ensureTls, tlsSupport, binaryVersion } from "./installer.ts";
import { writeEngineMcpConfig } from "./mcp/config.ts";
import { applySeeds } from "./seed.ts";
import { ensureIdentityFile } from "./identity.ts";
import { syncSystemPrompt } from "./prompt.ts";
import { installService, serviceAction, serviceAvailable } from "./service.ts";

function usage(): void {
  process.stdout.write(`lama-clean — stock llama.cpp lifecycle manager

Usage:
  node src/main.ts setup [--service user|system]
  node src/main.ts install [--build bNNNNN] [--accel cpu|cuda|vulkan|rocm|openvino|sycl] [--force]
  node src/main.ts tls [--check]
  node src/main.ts doctor [--json]
  node src/main.ts serve
  node src/main.ts engine-run
  node src/main.ts engine load <model-id> [--ttl HOURS]
  node src/main.ts engine unload
  node src/main.ts engine reload [model-id] [--ttl HOURS]
  node src/main.ts engine status
  node src/main.ts service install user|system [--admin] [--start|--no-start]
  node src/main.ts service start|stop|restart|status user|system [--admin]
  node src/main.ts seed
  node src/main.ts mcp

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
  const store = new Store(cfg.dbFile);
  seedStore(store, cfg, os);
  syncSystemPrompt(store, cfg);
  const seedReport = applySeeds(store, cfg, os);
  writeEngineMcpConfig(store, cfg);
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
    const report = {
      labels: {
        os: "SOURCE_VERIFIED",
        db: "SOURCE_VERIFIED",
        binary: binary ? "LIVE_PROBE_PASSED" : "NOT_TESTED",
        tls: linkage.supported === null ? "UNVERIFIED" : "SOURCE_VERIFIED",
        engine: status.status === "running" ? "LIVE_PROBE_PASSED" : "NOT_TESTED",
      },
      os,
      paths: { root: cfg.root, db: cfg.dbFile, models: cfg.modelsDir, uds: cfg.udsPath, admin: `http://${cfg.adminHost}:${cfg.adminPort}` },
      binary: { path: binary, version, tls: linkage },
      service: { mode: store.setting("service_mode") ?? cfg.serviceMode, available: serviceAvailable(os) },
      engine: status,
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
      process.stdout.write(`admin     http://${cfg.adminHost}:${cfg.adminPort}\n`);
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
    server.listen(cfg.adminPort, cfg.adminHost, () => {
      process.stdout.write(`lama admin: http://${cfg.adminHost}:${cfg.adminPort}\n`);
      process.stdout.write(`engine: ${cfg.engineUrl} (UDS ${cfg.udsPath})\n`);
      if (!cfg.adminToken) process.stdout.write("warning: LAMA_ADMIN_TOKEN is empty; loopback only\n");
    });
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
    const kind = rest.includes("--admin") ? "admin" : "engine";
    if (action === "install") {
      // engine: enable-only by default (the manager loads models on demand);
      // admin: start now, since it is the human entry point.
      const start = rest.includes("--no-start") ? false : rest.includes("--start") ? true : undefined;
      const result = installService(cfg, os, mode, kind, start === undefined ? {} : { start });
      store.audit("service.install", `${kind}/${mode}`, result.detail, "cli");
      process.stdout.write(`${JSON.stringify({ kind, mode, ...result }, null, 2)}\n`);
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
    throw new Error("service action must be install, start, stop, restart or status");
  }

  if (command === "mcp") {
    await import("./mcp/server.ts");
    return;
  }

  usage();
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`lama: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
