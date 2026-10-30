/* lama admin UI.
 * Every value is read from the lama HTTP API and every action is a plain API call,
 * so the whole application keeps working without this page (curl, scripts, gateway).
 * No demo data lives here.
 */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const TOKEN_KEY = "lama.admin.token";
const state = {
  token: sessionStorage.getItem(TOKEN_KEY) || "",
  data: null,
  chat: [],
  view: (location.hash || "#dashboard").replace(/^#/, ""),
  headers: {},
  busy: false,
  chatModel: null,
  requests: [],
  logs: [],
  logSeq: 0,
  logPaused: false,
  metrics: null,
  progress: null,
  relay: null,
  relayTimer: null,
  reloadBusy: false,
  transport: null,
  transportLoading: false,
  events: null,
  reconnectTimer: null,
  refreshTimer: null,
  chatAbort: null,
  integration: null,
  docsLang: "bash",
  liveNode: null,
  liveReason: null,
  liveReasonBox: null,
  liveTools: null,
  spDirty: false,
};

/* ---------- tiny DOM helpers ---------- */

function el(tag, options = {}, ...children) {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined && options.text !== null) node.textContent = String(options.text);
  if (options.title) node.title = String(options.title);
  if (options.id) node.id = options.id;
  for (const key of ["type", "value", "placeholder", "name", "min", "max", "step", "rows", "href", "target", "form", "for", "readonly"]) {
    if (options[key] !== undefined && options[key] !== null) node.setAttribute(key, options[key]);
  }
  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) {
      if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value);
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function btn(label, color, act, id) {
  const node = el("button", { class: `btn ${color || ""}`.trim(), text: label });
  node.type = "button";
  if (act) node.dataset.act = act;
  if (id !== undefined && id !== null) node.dataset.id = String(id);
  return node;
}

function tag(text, color) {
  return el("span", { class: `tag ${color || ""}`.trim(), text });
}

function setText(selector, value) {
  const node = $(selector);
  if (node) node.textContent = value === undefined || value === null || value === "" ? "—" : String(value);
}

function setNode(selector, node) {
  const target = $(selector);
  if (!target) return;
  target.textContent = "";
  target.append(node);
}

function setTag(selector, text, color) {
  setNode(selector, tag(text, color));
}

function short(value, limit = 70) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

function fmtTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function timeOnly(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString([], { hour12: false });
}

function fmtBytes(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let index = 0;
  let current = amount;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function duration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function fillSelect(select, items, current) {
  if (!select) return "";
  const value = current !== undefined ? String(current) : select.value;
  select.textContent = "";
  for (const item of items) {
    select.append(el("option", { text: item.label, attrs: { value: item.value } }));
  }
  if (value && items.some((item) => String(item.value) === value)) select.value = value;
  return select.value;
}

function emptyRow(tbody, columns, message) {
  const row = el("tr");
  row.append(el("td", { class: "muted", text: message, attrs: { colspan: columns } }));
  tbody.append(row);
}

function setBar(selector, percent) {
  const node = $(selector);
  if (!node) return;
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  node.style.width = `${value}%`;
  node.style.background = value >= 90 ? "var(--red)" : value >= 75 ? "var(--amber)" : "var(--green)";
}

/* ---------- auth + transport ---------- */

function lock(message) {
  state.token = "";
  sessionStorage.removeItem(TOKEN_KEY);
  disconnectEvents();
  setLive(false, "Events off");
  $("#authGate").hidden = false;
  $("#authError").textContent = message || "";
  const input = $("#authToken");
  if (input) setTimeout(() => input.focus(), 40);
}

function unlock() {
  $("#authGate").hidden = true;
  $("#authError").textContent = "";
  ensureEvents();
}

async function api(path, options = {}) {
  const headers = { accept: "application/json", ...(options.headers || {}) };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  let payload = options.body;
  if (payload && typeof payload === "object") {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(payload);
  }
  const response = await fetch(path, { ...options, headers, body: payload });
  state.headers = Object.fromEntries(response.headers.entries());
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text.slice(0, 400) };
  }
  if (response.status === 401) {
    lock("Admin token rejected. Paste the current LAMA_ADMIN_TOKEN.");
    throw new Error("401 invalid admin token");
  }
  if (!response.ok) throw new Error((data && data.error) || `HTTP ${response.status}`);
  return data;
}

async function fetchText(path) {
  const response = await fetch(path, { headers: { authorization: `Bearer ${state.token}`, accept: "text/plain" } });
  if (response.status === 401) {
    lock("Admin token rejected.");
    throw new Error("401 invalid admin token");
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

let toastTimer = null;
function toast(message, bad = false) {
  const node = $("#toast");
  node.textContent = String(message);
  node.classList.toggle("bad", Boolean(bad));
  node.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 4500);
}

let refreshTimer = null;
function deferredRefresh(delay = 1500) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (!state.token) return;
    loadState({ quiet: true }).catch(() => {});
  }, delay);
}

/* ---------- state loading ---------- */

async function loadState({ quiet = false } = {}) {
  const data = await api("/api/state");
  state.data = data;
  state.metrics = data.metrics || state.metrics;
  if (state.view !== "logs") state.requests = Array.isArray(data.logs?.requests) ? data.logs.requests : [];
  unlock();
  renderChrome();
  renderMetrics();
  renderView(state.view);
  if (!quiet) toast("State refreshed");
}

function renderChrome() {
  const data = state.data;
  if (!data) return;
  const identity = data.identity || {};
  $("#identityName").textContent = `${identity.name || "lama"} ${identity.version || ""}`.trim();
  $("#identityPill").title = identity.license || "";
  $("#sideIdentity").textContent = `${identity.name || "lama"} · ${identity.protocol || "stock llama.cpp"}`;
  $("#navModelCount").textContent = String(data.models.length);

  const engine = data.engine || {};
  const labels = {
    running: ["Engine running" + (engine.pid ? ` · pid ${engine.pid}` : ""), "#8ff0b4", "#245b39", "#123526"],
    starting: ["Engine starting", "#f0d49a", "#5c4a26", "#2a2315"],
    error: ["Engine error", "#ffb4b4", "#5c2b2b", "#2b1717"],
    stopped: ["Engine idle", "#9aa6ad", "#343b40", "#1b2023"],
  };
  const [label, color, border, background] = labels[engine.status] || labels.stopped;
  const pill = $("#headerStatus");
  pill.textContent = "";
  pill.append(el("span", { class: "dot" }), ` ${label}`);
  pill.setAttribute("style", `color:${color};border-color:${border};background:${background}`);
}

function renderView(name) {
  const renderers = {
    dashboard: renderOverview,
    logs: renderLogsView,
    models: renderModels,
    chat: renderChatView,
    runtime: renderRuntime,
    transports: renderTransports,
    mcp: renderMcp,
    prompts: renderPrompts,
    tools: renderTools,
    docs: renderDocsView,
    settings: renderSettings,
  };
  const render = renderers[name] || renderOverview;
  render();
}

/* ---------- server-sent events ---------- */

function setLive(alive, label) {
  const pill = $("#livePill");
  if (!pill) return;
  let labelNode = $("#liveLabel");
  if (!labelNode) {
    pill.textContent = "";
    pill.append(el("span", { class: "dot" }));
    labelNode = el("span", { id: "liveLabel" });
    pill.append(labelNode);
  }
  labelNode.textContent = ` ${label}`;
  pill.setAttribute(
    "style",
    alive ? "color:#65e69a;border-color:#17472d;background:#0c2115" : "color:#9aa6ad;border-color:#343b40;background:#1b2023",
  );
  const tagNode = $("#logLive");
  if (tagNode) {
    tagNode.textContent = alive ? "SSE LIVE" : "SSE OFFLINE";
    tagNode.className = `tag ${alive ? "green" : "red"}`;
  }
}

function disconnectEvents() {
  if (state.events) {
    state.events.abort();
    state.events = null;
  }
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
}

function ensureEvents() {
  if (!state.token) return;
  if (state.events && !state.events.signal.aborted) return;
  disconnectEvents();
  const controller = new AbortController();
  state.events = controller;
  void streamEvents(controller);
}

async function streamEvents(controller) {
  try {
    const response = await fetch("/api/events", {
      headers: { authorization: `Bearer ${state.token}`, accept: "text/event-stream" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (response.status === 401) {
      lock("Admin token rejected. Paste the current LAMA_ADMIN_TOKEN.");
      return;
    }
    if (!response.ok || !response.body) throw new Error(`events HTTP ${response.status}`);
    setLive(true, "Events live");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handleEventBlock(block);
        index = buffer.indexOf("\n\n");
      }
    }
    setLive(false, "Events ended");
  } catch {
    if (controller.signal.aborted) return;
    setLive(false, "Events offline");
  }
  if (!controller.signal.aborted && state.token) {
    state.reconnectTimer = setTimeout(ensureEvents, 4000);
  }
}

function handleEventBlock(block) {
  let event = "message";
  const data = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (!data.length) return;
  let payload;
  try {
    payload = JSON.parse(data.join("\n"));
  } catch {
    payload = { text: data.join("\n") };
  }
  onEvent(event, payload);
}

function onEvent(event, payload) {
  if (event === "hello") {
    setLive(true, `Events live · ${payload.clients ?? 1}`);
    return;
  }
  if (event === "ping") return;
  if (event === "metrics") {
    state.metrics = payload;
    renderMetrics();
    return;
  }
  if (event === "engine") {
    state.progress = payload;
    pushLog({ kind: "engine", at: payload.at, text: `${payload.phase} · ${payload.model_id || "no model"} · ${payload.detail || ""}` });
    if (["running", "stopped", "error"].includes(payload.phase)) deferredRefresh(900);
    if (state.view === "runtime") renderRuntime();
    return;
  }
  if (event === "audit") {
    pushLog({
      kind: "audit",
      at: payload.at,
      text: `${payload.actor || "system"} · ${payload.action || ""}${payload.target ? ` · ${payload.target}` : ""}${payload.detail ? ` · ${payload.detail}` : ""}`,
    });
    return;
  }
  if (event === "request") {
    state.requests.unshift(payload);
    if (state.requests.length > 300) state.requests.length = 300;
    const tokens = [payload.prompt_tokens, payload.completion_tokens].filter((value) => value !== null && value !== undefined).join("/");
    pushLog({
      kind: "request",
      at: payload.at,
      text: `${payload.status} · ${payload.model_key || payload.model_id || "—"} · ${payload.protocol}/${payload.transport_id || "—"} · ${payload.stream ? "stream" : "buffered"} · ${payload.duration_ms} ms${tokens ? ` · tokens ${tokens}` : ""}${payload.detail ? ` · ${payload.detail}` : ""}`,
    });
    if (state.view === "logs") renderRequestsTable();
    deferredRefresh(2000);
    return;
  }
  if (event === "tool") {
    pushLog({
      kind: "tool",
      at: payload.at,
      text: `${payload.tool} · ${payload.ok ? "ok" : "failed"} · ${payload.duration_ms} ms${payload.detail ? ` · ${payload.detail}` : ""}`,
    });
    deferredRefresh(1500);
    return;
  }
  if (event === "download") {
    hfApplyRow(payload);
    return;
  }
  if (event === "mcp") {
    pushLog({ kind: "mcp", at: new Date().toISOString(), text: `${payload.name || payload.id} · ${payload.status || "unknown"}${payload.last_probe_detail ? ` · ${payload.last_probe_detail}` : ""}` });
    deferredRefresh(1200);
  }
}

function pushLog(entry) {
  entry.id = ++state.logSeq;
  entry.at = entry.at || new Date().toISOString();
  state.logs.push(entry);
  if (state.logs.length > 800) state.logs.splice(0, state.logs.length - 800);
  $("#navLogCount").textContent = String(state.logs.length);
  if (state.view === "logs" && !state.logPaused && matchesLogFilter(entry)) {
    const box = $("#logStream");
    const placeholder = box.querySelector(".muted");
    if (placeholder) box.textContent = "";
    box.append(logLine(entry));
    while (box.children.length > 400) box.firstElementChild.remove();
    box.scrollTop = box.scrollHeight;
    $("#logCount").textContent = String(state.logs.length);
    $("#logStatus").textContent = `Last event ${timeOnly(entry.at)} · ${state.logs.length} buffered`;
  }
}

function logLine(entry) {
  const row = el("div", { class: `log-line ${entry.kind}` });
  row.append(
    el("span", { class: "log-time", text: timeOnly(entry.at) }),
    el("span", { class: "log-kind", text: entry.kind }),
    el("span", { class: "log-text", text: entry.text }),
  );
  return row;
}

function matchesLogFilter(entry) {
  const kind = $("#logKind").value || "all";
  const query = ($("#logSearch").value || "").trim().toLowerCase();
  if (kind !== "all" && entry.kind !== kind) return false;
  return !query || String(entry.text).toLowerCase().includes(query);
}

/* ---------- metrics ---------- */

function renderMetrics() {
  const metrics = state.metrics;
  if (!metrics) return;
  const memory = metrics.memory || {};
  const cpu = metrics.cpu || {};
  const disk = metrics.disk || {};
  const engine = metrics.engine;

  setText("#ovCpu", `${cpu.percent ?? 0}% · ${cpu.cores ?? "?"} cores`);
  setBar("#ovCpuBar", cpu.percent);
  setText("#ovMem", `${fmtBytes(memory.used)} / ${fmtBytes(memory.total)} · ${memory.percent ?? 0}%`);
  setBar("#ovMemBar", memory.percent);
  setText("#ovRss", engine ? `${fmtBytes(engine.rss)} · ${engine.cpu_percent ?? 0}% cpu` : "engine not running");
  setText("#ovDisk", `${fmtBytes(disk.used)} / ${fmtBytes(disk.total)} · ${disk.percent ?? 0}%`);
  setText("#ovLoad", `${cpu.load1 ?? "—"} / ${cpu.load5 ?? "—"} / ${cpu.load15 ?? "—"}`);
  setText("#metricStamp", timeOnly(metrics.at));

  setText("#rtCpu", `${cpu.percent ?? 0}% · load ${cpu.load1 ?? "—"}`);
  setBar("#rtCpuBar", cpu.percent);
  setText("#rtMem", `${fmtBytes(memory.used)} / ${fmtBytes(memory.total)} · ${memory.percent ?? 0}%`);
  setBar("#rtMemBar", memory.percent);
  setText("#rtSwap", `${fmtBytes(memory.swap_used)} / ${fmtBytes(memory.swap_total)} · ${memory.swap_percent ?? 0}%`);
  setText("#rtDisk", `${fmtBytes(disk.used)} / ${fmtBytes(disk.total)} · ${disk.percent ?? 0}%`);
  setText("#rtEngineCpu", engine ? `${engine.cpu_percent ?? 0}%` : "—");
  setText("#rtThreads", engine ? engine.threads ?? "—" : "—");
  setText("#rtUptime", engine ? duration(engine.uptime_s) : "—");
  setText("#rtAdminRss", metrics.process ? fmtBytes(metrics.process.rss) : "—");
  setText("#rtLoadAvg", `${cpu.load1 ?? "—"} / ${cpu.load5 ?? "—"} / ${cpu.load15 ?? "—"}`);
  setText("#rtMetricStamp", timeOnly(metrics.at));

  if (state.progress) renderProgress();
}

/* ---------- overview ---------- */

function requestTotals(models) {
  return models.reduce(
    (acc, model) => {
      const stats = model.stats || {};
      acc.total += stats.total || 0;
      acc.ok += stats.ok || 0;
      acc.failed += stats.failed || 0;
      return acc;
    },
    { total: 0, ok: 0, failed: 0 },
  );
}

function renderOverview() {
  const data = state.data;
  const engine = data.engine || {};
  const loaded = data.models.find((model) => model.id === engine.model_id);
  const totals = requestTotals(data.models);

  setText("#statModels", data.models.length);
  setText("#statModelsNote", `${data.models.filter((model) => model.enabled).length} enabled · registry`);
  setText("#statRequests", totals.total);
  setText("#statRequestsNote", `${totals.ok} ok · ${totals.failed} failed`);
  setTag("#statEngine", engine.status, engine.status === "running" ? "green" : engine.status === "error" ? "red" : "amber");
  setText("#statEngineNote", engine.pid ? `pid ${engine.pid} · ${data.config.engine_url}` : "engine idle");
  setText("#statLoaded", loaded ? loaded.name : "none");
  setText("#statLoadedNote", engine.expires_at ? `expires ${fmtTime(engine.expires_at)}` : engine.model_id ? "no expiry" : "nothing loaded");

  setTag("#dashMode", engine.status === "running" ? "ENGINE UP" : "ENGINE IDLE", engine.status === "running" ? "green" : "amber");
  setText("#dashEngine", `${location.origin}/v1 · stable`);
  setText("#dashAdmin", location.origin);
  setText("#dashUds", data.config.uds_path || "disabled");
  setText("#dashDb", data.config.db);
  const provider = data.providers[0];
  setText("#dashProvider", provider ? `${provider.name} · ${provider.base_url}` : "—");
  setText("#dashService", data.config.service_mode);
  setText("#dashIdentity", `${data.identity.name} ${data.identity.version}`);
  setText("#lastUpdate", new Date().toLocaleTimeString());
  renderMetrics();
}

/* ---------- logs ---------- */

function renderLogsView() {
  const box = $("#logStream");
  box.textContent = "";
  const rows = state.logs.filter(matchesLogFilter);
  if (!rows.length) {
    box.append(el("div", { class: "muted", attrs: { style: "padding:14px" }, text: state.logs.length ? "No event matches this filter." : "No events yet. Actions in this page and requests to /v1/* show up here." }));
  } else {
    for (const entry of rows.slice(-400)) box.append(logLine(entry));
    box.scrollTop = box.scrollHeight;
  }
  $("#logCount").textContent = String(state.logs.length);
  $("#navLogCount").textContent = String(state.logs.length);
  $("#logStatus").textContent = state.logs.length ? `${rows.length} shown · ${state.logs.length} buffered · newest ${timeOnly(state.logs[state.logs.length - 1].at)}` : "Waiting for events…";
  $("#logPause").textContent = state.logPaused ? "Resume" : "Pause";
  renderRequestsTable();
}

function renderRequestsTable() {
  const tbody = $("#requestTable");
  if (!tbody) return;
  tbody.textContent = "";
  const rows = state.requests || [];
  if (!rows.length) {
    emptyRow(tbody, 9, "No request recorded yet. Send one from the Playground or /v1/*.");
  } else {
    for (const row of rows.slice(0, 100)) {
      const tokens = [row.prompt_tokens, row.completion_tokens].filter((value) => value !== null && value !== undefined).join(" / ");
      const line = el("tr");
      line.append(
        el("td", { class: "mono", text: timeOnly(row.at), title: fmtTime(row.at) }),
        el("td", { class: "mono", text: row.model_key || row.model_id || "—" }),
        el("td", {}, tag(row.protocol || "—")),
        el("td", { class: "mono", text: row.transport_id || "—" }),
        el("td", {}, tag(row.stream ? "stream" : "buffered", row.stream ? "green" : "")),
        el("td", {}, tag(String(row.status), row.ok ? "green" : "red")),
        el("td", { class: "mono", text: `${row.duration_ms} ms` }),
        el("td", { class: "mono", text: tokens || "—" }),
        el("td", { class: "mono", text: row.system_prompt_id || "—" }),
      );
      tbody.append(line);
    }
  }
  const stats = requestTotals((state.data?.models) || []);
  $("#reqStats").textContent = `${stats.total} total · ${stats.ok} ok · ${stats.failed} failed`;
}

/* ---------- models ---------- */

function renderModels() {
  const data = state.data;
  const engine = data.engine || {};
  fillSelect(
    $("#modelProviderFilter"),
    [{ value: "all", label: "All providers" }, ...data.providers.map((row) => ({ value: row.id, label: row.name }))],
  );

  const query = ($("#modelSearch").value || "").trim().toLowerCase();
  const providerFilter = $("#modelProviderFilter").value || "all";
  const statusFilter = $("#modelStatusFilter").value || "all";
  const rows = data.models.filter((model) => {
    const active = model.id === engine.model_id;
    if (providerFilter !== "all" && model.provider_id !== providerFilter) return false;
    if (statusFilter === "loaded" && !active) return false;
    if (statusFilter === "available" && active) return false;
    if (!query) return true;
    return [model.name, model.id, model.model_id, model.path, model.quant].some((value) =>
      String(value ?? "").toLowerCase().includes(query),
    );
  });

  $("#modelCount").textContent = `${rows.length} / ${data.models.length}`;
  $("#modelCountBadge").textContent = `${data.models.length} registered`;
  const grid = $("#modelsGrid");
  grid.textContent = "";
  for (const model of rows) grid.append(modelCard(model, model.id === engine.model_id));
  $("#modelsEmpty").style.display = rows.length ? "none" : "";
  renderHf();
}

function modelCard(model, active) {
  const stats = model.stats || {};
  const card = el("div", { class: "model-card" });
  const head = el("div", { class: "model-card-head" });
  head.append(
    el(
      "div",
      {},
      el("div", { class: "model-card-name", text: model.name }),
      el("div", { class: "model-card-meta", text: `${model.model_id}${model.quant ? ` · ${model.quant}` : ""}` }),
      el("div", { class: "model-card-meta mono", text: short(model.path, 64), title: model.path || "" }),
    ),
    tag(active ? "LOADED" : model.enabled ? "READY" : "DISABLED", active ? "green" : model.enabled ? "" : "red"),
  );

  const tags = el("div", { class: "model-card-tags" });
  tags.append(
    tag(`provider ${model.provider_id || "—"}`),
    tag(`ctx ${model.context ?? "—"}`),
    tag(`max ${model.max_tokens ?? "—"}`),
    tag(`ttl ${model.ttl_hours ? `${model.ttl_hours}h` : "none"}`),
    tag(`mode ${model.load_mode}`),
  );

  const statGrid = el("div", { class: "model-card-stats" });
  for (const [label, value] of [
    ["ALIAS", model.model_id],
    ["REQUESTS", stats.total ?? 0],
    ["OK / FAILED", `${stats.ok ?? 0} / ${stats.failed ?? 0}`],
    ["AVG LATENCY", `${stats.avg_ms ?? 0} ms`],
  ]) {
    statGrid.append(el("div", { class: "model-card-stat" }, el("span", { text: label }), el("strong", { text: value })));
  }

  const actions = el("div", { class: "model-card-actions" });
  actions.append(
    btn(active ? "Reload" : "Load", "green", active ? "model-reload" : "model-load", model.id),
    btn("Edit", "", "model-edit", model.id),
    btn("Delete", "danger", "model-delete", model.id),
  );
  if (active) actions.lastChild.disabled = true;

  card.append(head, tags, statGrid, actions);
  if (stats.last_at) card.append(el("div", { class: "model-card-meta", text: `last request ${fmtTime(stats.last_at)}` }));
  return card;
}

/* ---------- hugging face downloads ---------- */

const hf = { token: { set: false, preview: null }, downloads: [], seen: new Map() };

async function hfRefreshToken() {
  try {
    hf.token = await api("/api/hf/token");
  } catch {
    return;
  }
  const badge = $("#hfTokenBadge");
  badge.textContent = hf.token.set ? `TOKEN ${hf.token.preview}` : "NO TOKEN";
  badge.className = hf.token.set ? "tag green" : "tag amber";
}

function hfRenderDownloads() {
  const box = $("#hfDownloads");
  box.textContent = "";
  if (!hf.downloads.length) {
    box.append(el("div", { class: "model-card-meta", text: "No downloads yet — paste a token (optional for public repos), list a repo, pick a file." }));
    return;
  }
  for (const row of hf.downloads) {
    const pct = row.bytes_total ? Math.min(100, Math.round((row.bytes_done / row.bytes_total) * 100)) : 0;
    const doneMiB = (row.bytes_done / 1048576).toFixed(1);
    const totalMiB = row.bytes_total ? ` / ${(row.bytes_total / 1048576).toFixed(1)} MiB` : "";
    const color = row.status === "failed" ? "red" : row.status === "done" ? "green" : "amber";
    const line = el("div", { class: "model-card-meta mono" });
    line.append(
      tag(row.status, color),
      ` ${row.repo}/${row.file} · ${pct}% · ${doneMiB}${totalMiB}${row.error ? ` · ${row.error}` : ""}`,
    );
    box.append(line);
  }
}

async function hfRefreshDownloads() {
  try {
    const data = await api("/api/hf/downloads");
    hf.downloads = data.downloads || [];
  } catch {
    return;
  }
  let finished = false;
  for (const row of hf.downloads) {
    const before = hf.seen.get(row.id);
    if (row.status === "done" && before && before !== "done") finished = true;
    hf.seen.set(row.id, row.status);
  }
  hfRenderDownloads();
  if (finished) deferredRefresh(800);
}

function hfApplyRow(row) {
  if (!row || row.id === undefined) return;
  const index = hf.downloads.findIndex((item) => item.id === row.id);
  const before = index >= 0 ? hf.downloads[index].status : null;
  if (index >= 0) hf.downloads[index] = row;
  else hf.downloads.unshift(row);
  hfRenderDownloads();
  if (row.status === "done" && before && before !== "done") deferredRefresh(800);
}

async function renderHf() {
  await Promise.all([hfRefreshToken().catch(() => {}), hfRefreshDownloads().catch(() => {})]);
}

$("#hfTokenSave").addEventListener("click", async () => {
  const token = $("#hfTokenInput").value.trim();
  if (!token) return toast("Paste a Hugging Face token first", true);
  try {
    await api("/api/hf/token", { method: "PUT", body: { token } });
    $("#hfTokenInput").value = "";
    toast("HF token saved in the admin database");
    hfRefreshToken();
  } catch (error) {
    toast(error.message, true);
  }
});

$("#hfTokenClear").addEventListener("click", async () => {
  try {
    await api("/api/hf/token", { method: "DELETE" });
    toast("HF token cleared");
    hfRefreshToken();
  } catch (error) {
    toast(error.message, true);
  }
});

$("#hfList").addEventListener("click", async () => {
  const repo = $("#hfRepo").value.trim();
  if (!repo) return toast("Type a repo id first, e.g. Qwen/Qwen2.5-0.5B-Instruct-GGUF", true);
  try {
    const data = await api(`/api/hf/files?repo=${encodeURIComponent(repo)}`);
    fillSelect(
      $("#hfFile"),
      data.files.map((file) => ({ value: file.path, label: `${file.path}${file.size ? ` · ${(file.size / 1048576).toFixed(1)} MiB` : ""}` })),
    );
    toast(`${data.files.length} GGUF file(s)`);
  } catch (error) {
    toast(error.message, true);
  }
});

$("#hfDownload").addEventListener("click", async () => {
  const repo = $("#hfRepo").value.trim();
  const file = $("#hfFile").value;
  if (!repo || !file) return toast("List the repo and pick a file first", true);
  try {
    await api("/api/models/download", { method: "POST", body: { repo, file } });
    toast(`Download started: ${file}`);
    hfRefreshDownloads();
  } catch (error) {
    toast(error.message, true);
  }
});

/* ---------- chat ---------- */

function renderChatView() {
  const data = state.data;
  const models = data.models.map((model) => ({ value: model.id, label: `${model.name} · ${model.model_id}` }));
  fillSelect($("#chatModel"), models, state.chatModel || $("#chatModel").value || models[0]?.value);
  state.chatModel = $("#chatModel").value;

  fillSelect(
    $("#chatTransport"),
    data.transports.map((row) => ({
      value: row.id,
      label: `${row.name} · ${row.protocol}`,
    })),
    $("#chatTransport").value || data.transports.find((row) => row.protocol === "http")?.id || "",
  );
  const previousSystem = $("#chatSystem").value || "system";
  fillSelect(
    $("#chatSystem"),
    [{ value: "", label: "None" }, ...data.prompts.map((prompt) => ({ value: prompt.id, label: `${prompt.name} v${prompt.version}${prompt.edited ? " · edited" : ""}` }))],
    previousSystem,
  );

  const model = data.models.find((row) => row.id === $("#chatModel").value);
  if (model && state.chatModel !== model.id) state.chatModel = model.id;
  if (model && !state.chatTouched) {
    state.chatTouched = true;
    $("#chatTemperature").value = model.temperature;
    $("#chatMaxTokens").value = model.max_tokens;
  }
  renderChatTranscript();
}

function renderChatTranscript() {
  const box = $("#chatTranscript");
  box.textContent = "";
  if (!state.chat.length) {
    box.append(
      el(
        "div",
        { class: "chat-empty" },
        el("strong", { text: "Ready to test a model" }),
        "Select a model, type a prompt and send. The engine must be loaded first.",
      ),
    );
    return;
  }
  for (const message of state.chat) {
    const wrap = el("div", { class: `chat-msg ${message.role}` });
    if (message.role === "assistant") {
      const reasoning = el("details", { class: "reasoning" });
      reasoning.hidden = !message.reasoning;
      reasoning.append(el("summary", { text: "Reasoning" }), el("div", { class: "reasoning-body", text: message.reasoning || "" }));
      wrap.append(reasoning);
    }
    const body = el("div", { class: "chat-body" });
    if (message.streaming && !message.content) {
      body.classList.add("typing");
      body.textContent = "…";
    } else {
      body.textContent = message.content || (message.role === "assistant" ? "(no text content)" : "");
    }
    wrap.append(body);
    if (message.tools && message.tools.length) {
      const list = el("div", { class: "chip-list", attrs: { style: "margin-top:8px" } });
      for (const call of message.tools) list.append(tag(toolName(call), "amber"));
      wrap.append(list);
    }
    if (message.meta) wrap.append(el("div", { class: "chat-foot", text: message.meta }));
    box.append(wrap);
  }
  box.scrollTop = box.scrollHeight;
}

function toolName(call) {
  if (!call || typeof call !== "object") return "tool";
  const record = Array.isArray(call) ? call[0] : call;
  return record?.function?.name || record?.name || record?.type || "tool";
}

function bindLiveChatNodes() {
  const nodes = $$(".chat-msg.assistant", $("#chatTranscript"));
  const wrap = nodes[nodes.length - 1];
  state.liveNode = wrap ? wrap.querySelector(".chat-body") : null;
  state.liveReasonBox = wrap ? wrap.querySelector(".reasoning") : null;
  state.liveReason = wrap ? wrap.querySelector(".reasoning-body") : null;
  state.liveTools = wrap ? wrap.querySelector(".chip-list") : null;
}

async function readSse(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      let event = "message";
      const data = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (data.length) {
        let payload;
        try {
          payload = JSON.parse(data.join("\n"));
        } catch {
          payload = { text: data.join("\n") };
        }
        onEvent(event, payload);
      }
      index = buffer.indexOf("\n\n");
    }
  }
}

async function sendChat() {
  if (state.busy) return;
  const data = state.data;
  if (!data) return toast("Not connected yet", true);
  const model = data.models.find((row) => row.id === $("#chatModel").value) || data.models[0];
  if (!model) return toast("Register a model first", true);
  const text = $("#chatPrompt").value.trim();
  if (!text) return;

  const protocol = $("#chatProtocol").value || "openai";
  const transportId = $("#chatTransport").value;
  const stream = $("#chatStream").checked;
  const includeTools = $("#chatTools").checked;
  const systemPromptId = $("#chatSystem").value;
  const messages = state.chat
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ role: message.role, content: message.content }))
    .filter((message) => message.content);
  messages.push({ role: "user", content: text });

  state.chat.push({ role: "user", content: text });
  const assistant = { role: "assistant", content: "", reasoning: "", tools: [], streaming: stream };
  state.chat.push(assistant);
  $("#chatPrompt").value = "";
  renderChatTranscript();
  bindLiveChatNodes();

  state.busy = true;
  $("#chatSend").disabled = true;
  $("#chatStop").hidden = !stream;
  setTag("#chatBadge", stream ? "STREAMING" : "SENDING", "amber");
  $("#chatStatus").textContent = "Waiting for the engine…";
  $("#chatMeta").textContent = "";
  const started = performance.now();
  const controller = new AbortController();
  state.chatAbort = controller;

  const append = (node, value) => {
    if (!node) return;
    node.classList.remove("typing");
    node.textContent += value;
    const box = $("#chatTranscript");
    box.scrollTop = box.scrollHeight;
  };

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${state.token}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: model.model_id,
        protocol,
        transport_id: transportId,
        stream,
        include_tools: includeTools,
        system_prompt_id: systemPromptId || "none",
        temperature: Number($("#chatTemperature").value),
        max_tokens: Number($("#chatMaxTokens").value),
        messages,
      }),
    });
    if (response.status === 401) {
      lock("Admin token rejected.");
      throw new Error("401 invalid admin token");
    }
    if (!response.ok) {
      const raw = await response.text();
      let detail = raw;
      try {
        detail = JSON.parse(raw).error || raw;
      } catch {
        // keep raw text
      }
      throw new Error(detail || `HTTP ${response.status}`);
    }

    if (!stream) {
      const payload = await response.json();
      assistant.content = payload.content || "";
      assistant.reasoning = payload.reasoning || "";
      assistant.tools = payload.tool_calls || [];
      assistant.streaming = false;
      const usage = payload.usage || {};
      const ms = payload.duration_ms ?? Math.round(performance.now() - started);
      assistant.meta = `${payload.protocol} · ${payload.transport} · HTTP ${payload.status} · ${ms} ms · prompt ${usage.prompt_tokens ?? usage.input_tokens ?? "—"} · completion ${usage.completion_tokens ?? usage.output_tokens ?? "—"}`;
      renderChatTranscript();
      setTag("#chatBadge", payload.ok ? "LIVE" : "FAILED", payload.ok ? "green" : "red");
      $("#chatStatus").textContent = `${payload.protocol} · ${payload.transport} · ${ms} ms`;
      renderChatMeta(assistant.meta);
      return;
    }

    let streamError = null;
    let doneInfo = null;
    await readSse(response, (event, payload) => {
      if (event === "start") {
        $("#chatStatus").textContent = `Streaming over ${payload.transport} · ${payload.protocol}`;
      } else if (event === "delta") {
        assistant.content += payload.text || "";
        append(state.liveNode, payload.text || "");
      } else if (event === "reasoning") {
        assistant.reasoning += payload.text || "";
        if (state.liveReasonBox) state.liveReasonBox.hidden = false;
        append(state.liveReason, payload.text || "");
      } else if (event === "tool") {
        assistant.tools.push(payload);
        if (state.liveTools) {
          state.liveTools.append(tag(toolName(payload), "amber"));
        }
      } else if (event === "usage") {
        assistant.usage = payload;
      } else if (event === "done") {
        doneInfo = payload;
      } else if (event === "error") {
        streamError = payload.message || `engine HTTP ${payload.status ?? "error"}`;
      }
    });

    assistant.streaming = false;
    if (!assistant.content && assistant.reasoning) assistant.content = "";
    if (streamError) throw new Error(streamError);
    if (controller.signal.aborted) throw new Error("stopped by user");
    const info = doneInfo || {};
    assistant.meta = `${protocol} · ${transportId} · ${info.duration_ms ?? Math.round(performance.now() - started)} ms · first token ${info.first_token_ms ?? "—"} ms · prompt ${info.prompt_tokens ?? "—"} · completion ${info.completion_tokens ?? "—"}`;
    renderChatTranscript();
    setTag("#chatBadge", "LIVE", "green");
    $("#chatStatus").textContent = `Done over ${transportId} in ${info.duration_ms ?? Math.round(performance.now() - started)} ms`;
    renderChatMeta(assistant.meta);
  } catch (error) {
    assistant.streaming = false;
    const aborted = controller.signal.aborted || /aborted/i.test(error.message);
    if (!assistant.content) assistant.content = aborted ? "(stopped)" : "";
    assistant.meta = aborted ? "stopped by user" : `error: ${error.message}`;
    renderChatTranscript();
    setTag("#chatBadge", aborted ? "STOPPED" : "FAILED", aborted ? "amber" : "red");
    $("#chatStatus").textContent = aborted ? "Stream stopped" : error.message;
    if (!aborted) toast(error.message, true);
  } finally {
    state.busy = false;
    state.chatAbort = null;
    $("#chatSend").disabled = false;
    $("#chatStop").hidden = true;
  }
}

function renderChatMeta(text) {
  const meta = $("#chatMeta");
  meta.textContent = "";
  for (const part of String(text || "").split(" · ")) if (part) meta.append(tag(part));
}

/* ---------- runtime ---------- */

function renderRuntime() {
  const data = state.data;
  const engine = data.engine || {};
  fillSelect(
    $("#rtModel"),
    data.models.map((model) => ({ value: model.id, label: `${model.name} · ${model.model_id}` })),
    $("#rtModel").value || engine.model_id || "",
  );
  $("#rtService").value = data.config.service_mode || "none";

  setTag("#runtimeState", engine.status, engine.status === "running" ? "green" : engine.status === "error" ? "red" : "amber");
  setText("#runtimePid", engine.pid ? `pid ${engine.pid}` : "no pid");
  const model = data.models.find((row) => row.id === engine.model_id);
  setText("#runtimeModel", model ? model.name : "none");
  setText("#runtimeLoadMode", `load mode ${engine.load_mode || "—"}`);
  setText("#runtimeExpires", engine.expires_at ? fmtTime(engine.expires_at) : "no expiry");
  setText("#runtimeStarted", engine.started_at ? `started ${fmtTime(engine.started_at)}` : "not started");
  const engineMetrics = state.metrics?.engine;
  setText("#runtimeRss", engineMetrics ? fmtBytes(engineMetrics.rss) : "—");
  setText("#runtimeRssNote", engineMetrics ? `${engineMetrics.threads ?? "?"} threads · ${engineMetrics.cpu_percent ?? 0}% cpu` : "/proc/<pid>/stat");

  setText("#rtSocket", engine.socket_path || data.config.uds_path || "disabled");
  setText("#rtPort", engine.port || "—");
  setText("#rtBuild", engine.build || "—");
  const provider = data.providers[0];
  setText("#rtProvider", provider ? `${provider.name} · ${provider.base_url}` : "—");
  setText("#rtError", engine.last_error || "none");
  $("#rtRaw").textContent = JSON.stringify(engine, null, 2);

  renderProgress();
  renderMetrics();
}

function renderProgress() {
  const box = $("#progressBox");
  if (!box) return;
  const progress = state.progress;
  if (!progress) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const phases = {
    loading: ["LOADING", 20, "amber"],
    waiting: ["WAITING", 55, "amber"],
    running: ["RUNNING", 100, "green"],
    stopping: ["STOPPING", 70, "amber"],
    stopped: ["STOPPED", 100, ""],
    reloading: ["RELOADING", 15, "amber"],
    error: ["ERROR", 100, "red"],
  };
  const [label, percent, color] = phases[progress.phase] || [String(progress.phase || "—"), 40, "amber"];
  const phaseTag = $("#progressPhase");
  phaseTag.textContent = label;
  phaseTag.className = `tag ${color}`.trim();
  $("#progressDetail").textContent = `${progress.model_id || "no model"} · ${progress.detail || "—"}`;
  const bar = $("#progressBar");
  bar.style.width = `${percent}%`;
  bar.style.background = progress.phase === "error" ? "var(--red)" : progress.phase === "running" ? "var(--green)" : "var(--amber)";
  $("#progressElapsed").textContent = progress.elapsed_ms ? `${(progress.elapsed_ms / 1000).toFixed(1)} s since the transition started` : "—";
}

/* ---------- zero-downtime relay panel ---------- */

function relayStep(name, stepState, note) {
  const node = $(`#relaySteps [data-step="${name}"]`);
  if (!node) return;
  node.dataset.state = stepState;
  node.setAttribute("aria-current", stepState === "active" ? "step" : "false");
  if (note !== undefined) {
    const small = node.querySelector("small");
    if (small) small.textContent = note;
  }
}

async function loadRelay() {
  if (!state.token) return;
  try {
    state.relay = await api("/api/engine/relay");
    renderRelay();
  } catch {
    // Polling must never break the page; the next tick retries.
  }
}

function startRelayPolling() {
  if (state.relayTimer) return;
  state.relayTimer = setInterval(() => {
    if (document.hidden || !state.token) return;
    if ($("#modalBackdrop") && $("#modalBackdrop").classList.contains("open")) return;
    void loadRelay();
  }, 1200);
  void loadRelay();
}

function renderRelay() {
  const panel = $("#relayPanel");
  const relay = state.relay;
  if (!panel || !relay) return;
  const phase = relay.phase === "warming" || relay.phase === "draining" ? relay.phase : "idle";
  const recent = Boolean(
    relay.last_swap && Number.isFinite(Date.parse(relay.last_swap.at)) && Date.now() - Date.parse(relay.last_swap.at) < 120_000,
  );
  const failed = phase === "idle" && Boolean(relay.last_error);
  panel.dataset.phase = failed ? "error" : phase;

  const labels =
    phase === "warming"
      ? ["Warming up", "amber"]
      : phase === "draining"
        ? ["Draining", "amber"]
        : failed
          ? ["Idle · error", "red"]
          : recent
            ? ["Swapped", "green"]
            : ["Idle", "green"];
  const phaseTag = $("#relayPhase");
  phaseTag.className = `tag relay-phase ${labels[1]}`;
  phaseTag.textContent = "";
  phaseTag.append(el("span", { class: "dot" }), ` ${labels[0]}`);

  const activeNote = relay.active?.pid ? `pid ${relay.active.pid} · :${relay.active.port}` : "no engine";
  if (phase === "warming") {
    relayStep("warmup", "active", `warming a spare engine${relay.warming?.port ? ` on :${relay.warming.port}` : ""}…`);
    relayStep("switch", "pending", "waits for a healthy spare");
    relayStep("drain", "pending", "old engine finishes in-flight work");
    relayStep("retire", "pending", "old pid stops last");
  } else if (phase === "draining") {
    const drain = relay.draining;
    relayStep("warmup", "done", "new engine healthy");
    relayStep("switch", "done", `traffic now on pid ${relay.active?.pid ?? "?"}`);
    relayStep("drain", "active", `${drain?.processing ?? "?"} in flight on old pid ${drain?.old_pid ?? "?"}`);
    relayStep("retire", "pending", "SIGTERM after the last request");
  } else if (recent) {
    const swap = relay.last_swap;
    relayStep("warmup", "done", `pid ${swap.new_pid ?? "?"} healthy on :${swap.new_port ?? "?"}`);
    relayStep("switch", "done", `pid ${swap.old_pid ?? "?"} → ${swap.new_pid ?? "?"}`);
    relayStep("drain", "done", `old pid ${swap.old_pid ?? "?"} drained`);
    relayStep("retire", "done", "old pid gone · stable URL untouched");
  } else if (failed) {
    relayStep("warmup", "error", short(relay.last_error, 70));
    relayStep("switch", "pending", "previous engine kept serving");
    relayStep("drain", "pending", "nothing to drain");
    relayStep("retire", "pending", "nothing retired");
  } else {
    relayStep("warmup", "pending", "spare engine not started");
    relayStep("switch", "pending", "proxy follows the healthy engine");
    relayStep("drain", "pending", "old engine finishes in-flight work");
    relayStep("retire", "pending", "old pid stops");
  }

  const processing = relay.inflight?.processing;
  setText("#relayInflight", typeof processing === "number" ? String(processing) : "—");
  const inflightNote =
    phase === "draining"
      ? `old ${relay.draining?.processing ?? "?"} · new ${relay.active?.processing ?? "?"} processing`
      : phase === "warming"
        ? `active ${relay.active?.processing ?? "?"} · spare takes no traffic yet`
        : "live requests_processing";
  setText("#relayInflightNote", inflightNote);
  setText("#relayActive", activeNote);
  setText(
    "#relayDraining",
    relay.draining
      ? `pid ${relay.draining.old_pid ?? "?"} · :${relay.draining.old_port} · ${relay.draining.processing ?? "?"} left`
      : "none",
  );
  setText(
    "#relayLastSwap",
    relay.last_swap
      ? `${timeOnly(relay.last_swap.at)} · ${relay.last_swap.old_pid ?? "?"} → ${relay.last_swap.new_pid ?? "?"} · :${relay.last_swap.new_port ?? "?"}`
      : "never",
  );

  const endpoint = relay.stable?.openai_base_url || `${location.origin}/v1`;
  setText("#relayEndpoint", endpoint);
  setText("#relayUds", relay.stable?.uds_path || "disabled");

  const description =
    phase === "warming"
      ? `Warming a second engine on port ${relay.warming?.port ?? "?"}. Clients keep using the stable URL; no request is cut yet.`
      : phase === "draining"
        ? `Traffic moved to pid ${relay.active?.pid ?? "?"} on port ${relay.active?.port ?? "?"}. Old pid ${relay.draining?.old_pid ?? "?"} is finishing ${relay.draining?.processing ?? "?"} in-flight request(s), then it retires.`
        : failed
          ? `Last reload failed: ${relay.last_error}. The running engine was never cut.`
          : recent
            ? `Last swap ${timeOnly(relay.last_swap.at)}: old pid ${relay.last_swap.old_pid ?? "?"} drained and retired; pid ${relay.last_swap.new_pid ?? "?"} is serving on port ${relay.last_swap.new_port ?? "?"}.`
            : "Ready. One click warms a spare engine, switches traffic, drains the old engine and retires it — the stable URL never changes.";
  setText("#relayDesc", description);

  const busy = Boolean(relay.reloading);
  const relayButton = $("#relayReload");
  if (relayButton) {
    relayButton.disabled = busy || state.reloadBusy;
    relayButton.textContent = busy || state.reloadBusy ? "Reloading…" : "⚡ Reload without downtime";
  }
  const runtimeButton = $("#rtReload");
  if (runtimeButton) {
    runtimeButton.disabled = busy || state.reloadBusy;
    runtimeButton.textContent = busy || state.reloadBusy ? "Reloading…" : "Reload";
  }
}

async function startReload(modelId, ttlHours) {
  if (state.reloadBusy) return toast("a reload is already running", true);
  state.reloadBusy = true;
  renderRelay();
  try {
    toast("reloading — warm up, switch, drain…");
    await api("/api/engine/reload", { method: "POST", body: { model_id: modelId, ttl_hours: ttlHours } });
    await loadState({ quiet: true });
    await loadRelay();
    toast("reload complete — old engine retired after drain");
  } catch (error) {
    await loadState({ quiet: true }).catch(() => {});
    await loadRelay();
    toast(error.message, true);
  } finally {
    state.reloadBusy = false;
    renderRelay();
  }
}

/* ---------- transports ---------- */

function renderTransports() {
  const data = state.data;
  const tbody = $("#transportsTable");
  tbody.textContent = "";
  if (!data.transports.length) emptyRow(tbody, 5, "No transport registered.");
  for (const row of data.transports) {
    const endpoint = row.protocol === "uds" ? row.socket_path : `${row.protocol}://${row.host}:${row.port}`;
    const stats = row.stats || {};
    const actions = el("div", { class: "admin-table-actions" });
    actions.append(btn("Open", "green", "transport-open", row.id), btn("Probe", "", "transport-probe", row.id));
    if (row.protocol === "uds") actions.append(btn("Link socket", "", "transport-link", row.id));
    const line = el("tr");
    line.append(
      el("td", { class: "mono", text: row.id }),
      el("td", {}, tag(row.protocol, row.protocol === "https" ? "green" : "")),
      el("td", { class: "mono", text: endpoint || "—", title: endpoint || "" }),
      el("td", { class: "mono", text: `${stats.total ?? 0} · ${stats.ok ?? 0}/${stats.failed ?? 0}` }),
      el("td", {}, actions),
    );
    tbody.append(line);
  }

  const documents = $("#documentsTable");
  documents.textContent = "";
  if (!data.documents.length) emptyRow(documents, 5, "No document stored.");
  for (const doc of data.documents) {
    const actions = el("div", { class: "admin-table-actions" });
    actions.append(btn("View", "", "document-view", doc.id), btn("Verify", "green", "document-verify", doc.id));
    const line = el("tr");
    line.append(
      el("td", { class: "mono", text: doc.slug }),
      el("td", { text: doc.title }),
      el("td", { class: "mono", text: doc.transport_id || "—" }),
      el("td", {}, doc.verified_at ? tag(fmtTime(doc.verified_at), "green") : tag("not verified", "amber")),
      el("td", {}, actions),
    );
    documents.append(line);
  }

  if (state.transport) void openTransport(state.transport, { silent: true });
}

async function openTransport(id, { silent = false } = {}) {
  if (state.transportLoading) return;
  state.transportLoading = true;
  state.transport = id;
  try {
    const [detail, docs] = await Promise.all([api(`/api/transports/${encodeURIComponent(id)}`), api(`/api/transports/${encodeURIComponent(id)}/docs`)]);
    const transport = detail.transport;
    const endpoint = transport.protocol === "uds" ? transport.socket_path : `${transport.protocol}://${transport.host}:${transport.port}`;
    $("#transportDetail").hidden = false;
    $("#tdTitle").textContent = `${transport.name} · ${transport.protocol}`;
    $("#tdMeta").textContent = endpoint || "—";
    $("#tdStats").textContent = `${detail.stats.total} req · ${detail.stats.ok} ok · ${detail.stats.failed} failed · ${detail.stats.avg_ms} ms avg`;
    $("#tdLink").hidden = transport.protocol !== "uds";
    renderDocs($("#tdDocs"), docs);
    const tbody = $("#tdRequests");
    tbody.textContent = "";
    if (!detail.requests.length) emptyRow(tbody, 8, "No request recorded for this transport yet.");
    for (const row of detail.requests) {
      const tokens = [row.prompt_tokens, row.completion_tokens].filter((value) => value !== null && value !== undefined).join(" / ");
      const line = el("tr");
      line.append(
        el("td", { class: "mono", text: timeOnly(row.at) }),
        el("td", { class: "mono", text: row.model_key || "—" }),
        el("td", {}, tag(row.protocol)),
        el("td", {}, tag(row.stream ? "stream" : "buffered", row.stream ? "green" : "")),
        el("td", {}, tag(String(row.status), row.ok ? "green" : "red")),
        el("td", { class: "mono", text: `${row.duration_ms} ms` }),
        el("td", { class: "mono", text: tokens || "—" }),
        el("td", { class: "muted", text: short(row.detail, 50), title: row.detail || "" }),
      );
      tbody.append(line);
    }
    if (!silent) toast(`transport ${id} opened`);
  } catch (error) {
    if (!silent) toast(error.message, true);
  } finally {
    state.transportLoading = false;
  }
}

function renderDocs(container, docs) {
  container.textContent = "";
  const head = el("div", { class: "doc-head" });
  head.append(
    el("div", { class: "doc-title", text: `${docs.transport.name} integration guide` }),
    el("div", { class: "sub", text: `Endpoint ${docs.transport.endpoint} · model alias ${docs.model_alias} · generated ${fmtTime(docs.generated_at)}` }),
  );
  container.append(head);
  for (const section of docs.sections || []) {
    const block = el("section", { class: "doc-section" });
    block.append(el("h3", { text: section.title }), el("p", { class: "doc-summary", text: section.summary }));
    for (const item of section.blocks || []) {
      if (item.kind === "table") {
        const table = el("table", { class: "doc-table" });
        const thead = el("thead");
        const headRow = el("tr");
        for (const cell of item.head || []) headRow.append(el("th", { text: cell }));
        thead.append(headRow);
        const tbody = el("tbody");
        for (const row of item.rows || []) {
          const line = el("tr");
          for (const cell of row) line.append(el("td", { class: "mono", text: cell }));
          tbody.append(line);
        }
        table.append(thead, tbody);
        block.append(table);
      } else if (item.kind === "note") {
        block.append(el("div", { class: "doc-note", text: item.text || "" }));
      } else if (item.kind === "code") {
        block.append(codeBlock(item));
      } else if (item.text) {
        block.append(el("p", { class: "doc-text", text: item.text }));
      }
    }
    container.append(block);
  }
}

function codeBlock(item) {
  const wrap = el("div", { class: "doc-code" });
  const head = el("div", { class: "doc-code-head" });
  const copy = el("button", { class: "btn small", text: "Copy" });
  copy.type = "button";
  copy.addEventListener("click", () => copyText(item.text || "", "snippet"));
  head.append(el("span", { text: item.title || item.language || "code" }), copy);
  wrap.append(head, el("pre", { class: "code", text: item.text || "" }));
  return wrap;
}

/* ---------- docs (integration guide) ---------- */

function renderDocsView() {
  if (state.integration) paintIntegration();
  void loadIntegration().catch((error) => toast(`docs: ${error.message}`, true));
}

async function loadIntegration() {
  const docs = await api("/api/docs/integration");
  state.integration = docs;
  paintIntegration();
}

function paintIntegration() {
  const docs = state.integration;
  if (!docs) return;
  setText("#docsStamp", `generated ${timeOnly(docs.generated_at)}`);
  setText("#docsAlias", `model ${docs.model_alias}`);

  const langs = $("#docsLangs");
  langs.textContent = "";
  const active = docs.languages.some((row) => row.id === state.docsLang) ? state.docsLang : docs.languages[0]?.id;
  state.docsLang = active;
  for (const row of docs.languages) {
    const button = el("button", { class: `btn small${row.id === active ? " green active" : ""}`, text: row.label });
    button.type = "button";
    button.dataset.docsLang = row.id;
    button.setAttribute("aria-pressed", String(row.id === active));
    langs.append(button);
  }

  $("#docsInstallTitle").textContent = docs.install.title;
  $("#docsInstallIntro").textContent = docs.install.intro;
  const install = $("#docsInstall");
  install.textContent = "";
  for (const step of docs.install.steps) install.append(installStep(step));
  if (docs.install.finish) install.append(el("p", { class: "doc-note", text: docs.install.finish }));

  const box = $("#docsScenarios");
  box.textContent = "";
  for (const scenario of docs.scenarios) box.append(scenarioCard(scenario, active));

  $("#docsUdsSummary").textContent = docs.uds.summary;
  $("#docsUdsPath").textContent = docs.uds_path || "disabled";
  const uds = $("#docsUds");
  uds.textContent = "";
  const udsExample = docs.uds.examples.find((row) => row.language === active);
  if (udsExample) uds.append(docsExampleBlock(udsExample));
}

function installStep(step) {
  const wrap = el("section", { class: "doc-section install-step" });
  wrap.append(el("h3", { text: step.title }), el("p", { class: "doc-summary", text: step.body }));
  if (step.code) {
    const block = el("div", { class: "doc-code" });
    const head = el("div", { class: "doc-code-head" });
    const copy = el("button", { class: "btn small", text: "Copy" });
    copy.type = "button";
    copy.addEventListener("click", () => copyText(step.code, step.title));
    head.append(el("span", { text: "bash" }), copy);
    block.append(head, el("pre", { class: "code", text: step.code }));
    wrap.append(block);
  }
  return wrap;
}

function scenarioCard(scenario, language) {
  const panel = el("div", { class: "panel doc-scenario" });
  const head = el("div", { class: "panel-head" });
  head.append(
    el(
      "div",
      {},
      el("div", { class: "panel-title", text: scenario.title }),
      el("div", { class: "panel-desc", text: scenario.summary }),
    ),
    tag(scenario.id),
  );
  const body = el("div", { class: "panel-body" });
  if (scenario.notes.length) {
    const notes = el("ul", { class: "doc-notes" });
    for (const note of scenario.notes) notes.append(el("li", { text: note }));
    body.append(notes);
  }
  const chosen = scenario.examples.find((row) => row.language === language) || scenario.examples[0];
  if (chosen) body.append(docsExampleBlock(chosen));
  panel.append(head, body);
  return panel;
}

function docsExampleBlock(item) {
  const block = el("div", { class: "doc-code" });
  const head = el("div", { class: "doc-code-head" });
  const copy = el("button", { class: "btn small", text: "Copy" });
  copy.type = "button";
  copy.addEventListener("click", () => copyText(item.code || "", `${item.label || item.language} snippet`));
  head.append(el("span", { text: `${item.label || ""} · ${item.language}` }), copy);
  block.append(head, el("pre", { class: "code", text: item.code || "" }));
  return block;
}

/* ---------- MCP ---------- */

function renderMcp() {
  const data = state.data;
  const tbody = $("#mcpTable");
  tbody.textContent = "";
  $("#mcpCount").textContent = `${data.mcp.length} server(s)`;
  if (!data.mcp.length) emptyRow(tbody, 7, "No MCP server registered.");
  for (const row of data.mcp) {
    const target = row.transport === "stdio" ? [row.command, ...(row.args || [])].filter(Boolean).join(" ") : row.url;
    const statusColor = row.status === "active" ? "green" : row.status === "inactive" ? "red" : "amber";
    const actions = el("div", { class: "admin-table-actions" });
    actions.append(
      btn("Probe", "", "mcp-probe", row.id),
      btn(row.enabled ? "Disable" : "Enable", row.enabled ? "" : "green", "mcp-toggle", row.id),
      btn("Delete", "danger", "mcp-delete", row.id),
    );
    const targetCell = el("td", { class: "mono" });
    const info = el("button", { class: "mini", text: "i", title: "Show the full command path" });
    info.type = "button";
    info.dataset.act = "mcp-info";
    const full = el("div", { class: "full mono", text: target || "—" });
    full.hidden = true;
    targetCell.append(info, el("span", { class: "mono", text: short(target, 44), title: target || "" }), full);

    const line = el("tr");
    line.append(
      el("td", {}, el("div", { class: "item-name", text: row.name }), el("div", { class: "item-sub mono", text: row.id })),
      el("td", {}, tag(row.status || "unknown", statusColor), row.enabled ? "" : tag("disabled", "red")),
      el("td", {}, tag(row.transport, row.transport === "stdio" ? "green" : "amber")),
      targetCell,
      el("td", { class: "mono", text: `${row.tools_count ?? 0}` }),
      el("td", { class: "mono", text: `${row.use_count ?? 0}` }),
      el("td", {}, actions),
    );
    tbody.append(line);
  }

  const matrix = $("#mcpMatrix");
  matrix.textContent = "";
  const rows = [];
  for (const server of data.mcp) for (const tool of server.tools || []) rows.push({ server, tool });
  $("#mcpMatrixCount").textContent = `${rows.length} tool(s)`;
  if (!rows.length) emptyRow(matrix, 7, "No tool advertised yet. Run a probe on the server.");
  for (const { server, tool } of rows) {
    const line = el("tr");
    const toggle = btn(tool.enabled ? "On" : "Off", tool.enabled ? "green" : "", "mcp-tool-toggle", tool.name);
    toggle.dataset.server = tool.mcp_id;
    toggle.title = tool.enabled ? "Disable this tool in the playground" : "Enable this tool in the playground";
    line.append(
      el("td", { class: "mono", text: tool.name }),
      el("td", { text: server.name }),
      el("td", {}, tag(server.status === "active" ? "active" : server.status || "unknown", server.status === "active" ? "green" : "amber")),
      el("td", {}, toggle),
      el("td", { class: "mono", text: `${tool.calls ?? 0}` }),
      el("td", { class: "mono", text: `${tool.ok ?? 0} / ${tool.failed ?? 0}` }),
      el("td", { class: "muted", text: tool.use_cases || "—" }),
    );
    matrix.append(line);
  }
  void loadEngineTools();
}

async function loadEngineTools() {
  const box = $("#mcpTools");
  try {
    const tools = await api("/tools");
    const list = Array.isArray(tools) ? tools : Array.isArray(tools?.tools) ? tools.tools : [];
    box.textContent = "";
    if (!list.length) {
      box.append(el("span", { class: "muted", text: "Engine answered with an empty tool list." }));
      return;
    }
    for (const tool of list) {
      const name = tool.display_name || tool.tool || tool?.function?.name || tool?.definition?.function?.name || "tool";
      const description = tool?.definition?.function?.description || tool?.description || "";
      box.append(el("span", { class: "tag", text: name, title: description }));
    }
  } catch (error) {
    box.textContent = "";
    box.append(el("span", { class: "muted", text: `Engine tools unavailable: ${error.message}` }));
  }
}

/* ---------- prompts ---------- */

function renderPrompts() {
  const data = state.data;
  const prompt = data.system_prompt || {};
  if (!state.spDirty) $("#spContent").value = prompt.content || "";
  $("#spFile").textContent = prompt.file || "prompts/lama-system.md";
  $("#spMeta").textContent = prompt.exists === false ? "missing" : `v${prompt.version ?? 1}${prompt.edited ? " · edited" : " · from file"}`;
  $("#spMeta").className = `tag ${prompt.edited ? "amber" : "green"}`;
  const chars = $("#spContent").value.length;
  const tokens = Math.round(chars / 4.2);
  $("#spChars").textContent = `${chars} chars · ~${tokens} prompt tokens · source ${prompt.source || "n/a"} · sha ${short(prompt.source_sha || "—", 16)}`;

  const usage = $("#spUsage");
  usage.textContent = "";
  const help = data.prompt_usage || {};
  for (const [key, value] of Object.entries(help)) {
    if (key === "summary") continue;
    usage.append(el("div", {}, el("div", { class: "item-name", text: key }), el("div", { class: "item-sub", text: String(value) })));
  }
  usage.prepend(el("p", { class: "doc-note", text: help.summary || "" }));

  const tbody = $("#promptsTable");
  tbody.textContent = "";
  if (!data.prompts.length) emptyRow(tbody, 6, "No prompt stored.");
  for (const row of data.prompts) {
    const actions = el("div", { class: "admin-table-actions" });
    actions.append(btn("Open", "", "prompt-open", row.id), btn("Use in chat", "green", "prompt-use", row.id));
    const line = el("tr");
    line.append(
      el("td", { class: "mono", text: row.name }),
      el("td", { class: "mono", text: `v${row.version}` }),
      el("td", {}, row.is_default ? tag("default", "green") : tag("—")),
      el("td", { class: "mono", text: `${row.runs ?? 0}` }),
      el("td", { class: "mono", text: `${row.content.length}` }),
      el("td", {}, actions),
    );
    tbody.append(line);
  }
}

function promptContentById(id) {
  return state.data?.prompts.find((row) => row.id === id)?.content ?? "";
}

async function saveSystemPrompt() {
  const content = $("#spContent").value.trim();
  if (!content) return toast("Prompt is empty", true);
  const saved = await api("/api/system-prompt", { method: "PUT", body: { content } });
  state.spDirty = false;
  toast(`system prompt saved as v${saved.version}`);
  await loadState({ quiet: true });
  $("#spContent").value = saved.content;
}

/* ---------- tools ---------- */

async function renderTools() {
  try {
    const data = await api("/api/tools");
    setText("#toolsStages", (data.stages || []).join(" → "));
    fillSelect($("#callName"), (data.tools || []).map((tool) => ({ value: tool.name, label: tool.name })), $("#callName").value);
    const list = $("#toolList");
    list.textContent = "";
    for (const tool of data.tools || []) {
      list.append(
        el(
          "div",
          {},
          el("div", { class: "item-name mono", text: tool.name }),
          el("div", { class: "item-sub", text: `${tool.description || ""}${tool.calls ? ` · ${tool.calls} call(s)` : ""}` }),
        ),
      );
    }
    if (!(data.tools || []).length) list.append(el("span", { class: "muted", text: "No tool advertised by the MCP server." }));
  } catch (error) {
    toast(`tools: ${error.message}`, true);
  }
}

/* ---------- settings ---------- */

function renderSettings() {
  const data = state.data;
  const config = data.config;
  setTag("#settingsStatus", "CONNECTED", "green");
  setText("#setAdmin", location.origin);
  setText("#setEngine", config.engine_url);
  setText("#setUds", config.uds_path || "disabled");
  setText("#setDb", config.db);
  setText("#setRoot", config.root);
  setText("#setService", config.service_mode);
  setText("#setOs", `${data.os.platform}/${data.os.arch} · ${data.os.distro} ${data.os.version} · glibc ${data.os.glibc || "n/a"}`);
  setText("#setTls", config.tls.enabled ? `enabled · ${config.tls.cert}` : "disabled (engine-native flags only)");

  const identity = data.identity || {};
  const branding = identity.branding || {};
  const contact = identity.contact || {};
  $("#identityFile").textContent = `${config.root}/identity.json`;
  setText("#idName", identity.name);
  setText("#idVersion", identity.version);
  setText("#idTagline", identity.tagline || "—");
  setText("#idOwner", branding.owner);
  setText("#idOrg", branding.organization);
  setText("#idLocation", branding.location || branding.address || "—");
  setText("#idContact", [contact.email, contact.phone, contact.website].filter(Boolean).join(" · ") || "—");
  setText("#idLicense", identity.license);
  setText("#idProtocol", identity.protocol || "—");
  $("#identityRaw").textContent = JSON.stringify(identity, null, 2);

  const headers = state.headers;
  setText("#hIdentity", headers["x-system-identity"]);
  setText("#hVersion", headers["x-system-version"]);
  setText("#hOwner", headers["x-system-owner"]);
  setText("#hPowered", headers["x-powered-by"]);
  const defaultPrompt = data.prompts.find((prompt) => prompt.is_default);
  setText("#hPrompt", defaultPrompt ? `${defaultPrompt.name} v${defaultPrompt.version}` : "none");

  const notes = $("#safetyNotes");
  notes.textContent = "";
  const items = [
    ["Token gate", "/api/* requires LAMA_ADMIN_TOKEN; a wrong token returns 401 and the UI locks itself."],
    ["Same-origin writes", "POST, PUT and DELETE with a foreign Origin header are refused before they reach the registry."],
    ["Proxy scope", "/v1/* is loopback-only unless LAMA_API_KEY is set for remote callers."],
    ["One engine", "Loading a model stops the current one; TTL expiry unloads it and removes the socket."],
    ["Workspace tools", "Tool calls run inside <root>/workspace and refuse paths outside it."],
    ["No secrets in the UI", "The token lives in this tab's sessionStorage and is never sent anywhere except this origin."],
    ["API first", "Every button in this page calls the same public API, so the server keeps working with the UI closed or deleted."],
  ];
  for (const [title, body] of items) {
    notes.append(el("div", {}, el("div", { class: "item-name", text: title }), el("div", { class: "item-sub", text: body })));
  }
}

/* ---------- modal + forms ---------- */

function closeModal() {
  $("#modalBackdrop").classList.remove("open");
}

function fieldNode(field) {
  const row = el("div", { class: `form-row${field.full ? " full" : ""}` });
  const id = `mf-${field.name}`;
  row.append(el("label", { text: field.label, attrs: { for: id } }));
  let input;
  if (field.type === "select") {
    input = document.createElement("select");
    for (const option of field.options || []) input.append(el("option", { text: option.label, attrs: { value: option.value } }));
    input.value = field.value === undefined ? "" : String(field.value);
  } else if (field.type === "textarea") {
    input = document.createElement("textarea");
    input.rows = field.rows || 5;
    input.value = field.value === undefined ? "" : String(field.value);
  } else if (field.type === "checkbox") {
    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(field.value);
  } else {
    input = document.createElement("input");
    input.type = field.type || "text";
    if (field.value !== undefined) input.value = String(field.value);
    if (field.placeholder) input.placeholder = field.placeholder;
    if (field.min !== undefined) input.min = String(field.min);
    if (field.max !== undefined) input.max = String(field.max);
    if (field.step !== undefined) input.step = String(field.step);
  }
  input.id = id;
  input.name = field.name;
  input.className = field.type === "textarea" ? "field mono" : "field";
  if (field.required) input.required = true;
  row.append(input);
  if (field.hint) row.append(el("p", { class: "sub", text: field.hint, attrs: { style: "margin-top:5px" } }));
  return row;
}

function readForm(form, fields) {
  const values = {};
  for (const field of fields) {
    const input = form.elements.namedItem(field.name);
    if (!input) continue;
    if (field.type === "checkbox") values[field.name] = Boolean(input.checked);
    else if (field.type === "number") values[field.name] = input.value === "" ? undefined : Number(input.value);
    else values[field.name] = input.value.trim();
  }
  return values;
}

function formModal(title, fields, submitLabel, onSubmit) {
  $("#modalTitle").textContent = title;
  const body = $("#modalBody");
  body.textContent = "";
  const form = el("form", { id: "modalForm" });
  const grid = el("div", { class: "form-grid" });
  for (const field of fields) grid.append(fieldNode(field));
  form.append(grid);
  body.append(form);

  const foot = $("#modalFoot");
  foot.textContent = "";
  const cancel = btn("Cancel", "");
  const submit = el("button", { class: "btn green", text: submitLabel, form: "modalForm", type: "submit" });
  foot.append(cancel, submit);
  cancel.addEventListener("click", closeModal);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      await onSubmit(readForm(form, fields));
      closeModal();
    } catch (error) {
      toast(error.message, true);
    } finally {
      submit.disabled = false;
    }
  });

  $("#modalBackdrop").classList.add("open");
  const first = form.querySelector("input, textarea, select");
  if (first) first.focus();
}

/* ---------- forms ---------- */

function modelForm(model) {
  const data = state.data;
  const config = data.config;
  formModal(
    model ? `Edit ${model.name}` : "Register a GGUF model",
    [
      { name: "id", label: "ID (SLUG)", value: model ? model.id : "", placeholder: "auto from name", hint: "Stable registry id. Keep it to update this row." },
      { name: "name", label: "DISPLAY NAME", value: model ? model.name : "", required: true },
      { name: "path", label: "GGUF PATH (ABSOLUTE)", value: model ? model.path : "", placeholder: `${config.models_dir}/model.gguf`, required: true, full: true },
      {
        name: "provider_id",
        label: "PROVIDER / MAPPING",
        type: "select",
        value: model ? model.provider_id : data.providers[0]?.id || "llamacpp",
        options: data.providers.map((provider) => ({ value: provider.id, label: `${provider.name} · ${provider.base_url}` })),
      },
      { name: "model_id", label: "MODEL ID (API ALIAS)", value: model ? model.model_id : "", placeholder: "e.g. qwen2.5-0.5b", hint: "Sent as --alias and as model in API calls." },
      { name: "quant", label: "QUANT", value: model ? model.quant || "" : "", placeholder: "Q4_K_M" },
      { name: "context", label: "CONTEXT", type: "number", value: model ? model.context : 4096, min: 256, step: 256 },
      { name: "max_tokens", label: "MAX TOKENS", type: "number", value: model ? model.max_tokens : 1024, min: 1, step: 1 },
      { name: "temperature", label: "TEMPERATURE", type: "number", value: model ? model.temperature : 0.7, min: 0, max: 2, step: 0.1 },
      { name: "ttl_hours", label: "TTL HOURS", type: "number", value: model ? model.ttl_hours : 4, min: 0, step: 0.01 },
      {
        name: "load_mode",
        label: "LOAD MODE",
        type: "select",
        value: model ? model.load_mode : "auto",
        options: ["auto", "mmap", "none", "mlock", "mmap+mlock", "dio"].map((value) => ({ value, label: value })),
      },
      { name: "enabled", label: "ENABLED", type: "checkbox", value: model ? Boolean(model.enabled) : true },
    ],
    model ? "Save model" : "Register",
    async (values) => {
      if (!values.id) delete values.id;
      await api("/api/models", { method: "POST", body: values });
      toast("model saved");
      await loadState({ quiet: true });
    },
  );

  const form = $("#modalForm");
  const grid = form?.querySelector(".form-grid");
  if (!grid) return;
  const row = el("div", { class: "form-row full" });
  const select = el("select", { class: "field", id: "mf-discover" });
  row.append(el("label", { text: "DISCOVERED GGUF", attrs: { for: "mf-discover" } }), select);
  grid.prepend(row);
  api("/api/models/discover")
    .then((res) => {
      fillSelect(select, [
        { value: "", label: `${res.files.length} GGUF file(s) under ${res.dir}` },
        ...res.files.map((file) => ({ value: file.file, label: `${file.name}${file.registered ? " (registered)" : ""}` })),
      ]);
    })
    .catch((error) => toast(`discover: ${error.message}`, true));
  select.addEventListener("change", () => {
    const file = select.value;
    if (!file) return;
    const name = file.split("/").pop().replace(/\.gguf$/i, "");
    const put = (field, value) => {
      const input = form.elements.namedItem(field);
      if (input) input.value = value;
    };
    put("name", name);
    put("path", file);
    put("model_id", slug(name));
    if (!model) put("id", slug(name));
  });
}

function transportForm() {
  const config = state.data.config;
  const enginePort = (() => {
    try {
      return Number(new URL(config.engine_url).port) || 9931;
    } catch {
      return 9931;
    }
  })();
  formModal(
    "Add transport",
    [
      { name: "name", label: "NAME", required: true, placeholder: "HTTP loopback" },
      { name: "protocol", label: "PROTOCOL", type: "select", value: "http", options: ["http", "https", "uds"].map((value) => ({ value, label: value })) },
      { name: "host", label: "HOST", value: "127.0.0.1" },
      { name: "port", label: "PORT", type: "number", value: enginePort, min: 1, max: 65535 },
      { name: "socket_path", label: "SOCKET PATH (UDS)", value: config.uds_path, full: true },
      { name: "gateway_hint", label: "GATEWAY HINT", type: "textarea", rows: 3, full: true },
    ],
    "Add transport",
    async (values) => {
      await api("/api/transports", { method: "POST", body: values });
      toast("transport saved");
      await loadState({ quiet: true });
    },
  );
}

function documentForm() {
  const data = state.data;
  formModal(
    "Add document",
    [
      { name: "title", label: "TITLE", required: true, placeholder: "Chat over UDS" },
      { name: "slug", label: "SLUG", placeholder: "auto from title" },
      {
        name: "transport_id",
        label: "TRANSPORT",
        type: "select",
        value: data.transports[0] ? data.transports[0].id : "",
        options: data.transports.map((row) => ({ value: row.id, label: `${row.id} (${row.protocol})` })),
      },
      { name: "body", label: "COMMAND / RECIPE", type: "textarea", rows: 7, required: true, full: true, placeholder: "curl -sS --unix-socket /tmp/llama-<uid>/llama.sock http://localhost/v1/models" },
    ],
    "Save document",
    async (values) => {
      await api("/api/documents", { method: "POST", body: values });
      toast("document saved");
      await loadState({ quiet: true });
    },
  );
}

function mcpForm() {
  formModal(
    "Add MCP server",
    [
      { name: "name", label: "NAME", required: true, placeholder: "lama-tools" },
      { name: "transport", label: "TRANSPORT", type: "select", value: "stdio", options: ["stdio", "http", "sse"].map((value) => ({ value, label: value })) },
      { name: "command", label: "COMMAND (STDIO)", placeholder: "node" },
      { name: "args", label: "ARGS (JSON ARRAY)", type: "textarea", rows: 3, value: "[]" },
      { name: "url", label: "URL (HTTP/SSE)", full: true, placeholder: "http://127.0.0.1:9000/mcp" },
      { name: "cwd", label: "CWD", full: true },
      { name: "timeout_ms", label: "TIMEOUT (MS)", type: "number", value: 30000, min: 1000, step: 1000 },
    ],
    "Add server",
    async (values) => {
      let args;
      try {
        args = JSON.parse(values.args || "[]");
      } catch {
        throw new Error("args must be valid JSON array");
      }
      if (!Array.isArray(args)) throw new Error("args must be a JSON array");
      await api("/api/mcp", { method: "POST", body: { ...values, args, env: {} } });
      toast("MCP server saved");
      await loadState({ quiet: true });
    },
  );
}

function promptForm() {
  formModal(
    "Add prompt",
    [
      { name: "name", label: "NAME", required: true, placeholder: "default" },
      { name: "content", label: "CONTENT", type: "textarea", rows: 9, required: true, full: true },
      { name: "is_default", label: "SET AS DEFAULT", type: "checkbox", value: false },
    ],
    "Save prompt",
    async (values) => {
      await api("/api/prompts", { method: "POST", body: values });
      toast("prompt saved");
      await loadState({ quiet: true });
    },
  );
}

/* ---------- shared utils ---------- */

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} copied`);
  } catch {
    const area = el("textarea", { value: text });
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    toast(`${label} copied`);
  }
}

function downloadText(name, text) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, attrs: { download: name } });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`${name} downloaded`);
}

/* ---------- actions ---------- */

const ACTIONS = {
  "model-load": async (id) => {
    toast("starting engine…");
    await api("/api/engine/load", { method: "POST", body: { model_id: id } });
    await loadState({ quiet: true });
    toast("engine started");
  },
  "model-reload": async (id) => {
    await startReload(id);
  },
  "model-edit": (id) => modelForm(state.data.models.find((row) => row.id === id)),
  "model-delete": async (id) => {
    if (!confirm(`Delete ${id} from the registry?`)) return;
    await api(`/api/models/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadState({ quiet: true });
    toast("model deleted");
  },
  "transport-open": async (id) => {
    await openTransport(id);
  },
  "transport-probe": async (id) => {
    const result = await api("/api/transports/probe", { method: "POST", body: { id } });
    $("#modalTitle").textContent = `Probe · ${id}`;
    $("#modalBody").textContent = "";
    $("#modalBody").append(el("pre", { class: "code", text: JSON.stringify(result, null, 2) }));
    $("#modalFoot").textContent = "";
    const close = btn("Close", "");
    close.addEventListener("click", closeModal);
    $("#modalFoot").append(close);
    $("#modalBackdrop").classList.add("open");
  },
  "transport-link": async (id) => {
    const result = await api(`/api/transports/${encodeURIComponent(id)}/link-socket`, { method: "POST" });
    toast(`socket linked → ${result.target}`);
    await loadState({ quiet: true });
  },
  "document-view": (id) => {
    const doc = state.data.documents.find((row) => row.id === id);
    if (!doc) return;
    $("#modalTitle").textContent = doc.title;
    $("#modalBody").textContent = "";
    $("#modalBody").append(el("pre", { class: "code", text: doc.body }));
    $("#modalFoot").textContent = "";
    const close = btn("Close", "");
    const copy = btn("Copy command", "green");
    copy.addEventListener("click", () => copyText(doc.body, "command"));
    close.addEventListener("click", closeModal);
    $("#modalFoot").append(close, copy);
    $("#modalBackdrop").classList.add("open");
  },
  "document-verify": async (id) => {
    toast("verifying…");
    const result = await api(`/api/documents/${encodeURIComponent(id)}/verify`, { method: "POST" });
    toast(`verified: ${result.detail}`);
    await loadState({ quiet: true });
  },
  "mcp-probe": async (id) => {
    toast("probing MCP server…");
    const result = await api(`/api/mcp/${encodeURIComponent(id)}/probe`, { method: "POST" });
    toast(`probe: ${result.detail}`);
    await loadState({ quiet: true });
  },
  "mcp-toggle": async (id) => {
    const row = state.data.mcp.find((item) => item.id === id);
    const result = await api(`/api/mcp/${encodeURIComponent(id)}/toggle`, { method: "POST", body: { enabled: !row?.enabled } });
    toast(`${result.row.name} ${result.row.enabled ? "enabled" : "disabled"}`);
    await loadState({ quiet: true });
  },
  "mcp-delete": async (id) => {
    if (!confirm(`Delete MCP server ${id}?`)) return;
    await api(`/api/mcp/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadState({ quiet: true });
    toast("MCP server deleted");
  },
  "mcp-tool-toggle": async (name, node) => {
    const server = node?.dataset.server;
    const tool = (state.data.mcp.find((row) => row.id === server)?.tools || []).find((row) => row.name === name);
    await api(`/api/mcp/tools/${encodeURIComponent(name)}/toggle`, { method: "POST", body: { enabled: !tool?.enabled } });
    toast(`${name} ${tool?.enabled ? "disabled" : "enabled"}`);
    await loadState({ quiet: true });
  },
  "mcp-info": (id, node) => {
    const cell = node.closest("td");
    const full = cell?.querySelector(".full");
    if (!full) return;
    full.hidden = !full.hidden;
    node.textContent = full.hidden ? "i" : "×";
    node.title = full.hidden ? "Show the full command path" : "Hide the full command path";
  },
  "prompt-open": (id) => {
    const content = promptContentById(id);
    $("#spContent").value = content;
    state.spDirty = true;
    showView("prompts");
    $("#spContent").scrollIntoView({ block: "center", behavior: "smooth" });
    toast(`${id} loaded into the editor (save to version it)`);
  },
  "prompt-use": (id) => {
    showView("chat");
    $("#chatSystem").value = id;
    toast("system prompt selected in the playground");
  },
};

document.addEventListener("click", async (event) => {
  const node = event.target.closest("[data-act]");
  if (!node) return;
  const handler = ACTIONS[node.dataset.act];
  if (!handler) return;
  event.preventDefault();
  node.disabled = true;
  try {
    await handler(node.dataset.id, node);
  } catch (error) {
    toast(error.message, true);
  } finally {
    node.disabled = false;
  }
});

/* ---------- routing + wiring ---------- */

function showView(name) {
  state.view = name;
  for (const section of $$(".view")) section.classList.toggle("active", section.id === `view-${name}`);
  for (const nav of $$("[data-view]")) nav.classList.toggle("active", nav.dataset.view === name);
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  $("#sidebar").classList.remove("open");
  if (state.data) renderView(name);
  if (name === "runtime") void loadRelay();
}

document.addEventListener("click", (event) => {
  const go = event.target.closest("[data-view],[data-go]");
  if (!go) return;
  showView(go.dataset.view || go.dataset.go);
});

document.addEventListener("click", (event) => {
  const copy = event.target.closest("[data-copy]");
  if (!copy) return;
  const node = document.getElementById(copy.dataset.copy);
  if (!node) return;
  const value = (node.textContent || "").trim();
  if (!value || value === "—") return toast("nothing to copy yet", true);
  void copyText(value, copy.dataset.copyLabel || "value");
});

$("#mobileMenu").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
$("#headerSettings").addEventListener("click", () => showView("settings"));
$("#headerRefresh").addEventListener("click", () => loadState().catch((error) => toast(error.message, true)));
$("#refreshAll").addEventListener("click", () => loadState().catch((error) => toast(error.message, true)));

$("#logPause").addEventListener("click", () => {
  state.logPaused = !state.logPaused;
  $("#logPause").textContent = state.logPaused ? "Resume" : "Pause";
  $("#logStatus").textContent = state.logPaused ? "Paused — events are buffered, not shown" : "Live again";
});
$("#logClear").addEventListener("click", () => {
  state.logs = [];
  $("#navLogCount").textContent = "0";
  renderLogsView();
});
$("#logKind").addEventListener("change", renderLogsView);
$("#logSearch").addEventListener("input", renderLogsView);
$("#reqRefresh").addEventListener("click", async () => {
  try {
    state.requests = await api("/api/requests?limit=100");
    renderRequestsTable();
    toast("requests refreshed");
  } catch (error) {
    toast(error.message, true);
  }
});

$("#modelRefresh").addEventListener("click", () => loadState().catch((error) => toast(error.message, true)));
$("#loadModelTop").addEventListener("click", () => modelForm(null));
$("#modelSearch").addEventListener("input", renderModels);
$("#modelProviderFilter").addEventListener("change", renderModels);
$("#modelStatusFilter").addEventListener("change", renderModels);

$("#runtimeRefresh").addEventListener("click", () => loadState().catch((error) => toast(error.message, true)));
$("#rtLoad").addEventListener("click", async () => {
  const modelId = $("#rtModel").value;
  if (!modelId) return toast("Register a model first", true);
  const ttl = $("#rtTtl").value === "" ? undefined : Number($("#rtTtl").value);
  try {
    toast("starting engine…");
    await api("/api/engine/load", { method: "POST", body: { model_id: modelId, ttl_hours: ttl } });
    await loadState({ quiet: true });
    toast("engine started");
  } catch (error) {
    toast(error.message, true);
  }
});
$("#rtReload").addEventListener("click", async () => {
  const modelId = $("#rtModel").value || undefined;
  const ttl = $("#rtTtl").value === "" ? undefined : Number($("#rtTtl").value);
  await startReload(modelId, ttl);
});
$("#relayReload").addEventListener("click", () => void startReload());
$("#rtUnload").addEventListener("click", async () => {
  try {
    await api("/api/engine/unload", { method: "POST" });
    await loadState({ quiet: true });
    toast("engine unloaded");
  } catch (error) {
    toast(error.message, true);
  }
});
$("#rtServiceSave").addEventListener("click", async () => {
  try {
    const mode = $("#rtService").value;
    await api("/api/service/mode", { method: "POST", body: { mode } });
    await loadState({ quiet: true });
    toast(`service mode ${mode}`);
  } catch (error) {
    toast(error.message, true);
  }
});

$("#transportRefresh").addEventListener("click", () => loadState().catch((error) => toast(error.message, true)));
$("#addTransport").addEventListener("click", transportForm);
$("#addDocument").addEventListener("click", documentForm);
$("#tdClose").addEventListener("click", () => {
  state.transport = null;
  $("#transportDetail").hidden = true;
});
$("#tdProbe").addEventListener("click", async () => {
  if (!state.transport) return;
  try {
    const result = await api("/api/transports/probe", { method: "POST", body: { id: state.transport } });
    toast(`probe: ${result.detail || "done"}`);
    await loadState({ quiet: true });
  } catch (error) {
    toast(error.message, true);
  }
});
$("#tdLink").addEventListener("click", async () => {
  if (!state.transport) return;
  try {
    const result = await api(`/api/transports/${encodeURIComponent(state.transport)}/link-socket`, { method: "POST" });
    toast(`socket linked → ${result.target}`);
  } catch (error) {
    toast(error.message, true);
  }
});
$("#tdDocsTxt").addEventListener("click", async () => {
  if (!state.transport) return;
  try {
    const text = await fetchText(`/api/transports/${encodeURIComponent(state.transport)}/docs.txt`);
    downloadText(`${state.transport}-integration.md`, text);
  } catch (error) {
    toast(error.message, true);
  }
});

$("#docsRefresh").addEventListener("click", () => loadIntegration().then(() => toast("docs refreshed")).catch((error) => toast(error.message, true)));
$("#docsDownload").addEventListener("click", async () => {
  try {
    const text = await fetchText("/api/docs/integration.md");
    downloadText("lama-integration.md", text);
  } catch (error) {
    toast(error.message, true);
  }
});
$("#docsLangs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-docs-lang]");
  if (!button) return;
  state.docsLang = button.dataset.docsLang;
  paintIntegration();
});

$("#mcpRefresh").addEventListener("click", () => loadState().catch((error) => toast(error.message, true)));
$("#addMcp").addEventListener("click", mcpForm);
$("#mcpSync").addEventListener("click", async () => {
  try {
    const result = await api("/api/mcp/sync", { method: "POST" });
    toast(`synced ${result.count} stdio server(s)`);
    await loadState({ quiet: true });
  } catch (error) {
    toast(error.message, true);
  }
});
$("#mcpShowConfig").addEventListener("click", async () => {
  try {
    const config = await api("/api/mcp/config");
    $("#mcpConfigPath").textContent = config.path;
    $("#mcpConfig").textContent = JSON.stringify(config.servers, null, 2);
  } catch (error) {
    toast(error.message, true);
  }
});

$("#promptRefresh").addEventListener("click", () => loadState().catch((error) => toast(error.message, true)));
$("#addPrompt").addEventListener("click", promptForm);
$("#spSave").addEventListener("click", () => saveSystemPrompt().catch((error) => toast(error.message, true)));
$("#spSave2").addEventListener("click", () => saveSystemPrompt().catch((error) => toast(error.message, true)));
$("#spReset").addEventListener("click", async () => {
  if (!confirm("Reset the managed prompt to prompts/lama-system.md? Local edits are replaced.")) return;
  try {
    const saved = await api("/api/system-prompt/reset", { method: "POST" });
    state.spDirty = false;
    $("#spContent").value = saved.content;
    await loadState({ quiet: true });
    toast("prompt reset to the file");
  } catch (error) {
    toast(error.message, true);
  }
});
$("#spFileLoad").addEventListener("click", async () => {
  try {
    const prompt = await api("/api/system-prompt");
    if (prompt.file_content === null) return toast("Prompt file is missing", true);
    $("#spContent").value = prompt.file_content;
    state.spDirty = true;
    toast("file copy loaded into the editor (not saved)");
  } catch (error) {
    toast(error.message, true);
  }
});
$("#spCopy").addEventListener("click", () => copyText($("#spContent").value, "prompt"));
$("#spDownload").addEventListener("click", () => downloadText("lama-system.md", $("#spContent").value));
$("#spContent").addEventListener("input", () => {
  state.spDirty = true;
  const chars = $("#spContent").value.length;
  $("#spChars").textContent = `${chars} chars · ~${Math.round(chars / 4.2)} prompt tokens · unsaved edits`;
});

$("#parseRun").addEventListener("click", async () => {
  try {
    const result = await api("/api/tools/parse", { method: "POST", body: { text: $("#parseText").value } });
    $("#parseResult").textContent = JSON.stringify(result, null, 2);
    toast(result.calls.length ? `${result.calls.length} call(s) recovered` : "no call found", !result.calls.length);
  } catch (error) {
    toast(error.message, true);
  }
});
$("#parseClear").addEventListener("click", () => {
  $("#parseText").value = "";
  $("#parseResult").textContent = "No parse performed.";
});
$("#callRun").addEventListener("click", async () => {
  try {
    let args;
    try {
      args = JSON.parse($("#callArgs").value || "{}");
    } catch {
      throw new Error("arguments must be valid JSON");
    }
    const result = await api("/api/tools/call", { method: "POST", body: { name: $("#callName").value, arguments: args } });
    $("#callResult").textContent = JSON.stringify(result, null, 2);
    toast("tool executed");
  } catch (error) {
    $("#callResult").textContent = error.message;
    toast(error.message, true);
  }
});

$("#chatSend").addEventListener("click", () => sendChat());
$("#chatStop").addEventListener("click", () => {
  if (state.chatAbort) state.chatAbort.abort();
});
$("#chatPrompt").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void sendChat();
  }
});
$("#chatClear").addEventListener("click", () => {
  if (state.chatAbort) state.chatAbort.abort();
  state.chat = [];
  $("#chatMeta").textContent = "";
  $("#chatStatus").textContent = "No request sent yet";
  setTag("#chatBadge", "NO REQUEST YET", "amber");
  renderChatTranscript();
});
$("#chatExport").addEventListener("click", () => copyText(JSON.stringify(state.chat, null, 2), "transcript"));
$("#chatModel").addEventListener("change", () => {
  const model = state.data?.models.find((row) => row.id === $("#chatModel").value);
  if (!model) return;
  state.chatModel = model.id;
  $("#chatTemperature").value = model.temperature;
  $("#chatMaxTokens").value = model.max_tokens;
});

$("#admConnect").addEventListener("click", async () => {
  const value = $("#admToken").value.trim();
  if (!value) return toast("Paste the token first", true);
  state.token = value;
  try {
    await loadState({ quiet: true });
    sessionStorage.setItem(TOKEN_KEY, value);
    $("#admToken").value = "";
    toast("connected");
  } catch (error) {
    state.token = "";
    sessionStorage.removeItem(TOKEN_KEY);
    $("#authError").textContent = error.message;
    $("#authGate").hidden = false;
  }
});
$("#admForget").addEventListener("click", () => {
  lock("Token forgotten. Paste it again to reconnect.");
  $("#admToken").value = "";
});

$("#authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = $("#authToken").value.trim();
  if (!value) return;
  state.token = value;
  try {
    await loadState({ quiet: true });
    sessionStorage.setItem(TOKEN_KEY, value);
    $("#authToken").value = "";
    unlock();
    toast("connected");
  } catch (error) {
    state.token = "";
    sessionStorage.removeItem(TOKEN_KEY);
    $("#authError").textContent = error.message;
  }
});

$("#modalCancel").addEventListener("click", closeModal);
$("#modalClose").addEventListener("click", closeModal);
$("#modalBackdrop").addEventListener("click", (event) => {
  if (event.target === $("#modalBackdrop")) closeModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModal();
});

/* ---------- boot ---------- */

renderChatTranscript();
showView(state.view);
startRelayPolling();
if (!state.token) {
  lock("");
} else {
  loadState({ quiet: true }).catch((error) => lock(error.message));
}

setInterval(() => {
  if (document.hidden || state.busy || !state.token) return;
  if ($("#modalBackdrop").classList.contains("open")) return;
  loadState({ quiet: true }).catch(() => {});
}, 30000);
