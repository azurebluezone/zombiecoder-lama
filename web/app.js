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
  audit: [],
  chat: [],
  view: (location.hash || "#dashboard").replace(/^#/, ""),
  headers: {},
  busy: false,
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
  const node = el("span", { class: `tag ${color || ""}`.trim(), text });
  return node;
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

function fmtTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function bytes(value) {
  if (!value) return "—";
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
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
  const cell = el("td", { class: "muted", text: message, attrs: { colspan: columns } });
  row.append(cell);
  tbody.append(row);
}

/* ---------- transport ---------- */

function lock(message) {
  state.token = "";
  sessionStorage.removeItem(TOKEN_KEY);
  $("#authGate").hidden = false;
  $("#authError").textContent = message || "";
  const input = $("#authToken");
  if (input) setTimeout(() => input.focus(), 40);
}

function unlock() {
  $("#authGate").hidden = true;
  $("#authError").textContent = "";
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

let toastTimer = null;
function toast(message, bad = false) {
  const node = $("#toast");
  node.textContent = String(message);
  node.classList.toggle("bad", Boolean(bad));
  node.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 4500);
}

/* ---------- state loading ---------- */

async function loadState({ quiet = false } = {}) {
  const data = await api("/api/state");
  state.data = data;
  state.audit = Array.isArray(data.audit) ? data.audit : [];
  unlock();
  renderChrome();
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
    models: renderModels,
    chat: renderChatView,
    runtime: renderRuntime,
    transports: renderTransports,
    mcp: renderMcp,
    prompts: renderPrompts,
    tools: renderTools,
    settings: renderSettings,
  };
  const render = renderers[name] || renderOverview;
  render();
}

/* ---------- views ---------- */

function renderOverview() {
  const data = state.data;
  const engine = data.engine || {};
  const loaded = data.models.find((model) => model.id === engine.model_id);

  setText("#statModels", data.models.length);
  setText("#statModelsNote", `${data.models.filter((model) => model.enabled).length} enabled · registry`);
  setTag("#statEngine", engine.status, engine.status === "running" ? "green" : engine.status === "error" ? "red" : "amber");
  setText("#statEngineNote", engine.pid ? `pid ${engine.pid} · ${data.config.engine_url}` : "engine idle");
  setText("#statLoaded", loaded ? loaded.name : "none");
  setText("#statLoadedNote", engine.expires_at ? `expires ${fmtTime(engine.expires_at)}` : engine.model_id ? "no expiry" : "nothing loaded");
  setText("#statRegistry", `${data.mcp.length} · ${data.transports.length} · ${data.documents.length}`);
  setText("#statRegistryNote", "mcp · transports · documents");

  setTag("#dashMode", engine.status === "running" ? "ENGINE UP" : "ENGINE IDLE", engine.status === "running" ? "green" : "amber");
  setText("#dashEngine", data.config.engine_url);
  setText("#dashAdmin", location.origin);
  setText("#dashUds", data.config.uds_path || "disabled");
  setText("#dashDb", data.config.db);
  const provider = data.providers[0];
  setText("#dashProvider", provider ? `${provider.name} · ${provider.base_url}` : "—");
  setText("#dashService", data.config.service_mode);
  setText("#dashIdentity", `${data.identity.name} ${data.identity.version}`);
  setText("#lastUpdate", new Date().toLocaleTimeString());

  renderActivityRows();
}

function renderActivityRows() {
  const tbody = $("#activityTable");
  tbody.textContent = "";
  const query = ($("#activitySearch").value || "").trim().toLowerCase();
  const rows = state.audit.filter((row) =>
    !query || [row.action, row.target, row.actor, row.detail].some((value) => String(value ?? "").toLowerCase().includes(query)),
  );
  if (!rows.length) return emptyRow(tbody, 5, query ? "No audit event matches the filter." : "No audit events yet.");
  for (const row of rows.slice(0, 100)) {
    const line = el("tr");
    line.append(
      el("td", { class: "mono", text: fmtTime(row.at) }),
      el("td", { text: row.actor || "—" }),
      el("td", { text: row.action || "—" }),
      el("td", { class: "mono", text: short(row.target, 42), title: row.target || "" }),
      el("td", { class: "muted", text: short(row.detail, 90), title: row.detail || "" }),
    );
    tbody.append(line);
  }
}

function renderModels() {
  const data = state.data;
  const engine = data.engine || {};
  const provider = $("#modelProviderFilter").value || "all";
  fillSelect(
    $("#modelProviderFilter"),
    [{ value: "all", label: "All providers" }, ...data.providers.map((row) => ({ value: row.id, label: row.name }))],
    provider,
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
}

function modelCard(model, active) {
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
    tag(`ctx ${model.context ?? "—"}`),
    tag(`max ${model.max_tokens ?? "—"}`),
    tag(`ttl ${model.ttl_hours ? `${model.ttl_hours}h` : "none"}`),
    tag(`mode ${model.load_mode}`),
  );

  const stats = el("div", { class: "model-card-stats" });
  for (const [label, value] of [
    ["MODEL ID", model.model_id],
    ["QUANT", model.quant || "—"],
    ["LOAD MODE", model.load_mode],
    ["TTL", model.ttl_hours ? `${model.ttl_hours} h` : "none"],
  ]) {
    stats.append(el("div", { class: "model-card-stat" }, el("span", { text: label }), el("strong", { text: value })));
  }

  const actions = el("div", { class: "model-card-actions" });
  const load = btn(active ? "Reload" : "Load", "green", active ? "model-reload" : "model-load", model.id);
  actions.append(load, btn("Edit", "", "model-edit", model.id), btn("Delete", "danger", "model-delete", model.id));
  if (active) actions.lastChild.disabled = true;

  card.append(head, tags, stats, actions);
  return card;
}

function renderChatView() {
  const data = state.data;
  fillSelect(
    $("#chatModel"),
    data.models.map((model) => ({ value: model.id, label: `${model.name} · ${model.model_id}` })),
  );
  const previous = $("#chatSystem").value;
  fillSelect(
    $("#chatSystem"),
    [{ value: "", label: "None" }, ...data.prompts.map((prompt) => ({ value: prompt.id, label: `${prompt.name} v${prompt.version}` }))],
    previous,
  );
  const model = data.models.find((row) => row.id === $("#chatModel").value);
  // Only reset the knobs when the selected model actually changes; auto refresh must not
  // overwrite values the user typed.
  if (model && state.chatModel !== model.id) {
    state.chatModel = model.id;
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
  for (const message of state.chat) box.append(el("div", { class: `chat-msg ${message.role}`, text: message.content }));
  box.scrollTop = box.scrollHeight;
}

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
  const mmap = engine.mmap;
  setText("#runtimeMmap", mmap ? (mmap.mapped ? "mapped" : "not mapped") : "—");
  setText("#runtimeMmapNote", mmap ? `${mmap.detail}${mmap.perms ? ` · ${mmap.perms}` : ""}${mmap.bytes ? ` · ${bytes(mmap.bytes)}` : ""}` : "/proc/<pid>/maps");

  setText("#rtSocket", engine.socket_path || data.config.uds_path || "disabled");
  setText("#rtPort", engine.port || "—");
  setText("#rtBuild", engine.build || "—");
  const provider = data.providers[0];
  setText("#rtProvider", provider ? `${provider.name} · ${provider.base_url}` : "—");
  setText("#rtError", engine.last_error || "none");
  $("#rtRaw").textContent = JSON.stringify(engine, null, 2);
}

function renderTransports() {
  const data = state.data;
  const transports = $("#transportsTable");
  transports.textContent = "";
  if (!data.transports.length) emptyRow(transports, 5, "No transport registered.");
  for (const row of data.transports) {
    const endpoint = row.protocol === "uds" ? row.socket_path : `${row.protocol}://${row.host}:${row.port}`;
    const actions = el("div", { class: "admin-table-actions" });
    actions.append(btn("Probe", "", "transport-probe", row.id));
    if (row.protocol === "uds") actions.append(btn("Link socket", "", "transport-link", row.id));
    const line = el("tr");
    line.append(
      el("td", { class: "mono", text: row.id }),
      el("td", {}, tag(row.protocol, row.protocol === "https" ? "green" : "")),
      el("td", { class: "mono", text: endpoint || "—", title: endpoint || "" }),
      el("td", { class: "muted", text: short(row.gateway_hint, 80), title: row.gateway_hint || "" }),
      el("td", {}, actions),
    );
    transports.append(line);
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
}

function renderMcp() {
  const data = state.data;
  const tbody = $("#mcpTable");
  tbody.textContent = "";
  $("#mcpCount").textContent = `${data.mcp.length} server(s)`;
  if (!data.mcp.length) emptyRow(tbody, 6, "No MCP server registered.");
  for (const row of data.mcp) {
    const target = row.transport === "stdio" ? [row.command, ...(row.args || [])].filter(Boolean).join(" ") : row.url;
    const actions = el("div", { class: "admin-table-actions" });
    actions.append(btn("Probe", "", "mcp-probe", row.id), btn("Delete", "danger", "mcp-delete", row.id));
    const line = el("tr");
    line.append(
      el("td", {}, el("div", { class: "item-name", text: row.name }), el("div", { class: "item-sub mono", text: row.id })),
      el("td", {}, tag(row.transport, row.transport === "stdio" ? "green" : "amber"), row.enabled ? "" : tag("disabled", "red")),
      el("td", { class: "mono", text: short(target, 70), title: target || "" }),
      el("td", { class: "muted", text: (row.env_keys || []).join(", ") || "—" }),
      el("td", { class: "mono", text: `${row.timeout_ms} ms` }),
      el("td", {}, actions),
    );
    tbody.append(line);
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

function renderPrompts() {
  const tbody = $("#promptsTable");
  tbody.textContent = "";
  if (!state.data.prompts.length) return emptyRow(tbody, 5, "No prompt stored.");
  for (const prompt of state.data.prompts) {
    const actions = el("div", { class: "admin-table-actions" });
    actions.append(btn("View", "", "prompt-view", prompt.id), btn("Use", "green", "prompt-use", prompt.id));
    const line = el("tr");
    line.append(
      el("td", { class: "mono", text: prompt.name }),
      el("td", { class: "mono", text: `v${prompt.version}` }),
      el("td", {}, prompt.is_default ? tag("default", "green") : tag("—")),
      el("td", { class: "muted", text: short(prompt.content, 100), title: prompt.content }),
      el("td", {}, actions),
    );
    tbody.append(line);
  }
}

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
          el("div", { class: "item-sub", text: tool.description || "" }),
        ),
      );
    }
    if (!(data.tools || []).length) list.append(el("span", { class: "muted", text: "No tool advertised by the MCP server." }));
  } catch (error) {
    toast(`tools: ${error.message}`, true);
  }
}

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
  setText("#identityFile", `${config.root}/identity.json`);
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
  if (field.hint) row.append(el("p", { class: "sub", text: field.hint, style: "margin-top:5px" }));
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

/* ---------- actions ---------- */

function modelForm(model) {
  const config = state.data.config;
  formModal(
    model ? `Edit ${model.name}` : "Register a GGUF model",
    [
      { name: "id", label: "ID (SLUG)", value: model ? model.id : "", placeholder: "auto from name", hint: "Stable registry id. Keep it to update this row." },
      { name: "name", label: "DISPLAY NAME", value: model ? model.name : "", required: true },
      { name: "path", label: "GGUF PATH (ABSOLUTE)", value: model ? model.path : "", placeholder: `${config.models_dir}/model.gguf`, required: true, full: true },
      { name: "model_id", label: "MODEL ID (API)", value: model ? model.model_id : "", placeholder: "e.g. qwen2.5-0.5b" },
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
      {
        name: "protocol",
        label: "PROTOCOL",
        type: "select",
        value: "http",
        options: ["http", "https", "uds"].map((value) => ({ value, label: value })),
      },
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
      {
        name: "transport",
        label: "TRANSPORT",
        type: "select",
        value: "stdio",
        options: ["stdio", "http", "sse"].map((value) => ({ value, label: value })),
      },
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

async function sendChat() {
  if (state.busy) return;
  const data = state.data;
  if (!data) return toast("Not connected yet", true);
  const model = data.models.find((row) => row.id === $("#chatModel").value);
  if (!model) return toast("Register a model first", true);
  const text = $("#chatPrompt").value.trim();
  if (!text) return;

  const messages = [];
  const systemId = $("#chatSystem").value;
  if (systemId) {
    const prompt = data.prompts.find((row) => row.id === systemId);
    if (prompt) messages.push({ role: "system", content: prompt.content });
  }
  for (const message of state.chat) messages.push({ role: message.role, content: message.content });
  messages.push({ role: "user", content: text });

  state.busy = true;
  $("#chatSend").disabled = true;
  setTag("#chatBadge", "SENDING", "amber");
  $("#chatStatus").textContent = "Waiting for the engine…";
  const started = performance.now();
  try {
    const response = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: model.model_id,
        temperature: Number($("#chatTemperature").value),
        max_tokens: Number($("#chatMaxTokens").value),
        messages,
      }),
    });
    const raw = await response.text();
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const detail = payload && payload.error ? payload.error.message || payload.error : `HTTP ${response.status}`;
      throw new Error(detail);
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("engine returned no message content");
    const ms = Math.round(performance.now() - started);
    state.chat.push({ role: "user", content: text }, { role: "assistant", content });
    $("#chatPrompt").value = "";
    renderChatTranscript();
    setTag("#chatBadge", "LIVE", "green");
    $("#chatStatus").textContent = `HTTP ${response.status} · ${ms} ms`;
    $("#chatMeta").textContent = "";
    const usage = payload.usage || {};
    for (const [label, value] of [
      ["model", model.model_id],
      ["latency", `${ms} ms`],
      ["prompt", usage.prompt_tokens],
      ["completion", usage.completion_tokens],
    ]) {
      $("#chatMeta").append(tag(`${label} ${value === undefined ? "—" : value}`));
    }
  } catch (error) {
    setTag("#chatBadge", "FAILED", "red");
    $("#chatStatus").textContent = error.message;
    toast(error.message, true);
  } finally {
    state.busy = false;
    $("#chatSend").disabled = false;
  }
}

const ACTIONS = {
  "model-load": async (id) => {
    toast("starting engine…");
    await api("/api/engine/load", { method: "POST", body: { model_id: id } });
    await loadState({ quiet: true });
    toast("engine started");
  },
  "model-reload": async (id) => {
    toast("reloading engine…");
    await api("/api/engine/reload", { method: "POST", body: { model_id: id } });
    await loadState({ quiet: true });
    toast("engine reloaded");
  },
  "model-edit": (id) => modelForm(state.data.models.find((row) => row.id === id)),
  "model-delete": async (id) => {
    if (!confirm(`Delete ${id} from the registry?`)) return;
    await api(`/api/models/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadState({ quiet: true });
    toast("model deleted");
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
  "mcp-delete": async (id) => {
    if (!confirm(`Delete MCP server ${id}?`)) return;
    await api(`/api/mcp/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadState({ quiet: true });
    toast("MCP server deleted");
  },
  "prompt-view": (id) => {
    const prompt = state.data.prompts.find((row) => row.id === id);
    if (!prompt) return;
    $("#modalTitle").textContent = `${prompt.name} v${prompt.version}`;
    $("#modalBody").textContent = "";
    $("#modalBody").append(el("pre", { class: "code", text: prompt.content }));
    $("#modalFoot").textContent = "";
    const close = btn("Close", "");
    const copy = btn("Copy", "green");
    copy.addEventListener("click", () => copyText(prompt.content, "prompt"));
    close.addEventListener("click", closeModal);
    $("#modalFoot").append(close, copy);
    $("#modalBackdrop").classList.add("open");
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
    await handler(node.dataset.id);
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
}

document.addEventListener("click", (event) => {
  const go = event.target.closest("[data-view],[data-go]");
  if (!go) return;
  showView(go.dataset.view || go.dataset.go);
});

$("#mobileMenu").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
$("#headerSettings").addEventListener("click", () => showView("settings"));
$("#headerRefresh").addEventListener("click", () => loadState().catch((error) => toast(error.message, true)));
$("#refreshAll").addEventListener("click", () => loadState().catch((error) => toast(error.message, true)));
$("#activityRefresh").addEventListener("click", async () => {
  try {
    state.audit = await api("/api/audit?limit=100");
    renderActivityRows();
    toast("audit refreshed");
  } catch (error) {
    toast(error.message, true);
  }
});
$("#activitySearch").addEventListener("input", renderActivityRows);

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
  try {
    toast("reloading engine…");
    await api("/api/engine/reload", { method: "POST", body: { model_id: modelId, ttl_hours: ttl } });
    await loadState({ quiet: true });
    toast("engine reloaded");
  } catch (error) {
    toast(error.message, true);
  }
});
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

$("#chatSend").addEventListener("click", sendChat);
$("#chatPrompt").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void sendChat();
  }
});
$("#chatClear").addEventListener("click", () => {
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
    const data = await api("/api/state");
    sessionStorage.setItem(TOKEN_KEY, value);
    state.data = data;
    state.audit = Array.isArray(data.audit) ? data.audit : [];
    $("#admToken").value = "";
    renderChrome();
    renderView(state.view);
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
    const data = await api("/api/state");
    sessionStorage.setItem(TOKEN_KEY, value);
    state.data = data;
    state.audit = Array.isArray(data.audit) ? data.audit : [];
    $("#authToken").value = "";
    unlock();
    renderChrome();
    renderView(state.view);
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
if (!state.token) {
  lock("");
} else {
  loadState({ quiet: true }).catch((error) => lock(error.message));
}

setInterval(() => {
  if (document.hidden || state.busy || !state.token) return;
  if ($("#modalBackdrop").classList.contains("open")) return;
  loadState({ quiet: true }).catch(() => {});
}, 20000);
