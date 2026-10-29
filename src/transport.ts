import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import type { DocumentRow, EngineTransport, TransportRow } from "./types.ts";

export interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  allowSelfSigned?: boolean;
}

function payload(body: unknown): Buffer | null {
  if (body === undefined) return null;
  return Buffer.from(JSON.stringify(body));
}

export function requestHttp(url: string, options: RequestOptions = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = payload(options.body);
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(options.headers ?? {}),
    };
    if (body) {
      headers["content-type"] = headers["content-type"] ?? "application/json";
      headers["content-length"] = String(body.length);
    }
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: options.method ?? (body ? "POST" : "GET"),
        headers,
        rejectUnauthorized: parsed.protocol === "https:" ? !(options.allowSelfSigned ?? false) : undefined,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
          if (text.length > 4 * 1024 * 1024) req.destroy(new Error("response too large"));
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    req.setTimeout(options.timeoutMs ?? 15_000, () => req.destroy(new Error(`timeout after ${options.timeoutMs ?? 15_000}ms`)));
    req.end(body ?? undefined);
  });
}

export function requestUds(socketPath: string, urlPath: string, options: RequestOptions = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const body = payload(options.body);
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(options.headers ?? {}),
    };
    if (body) {
      headers["content-type"] = headers["content-type"] ?? "application/json";
      headers["content-length"] = String(body.length);
    }
    const req = http.request(
      {
        socketPath,
        path: urlPath,
        method: options.method ?? (body ? "POST" : "GET"),
        headers,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
          if (text.length > 4 * 1024 * 1024) req.destroy(new Error("response too large"));
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    req.setTimeout(options.timeoutMs ?? 15_000, () => req.destroy(new Error(`timeout after ${options.timeoutMs ?? 15_000}ms`)));
    req.end(body ?? undefined);
  });
}

export async function request(
  transport: Pick<TransportRow, "protocol" | "host" | "port" | "socket_path">,
  urlPath: string,
  options: RequestOptions = {},
): Promise<HttpResult> {
  if (transport.protocol === "uds") {
    if (!transport.socket_path) throw new Error("UDS transport has no socket_path");
    return requestUds(transport.socket_path, urlPath, options);
  }
  const host = transport.host || "127.0.0.1";
  const port = transport.port || 9931;
  const scheme = transport.protocol;
  return requestHttp(`${scheme}://${host}:${port}${urlPath}`, options);
}

export function linkSocket(source: string, gatewayDir: string): { target: string; changed: boolean } {
  const stat = fs.statSync(source);
  if (!stat.isSocket()) throw new Error(`${source} is not a socket`);
  fs.mkdirSync(gatewayDir, { recursive: true, mode: 0o700 });
  const target = path.join(gatewayDir, "llama.sock");
  try {
    const existing = fs.lstatSync(target);
    if (existing.isSymbolicLink()) {
      const resolved = path.resolve(gatewayDir, fs.readlinkSync(target));
      if (resolved === path.resolve(source)) return { target, changed: false };
      throw new Error(`${target} already points to ${resolved}; remove it explicitly before relinking`);
    }
    throw new Error(`${target} exists and is not a symlink; remove it explicitly before relinking`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  fs.symlinkSync(source, target, "file");
  return { target, changed: true };
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
  status: number | null;
}

export async function probeTransport(transport: TransportRow, modelId: string, apiKey = ""): Promise<ProbeResult> {
  const auth = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  try {
    const health = await request(transport, "/health", { timeoutMs: 5000, headers: auth });
    if (health.status !== 200) return { ok: false, detail: `health HTTP ${health.status}`, status: health.status };
    const props = await request(transport, "/props", { timeoutMs: 5000, headers: auth });
    if (props.status !== 200) return { ok: false, detail: `props HTTP ${props.status}`, status: props.status };
    const models = await request(transport, "/v1/models", { timeoutMs: 5000, headers: auth });
    if (models.status !== 200) return { ok: false, detail: `models HTTP ${models.status}`, status: models.status };
    const body = {
      model: modelId,
      max_tokens: 8,
      temperature: 0,
      messages: [{ role: "user", content: "Reply with ok." }],
    };
    const chat = await request(transport, "/v1/chat/completions", {
      timeoutMs: 60_000,
      headers: auth,
      body,
    });
    if (chat.status !== 200) return { ok: false, detail: `chat HTTP ${chat.status}: ${chat.text.slice(0, 200)}`, status: chat.status };
    const parsed = JSON.parse(chat.text) as { choices?: Array<{ message?: { content?: string } }> };
    if (!parsed.choices?.[0]?.message) return { ok: false, detail: "chat response has no choices[0].message", status: chat.status };
    return { ok: true, detail: `health 200, props 200, models 200, chat 200`, status: 200 };
  } catch (error) {
    return { ok: false, detail: (error as Error).message, status: null };
  }
}

export function protocolLabel(protocol: EngineTransport): string {
  return protocol === "uds" ? "UDS" : protocol.toUpperCase();
}

export function documentTransport(store: { getTransport: (id: string) => TransportRow | undefined }, doc: DocumentRow): TransportRow | undefined {
  return doc.transport_id ? store.getTransport(doc.transport_id) : undefined;
}
