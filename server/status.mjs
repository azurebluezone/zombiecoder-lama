#!/usr/bin/env node
/**
 * lama status file — read-only polling endpoint.
 *
 * Why this exists: the admin app is optional. When only the server runs, a
 * browser or a socket still needs a cheap way to ask "is it alive, which model,
 * how busy". This file answers that and nothing else:
 *
 *   - no admin imports, no SQLite, no engine spawn, no tool calls, no writes
 *   - JSON by default; the HTML page is hidden behind LAMA_STATUS_HTML=1
 *   - listens on TCP (127.0.0.1:9935) and optionally on a Unix socket
 *   - /healthz stays open for supervisors; other routes honour LAMA_STATUS_TOKEN
 *
 * Routes
 *   GET /healthz      "ok" (200) or "down" (503), always open
 *   GET /status.json  full snapshot
 *   GET /metrics      Prometheus-style key/value lines
 *   GET /             JSON snapshot; HTML only when LAMA_STATUS_HTML=1
 *
 * Usage
 *   node server/status.mjs
 *   LAMA_STATUS_PORT=0 node server/status.mjs        # ephemeral port, printed
 *   LAMA_STATUS_UDS=/run/user/1000/lama-status.sock node server/status.mjs
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LAMA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- env ---------------------------------------------------------------------
const fileEnv = {};
const ENV_FILE = process.env.LAMA_ENV_FILE || path.join(LAMA, ".env");
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) fileEnv[match[1]] = match[2];
  }
}
const env = (key) => (Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : (fileEnv[key] ?? ""));

const cfg = {
  host: env("LAMA_STATUS_HOST") || "127.0.0.1",
  port: Number(env("LAMA_STATUS_PORT") || 9935),
  uds: env("LAMA_STATUS_UDS") || "",
  token: env("LAMA_STATUS_TOKEN") || "",
  html: /^(1|true|yes|on)$/i.test(env("LAMA_STATUS_HTML") || ""),
  engineHost: env("LAMA_LLAMA_HOST") || "127.0.0.1",
  enginePort: Number(env("LAMA_LLAMA_PORT") || 9931),
  engineUds: env("LAMA_UDS_SOCK") || path.join(os.tmpdir(), `llama-${process.getuid?.() ?? 0}`, "llama.sock"),
  mgmtPort: Number(env("LAMA_MGMT_PORT") || 9934),
  modelsDir: env("LAMA_MODELS_DIR") || path.join(LAMA, "models"),
  apiKey: env("LAMA_API_KEY") || "",
};

const T0 = Date.now();

// ---- probes ------------------------------------------------------------------
function httpGet(options, bodyPath) {
  return new Promise((resolve) => {
    const req = http.request({ ...options, path: bodyPath, method: "GET", timeout: 800 }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (text.length < 65536) text += chunk;
      });
      res.on("end", () => resolve({ ok: true, status: res.statusCode ?? 0, text }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolve({ ok: false, status: 0, text: error.message }));
    req.end();
  });
}

async function engineProbe() {
  const viaUds = fs.existsSync(cfg.engineUds);
  const base = viaUds ? { socketPath: cfg.engineUds } : { host: cfg.engineHost, port: cfg.enginePort };
  const health = await httpGet(base, "/health");
  const props = health.ok ? await httpGet(base, "/props") : { ok: false, status: 0, text: "" };
  let model = null;
  if (props.ok) {
    try {
      const parsed = JSON.parse(props.text);
      model = parsed.model_path ? path.basename(parsed.model_path) : null;
      if (model && parsed.default_generation_settings?.n_ctx) {
        model = `${model} (ctx ${parsed.default_generation_settings.n_ctx})`;
      }
    } catch {
      model = null;
    }
  }
  return {
    up: health.ok && health.status === 200,
    status: health.status,
    transport: viaUds ? "uds" : "tcp",
    endpoint: viaUds ? cfg.engineUds : `${cfg.engineHost}:${cfg.enginePort}`,
    model,
    detail: health.ok ? "" : health.text.slice(0, 200),
  };
}

async function managerProbe() {
  const headers = cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {};
  const res = await httpGet({ host: "127.0.0.1", port: cfg.mgmtPort, headers }, "/healthz");
  return { up: res.ok && res.status === 200, port: cfg.mgmtPort, status: res.status };
}

function diskUsage(target) {
  try {
    const stat = fs.statfsSync(target);
    const total = stat.blocks * stat.bsize;
    const free = stat.bavail * stat.bsize;
    return { total, free, used: total - free, used_pct: total ? Math.round(((total - free) / total) * 1000) / 10 : null };
  } catch {
    return null;
  }
}

function modelCount() {
  try {
    return fs.readdirSync(cfg.modelsDir).filter((name) => name.toLowerCase().endsWith(".gguf")).length;
  } catch {
    return 0;
  }
}

async function snapshot() {
  const [engine, manager] = await Promise.all([engineProbe(), managerProbe()]);
  const load = os.loadavg();
  return {
    name: "lama-status",
    ok: engine.up,
    time: new Date().toISOString(),
    uptime_s: Math.round(process.uptime()),
    pid: process.pid,
    node: process.version,
    engine,
    manager,
    host: {
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.release()}`,
      load1: Math.round(load[0] * 100) / 100,
      load5: Math.round(load[1] * 100) / 100,
      mem_total: os.totalmem(),
      mem_free: os.freemem(),
      mem_used_pct: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 1000) / 10,
    },
    models: { dir: cfg.modelsDir, count: modelCount(), disk: diskUsage(cfg.modelsDir) },
    started_at: new Date(T0).toISOString(),
  };
}

// ---- http --------------------------------------------------------------------
function authorized(req, url) {
  if (!cfg.token) return true;
  if (req.headers.authorization === `Bearer ${cfg.token}`) return true;
  return url.searchParams.get("token") === cfg.token;
}

const PAGE = `<!doctype html>
<html lang="bn"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>lama status</title>
<style>
:root{color-scheme:dark}
body{margin:0;padding:24px;font:18px/1.6 system-ui,sans-serif;background:#14110f;color:#f2e9df}
h1{font-size:22px;margin:0 0 12px}
dl{display:grid;grid-template-columns:9rem 1fr;gap:6px 14px;margin:0}
dt{color:#b9a893}dd{margin:0;word-break:break-all}
.up{color:#7ddc9a}.down{color:#ff8b7a}
</style></head><body>
<h1>lama status</h1>
<dl id="rows"><dt>loading</dt><dd>…</dd></dl>
<script>
function row(k,v,cls){var d=document.createElement("dt");d.textContent=k;var e=document.createElement("dd");e.textContent=v;if(cls)e.className=cls;return [d,e];}
async function tick(){
  try{
    var r=await fetch("status.json",{cache:"no-store"});var s=await r.json();
    var rows=document.getElementById("rows");rows.textContent="";
    row("engine",s.engine.up?"up ("+s.engine.transport+")":"down",s.engine.up?"up":"down").forEach(function(n){rows.appendChild(n)});
    row("model",s.engine.model||"—").forEach(function(n){rows.appendChild(n)});
    row("manager",s.manager.up?"up":"down",s.manager.up?"up":"down").forEach(function(n){rows.appendChild(n)});
    row("load",s.host.load1+" / "+s.host.load5).forEach(function(n){rows.appendChild(n)});
    row("memory",s.host.mem_used_pct+"% used").forEach(function(n){rows.appendChild(n)});
    row("models",s.models.count+" file(s)").forEach(function(n){rows.appendChild(n)});
    row("disk",s.models.disk?s.models.disk.used_pct+"% used":"—").forEach(function(n){rows.appendChild(n)});
    row("updated",s.time).forEach(function(n){rows.appendChild(n)});
  }catch(e){
    var rows=document.getElementById("rows");rows.textContent="";
    row("status","unreachable").forEach(function(n){rows.appendChild(n)});
  }
}
tick();setInterval(tick,2000);
</script></body></html>
`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://status");
  const send = (code, type, body) => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(body);
  };

  if (url.pathname === "/healthz") {
    const engine = await engineProbe();
    return send(engine.up ? 200 : 503, "text/plain; charset=utf-8", engine.up ? "ok\n" : "down\n");
  }
  if (!authorized(req, url)) return send(401, "application/json", JSON.stringify({ error: "bad or missing status token" }));

  const snap = await snapshot();
  if (url.pathname === "/metrics") {
    const lines = [
      "# HELP lama_engine_up Engine reachable on its TCP or Unix socket.",
      "# TYPE lama_engine_up gauge",
      `lama_engine_up ${snap.engine.up ? 1 : 0}`,
      "# TYPE lama_manager_up gauge",
      `lama_manager_up ${snap.manager.up ? 1 : 0}`,
      "# TYPE lama_status_uptime_seconds gauge",
      `lama_status_uptime_seconds ${snap.uptime_s}`,
      "# TYPE lama_models_total gauge",
      `lama_models_total ${snap.models.count}`,
      "# TYPE lama_host_load1 gauge",
      `lama_host_load1 ${snap.host.load1}`,
      "# TYPE lama_host_mem_used_pct gauge",
      `lama_host_mem_used_pct ${snap.host.mem_used_pct}`,
      "",
    ];
    return send(200, "text/plain; version=0.0.4; charset=utf-8", lines.join("\n"));
  }
  if (url.pathname === "/" && cfg.html) return send(200, "text/html; charset=utf-8", PAGE);
  return send(200, "application/json", `${JSON.stringify(snap, null, 2)}\n`);
});

function announce(where) {
  process.stdout.write(`lama status on ${where} (html=${cfg.html ? "on" : "off"}, token=${cfg.token ? "on" : "off"})\n`);
}

server.listen(cfg.port, cfg.host, () => announce(`http://${cfg.host}:${server.address().port}`));

if (cfg.uds) {
  const udsServer = http.createServer(server.listeners("request")[0]);
  try {
    fs.rmSync(cfg.uds, { force: true });
  } catch {}
  udsServer.listen(cfg.uds, () => {
    fs.chmodSync(cfg.uds, 0o660);
    announce(`unix:${cfg.uds}`);
  });
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
