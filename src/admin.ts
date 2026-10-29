import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import type { EngineManager } from "./engine.ts";
import type { EngineTransport, LoadMode, McpTransport, OsInfo, TransportRow } from "./types.ts";
import { linkSocket, probeTransport, request } from "./transport.ts";
import { engineMcpConfig, mcpSummary, writeEngineMcpConfig } from "./mcp/config.ts";
import { probeStdio } from "./mcp/probe.ts";
import { MCP_TOOLS, callTool } from "./mcp/tools.ts";
import { parseToolCalls } from "./tools/parser.ts";
import { identityHeaders, loadIdentity } from "./identity.ts";

interface Context {
  store: Store;
  cfg: Config;
  os: OsInfo;
  engine: EngineManager;
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

function fail(res: http.ServerResponse, status: number, message: string): void {
  json(res, status, { error: message });
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
    if (size > 1024 * 1024) throw new Error("request body exceeds 1 MiB");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  const parsed: unknown = JSON.parse(text);
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

  const proxyToEngine = (req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): void => {
    const target = new URL(cfg.engineUrl);
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers.host;
    if (cfg.engineApiKey) headers.authorization = `Bearer ${cfg.engineApiKey}`;
    else delete headers.authorization;
    const client = target.protocol === "https:" ? https : http;
    const upstream = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: urlPath,
        method: req.method,
        headers,
        rejectUnauthorized: process.env.LAMA_TLS_INSECURE !== "1",
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, { ...upstreamRes.headers, ...IDENTITY_HEADERS });
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", (error: Error) => {
      if (!res.headersSent) json(res, 502, { error: `engine unreachable: ${error.message}` });
      else res.destroy();
    });
    req.on("aborted", () => upstream.destroy());
    req.pipe(upstream);
  };

  return http.createServer(async (req, res) => {
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
        proxyToEngine(req, res, `${pathname}${url.search}`);
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

      if (method === "GET" && pathname === "/api/state") {
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
            tls: { key: cfg.tlsKey, cert: cfg.tlsCert, enabled: process.env.LAMA_TLS === "1" },
            service_mode: store.setting("service_mode") ?? cfg.serviceMode,
            gateway_dir: cfg.gatewayDir,
          },
          engine: await engine.status(),
          identity,
          providers: store.listProviders(),
          models: store.listModels(),
          mcp: store.listMcp().map(mcpSummary),
          transports: store.listTransports(),
          documents: store.listDocuments(),
          prompts: store.listPrompts(),
          sessions: store.listSessions(),
          audit: store.listAudit(50),
          warnings: cfg.warnings,
        });
        return;
      }

      if (method === "GET" && pathname === "/api/engine/status") {
        json(res, 200, await engine.status());
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

      if (method === "POST" && pathname === "/api/models") {
        const input = await body(req);
        const name = str(input.name, "name", 200);
        const id = slug(typeof input.id === "string" && input.id.trim() ? input.id : name);
        const modelPath = str(input.path, "path", 4000);
        if (!path.isAbsolute(modelPath) || !fs.existsSync(modelPath)) throw new Error("path must be an existing absolute file");
        if (!modelPath.toLowerCase().endsWith(".gguf")) throw new Error("path must point to a .gguf file");
        store.upsertModel({
          id,
          provider_id: "llamacpp",
          name,
          model_id: str(input.model_id ?? id, "model_id", 200),
          path: modelPath,
          context: num(input.context, "context", 4096, 256, 1_048_576),
          max_tokens: num(input.max_tokens, "max_tokens", 1024, 1, 1_048_576),
          temperature: num(input.temperature, "temperature", 0.7, 0, 2),
          quant: typeof input.quant === "string" ? input.quant : null,
          load_mode: (typeof input.load_mode === "string" && LOAD_MODES.has(input.load_mode as LoadMode) ? input.load_mode : "auto") as LoadMode,
          ttl_hours: input.ttl_hours === undefined || input.ttl_hours === "" ? cfg.defaultTtlHours : num(input.ttl_hours, "ttl_hours", cfg.defaultTtlHours, 0, 720),
          enabled: input.enabled === false ? 0 : 1,
          metadata_json: JSON.stringify(input.metadata && typeof input.metadata === "object" ? input.metadata : {}),
        });
        store.audit("model.upsert", id, modelPath, "admin");
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
        store.audit("mcp.probe", row.name, result.detail, "admin");
        json(res, 200, result);
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

      if (method === "POST" && pathname === "/api/prompts") {
        const input = await body(req);
        const name = str(input.name, "name", 64);
        const content = str(input.content, "content", 20000);
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
        json(res, 200, await probeTransport(transport, model.model_id, process.env.LAMA_ENGINE_API_KEY ?? ""));
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
        json(res, 200, {
          tools: MCP_TOOLS.map((tool) => ({ name: tool.name, description: tool.description })),
          stages: ["native", "marker", "json"],
        });
        return;
      }

      if (method === "POST" && pathname === "/api/tools/parse") {
        const input = await body(req);
        const text = typeof input.text === "string" ? input.text : "";
        if (text.length > 200_000) throw new Error("text exceeds 200000 chars");
        const native = input.native;
        const result = parseToolCalls(text, MCP_TOOLS.map((tool) => tool.name), native);
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
        const result = await callTool(name, args);
        store.audit("tools.call", name, Object.keys(args).join(","), "admin");
        json(res, 200, { name, result });
        return;
      }

      fail(res, 404, `no route for ${method} ${pathname}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /not found/i.test(message) ? 404 : /required|must|invalid|exceeds|\b(refused|refusing)\b|unknown|cross-origin/i.test(message) ? 400 : 500;
      fail(res, status, message);
    }
  });
}
