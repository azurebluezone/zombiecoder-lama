import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import type { EngineManager } from "./engine.ts";
import { resolveModel } from "./engine.ts";
import type { EngineTransport, LoadMode, McpTransport, ModelRow, OsInfo, TransportRow } from "./types.ts";
import { linkSocket, openStream, probeTransport, request } from "./transport.ts";
import { engineMcpConfig, mcpSummary, writeEngineMcpConfig } from "./mcp/config.ts";
import { probeStdio } from "./mcp/probe.ts";
import { MCP_TOOLS, TOOL_USE_CASES, callTool } from "./mcp/tools.ts";
import { parseToolCalls } from "./tools/parser.ts";
import { identityHeaders, loadIdentity } from "./identity.ts";
import { EventHub } from "./realtime.ts";
import { MetricsCollector } from "./metrics.ts";
import { buildTransportDocs, docsToMarkdown } from "./docs.ts";
import { buildIntegrationDocs, integrationToMarkdown } from "./integration.ts";
import { PROMPT_USAGE, promptMeta, readPromptFile, resetSystemPrompt, saveSystemPrompt, syncSystemPrompt } from "./prompt.ts";
import {
  clearToken as hfClearToken,
  downloadFile as hfDownloadFile,
  getToken as hfGetToken,
  listGgufFiles as hfListGgufFiles,
  maskToken as hfMaskToken,
  setToken as hfSetToken,
} from "./hf.ts";

interface Context {
  store: Store;
  cfg: Config;
  os: OsInfo;
  engine: EngineManager;
}

interface Endpoint extends Pick<TransportRow, "protocol" | "host" | "port" | "socket_path"> {
  id: string;
}

const LOAD_MODES = new Set<LoadMode>(["auto", "mmap", "none", "mlock", "mmap+mlock", "dio"]);
const MCP_TRANSPORTS = new Set<McpTransport>(["stdio", "http", "sse"]);
const PROTOCOLS = new Set<EngineTransport>(["http", "https", "uds"]);

let IDENTITY_HEADERS: Record<string, string> = {};

function json(res: http.ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...IDENTITY_HEADERS,
  });
  res.end(body);
}

function text(res: http.ServerResponse, status: number, value: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(value),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...IDENTITY_HEADERS,
  });
  res.end(value);
}

function fail(res: http.ServerResponse, status: number, message: string): void {
  json(res, status, { error: message });
}

/**
 * Bind the admin listener and turn a port collision into one actionable line.
 * `server.listen()` otherwise emits an unhandled 'error' event, which is how
 * systemd kept restarting the unit while the journal filled with stack traces.
 */
export function listenAdminServer(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: NodeJS.ErrnoException): void => {
      cleanup();
      if (error.code === "EADDRINUSE") {
        error.message = `admin port ${host}:${port} is already in use; find the owner with \`ss -ltnp | grep :${port}\` or set LAMA_ADMIN_PORT`;
      } else if (error.code === "EACCES") {
        error.message = `admin port ${host}:${port} needs elevated privileges or is reserved; set LAMA_ADMIN_PORT to a free port`;
      }
      reject(error);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/**
 * Probe /healthz and accept only this service's own answer. A foreign process
 * (the legacy JS manager also answers {"ok":true}) must not be mistaken for a
 * running lama admin, or a second unit would silently stand down.
 */
export function adminHealth(host: string, port: number, timeoutMs = 1500): Promise<{ up: boolean; detail: string }> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/healthz", timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        if (body.length < 4096) body += chunk;
      });
      res.on("end", () => {
        let service: string | undefined;
        try {
          service = (JSON.parse(body) as { service?: string }).service;
        } catch {
          service = undefined;
        }
        if (res.statusCode === 200 && service === "lama-admin") resolve({ up: true, detail: "lama-admin healthz 200" });
        else resolve({ up: false, detail: `port ${port} answered ${res.statusCode ?? "?"} but not as lama-admin` });
      });
      res.on("error", (error: Error) => resolve({ up: false, detail: error.message }));
    });
    req.on("timeout", () => req.destroy(new Error(`no answer from ${host}:${port} within ${timeoutMs}ms`)));
    req.on("error", (error: Error) => resolve({ up: false, detail: error.message }));
  });
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function tokenFrom(req: http.IncomingMessage): string {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  const direct = req.headers["x-admin-token"];
  return typeof direct === "string" ? direct.trim() : "";
}

function loopback(req: http.IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 4 * 1024 * 1024) throw new Error("request body exceeds 4 MiB");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON object required");
  return parsed as Record<string, unknown>;
}

function str(value: unknown, name: string, max = 2000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  if (value.length > max) throw new Error(`${name} exceeds ${max} chars`);
  return value.trim();
}

function num(value: unknown, name: string, fallback: number, min: number, max: number): number {
  const parsed = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return parsed;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

function staticFile(cfg: Config, pathname: string): { file: string; type: string } | null {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (relative.includes("\0")) return null;
  const file = path.resolve(cfg.webDir, relative);
  if (!file.startsWith(path.resolve(cfg.webDir) + path.sep)) return null;
  const type =
    file.endsWith(".html")
      ? "text/html; charset=utf-8"
      : file.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : file.endsWith(".css")
          ? "text/css; charset=utf-8"
          : "application/octet-stream";
  return fs.existsSync(file) ? { file, type } : null;
}

function findModel(store: Store, key: string | null | undefined): ModelRow | undefined {
  if (!key) return undefined;
  const direct = resolveModel(store, key);
  if (direct) return direct;
  const tail = key.includes("/") ? key.slice(key.lastIndexOf("/") + 1) : "";
  return tail ? resolveModel(store, tail) : undefined;
}

function activeModel(store: Store): ModelRow | undefined {
  const state = store.engineState();
  return (state.model_id ? store.getModel(state.model_id) : undefined) ?? store.listModels().find((row) => row.enabled) ?? store.listModels()[0];
}

function activeAlias(store: Store): string {
  return activeModel(store)?.model_id ?? "model";
}

function resolveEndpoint(store: Store, cfg: Config, id: string | null | undefined): Endpoint {
  const row = id ? store.getTransport(id) : undefined;
  if (row) return { id: row.id, protocol: row.protocol, host: row.host, port: row.port, socket_path: row.socket_path };
  const protocol = id === "uds" || (!id && cfg.udsPath) ? "uds" : cfg.tls ? "https" : "http";
  if (protocol === "uds" && cfg.udsPath) {
    return { id: "uds", protocol: "uds", host: null, port: null, socket_path: cfg.udsPath };
  }
  return {
    id: protocol,
    protocol,
    host: cfg.engineHost,
    port: cfg.enginePort,
    socket_path: null,
  };
}

function engineHeaders(cfg: Config): Record<string, string> {
  return cfg.engineApiKey ? { authorization: `Bearer ${cfg.engineApiKey}` } : {};
}

function usageOf(value: unknown): { prompt: number | null; completion: number | null } | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  const prompt = usage.prompt_tokens ?? usage.input_tokens;
  const completion = usage.completion_tokens ?? usage.output_tokens;
  if (prompt === undefined && completion === undefined) return null;
  return {
    prompt: typeof prompt === "number" ? prompt : null,
    completion: typeof completion === "number" ? completion : null,
  };
}

function scanUsage(payload: string): { prompt: number | null; completion: number | null } {
  let prompt: number | null = null;
  let completion: number | null = null;
  const merge = (value: unknown): void => {
    const usage = usageOf(value);
    if (!usage) return;
    if (usage.prompt !== null) prompt = usage.prompt;
    if (usage.completion !== null) completion = usage.completion;
  };
  try {
    const whole: unknown = JSON.parse(payload);
    merge((whole as { usage?: unknown })?.usage);
    merge((whole as { message?: { usage?: unknown } })?.message?.usage);
  } catch {
    // streaming payload: scan SSE data lines below
  }
  for (const line of payload.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as { usage?: unknown; message?: { usage?: unknown } };
      merge(parsed.usage);
      merge(parsed.message?.usage);
    } catch {
      // ignore non-JSON keep-alive lines
    }
  }
  return { prompt, completion };
}

function deltaText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0] as { delta?: { content?: unknown }; text?: unknown } | undefined;
  if (typeof first?.delta?.content === "string") return first.delta.content;
  if (typeof first?.text === "string") return first.text;
  const delta = record.delta as { text?: unknown } | undefined;
  if (typeof delta?.text === "string") return delta.text;
  if (typeof record.completion === "string") return record.completion;
  return "";
}

function deltaReasoning(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0] as { delta?: { reasoning_content?: unknown } } | undefined;
  if (typeof first?.delta?.reasoning_content === "string") return first.delta.reasoning_content;
  const delta = record.delta as { thinking?: unknown } | undefined;
  if (typeof delta?.thinking === "string") return delta.thinking;
  return "";
}

/** SSE helper for the chat relay; named events keep parsing simple in the browser. */
function sse(res: http.ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function probeDocument(ctx: Context, id: string): Promise<{ ok: boolean; detail: string }> {
  const doc = ctx.store.getDocument(id);
  if (!doc) throw new Error("document not found");
  const transport = doc.transport_id ? ctx.store.getTransport(doc.transport_id) : undefined;
  if (!transport) throw new Error("document has no transport");
  const model = ctx.store.listModels().find((item) => item.enabled) ?? ctx.store.listModels()[0];
  if (!model) throw new Error("no model row to probe with");
  const health = await request(transport, "/health", { timeoutMs: 5000 }).catch((error: unknown) => ({
    status: 0,
    headers: {},
    text: error instanceof Error ? error.message : String(error),
  }));
  if (health.status !== 200) return { ok: false, detail: `health HTTP ${health.status || "unreachable"}: ${health.text.slice(0, 200)}` };
  if (doc.slug.includes("anthropic")) {
    const response = await request(transport, "/v1/messages", {
      timeoutMs: 60_000,
      body: { model: model.model_id, max_tokens: 8, messages: [{ role: "user", content: "Reply with ok." }] },
    }).catch((error: unknown) => ({ status: 0, headers: {}, text: error instanceof Error ? error.message : String(error) }));
    if (response.status !== 200) return { ok: false, detail: `messages HTTP ${response.status || "unreachable"}: ${response.text.slice(0, 200)}` };
    const parsed = JSON.parse(response.text) as { content?: unknown };
    if (!Array.isArray(parsed.content)) return { ok: false, detail: "messages response has no content array" };
    return { ok: true, detail: "health 200, messages 200, content array present" };
  }
  const response = await request(transport, "/v1/chat/completions", {
    timeoutMs: 60_000,
    body: { model: model.model_id, max_tokens: 8, temperature: 0, messages: [{ role: "user", content: "Reply with ok." }] },
  }).catch((error: unknown) => ({ status: 0, headers: {}, text: error instanceof Error ? error.message : String(error) }));
  if (response.status !== 200) return { ok: false, detail: `chat HTTP ${response.status || "unreachable"}: ${response.text.slice(0, 200)}` };
  const parsed = JSON.parse(response.text) as { choices?: unknown };
  if (!Array.isArray(parsed.choices)) return { ok: false, detail: "chat response has no choices array" };
  return { ok: true, detail: "health 200, chat 200, choices array present" };
}

const PROXY_PATHS = /^\/(v1\/|health$|props$|tools$|metrics$|slots$|tokenize$|apply-template$|embedding)/;

export function createAdminServer(ctx: Context): http.Server {
  const { store, cfg, os, engine } = ctx;
  const identity = loadIdentity(cfg.root);
  IDENTITY_HEADERS = identityHeaders(identity);
  const hub = new EventHub();
  const metrics = new MetricsCollector(cfg, store);

  // Seed the managed prompt once per boot; a user edit is never overwritten.
  syncSystemPrompt(store, cfg);

  store.setAuditListener((row) => hub.broadcast("audit", row));
  engine.setProgressListener((event) => {
    hub.broadcast("engine", event);
  });

  const metricsTimer = setInterval(() => {
    try {
      const snapshot = metrics.sample();
      if (hub.size > 0) hub.broadcast("metrics", snapshot);
    } catch {
      // metrics are advisory; never crash the admin loop
    }
  }, 2000);
  metricsTimer.unref();

  const toolServer = (tool: string): string | null => store.listMcpTools().find((row) => row.name === tool)?.mcp_id ?? null;

  const recordRequest = (input: Parameters<Store["logRequest"]>[0]) => {
    const row = store.logRequest(input);
    hub.broadcast("request", row);
    return row;
  };

  const proxyToEngine = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    urlPath: string,
    resumed?: { raw: Buffer; started: number },
  ): Promise<void> => {
    const started = resumed?.started ?? Date.now();
    let raw: Buffer;
    if (resumed) {
      raw = resumed.raw;
    } else {
      const chunks: Buffer[] = [];
      let received = 0;
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk);
        received += buffer.length;
        if (received > 4 * 1024 * 1024) {
          fail(res, 400, "request body exceeds 4 MiB");
          return;
        }
        chunks.push(buffer);
      }
      raw = Buffer.concat(chunks);
    }
    let payload: Record<string, unknown> | null = null;
    try {
      payload = raw.length ? (JSON.parse(raw.toString("utf8")) as Record<string, unknown>) : null;
    } catch {
      payload = null;
    }
    const model = findModel(store, typeof payload?.model === "string" ? payload.model : null);
    const alias = typeof payload?.model === "string" ? payload.model : activeAlias(store);
    const protocol = urlPath.startsWith("/v1/messages") ? "anthropic" : "openai";
    const stream = payload?.stream === true;
    const transportId = cfg.tls ? "https" : "http";
    const endpoint = store.getTransport(transportId) ? transportId : null;

    const target = new URL(cfg.engineUrl);
    const engineState = store.engineState();
    // Blue-green reload moves the live engine to the spare port; the proxy
    // follows engine_state.port instead of the boot-time URL.
    if (engineState.status === "running" && engineState.port) target.port = String(engineState.port);
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers.host;
    headers["content-length"] = String(raw.length);
    if (cfg.engineApiKey) headers.authorization = `Bearer ${cfg.engineApiKey}`;
    else delete headers.authorization;
    const client = target.protocol === "https:" ? https : http;

    const finish = (status: number, captured: string, bytes: number, detail = ""): void => {
      const usage = scanUsage(captured);
      try {
        recordRequest({
          model_id: model?.id ?? null,
          model_key: alias,
          provider_id: model?.provider_id ?? "llamacpp",
          transport_id: endpoint,
          protocol: protocol as "openai" | "anthropic",
          endpoint: urlPath,
          method: req.method ?? "POST",
          status,
          ok: status >= 200 && status < 300 ? 1 : 0,
          stream: stream ? 1 : 0,
          duration_ms: Date.now() - started,
          first_token_ms: null,
          prompt_tokens: usage.prompt,
          completion_tokens: usage.completion,
          bytes,
          system_prompt_id: null,
          detail: detail.slice(0, 500),
        });
      } catch {
        // logging must never break the proxy response
      }
    };

    // Reload = systemd restart: the engine is briefly absent by design. Hold
    // client requests until it is back instead of answering 502, so a stable
    // base URL survives model swaps.
    const waitForReady = async (): Promise<boolean> => {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const state = store.engineState();
        if (state.status === "running") return true;
        if (!engine.isReloading() && state.status !== "starting") return false;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return false;
    };
    if (engine.isReloading() || store.engineState().status === "starting") {
      if (!(await waitForReady())) {
        fail(res, 503, "engine is reloading; retry shortly");
        return;
      }
    }

    const upstream = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: `${urlPath}`,
        method: req.method,
        headers,
        // Stock llama.cpp closes streaming sockets without announcing it; a
        // reused keep-alive socket then dies with ECONNRESET. One fresh
        // upstream connection per proxied request removes that failure mode.
        agent: false,
        rejectUnauthorized: process.env.LAMA_TLS_INSECURE !== "1",
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502;
        res.writeHead(status, { ...upstreamRes.headers, ...IDENTITY_HEADERS });
        let captured = "";
        let bytes = 0;
        upstreamRes.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          const piece = chunk.toString("utf8");
          // Keep the first 384 KiB (error bodies) and the last 64 KiB (streaming usage).
          captured = captured.length < 384 * 1024 ? captured + piece : `${captured.slice(0, 384 * 1024)}${piece}`;
          if (captured.length > 448 * 1024) captured = captured.slice(-96 * 1024);
          res.write(chunk);
        });
        upstreamRes.on("end", () => {
          res.end();
          finish(status, captured, bytes, status >= 400 ? "proxy upstream error" : "");
        });
        upstreamRes.on("error", () => {
          res.destroy();
          finish(status, captured, bytes, "upstream stream error");
        });
      },
    );
    upstream.on("error", (error: Error) => {
      // A reload can kill the upstream between the readiness check and the
      // connect. Wait for the restarted engine, then replay the buffered
      // request instead of leaking a reset to the client.
      if (!res.headersSent && (engine.isReloading() || store.engineState().status === "starting")) {
        void waitForReady().then((ready) => {
          if (ready) {
            void proxyToEngine(req, res, urlPath, { raw, started });
            return;
          }
          fail(res, 503, "engine reload finished without a running engine");
          finish(503, "", 0, error.message);
        });
        return;
      }
      if (!res.headersSent) fail(res, 502, `engine unreachable: ${error.message}`);
      else res.destroy();
      finish(502, "", 0, error.message);
    });
    req.on("aborted", () => upstream.destroy());
    upstream.end(raw.length ? raw : undefined);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = decodeURIComponent(url.pathname);
      const method = req.method ?? "GET";

      if (method === "GET" && pathname === "/healthz") {
        json(res, 200, { ok: true, service: "lama-admin" });
        return;
      }

      if (method === "GET" && pathname === "/admin") {
        res.writeHead(302, { location: "/", ...IDENTITY_HEADERS });
        res.end();
        return;
      }

      // OpenAI/Anthropic surface for the gateway: loopback by default, or LAMA_API_KEY.
      if (PROXY_PATHS.test(pathname)) {
        if (!loopback(req)) {
          if (!cfg.apiKey) return fail(res, 403, "proxy is loopback-only; set LAMA_API_KEY for remote use");
          if (!safeEqual(tokenFrom(req), cfg.apiKey)) return fail(res, 401, "invalid proxy API key");
        }
        await proxyToEngine(req, res, `${pathname}${url.search}`);
        return;
      }

      if (method === "GET" && !pathname.startsWith("/api/")) {
        const file = staticFile(cfg, pathname);
        if (!file) return fail(res, 404, "not found");
        const content = fs.readFileSync(file.file);
        res.writeHead(200, {
          "content-type": file.type,
          "content-length": content.length,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy":
            // style-src allows inline style attributes (the admin layout uses a few); scripts stay external.
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        });
        res.end(content);
        return;
      }

      if (cfg.adminToken) {
        const supplied = tokenFrom(req);
        if (!supplied || !safeEqual(supplied, cfg.adminToken)) return fail(res, 401, "invalid admin token");
      } else if (!loopback(req)) {
        return fail(res, 403, "LAMA_ADMIN_TOKEN is empty and the request is not loopback");
      }

      if (method === "POST" || method === "PUT" || method === "DELETE") {
        const origin = req.headers.origin;
        if (typeof origin === "string" && origin !== "null") {
          const originHost = new URL(origin).host;
          if (originHost !== req.headers.host) return fail(res, 403, "cross-origin request refused");
        }
      }

      // ---------- realtime ----------
      if (method === "GET" && pathname === "/api/events") {
        hub.add(req, res);
        return;
      }

      if (method === "GET" && pathname === "/api/metrics") {
        json(res, 200, metrics.sample());
        return;
      }

      // ---------- state ----------
      if (method === "GET" && pathname === "/api/state") {
        const stats = store.requestStats(0);
        const toolStats = new Map(store.toolUsageStats().map((row) => [row.tool, row]));
        const byModel = new Map(stats.filter((row) => row.model_id).map((row) => [row.model_id, row]));
        const promptUsage = new Map(store.promptUsage().map((row) => [row.system_prompt_id ?? "", row]));
        const prompt = store.getPrompt("system");
        json(res, 200, {
          ok: true,
          os: {
            platform: os.platform,
            arch: os.arch,
            distro: os.distro,
            version: os.distroVersion,
            glibc: os.glibc,
            service_manager: os.serviceManager,
            root: os.isRoot,
          },
          config: {
            root: cfg.root,
            db: cfg.dbFile,
            models_dir: cfg.modelsDir,
            engine_url: cfg.engineUrl,
            uds_path: cfg.udsPath,
            tls: { key: cfg.tlsKey, cert: cfg.tlsCert, enabled: cfg.tls },
            service_mode: store.setting("service_mode") ?? cfg.serviceMode,
            gateway_dir: cfg.gatewayDir,
          },
          engine: await engine.status(),
          metrics: metrics.sample(),
          identity,
          providers: store.listProviders(),
          models: store.listModels().map((model) => ({
            ...model,
            stats: byModel.get(model.id) ?? {
              model_id: model.id,
              transport_id: null,
              total: 0,
              ok: 0,
              failed: 0,
              avg_ms: 0,
              last_at: null,
              prompt_tokens: 0,
              completion_tokens: 0,
            },
          })),
          mcp: store.listMcp().map((row) => ({
            ...mcpSummary(row),
            tools: store.listMcpTools(row.id).map((tool) => ({
              ...tool,
              enabled: Boolean(tool.enabled),
              calls: toolStats.get(tool.name)?.calls ?? 0,
              ok: toolStats.get(tool.name)?.ok ?? 0,
              failed: toolStats.get(tool.name)?.failed ?? 0,
              last_at: toolStats.get(tool.name)?.last_at ?? null,
            })),
          })),
          transports: store.listTransports().map((row) => ({
            ...row,
            stats: stats
              .filter((item) => item.transport_id === row.id)
              .reduce(
                (acc, item) => ({
                  total: acc.total + item.total,
                  ok: acc.ok + item.ok,
                  failed: acc.failed + item.failed,
                  avg_ms: item.avg_ms,
                  last_at: item.last_at ?? acc.last_at,
                }),
                { total: 0, ok: 0, failed: 0, avg_ms: 0, last_at: null as string | null },
              ),
          })),
          documents: store.listDocuments(),
          prompts: store.listPrompts().map((row) => ({
            ...row,
            runs: promptUsage.get(row.id)?.runs ?? 0,
            last_used_at: promptUsage.get(row.id)?.last_at ?? null,
          })),
          system_prompt: { ...promptMeta(prompt, cfg), content: prompt?.content ?? "" },
          prompt_usage: PROMPT_USAGE,
          sessions: store.listSessions(),
          logs: { audit: store.listAudit(50), requests: store.listRequests({ limit: 30 }) },
          warnings: cfg.warnings,
        });
        return;
      }

      if (method === "GET" && pathname === "/api/engine/status") {
        json(res, 200, await engine.status());
        return;
      }

      // Cheap snapshot for the runtime hero panel: phase, both engines, real
      // in-flight gauges and stable endpoints (polled about once per second).
      if (method === "GET" && pathname === "/api/engine/relay") {
        json(res, 200, await engine.relayStatus());
        return;
      }

      if (method === "POST" && pathname === "/api/engine/load") {
        const input = await body(req);
        const modelId = str(input.model_id, "model_id", 200);
        const ttl = input.ttl_hours === undefined ? undefined : num(input.ttl_hours, "ttl_hours", 0, 0, 720);
        json(res, 200, await engine.start(modelId, ttl));
        return;
      }

      if (method === "POST" && pathname === "/api/engine/unload") {
        json(res, 200, await engine.stop());
        return;
      }

      if (method === "POST" && pathname === "/api/engine/reload") {
        const input = await body(req);
        const modelId = typeof input.model_id === "string" && input.model_id.trim() ? input.model_id.trim() : undefined;
        const ttl = input.ttl_hours === undefined ? undefined : num(input.ttl_hours, "ttl_hours", 0, 0, 720);
        json(res, 200, await engine.reload(modelId, ttl));
        return;
      }

      // ---------- models ----------
      if (method === "GET" && pathname === "/api/models/discover") {
        const registered = new Set(store.listModels().map((row) => row.path));
        const files: Array<{ file: string; name: string; id: string; bytes: number; registered: boolean }> = [];
        const scans: Array<{ dir: string; depth: number }> = [{ dir: cfg.modelsDir, depth: 0 }];
        while (scans.length > 0) {
          const item = scans.shift()!;
          if (item.depth > 2) continue;
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(item.dir, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const entry of entries) {
            const file = path.join(item.dir, entry.name);
            if (entry.isDirectory()) scans.push({ dir: file, depth: item.depth + 1 });
            else if (entry.isFile() && entry.name.toLowerCase().endsWith(".gguf")) {
              const name = entry.name.replace(/\.gguf$/i, "");
              files.push({ file, name, id: slug(name), bytes: fs.statSync(file).size, registered: registered.has(file) });
            }
          }
        }
        json(res, 200, { dir: cfg.modelsDir, files });
        return;
      }

      if (method === "POST" && pathname === "/api/models") {
        const input = await body(req);
        const id = slug(typeof input.id === "string" && input.id.trim() ? input.id : str(input.name, "name", 200));
        const existing = store.getModel(id);
        const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : existing?.name;
        if (!name) throw new Error("name is required for a new model");
        const providerId = typeof input.provider_id === "string" && input.provider_id.trim() ? input.provider_id.trim() : existing?.provider_id ?? "llamacpp";
        if (!store.getProvider(providerId)) throw new Error(`unknown provider_id: ${providerId}`);
        const modelKey =
          typeof input.model_id === "string" && input.model_id.trim()
            ? input.model_id.trim()
            : existing?.model_id ?? id;
        // UNIQUE(provider_id, model_id): two rows with one alias would make
        // engine resolution ambiguous, so reject the clash here, in words.
        const clash = store.listModels().find((row) => row.id !== id && row.provider_id === providerId && row.model_id === modelKey);
        if (clash) throw new Error(`model_id "${modelKey}" is already registered as "${clash.id}"; pick another alias`);
        const pathValue =
          typeof input.path === "string" && input.path.trim() ? input.path.trim() : existing?.path ?? "";
        if (!pathValue) throw new Error("path is required for a new model");
        if (!path.isAbsolute(pathValue) || !fs.existsSync(pathValue)) throw new Error("path must be an existing absolute file");
        if (!pathValue.toLowerCase().endsWith(".gguf")) throw new Error("path must point to a .gguf file");
        store.upsertModel({
          id,
          provider_id: providerId,
          name,
          model_id: modelKey,
          path: pathValue,
          context: num(input.context, "context", existing?.context ?? 4096, 256, 1_048_576),
          max_tokens: num(input.max_tokens, "max_tokens", existing?.max_tokens ?? 1024, 1, 1_048_576),
          temperature: num(input.temperature, "temperature", existing?.temperature ?? 0.7, 0, 2),
          quant: typeof input.quant === "string" ? input.quant : existing?.quant ?? null,
          load_mode:
            typeof input.load_mode === "string" && LOAD_MODES.has(input.load_mode as LoadMode)
              ? (input.load_mode as LoadMode)
              : existing?.load_mode ?? "auto",
          ttl_hours:
            input.ttl_hours === undefined || input.ttl_hours === ""
              ? existing?.ttl_hours ?? cfg.defaultTtlHours
              : num(input.ttl_hours, "ttl_hours", cfg.defaultTtlHours, 0, 720),
          enabled: input.enabled === false ? 0 : input.enabled === true ? 1 : existing?.enabled ?? 1,
          metadata_json:
            input.metadata && typeof input.metadata === "object"
              ? JSON.stringify(input.metadata)
              : existing?.metadata_json ?? "{}",
        });
        store.audit("model.upsert", id, `${providerId} · alias=${store.getModel(id)?.model_id}`, "admin");
        json(res, 200, store.getModel(id));
        return;
      }

      const modelDelete = /^\/api\/models\/([^/]+)$/.exec(pathname);
      if (method === "DELETE" && modelDelete?.[1]) {
        const id = modelDelete[1];
        if (store.engineState().model_id === id) throw new Error("unload the engine before deleting the active model");
        store.deleteModel(id);
        store.audit("model.delete", id, "", "admin");
        json(res, 200, { ok: true });
        return;
      }

      // ---------- hugging face (token + GGUF downloads) ----------
      if (method === "GET" && pathname === "/api/hf/token") {
        const token = hfGetToken(store);
        json(res, 200, { set: Boolean(token), preview: token ? hfMaskToken(token) : null });
        return;
      }

      if (method === "PUT" && pathname === "/api/hf/token") {
        const input = await body(req);
        const token = typeof input.token === "string" ? input.token.trim() : "";
        if (!token) return fail(res, 400, "token is required");
        hfSetToken(store, token);
        store.audit("hf.token.set", hfMaskToken(token), "admin");
        json(res, 200, { set: true, preview: hfMaskToken(token) });
        return;
      }

      if (method === "DELETE" && pathname === "/api/hf/token") {
        hfClearToken(store);
        store.audit("hf.token.clear", "", "admin");
        json(res, 200, { set: false });
        return;
      }

      if (method === "GET" && pathname === "/api/hf/files") {
        const repo = (url.searchParams.get("repo") ?? "").trim();
        if (!repo) return fail(res, 400, "repo query parameter is required, e.g. ?repo=Qwen/Qwen2.5-0.5B-Instruct-GGUF");
        const files = await hfListGgufFiles(repo, hfGetToken(store));
        json(res, 200, { repo, files });
        return;
      }

      if (method === "GET" && pathname === "/api/hf/downloads") {
        json(res, 200, { downloads: store.listDownloads() });
        return;
      }

      if (method === "POST" && pathname === "/api/models/download") {
        const input = await body(req);
        const repo = str(input.repo, "repo", 300);
        const file = str(input.file, "file", 300);
        const token = hfGetToken(store);
        const row = store.startDownload(repo, file, path.join(cfg.modelsDir, path.basename(file)));
        json(res, 202, row);
        // The transfer runs in the background; progress lands in model_downloads
        // and fans out over the existing SSE hub, so the UI polls nothing new.
        void (async () => {
          let lastWrite = 0;
          try {
            const result = await hfDownloadFile(repo, file, cfg.modelsDir, token, (done, total) => {
              const stamp = Date.now();
              if (stamp - lastWrite < 1000) return;
              lastWrite = stamp;
              store.updateDownload(row.id, done, total);
              hub.broadcast("download", store.downloadRow(row.id));
            });
            store.finishDownload(row.id, result.path, result.bytes);
            store.audit("hf.download", `${repo}/${file}`, result.path, "admin");
            hub.broadcast("download", store.downloadRow(row.id));
          } catch (error) {
            store.failDownload(row.id, error instanceof Error ? error.message : String(error));
            hub.broadcast("download", store.downloadRow(row.id));
          }
        })();
        return;
      }

      // ---------- chat (protocol + transport + streaming) ----------
      if (method === "POST" && pathname === "/api/chat") {
        const input = await body(req);
        const protocol = input.protocol === "anthropic" ? "anthropic" : "openai";
        const endpoint = resolveEndpoint(store, cfg, typeof input.transport_id === "string" ? input.transport_id : "http");
        const model = findModel(store, typeof input.model === "string" ? input.model : null) ?? activeModel(store);
        if (!model) throw new Error("register a model first");
        const alias = typeof input.model === "string" && input.model.trim() ? input.model.trim() : model.model_id;
        const rawMessages = Array.isArray(input.messages) ? input.messages : [];
        if (rawMessages.length === 0) throw new Error("messages must be a non-empty array");
        const messages = rawMessages
          .map((message) => {
            const row = (message ?? {}) as Record<string, unknown>;
            return {
              role: row.role === "assistant" || row.role === "system" ? row.role : "user",
              content: typeof row.content === "string" ? row.content : "",
            };
          })
          .filter((message) => message.content.length > 0);
        if (messages.length === 0) throw new Error("messages contain no text content");

        let prompt = store.getPrompt("system") ?? store.defaultPrompt();
        if (input.system_prompt_id === "none" || input.system_prompt_id === "") prompt = undefined;
        else if (typeof input.system_prompt_id === "string") prompt = store.getPrompt(input.system_prompt_id) ?? prompt;
        const systemText = prompt?.content ?? "";
        const toolsEnabled = new Set(
          store
            .listMcpTools()
            .filter((tool) => Boolean(tool.enabled))
            .map((tool) => tool.name),
        );
        const includeTools = input.include_tools === true;

        const openaiTools = includeTools
          ? MCP_TOOLS.filter((tool) => toolsEnabled.size === 0 || toolsEnabled.has(tool.name)).map((tool) => ({
              type: "function",
              function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
            }))
          : undefined;
        const anthropicTools = includeTools
          ? MCP_TOOLS.filter((tool) => toolsEnabled.size === 0 || toolsEnabled.has(tool.name)).map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema,
            }))
          : undefined;

        const stream = input.stream !== false && input.stream !== 0;
        const maxTokens = num(input.max_tokens, "max_tokens", model.max_tokens ?? 512, 1, 32768);
        const temperature = num(input.temperature, "temperature", model.temperature ?? 0.7, 0, 2);
        const pathPart = protocol === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
        const payload: Record<string, unknown> =
          protocol === "anthropic"
            ? {
                model: alias,
                max_tokens: maxTokens,
                temperature,
                messages: messages.filter((message) => message.role !== "system"),
                ...(systemText ? { system: systemText } : {}),
                ...(anthropicTools ? { tools: anthropicTools } : {}),
                ...(stream ? { stream: true } : {}),
              }
            : {
                model: alias,
                max_tokens: maxTokens,
                temperature,
                messages: [
                  ...(systemText && !messages.some((message) => message.role === "system")
                    ? [{ role: "system", content: systemText }]
                    : []),
                  ...messages,
                ],
                ...(openaiTools ? { tools: openaiTools } : {}),
                ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
              };

        const started = Date.now();
        const baseLog = {
          model_id: model.id,
          model_key: alias,
          provider_id: model.provider_id,
          transport_id: endpoint.id,
          protocol: protocol as "openai" | "anthropic",
          endpoint: pathPart,
          method: "POST",
          stream: stream ? 1 : 0,
          system_prompt_id: systemText ? prompt?.id ?? null : null,
        };

        if (!stream) {
          const result = await request(endpoint, pathPart, {
            timeoutMs: 600_000,
            body: payload,
            headers: engineHeaders(cfg),
            allowSelfSigned: process.env.LAMA_TLS_INSECURE === "1",
          });
          let parsed: Record<string, unknown> | null = null;
          try {
            parsed = result.text ? (JSON.parse(result.text) as Record<string, unknown>) : null;
          } catch {
            parsed = null;
          }
          const usage = parsed ? usageOf(parsed.usage) : null;
          const firstChoice = (parsed?.choices as Array<{ message?: { content?: unknown; reasoning_content?: unknown } }> | undefined)?.[0];
          const content =
            protocol === "anthropic"
              ? (Array.isArray(parsed?.content) ? (parsed.content as Array<{ type?: string; text?: string }>) : [])
                  .filter((block) => block.type === "text" && typeof block.text === "string")
                  .map((block) => block.text)
                  .join("")
              : typeof firstChoice?.message?.content === "string"
                ? firstChoice.message.content
                : "";
          const reasoning =
            typeof firstChoice?.message?.reasoning_content === "string" ? firstChoice.message.reasoning_content : "";
          const toolCalls =
            protocol === "anthropic"
              ? (Array.isArray(parsed?.content) ? (parsed.content as Array<Record<string, unknown>>) : []).filter(
                  (block) => block.type === "tool_use",
                )
              : ((parsed?.choices as Array<{ message?: { tool_calls?: unknown } }> | undefined)?.[0]?.message?.tool_calls ?? []);
          recordRequest({
            ...baseLog,
            status: result.status,
            ok: result.status >= 200 && result.status < 300 ? 1 : 0,
            duration_ms: Date.now() - started,
            first_token_ms: null,
            prompt_tokens: usage?.prompt ?? null,
            completion_tokens: usage?.completion ?? null,
            bytes: Buffer.byteLength(result.text),
            detail: result.status >= 400 ? result.text.slice(0, 300) : "",
          });
          json(res, 200, {
            ok: result.status >= 200 && result.status < 300,
            status: result.status,
            protocol,
            transport: endpoint.id,
            model: alias,
            duration_ms: Date.now() - started,
            content,
            reasoning,
            tool_calls: toolCalls,
            usage: parsed?.usage ?? null,
            raw: parsed,
          });
          return;
        }

        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          ...IDENTITY_HEADERS,
        });
        res.flushHeaders();
        let closed = false;
        res.on("close", () => {
          closed = !res.writableEnded;
        });

        let upstream: http.IncomingMessage;
        try {
          upstream = await openStream(endpoint, pathPart, {
            timeoutMs: 600_000,
            body: payload,
            headers: engineHeaders(cfg),
            allowSelfSigned: process.env.LAMA_TLS_INSECURE === "1",
          });
        } catch (error) {
          sse(res, "error", { message: (error as Error).message });
          res.end();
          recordRequest({
            ...baseLog,
            status: 0,
            ok: 0,
            duration_ms: Date.now() - started,
            first_token_ms: null,
            prompt_tokens: null,
            completion_tokens: null,
            bytes: 0,
            detail: (error as Error).message,
          });
          return;
        }

        const status = upstream.statusCode ?? 502;
        sse(res, "start", { status, protocol, transport: endpoint.id, model: alias });
        if (status !== 200) {
          let detail = "";
          for await (const chunk of upstream) detail += String(chunk);
          sse(res, "error", { status, message: detail.slice(0, 800) || `engine HTTP ${status}` });
          res.end();
          recordRequest({
            ...baseLog,
            status,
            ok: 0,
            duration_ms: Date.now() - started,
            first_token_ms: null,
            prompt_tokens: null,
            completion_tokens: null,
            bytes: Buffer.byteLength(detail),
            detail: detail.slice(0, 500),
          });
          return;
        }

        let buffer = "";
        let firstToken: number | null = null;
        let bytes = 0;
        let captured = "";
        let usage: { prompt: number | null; completion: number | null } = { prompt: null, completion: null };
        const toolCalls: unknown[] = [];

        const handle = (block: string): void => {
          for (const line of block.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(":")) continue;
            const data = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
            if (!data || data === "[DONE]") continue;
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(data) as Record<string, unknown>;
            } catch {
              continue;
            }
            const found = usageOf(parsed.usage) ?? usageOf((parsed.message as { usage?: unknown } | undefined)?.usage);
            if (found) usage = { prompt: found.prompt ?? usage.prompt, completion: found.completion ?? usage.completion };
            const content = deltaText(parsed);
            if (content) {
              if (firstToken === null) firstToken = Date.now() - started;
              sse(res, "delta", { text: content });
            }
            const reasoning = deltaReasoning(parsed);
            if (reasoning) {
              if (firstToken === null) firstToken = Date.now() - started;
              sse(res, "reasoning", { text: reasoning });
            }
            const delta = parsed.delta as { type?: string; text?: string } | undefined;
            if (delta?.type === "input_json_delta") continue;
            const contentBlock = parsed.content_block as { type?: string; name?: string } | undefined;
            if (contentBlock?.type === "tool_use") {
              toolCalls.push(parsed.content_block);
              sse(res, "tool", parsed.content_block ?? {});
            }
            const choice = (parsed.choices as Array<{ delta?: { tool_calls?: unknown } }> | undefined)?.[0];
            if (choice?.delta?.tool_calls) {
              toolCalls.push(choice.delta.tool_calls);
              sse(res, "tool", choice.delta.tool_calls);
            }
          }
        };

        try {
          for await (const chunk of upstream) {
            if (closed) break;
            const piece = String(chunk);
            bytes += Buffer.byteLength(piece);
            if (captured.length < 512 * 1024) captured += piece;
            buffer += piece;
            let index = buffer.indexOf("\n\n");
            while (index >= 0) {
              const block = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              handle(block);
              index = buffer.indexOf("\n\n");
            }
          }
          if (buffer.trim()) handle(buffer);
          if (closed) {
            recordRequest({
              ...baseLog,
              status: 0,
              ok: 0,
              duration_ms: Date.now() - started,
              first_token_ms: firstToken,
              prompt_tokens: usage.prompt,
              completion_tokens: usage.completion,
              bytes,
              detail: "client aborted the stream",
            });
            return;
          }
          const scanned = scanUsage(captured);
          usage = { prompt: usage.prompt ?? scanned.prompt, completion: usage.completion ?? scanned.completion };
          const done = {
            status,
            duration_ms: Date.now() - started,
            first_token_ms: firstToken,
            prompt_tokens: usage.prompt,
            completion_tokens: usage.completion,
            bytes,
            tool_calls: toolCalls.length,
          };
          sse(res, "usage", usage);
          sse(res, "done", done);
          res.end();
          recordRequest({
            ...baseLog,
            status,
            ok: 1,
            duration_ms: done.duration_ms,
            first_token_ms: firstToken,
            prompt_tokens: usage.prompt,
            completion_tokens: usage.completion,
            bytes,
            detail: "",
          });
        } catch (error) {
          if (!closed) {
            sse(res, "error", { message: (error as Error).message });
            res.end();
          }
          recordRequest({
            ...baseLog,
            status: 0,
            ok: 0,
            duration_ms: Date.now() - started,
            first_token_ms: firstToken,
            prompt_tokens: usage.prompt,
            completion_tokens: usage.completion,
            bytes,
            detail: (error as Error).message,
          });
        }
        return;
      }

      // ---------- requests ----------
      if (method === "GET" && pathname === "/api/requests") {
        json(
          res,
          200,
          store.listRequests({
            limit: Number(url.searchParams.get("limit") ?? 100),
            model_id: url.searchParams.get("model_id"),
            transport_id: url.searchParams.get("transport_id"),
            protocol: url.searchParams.get("protocol"),
            ok: url.searchParams.get("ok") === null ? null : url.searchParams.get("ok") === "1",
          }),
        );
        return;
      }

      if (method === "GET" && pathname === "/api/requests/stats") {
        json(res, 200, store.requestStats(Number(url.searchParams.get("hours") ?? 24)));
        return;
      }

      // ---------- system prompt ----------
      if (method === "GET" && pathname === "/api/system-prompt") {
        const prompt = store.getPrompt("system") ?? store.defaultPrompt();
        json(res, 200, {
          ...promptMeta(prompt, cfg),
          content: prompt?.content ?? "",
          usage: PROMPT_USAGE,
          file_content: readPromptFile(cfg)?.content ?? null,
        });
        return;
      }

      if (method === "PUT" && pathname === "/api/system-prompt") {
        const input = await body(req);
        const content = str(input.content, "content", 100_000);
        const saved = saveSystemPrompt(store, content);
        store.audit("prompt.save", saved.id, `v${saved.version}`, "admin");
        json(res, 200, { ...promptMeta(saved, cfg), content: saved.content, usage: PROMPT_USAGE });
        return;
      }

      if (method === "POST" && pathname === "/api/system-prompt/reset") {
        const reset = resetSystemPrompt(store, cfg);
        store.audit("prompt.reset", "system", reset.action, "admin");
        json(res, 200, { ...promptMeta(reset.prompt, cfg), content: reset.prompt?.content ?? "", usage: PROMPT_USAGE });
        return;
      }

      if (method === "GET" && pathname === "/api/system-prompt.txt") {
        const prompt = store.getPrompt("system") ?? store.defaultPrompt();
        text(res, 200, `${prompt?.content ?? ""}\n`, "text/markdown; charset=utf-8");
        return;
      }

      if (method === "GET" && pathname === "/api/prompt") {
        const prompt = store.getPrompt("system") ?? store.defaultPrompt();
        json(res, 200, { content: prompt?.content ?? "", meta: promptMeta(prompt, cfg) });
        return;
      }

      if (method === "POST" && pathname === "/api/prompts") {
        const input = await body(req);
        const name = str(input.name, "name", 64);
        const content = str(input.content, "content", 100_000);
        store.upsertPrompt({
          id: slug(name),
          name,
          content,
          version: 1,
          is_default: input.is_default === true ? 1 : 0,
          metadata_json: JSON.stringify(input.metadata && typeof input.metadata === "object" ? input.metadata : {}),
        });
        store.audit("prompt.upsert", name, "", "admin");
        json(res, 200, store.getPrompt(slug(name)));
        return;
      }

      // ---------- MCP ----------
      if (method === "POST" && pathname === "/api/mcp") {
        const input = await body(req);
        const name = str(input.name, "name", 64);
        const transport = str(input.transport, "transport", 20) as McpTransport;
        if (!MCP_TRANSPORTS.has(transport)) throw new Error("transport must be stdio, http or sse");
        const command = transport === "stdio" ? str(input.command, "command", 2000) : null;
        const urlValue = transport === "stdio" ? null : str(input.url, "url", 4000);
        const args = input.args === undefined ? [] : input.args;
        if (!Array.isArray(args)) throw new Error("args must be an array");
        const env = input.env === undefined ? {} : input.env;
        if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("env must be an object");
        store.upsertMcp({
          id: slug(name),
          name,
          transport,
          command,
          args_json: JSON.stringify(args.map(String)),
          env_json: JSON.stringify(env),
          cwd: typeof input.cwd === "string" ? input.cwd : null,
          url: urlValue,
          api_key_ref: typeof input.api_key_ref === "string" ? input.api_key_ref : null,
          timeout_ms: num(input.timeout_ms, "timeout_ms", 30000, 1000, 600000),
          enabled: input.enabled === false ? 0 : 1,
          metadata_json: JSON.stringify(input.metadata && typeof input.metadata === "object" ? input.metadata : {}),
        });
        const sync = writeEngineMcpConfig(store, cfg);
        store.audit("mcp.upsert", name, `transport=${transport} synced=${sync.count}`, "admin");
        json(res, 200, { row: mcpSummary(store.getMcp(slug(name))!), sync });
        return;
      }

      const mcpDelete = /^\/api\/mcp\/([^/]+)$/.exec(pathname);
      if (method === "DELETE" && mcpDelete?.[1]) {
        store.deleteMcp(mcpDelete[1]);
        writeEngineMcpConfig(store, cfg);
        store.audit("mcp.delete", mcpDelete[1], "", "admin");
        json(res, 200, { ok: true });
        return;
      }

      const mcpProbe = /^\/api\/mcp\/([^/]+)\/probe$/.exec(pathname);
      if (method === "POST" && mcpProbe?.[1]) {
        const row = store.getMcp(mcpProbe[1]);
        if (!row) throw new Error("mcp server not found");
        const result = await probeStdio(row);
        store.setMcpProbe(row.id, result.ok, result.detail, result.tools);
        store.audit("mcp.probe", row.name, result.detail, "admin");
        const summary = mcpSummary(store.getMcp(row.id)!);
        hub.broadcast("mcp", summary);
        json(res, 200, { ...result, row: summary });
        return;
      }

      const mcpToggle = /^\/api\/mcp\/([^/]+)\/toggle$/.exec(pathname);
      if (method === "POST" && mcpToggle?.[1]) {
        const row = store.getMcp(mcpToggle[1]);
        if (!row) throw new Error("mcp server not found");
        const input = await body(req);
        const enabled = typeof input.enabled === "boolean" ? input.enabled : !row.enabled;
        store.upsertMcp({
          ...row,
          enabled: enabled ? 1 : 0,
        });
        const sync = writeEngineMcpConfig(store, cfg);
        store.audit("mcp.toggle", row.name, enabled ? "enabled" : "disabled", "admin");
        const summary = mcpSummary(store.getMcp(row.id)!);
        hub.broadcast("mcp", summary);
        json(res, 200, { row: summary, sync });
        return;
      }

      if (method === "POST" && pathname === "/api/mcp/sync") {
        const sync = writeEngineMcpConfig(store, cfg);
        store.audit("mcp.sync", "", `${sync.count} stdio servers`, "admin");
        json(res, 200, sync);
        return;
      }

      if (method === "GET" && pathname === "/api/mcp/config") {
        const config = engineMcpConfig(store);
        const servers = config.mcpServers as Record<string, { command?: string; args?: string[] }>;
        json(res, 200, {
          path: path.join(cfg.dataDir, "mcp-servers.generated.json"),
          servers: Object.fromEntries(
            Object.entries(servers).map(([name, value]) => [name, { command: value.command, args: value.args ?? [] }]),
          ),
        });
        return;
      }

      if (method === "GET" && pathname === "/api/mcp/matrix") {
        const usage = new Map(store.toolUsageStats().map((row) => [row.tool, row]));
        json(res, 200, {
          servers: store.listMcp().map(mcpSummary),
          tools: store.listMcpTools().map((tool) => {
            const server = store.getMcp(tool.mcp_id);
            const stats = usage.get(tool.name);
            return {
              ...tool,
              enabled: Boolean(tool.enabled),
              server: server ? server.name : tool.mcp_id,
              active: Boolean(server?.enabled) && server?.status === "active",
              calls: stats?.calls ?? 0,
              ok: stats?.ok ?? 0,
              failed: stats?.failed ?? 0,
              last_at: stats?.last_at ?? null,
              use_cases: tool.use_cases || TOOL_USE_CASES[tool.name] || "",
            };
          }),
        });
        return;
      }

      const mcpToolToggle = /^\/api\/mcp\/tools\/([^/]+)\/toggle$/.exec(pathname);
      if (method === "POST" && mcpToolToggle?.[1]) {
        const name = mcpToolToggle[1];
        const row = store.listMcpTools().find((tool) => tool.name === name);
        if (!row) throw new Error("mcp tool not found");
        const input = await body(req);
        const enabled = typeof input.enabled === "boolean" ? input.enabled : !row.enabled;
        store.toggleMcpTool(name, enabled);
        store.audit("mcp.tool.toggle", name, enabled ? "enabled" : "disabled", "admin");
        json(res, 200, { tool: name, enabled });
        return;
      }

      // ---------- transports + docs ----------
      if (method === "POST" && pathname === "/api/transports") {
        const input = await body(req);
        const protocol = str(input.protocol, "protocol", 10) as EngineTransport;
        if (!PROTOCOLS.has(protocol)) throw new Error("protocol must be http, https or uds");
        const name = str(input.name, "name", 100);
        const id = slug(typeof input.id === "string" ? input.id : name);
        store.upsertTransport({
          id,
          name,
          protocol,
          host: protocol === "uds" ? null : str(input.host ?? "127.0.0.1", "host", 200),
          port: protocol === "uds" ? null : num(input.port, "port", cfg.enginePort, 1, 65535),
          socket_path: protocol === "uds" ? str(input.socket_path, "socket_path", 4000) : null,
          tls_key: typeof input.tls_key === "string" ? input.tls_key : null,
          tls_cert: typeof input.tls_cert === "string" ? input.tls_cert : null,
          gateway_hint: typeof input.gateway_hint === "string" ? input.gateway_hint : "",
          metadata_json: JSON.stringify(input.metadata && typeof input.metadata === "object" ? input.metadata : {}),
        });
        store.audit("transport.upsert", id, protocol, "admin");
        json(res, 200, store.getTransport(id));
        return;
      }

      const link = /^\/api\/transports\/([^/]+)\/link-socket$/.exec(pathname);
      if (method === "POST" && link?.[1]) {
        const transport = store.getTransport(link[1]);
        if (!transport) throw new Error("transport not found");
        if (transport.protocol !== "uds" || !transport.socket_path) throw new Error("only UDS transports can be linked");
        const result = linkSocket(transport.socket_path, cfg.gatewayDir);
        store.audit("transport.link_socket", transport.id, result.target, "admin");
        json(res, 200, result);
        return;
      }

      const integrationRoute = /^\/api\/docs\/integration(\.md)?$/.exec(pathname);
      if (method === "GET" && integrationRoute) {
        const docs = buildIntegrationDocs(store, cfg, activeAlias(store));
        if (integrationRoute[1]) return text(res, 200, integrationToMarkdown(docs), "text/markdown; charset=utf-8");
        json(res, 200, docs);
        return;
      }

      const docsRoute = /^\/api\/transports\/([^/]+)\/docs(\.txt)?$/.exec(pathname);
      if (method === "GET" && docsRoute?.[1]) {
        const transport = store.getTransport(docsRoute[1]);
        if (!transport) throw new Error("transport not found");
        const docs = buildTransportDocs(store, cfg, transport, activeAlias(store));
        if (docsRoute[2]) return text(res, 200, docsToMarkdown(docs), "text/markdown; charset=utf-8");
        json(res, 200, docs);
        return;
      }

      const transportDetail = /^\/api\/transports\/([^/]+)$/.exec(pathname);
      if (method === "GET" && transportDetail?.[1]) {
        const transport = store.getTransport(transportDetail[1]);
        if (!transport) throw new Error("transport not found");
        const requests = store.listRequests({ transport_id: transport.id, limit: 100 });
        const totals = requests.reduce(
          (acc, row) => ({
            total: acc.total + 1,
            ok: acc.ok + (row.ok ? 1 : 0),
            failed: acc.failed + (row.ok ? 0 : 1),
            avg_ms: acc.avg_ms + row.duration_ms,
          }),
          { total: 0, ok: 0, failed: 0, avg_ms: 0 },
        );
        json(res, 200, {
          transport,
          documents: store.listDocuments().filter((doc) => doc.transport_id === transport.id),
          requests,
          stats: {
            total: totals.total,
            ok: totals.ok,
            failed: totals.failed,
            avg_ms: totals.total ? Math.round(totals.avg_ms / totals.total) : 0,
          },
        });
        return;
      }

      if (method === "POST" && pathname === "/api/documents") {
        const input = await body(req);
        const slugValue = slug(str(input.slug ?? input.title, "slug", 120));
        const title = str(input.title, "title", 200);
        const bodyText = str(input.body, "body", 100000);
        const transportId = typeof input.transport_id === "string" ? input.transport_id : null;
        if (transportId && !store.getTransport(transportId)) throw new Error("unknown transport_id");
        store.upsertDocument({
          id: slugValue,
          slug: slugValue,
          title,
          transport_id: transportId,
          body: bodyText,
          verified_at: null,
          metadata_json: JSON.stringify(input.metadata && typeof input.metadata === "object" ? input.metadata : {}),
        });
        store.audit("document.upsert", slugValue, "", "admin");
        json(res, 200, store.getDocumentBySlug(slugValue));
        return;
      }

      const verify = /^\/api\/documents\/([^/]+)\/verify$/.exec(pathname);
      if (method === "POST" && verify?.[1]) {
        const id = verify[1];
        const result = await probeDocument(ctx, id);
        if (result.ok) store.markDocumentVerified(id, result.detail);
        else store.audit("document.verify_failed", id, result.detail, "admin");
        json(res, result.ok ? 200 : 502, result);
        return;
      }

      if (method === "POST" && pathname === "/api/transports/probe") {
        const input = await body(req);
        const transport = store.getTransport(str(input.id, "id", 100));
        if (!transport) throw new Error("transport not found");
        const model = store.listModels().find((item) => item.enabled) ?? store.listModels()[0];
        if (!model) throw new Error("no model row to probe with");
        json(res, 200, await probeTransport(transport, model.model_id, cfg.engineApiKey));
        return;
      }

      if (method === "POST" && pathname === "/api/service/mode") {
        const input = await body(req);
        const mode = str(input.mode, "mode", 10);
        if (!["none", "user", "system"].includes(mode)) throw new Error("mode must be none, user or system");
        store.setSetting("service_mode", mode);
        store.audit("service.mode", mode, "", "admin");
        json(res, 200, { mode });
        return;
      }

      if (method === "GET" && pathname === "/api/audit") {
        json(res, 200, store.listAudit(Number(url.searchParams.get("limit") ?? 100)));
        return;
      }

      // Tool fallback: native tool_calls first, then markers, then JSON blocks.
      // Parsing never executes anything; execution is a separate, audited call.
      if (method === "GET" && pathname === "/api/tools") {
        const stats = new Map(store.toolUsageStats().map((row) => [row.tool, row]));
        const switches = new Map(store.listMcpTools().map((row) => [row.name, row.enabled]));
        json(res, 200, {
          tools: MCP_TOOLS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            enabled: switches.get(tool.name) === undefined ? true : Boolean(switches.get(tool.name)),
            calls: stats.get(tool.name)?.calls ?? 0,
            last_at: stats.get(tool.name)?.last_at ?? null,
          })),
          stages: ["native", "marker", "json"],
        });
        return;
      }

      if (method === "POST" && pathname === "/api/tools/parse") {
        const input = await body(req);
        const parseText = typeof input.text === "string" ? input.text : "";
        if (parseText.length > 200_000) throw new Error("text exceeds 200000 chars");
        const native = input.native;
        const result = parseToolCalls(parseText, MCP_TOOLS.map((tool) => tool.name), native);
        store.audit("tools.parse", `${result.calls.length} call(s)`, `${result.rejected.length} rejected`, "admin");
        json(res, 200, result);
        return;
      }

      if (method === "POST" && pathname === "/api/tools/call") {
        const input = await body(req);
        const name = str(input.name, "name", 64);
        if (!MCP_TOOLS.some((tool) => tool.name === name)) throw new Error(`unknown tool ${name}`);
        const args =
          input.arguments && typeof input.arguments === "object" && !Array.isArray(input.arguments)
            ? (input.arguments as Record<string, unknown>)
            : {};
        const started = Date.now();
        try {
          const result = await callTool(name, args);
          const usage = store.logToolUsage({
            tool: name,
            mcp_id: toolServer(name),
            ok: true,
            duration_ms: Date.now() - started,
            detail: Object.keys(args).join(","),
          });
          hub.broadcast("tool", usage);
          store.audit("tools.call", name, Object.keys(args).join(","), "admin");
          json(res, 200, { name, result, duration_ms: usage.duration_ms });
        } catch (error) {
          const usage = store.logToolUsage({
            tool: name,
            mcp_id: toolServer(name),
            ok: false,
            duration_ms: Date.now() - started,
            detail: (error as Error).message,
          });
          hub.broadcast("tool", usage);
          store.audit("tools.call_failed", name, (error as Error).message, "admin");
          throw error;
        }
        return;
      }

      fail(res, 404, `no route for ${method} ${pathname}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /not found/i.test(message) ? 404 : /required|must|invalid|exceeds|\b(refused|refusing)\b|unknown|cross-origin/i.test(message) ? 400 : 500;
      fail(res, status, message);
    }
  });

  server.on("close", () => {
    clearInterval(metricsTimer);
    hub.stop();
    store.setAuditListener(null);
    engine.setProgressListener(null);
  });

  return server;
}
