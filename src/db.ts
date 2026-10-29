import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  DocumentRow,
  EngineState,
  McpRow,
  ModelRow,
  PromptRow,
  ProviderRow,
  SessionRow,
  TransportRow,
} from "./types.ts";
import type { Config } from "./config.ts";
import type { OsInfo } from "./types.ts";

const now = (): string => new Date().toISOString();

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('llamacpp')),
        base_url TEXT NOT NULL,
        build TEXT,
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        model_id TEXT NOT NULL,
        path TEXT,
        context INTEGER,
        max_tokens INTEGER,
        temperature REAL NOT NULL DEFAULT 0.7,
        quant TEXT,
        load_mode TEXT NOT NULL DEFAULT 'auto'
          CHECK (load_mode IN ('auto','mmap','none','mlock','mmap+mlock','dio')),
        ttl_hours REAL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider_id, model_id)
      );

      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        transport TEXT NOT NULL CHECK (transport IN ('stdio','http','sse')),
        command TEXT,
        args_json TEXT NOT NULL DEFAULT '[]',
        env_json TEXT NOT NULL DEFAULT '{}',
        cwd TEXT,
        url TEXT,
        api_key_ref TEXT,
        timeout_ms INTEGER NOT NULL DEFAULT 30000,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transports (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL CHECK (protocol IN ('http','https','uds')),
        host TEXT,
        port INTEGER,
        socket_path TEXT,
        tls_key TEXT,
        tls_cert TEXT,
        gateway_hint TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        transport_id TEXT REFERENCES transports(id) ON DELETE SET NULL,
        body TEXT NOT NULL,
        verified_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS system_prompts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
        system_prompt_id TEXT REFERENCES system_prompts(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT
      );

      CREATE TABLE IF NOT EXISTS engine_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        model_id TEXT,
        pid INTEGER,
        status TEXT NOT NULL DEFAULT 'stopped'
          CHECK (status IN ('stopped','starting','running','error')),
        started_at TEXT,
        expires_at TEXT,
        load_mode TEXT NOT NULL DEFAULT 'auto',
        socket_path TEXT,
        port INTEGER,
        build TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor TEXT NOT NULL DEFAULT 'system',
        action TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id);
      CREATE INDEX IF NOT EXISTS idx_documents_transport ON documents(transport_id);
      CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_events(at DESC);
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE providers ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE models ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE mcp_servers ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE transports ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE documents ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE system_prompts ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';

      CREATE TABLE IF NOT EXISTS system_identity (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        tagline TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
];

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/\.gguf$/i, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "item"
  );
}

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Windows and some filesystems do not support chmod; not fatal.
    }
    this.assertCompatible();
    this.migrate();
  }

  private assertCompatible(): void {
    const table = this.one<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'system_prompts'",
    );
    if (!table) return;
    const columns = this.all<{ name: string }>("PRAGMA table_info(system_prompts)").map((row) => row.name);
    if (!columns.includes("content") || !columns.includes("version")) {
      throw new Error(
        "this SQLite file belongs to the legacy JS manager; set LAMA_DB to a new file (the legacy schema is not migrated)",
      );
    }
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS lama_manager_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = new Set(
      this.all<{ version: number }>("SELECT version FROM lama_manager_migrations").map((row) => row.version),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.db.exec("BEGIN");
      try {
        this.db.exec(migration.sql);
        this.db.prepare("INSERT INTO lama_manager_migrations(version, applied_at) VALUES (?, ?)").run(
          migration.version,
          now(),
        );
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  one<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  run(sql: string, ...params: unknown[]): void {
    this.db.prepare(sql).run(...(params as never[]));
  }

  setting(key: string): string | null {
    return this.one<{ value: string }>("SELECT value FROM app_settings WHERE key = ?", key)?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.run(
      "INSERT INTO app_settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      key,
      value,
      now(),
    );
  }

  identity(): { name: string; version: string; tagline: string; payload_json: string } | undefined {
    return this.one("SELECT name, version, tagline, payload_json FROM system_identity WHERE id = 1");
  }

  setIdentity(name: string, version: string, tagline: string, payloadJson: string): void {
    this.run(
      `INSERT INTO system_identity(id, name, version, tagline, payload_json, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         version = excluded.version,
         tagline = excluded.tagline,
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at`,
      name,
      version,
      tagline,
      payloadJson,
      now(),
    );
  }

  audit(action: string, target = "", detail = "", actor = "system"): void {
    this.run(
      "INSERT INTO audit_events(at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)",
      now(),
      actor,
      action,
      target,
      detail,
    );
  }

  listAudit(limit = 100): Array<{ id: number; at: string; actor: string; action: string; target: string; detail: string }> {
    return this.all("SELECT * FROM audit_events ORDER BY id DESC LIMIT ?", Math.min(Math.max(limit, 1), 500));
  }

  listProviders(): ProviderRow[] {
    return this.all("SELECT * FROM providers ORDER BY id");
  }

  getProvider(id: string): ProviderRow | undefined {
    return this.one("SELECT * FROM providers WHERE id = ?", id);
  }

  upsertProvider(row: Omit<ProviderRow, "created_at" | "updated_at">): void {
    this.run(
      `INSERT INTO providers(id, name, kind, base_url, build, config_json, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         kind = excluded.kind,
         base_url = excluded.base_url,
         build = excluded.build,
         config_json = excluded.config_json,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
      row.id,
      row.name,
      row.kind,
      row.base_url,
      row.build,
      row.config_json,
      row.metadata_json,
      now(),
      now(),
    );
  }

  listModels(): ModelRow[] {
    return this.all("SELECT * FROM models ORDER BY name");
  }

  getModel(id: string): ModelRow | undefined {
    return this.one("SELECT * FROM models WHERE id = ?", id);
  }

  getModelByModelId(modelId: string): ModelRow | undefined {
    return this.one("SELECT * FROM models WHERE model_id = ?", modelId);
  }

  upsertModel(row: Omit<ModelRow, "created_at" | "updated_at">): void {
    this.run(
      `INSERT INTO models(id, provider_id, name, model_id, path, context, max_tokens, temperature, quant, load_mode, ttl_hours, enabled, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         provider_id = excluded.provider_id,
         name = excluded.name,
         model_id = excluded.model_id,
         path = excluded.path,
         context = excluded.context,
         max_tokens = excluded.max_tokens,
         temperature = excluded.temperature,
         quant = excluded.quant,
         load_mode = excluded.load_mode,
         ttl_hours = excluded.ttl_hours,
         enabled = excluded.enabled,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
      row.id,
      row.provider_id,
      row.name,
      row.model_id,
      row.path,
      row.context,
      row.max_tokens,
      row.temperature,
      row.quant,
      row.load_mode,
      row.ttl_hours,
      row.enabled,
      row.metadata_json,
      now(),
      now(),
    );
  }

  deleteModel(id: string): void {
    this.run("DELETE FROM models WHERE id = ?", id);
  }

  listMcp(): McpRow[] {
    return this.all("SELECT * FROM mcp_servers ORDER BY name");
  }

  getMcp(id: string): McpRow | undefined {
    return this.one("SELECT * FROM mcp_servers WHERE id = ?", id);
  }

  upsertMcp(row: Omit<McpRow, "created_at" | "updated_at">): void {
    this.run(
      `INSERT INTO mcp_servers(id, name, transport, command, args_json, env_json, cwd, url, api_key_ref, timeout_ms, enabled, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         transport = excluded.transport,
         command = excluded.command,
         args_json = excluded.args_json,
         env_json = excluded.env_json,
         cwd = excluded.cwd,
         url = excluded.url,
         api_key_ref = excluded.api_key_ref,
         timeout_ms = excluded.timeout_ms,
         enabled = excluded.enabled,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
      row.id,
      row.name,
      row.transport,
      row.command,
      row.args_json,
      row.env_json,
      row.cwd,
      row.url,
      row.api_key_ref,
      row.timeout_ms,
      row.enabled,
      row.metadata_json,
      now(),
      now(),
    );
  }

  deleteMcp(id: string): void {
    this.run("DELETE FROM mcp_servers WHERE id = ?", id);
  }

  listTransports(): TransportRow[] {
    return this.all("SELECT * FROM transports ORDER BY id");
  }

  getTransport(id: string): TransportRow | undefined {
    return this.one("SELECT * FROM transports WHERE id = ?", id);
  }

  upsertTransport(row: Omit<TransportRow, "created_at" | "updated_at">): void {
    this.run(
      `INSERT INTO transports(id, name, protocol, host, port, socket_path, tls_key, tls_cert, gateway_hint, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         protocol = excluded.protocol,
         host = excluded.host,
         port = excluded.port,
         socket_path = excluded.socket_path,
         tls_key = excluded.tls_key,
         tls_cert = excluded.tls_cert,
         gateway_hint = excluded.gateway_hint,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
      row.id,
      row.name,
      row.protocol,
      row.host,
      row.port,
      row.socket_path,
      row.tls_key,
      row.tls_cert,
      row.gateway_hint,
      row.metadata_json,
      now(),
      now(),
    );
  }

  listDocuments(): DocumentRow[] {
    return this.all("SELECT * FROM documents ORDER BY slug");
  }

  getDocument(id: string): DocumentRow | undefined {
    return this.one("SELECT * FROM documents WHERE id = ?", id);
  }

  getDocumentBySlug(slugValue: string): DocumentRow | undefined {
    return this.one("SELECT * FROM documents WHERE slug = ?", slugValue);
  }

  upsertDocument(row: Omit<DocumentRow, "created_at" | "updated_at">): void {
    this.run(
      `INSERT INTO documents(id, slug, title, transport_id, body, verified_at, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         slug = excluded.slug,
         title = excluded.title,
         transport_id = excluded.transport_id,
         body = excluded.body,
         verified_at = excluded.verified_at,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
      row.id,
      row.slug,
      row.title,
      row.transport_id,
      row.body,
      row.verified_at,
      row.metadata_json,
      now(),
      now(),
    );
  }

  markDocumentVerified(id: string, detail: string): void {
    this.run("UPDATE documents SET verified_at = ?, updated_at = ? WHERE id = ?", now(), now(), id);
    this.audit("document.verify", id, detail);
  }

  listPrompts(): PromptRow[] {
    return this.all("SELECT * FROM system_prompts ORDER BY name");
  }

  getPrompt(id: string): PromptRow | undefined {
    return this.one("SELECT * FROM system_prompts WHERE id = ?", id);
  }

  defaultPrompt(): PromptRow | undefined {
    return this.one("SELECT * FROM system_prompts WHERE is_default = 1 LIMIT 1");
  }

  upsertPrompt(row: Omit<PromptRow, "created_at" | "updated_at">): void {
    this.run(
      `INSERT INTO system_prompts(id, name, content, version, is_default, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         content = excluded.content,
         version = system_prompts.version + 1,
         is_default = excluded.is_default,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
      row.id,
      row.name,
      row.content,
      row.version,
      row.is_default,
      row.metadata_json,
      now(),
      now(),
    );
  }

  listSessions(): SessionRow[] {
    return this.all("SELECT * FROM sessions ORDER BY updated_at DESC");
  }

  upsertSession(row: Omit<SessionRow, "created_at" | "updated_at">): void {
    this.run(
      `INSERT INTO sessions(id, title, model_id, system_prompt_id, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         model_id = excluded.model_id,
         system_prompt_id = excluded.system_prompt_id,
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at`,
      row.id,
      row.title,
      row.model_id,
      row.system_prompt_id,
      now(),
      now(),
      row.expires_at,
    );
  }

  deleteSession(id: string): void {
    this.run("DELETE FROM sessions WHERE id = ?", id);
  }

  engineState(): EngineState {
    const row = this.one<{
      model_id: string | null;
      pid: number | null;
      status: EngineState["status"];
      started_at: string | null;
      expires_at: string | null;
      load_mode: EngineState["load_mode"];
      socket_path: string | null;
      port: number | null;
      build: string | null;
      last_error: string | null;
      updated_at: string;
    }>("SELECT * FROM engine_state WHERE id = 1");
    if (!row) {
      return {
        model_id: null,
        pid: null,
        status: "stopped",
        started_at: null,
        expires_at: null,
        load_mode: "auto",
        socket_path: null,
        port: null,
        build: null,
        mmap: null,
        last_error: null,
        updated_at: now(),
      };
    }
    return { ...row, mmap: null };
  }

  setEngineState(state: Omit<EngineState, "updated_at" | "mmap">): void {
    this.run(
      `INSERT INTO engine_state(id, model_id, pid, status, started_at, expires_at, load_mode, socket_path, port, build, last_error, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         model_id = excluded.model_id,
         pid = excluded.pid,
         status = excluded.status,
         started_at = excluded.started_at,
         expires_at = excluded.expires_at,
         load_mode = excluded.load_mode,
         socket_path = excluded.socket_path,
         port = excluded.port,
         build = excluded.build,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
      state.model_id,
      state.pid,
      state.status,
      state.started_at,
      state.expires_at,
      state.load_mode,
      state.socket_path,
      state.port,
      state.build,
      state.last_error,
      now(),
    );
  }
}

function curl(pathPart: string, body: string): string {
  return `curl -sS http://127.0.0.1:9931${pathPart} \\\n  -H 'content-type: application/json' \\\n  -d '${body}'`;
}

function curlUds(socket: string, pathPart: string, body: string): string {
  return `curl -sS --unix-socket ${socket} http://localhost${pathPart} \\\n  -H 'content-type: application/json' \\\n  -d '${body}'`;
}

export function seedStore(store: Store, cfg: Config, os: OsInfo): void {
  const seedVersion = "1";
  store.upsertProvider({
    id: "llamacpp",
    name: "llama.cpp (stock)",
    kind: "llamacpp",
    base_url: cfg.engineUrl,
    build: null,
    config_json: JSON.stringify({ binary: cfg.llamaBin || "auto", load_mode: cfg.loadMode, accel: cfg.accel }),
    metadata_json: "{}",
  });

  const tlsPresent = fs.existsSync(cfg.tlsKey) && fs.existsSync(cfg.tlsCert);
  store.upsertTransport({
    id: "http",
    name: "HTTP loopback",
    protocol: "http",
    host: cfg.engineHost,
    port: cfg.enginePort,
    socket_path: null,
    tls_key: null,
    tls_cert: null,
    gateway_hint: `Base URL: http://${cfg.adminHost}:${cfg.adminPort} — add this as the gateway's HTTP provider URL. The gateway is a separate connection; do not pass this as an environment variable to llama.cpp.`,
    metadata_json: "{}",
  });
  if (tlsPresent) {
    store.upsertTransport({
      id: "https",
      name: "HTTPS loopback (engine-native TLS)",
      protocol: "https",
      host: cfg.engineHost,
      port: cfg.enginePort,
      socket_path: null,
      tls_key: cfg.tlsKey,
      tls_cert: cfg.tlsCert,
      gateway_hint: `Base URL: https://${cfg.engineHost}:${cfg.enginePort} — verify the certificate chain before adding it to the gateway. Stock binaries need an OpenSSL build for this.`,
      metadata_json: "{}",
    });
  }
  if (cfg.udsPath) {
    store.upsertTransport({
      id: "uds",
      name: "Unix domain socket",
      protocol: "uds",
      host: null,
      port: null,
      socket_path: cfg.udsPath,
      tls_key: null,
      tls_cert: null,
      gateway_hint: `Do not copy a path from this file into the gateway config. Create a symlink in the gateway folder: ${path.join(cfg.gatewayDir, "llama.sock")} -> ${cfg.udsPath}. Then the gateway uses http://localhost/v1 over that socket.`,
      metadata_json: "{}",
    });
  }

  store.upsertDocument({
    id: "openai-http",
    slug: "openai-http",
    title: "OpenAI chat completions over HTTP",
    transport_id: "http",
    body: curl(
      "/v1/chat/completions",
      '{"model":"MODEL_ID","messages":[{"role":"user","content":"hello"}],"max_tokens":64}',
    ),
    verified_at: null,
    metadata_json: "{}",
  });
  store.upsertDocument({
    id: "anthropic-http",
    slug: "anthropic-http",
    title: "Anthropic Messages over HTTP",
    transport_id: "http",
    body: curl(
      "/v1/messages",
      '{"model":"MODEL_ID","max_tokens":64,"messages":[{"role":"user","content":"hello"}]}',
    ),
    verified_at: null,
    metadata_json: "{}",
  });
  if (cfg.udsPath) {
    store.upsertDocument({
      id: "openai-uds",
      slug: "openai-uds",
      title: "OpenAI chat completions over UDS",
      transport_id: "uds",
      body: curlUds(
        cfg.udsPath,
        "/v1/chat/completions",
        '{"model":"MODEL_ID","messages":[{"role":"user","content":"hello"}],"max_tokens":64}',
      ),
      verified_at: null,
      metadata_json: "{}",
    });
    store.upsertDocument({
      id: "anthropic-uds",
      slug: "anthropic-uds",
      title: "Anthropic Messages over UDS",
      transport_id: "uds",
      body: curlUds(
        cfg.udsPath,
        "/v1/messages",
        '{"model":"MODEL_ID","max_tokens":64,"messages":[{"role":"user","content":"hello"}]}',
      ),
      verified_at: null,
      metadata_json: "{}",
    });
  }

  if (!store.defaultPrompt()) {
    store.upsertPrompt({
      id: "default",
      name: "default",
      content:
        "You are a concise assistant running on a local llama.cpp engine. Answer in the user's language. Use a tool only when it is necessary; never invent tool results.",
      version: 1,
      is_default: 1,
      metadata_json: "{}",
    });
  }

  if (!store.getMcp("lama-tools")) {
    store.upsertMcp({
      id: "lama-tools",
      name: "lama-tools",
      transport: "stdio",
      command: process.execPath,
      args_json: JSON.stringify([path.join(cfg.root, "src", "mcp", "server.ts")]),
      env_json: JSON.stringify({ LAMA_WORKSPACE: cfg.workspaceDir, LAMA_ENV_FILE: cfg.envFile }),
      cwd: cfg.root,
      url: null,
      api_key_ref: null,
      timeout_ms: 30000,
      enabled: 1,
      metadata_json: "{}",
    });
  }

  if (fs.existsSync(cfg.modelsDir)) {
    for (const entry of fs.readdirSync(cfg.modelsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".gguf")) continue;
      const modelId = slug(entry.name);
      const existing = store.getModel(modelId);
      if (existing) continue;
      store.upsertModel({
        id: modelId,
        provider_id: "llamacpp",
        name: entry.name.replace(/\.gguf$/i, ""),
        model_id: modelId,
        path: path.join(cfg.modelsDir, entry.name),
        context: 4096,
        max_tokens: 1024,
        temperature: 0.7,
        quant: null,
        load_mode: "auto",
        ttl_hours: cfg.defaultTtlHours,
        enabled: 1,
        metadata_json: "{}",
      });
    }
  }

  store.setSetting("seed_version", seedVersion);
  store.setSetting("seeded_os", JSON.stringify({ platform: os.platform, arch: os.arch, distro: os.distro }));
  if (!store.setting("admin_token_generated")) {
    store.setSetting("admin_token_generated", cfg.adminToken ? "external" : "missing");
  }
}
