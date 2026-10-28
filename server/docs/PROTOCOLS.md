# Calling the lama engine — protocol cheatsheet (v3, verified 2026-10-28)

Every snippet follows a published specification — llama.cpp server docs (llama.app),
llama.cpp `docs/function-calling.md`, and Vercel AI Gateway `sdks-and-apis`.
No invented formats, no SDK dependency in this stack.

Architecture: `zombie-gateway (5252) → lama manager (9933) → engine (9931, TCP + UDS)`.
The engine stays stock; the manager only spawns/proxies/downloads/logs.
`<alias>` = model name from `GET /api/models`.

## 1. OpenAI Chat Completions — `POST /v1/chat/completions`

```bash
curl http://127.0.0.1:9933/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"<alias>","messages":[{"role":"user","content":"Hi"}]}'
```

Verified live (Qwen3.5-4B): `object:"chat.completion"`, `choices[].finish_reason`,
`usage.total_tokens`. Streaming (`"stream": true`) yields SSE frames with
`object:"chat.completion.chunk"` (verified, 2+ frames).

SDK form (Vercel AI Gateway pattern — only the base URL changes):

```js
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://127.0.0.1:9933/v1", apiKey: "not-needed" });
```

Model ids follow Vercel's `provider/model` slug convention: ours is `llamacpp/<alias>`.
The lama admin shows that id per model (Models → **mapping id**) together with the
live gateway catalogue (`GET <gateway>/v1/models`), so `live` / `pending-restart` /
`catalog-only` / `not-mapped` is visible instead of guessed. The `map` button writes
`CP_LLAMACPP_BASE_URL=<manager>` + the alias into the gateway env (backup first);
the gateway re-reads it at start, hence `pending-restart` until it is restarted.
Full audit trail: `server/docs/AUDIT.md`.

## 2. Anthropic Messages — `POST /v1/messages`

```bash
curl http://127.0.0.1:9933/v1/messages \
  -H "content-type: application/json" -H "anthropic-version: 2023-06-01" \
  -d '{"model":"<alias>","max_tokens":16,"messages":[{"role":"user","content":"Hi"}]}'
```

Verified: top-level `content` array of typed blocks (thinking models emit
`"thinking"` blocks), `stop_reason`.

## 3. Tool calling (native, template-dependent)

`tools: [{type:"function", function:{name, description, parameters}}]` → success is
`finish_reason:"tool_calls"` with `message.tool_calls[].function.{name,arguments}`.
Verified live: `get_current_weather({"location":"Istanbul"})` on Qwen3.5-4B (~74 s on 4 CPU cores).
A tool-untrained model fails here — a model-capability limit, not a server limit.

## 4. UDS — Unix domain socket

The engine binds TCP + UDS in one process: `--host "127.0.0.1,/tmp/llama-<uid>/llama.sock"`.
Socket security (verified: `700` dir, `660` socket):

- directory `/tmp/llama-<uid>/` mode `0700` — other users cannot even traverse;
- socket file mode `0660` — only owner + group may connect;
- `/tmp/` sticky bit additionally prevents cross-user deletion;
- stale socket (left by a killed server) is unlinked before each spawn — otherwise
  the bind fails with "couldn't bind HTTP server socket".

```bash
curl --unix-socket /tmp/llama-1000/llama.sock http://localhost/health
```

## 5. TLS — engine-native only, honest skipping

TLS comes from llama.cpp's own `--ssl-key-file` / `--ssl-cert-file` (set
`LAMA_SSL_KEY`/`LAMA_SSL_CERT` in `lama/.env`). We never write a custom TLS layer.

**Known engine behaviour (verified in logs):** when the SSL flags are set, the
whole engine becomes TLS-only — including the UDS listener (`listening on
https://…` in the llama log). Plaintext probes then fail by design; the manager's
engine link is TLS-aware and its `http` test reports this instead of hiding it.

When TLS is **off** (`LAMA_SSL_KEY`/`LAMA_SSL_CERT` empty — the state
`templates/env.template` ships with; this machine runs with TLS **on**), the `https`
self-test reports exactly:
`skipped: LAMA_SSL_KEY/LAMA_SSL_CERT not configured — engine-native TLS is off
(by design)` — verified live. No fake pass, ever.

## 6. Download ledger — `models/catalog.json`

`POST /api/download {repo, file}` streams the GGUF from Hugging Face into
`lama/models/` and records `{repo, file, path, size, downloaded_at}` in
`models/catalog.json` (atomic tmp+rename writes). A repeat request for the same
`repo+file` returns `cached:true` and downloads nothing (verified live:
second call returned `cached:true, "already in catalog — not re-downloaded"`).

## 7. MCP fallback (documented flow)

```
model calls tools natively      → engine chat template handles it (finish_reason: tool_calls)
model cannot call tools         → llama.cpp native MCP: --mcp-servers-config <config.json>
                                  (experimental flag, per `llama serve --help` line 569)
                                  the MCP server resolves tools against the zombie-gateway
                                  (LAMA_GATEWAY_BASE_URL http://127.0.0.1:5252; HTTP or UDS per config)
gateway down                    → engine keeps serving; only the fallback tools stop
```

Config template: `lama/templates/mcp-gateway.json`. The Vercel AI SDK is an
**optional client-side surface behind the gateway**, never a lama dependency —
lama uses Node built-ins only.

## 8. Admin API surface (manager, `127.0.0.1:9933`)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/status` | manager uptime, engine health, TLS/UDS/MCP state, loaded model, TTL |
| GET | `/api/models` | scanned GGUFs + catalog metadata |
| POST | `/api/sync` | rescan model dirs at runtime, returns count + list |
| POST | `/api/load` | `{name, ctx, ttl_hours}` — spawn engine, wait for health (≤180 s) |
| POST | `/api/unload` | SIGTERM (SIGKILL after 5 s) |
| POST | `/api/test` | `{kind}` — http/https/uds/openai/stream/anthropic/tools, honest skip |
| GET | `/api/metrics` | totals, per-model matrix (calls/errors/total/avg/max), per-test matrix |
| GET | `/api/logs` | `mgmt.jsonl` tail (`?n=`) |
| GET | `/api/engine-logs` | tail of the live engine log (`llama-<alias>.log`) |
| POST | `/api/download` | `{repo, file}` — HF download, deduped via `models/catalog.json` |
| POST | `/api/map` | `{name}` — writes `CP_LLAMACPP_BASE_URL=<manager>` + alias into the gateway env (backup first) |
| GET | `/api/runtime` | one snapshot: engine (incl. `version`), slots, counters, memory (mmap), MCP config, chat-lab stats |
| GET | `/api/config` | db path, data dir, bridge path, transports, generated MCP config, default prompt |
| GET | `/api/preflight` | runtime checks: OS, node, llama.cpp binary+version, models, server, model, OpenAI probe, Anthropic probe |

`/api/status.llama.version` and `/api/runtime.engine.version` carry
`{binary:{raw,version,build,commit}, props:{raw,build,commit}|null, build, commit,
match, source}` — `llama --version` and `/props.build_info` quoted verbatim and
compared (`match:false` = the binary on disk differs from the running engine).

Self-tests assert documented response shapes and report honest timing
(fixed 2026-10-28: latency is measured after the work completes, not before).
Test results are logged as `kind:"test"` with the test name in `test`, so the
self-test matrix survives a restart.

## 9. SQLite control plane — `data/lama.db`

`node:sqlite` (built into Node ≥ 22.13, no npm dependency), WAL mode, file
`0600`, `data/` `0700`. Numbered migrations live in `server/lib/db.mjs` and are
applied at manager start.

| Table | Rows are… |
| --- | --- |
| `system_prompts` | identities (name, slug, scope, default flag, current version id) |
| `system_prompt_versions` | immutable content + checksum; edits append, never rewrite |
| `prompt_bindings` | prompt → global/model/mcp_server, priority, enabled |
| `mcp_servers` | transport + connection fields + last probe summary |
| `mcp_tools` | tools from the last successful probe |
| `mcp_probes` | append-only probe history |
| `chat_runs` | one row per chat-lab run (format, tokens, TTFT, finish, error) |
| `audit_events` | config mutations with actor/entity/detail |
| `app_settings` | key/value (`default_prompt_id`, …) |

Verified live: seeded `lama-default` v1, appended v2 through
`POST /api/prompts/:id/versions`, resolved v2 as default, and 8 chat runs with
524 prompt / 367 completion tokens in `chat_runs`.

## 10. Transports — what the engine accepts vs what the DB offers

| DB `transport` | Probe | Engine config entry | Evidence |
| --- | --- | --- | --- |
| `stdio` | spawn + `initialize` + `tools/list` over NDJSON | `{command, args, env, cwd, timeout_ms}` | live: stub discovered 1 tool |
| `http` | JSON-RPC `initialize` + `tools/list` POST (SSE replies parsed) | `node bridge.mjs <spec>` | live: 1 tool |
| `sse` | same POST; falls back to legacy GET endpoint handshake | `node bridge.mjs <spec>` | same code path as http |
| `uds` | same JSON-RPC over `unix:///…sock/mcp` | `node bridge.mjs <spec>` | live: 1 tool |
| `openai` | `GET /v1/models`, fallback 1-token `/v1/chat/completions` | bridge exposes `openai_chat` | live: 1 model, tool call returned `pong` |
| `anthropic` | `GET /v1/models`, fallback `/v1/messages` | bridge exposes `anthropic_messages` | live: 1 model, tool call returned `hi` |

llama.cpp 0.7.0-dev's own MCP client is **stdio only** — the engine log prints
`MCP server '<name>' has no command, skipping` for anything else. The bridge is
the honest way to keep HTTP/SSE/UDS/OpenAI/Anthropic in the same UI. Verified
live with `stub-echo`: `MCP warmup: 'stub-echo' discovered 1 tools` and
`Added 1 MCP tools`.

## 11. Chat lab formats

| `format` | Endpoint | Notes |
| --- | --- | --- |
| `openai` | `POST /v1/chat/completions` | `stream:true` adds `stream_options.include_usage` (honoured by build 11941: the final chunk carries `usage`, verified live); TTFT measured on first delta |
| `tools` | same + `tools[]` | success is `finish_reason:tool_calls`; a model limit is reported as such |
| `anthropic` | `POST /v1/messages` | `thinking` blocks are shown as `[thinking] …` when no text block exists |
| `responses` | `POST /v1/responses` | `output[].content[].type=="output_text"`, else `reasoning_text`/`summary_text`; the response has no top-level `output_text` field (that is an SDK convenience) |
| `embeddings` | `POST /v1/embeddings` | requires engine `--embeddings` (docs: pooling ≠ none). Without it the exact engine error is stored: `501 not_supported_error "This server does not support embeddings. Start it with \`--embeddings\`"` |

`/tokenize` and `/detokenize` are **POST only** — `GET /tokenize` returns 404
`File not found` (live), `POST` returns `{"tokens":[…]}`. The manager's `/v1` proxy
forwards the method unchanged, so a GET is refused by the engine, not by us.

Usage is read from the response (`prompt_tokens`/`completion_tokens` or
`input_tokens`/`output_tokens`). No token count is ever estimated.

## 12. Runtime truth (cards + metrics)

- `/props` → `model_alias`, `model_ftype`, `total_slots`,
  `endpoint_metrics`, `endpoint_slots`, `endpoint_props`, `chat_template_caps`,
  `build_info`. **No top-level `n_ctx`** in build 11941 — context size lives in
  `default_generation_settings.n_ctx`, which `pickProps` falls back to.
- `/slots` → per-slot `is_processing` → card state `generating` / `idle` /
  `not-loaded`.
- `/metrics` → exact documented names only: `llamacpp:prompt_tokens_total`,
  `llamacpp:tokens_predicted_total`, `llamacpp:requests_processing`,
  `llamacpp:requests_deferred`, `llamacpp:n_decode_total` (engine must run with
  `--metrics`; disabled → the endpoint answers `501 not_supported_error`, so the
  manager reports `metrics_enabled:false` and `missing[]` instead of inventing
  numbers). llama.cpp documents **no** KV-cache gauge, so `kv_cache_usage_ratio`
  is always `null` — never `0`. A substring match was a real bug here: the
  `*_seconds` gauges contain "prompt_tokens" too (see `server/docs/AUDIT.md`).
- `/proc/<pid>/maps` → **the only mmap source**: mapped regions of the GGUF,
  each one's size, and whether the mapping is shared (`r--s`, MAP_SHARED) or
  private. `/props` exposes no mmap state at all; the engine log (when it
  prints `*_Mapped … buffer size`) is kept as `memory.log_hint` and never
  counted as the answer. Verified live: 1 region, 1848.3 MB shared,
  0 `/dev/shm` segments. Without a pid (engine down) the fields are `null`
  with a `note`, not `0`.
