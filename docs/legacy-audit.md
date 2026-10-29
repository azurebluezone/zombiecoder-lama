# Code ↔ llama.cpp docs audit (2026-10-28)

Line-by-line comparison of this repo against the two upstream sources that describe
the engine we spawn:

| Source | Local copy | Lines | What it is |
| --- | --- | --- | --- |
| `ggml-org/llama.cpp` `tools/server/README.md` (master) | `/tmp/opencode/llama-server-readme.md` | 2612 | server API + flags reference |
| `llama serve --help` of the installed binary | `/tmp/opencode/llama-serve-help.txt` | 753 | what *this* build actually accepts |

Installed engine: `llama version` → `0.7.0-dev (build 11941, commit 19ff817fb)`,
`/props.build_info` → `b11941-19ff817fb` (both live).

Rule used for every row: a mismatch is only "fixed" when a live probe proves the
new behaviour. `UNVERIFIED` means the probe was not run.

## 1. Findings that were real bugs (fixed)

| # | Where | What was wrong | Evidence | Fix |
| --- | --- | --- | --- | --- |
| 1 | `server/server.mjs` `engineCounters` (old) | Substring match `includes("prompt_tokens")` could return `llamacpp:prompt_tokens_seconds` — a **tokens/second gauge** — as a token count; same risk for `tokens_predicted_seconds_total` | live `/metrics` lists both `prompt_tokens_total` and `prompt_tokens_seconds` (15 `llamacpp:*` lines) | `server/lib/runtime.mjs` now looks up the exact documented names and exposes a `missing[]` list |
| 2 | `server/server.mjs` `engineCounters` (old) | `kv_cache_usage_ratio` was picked from a metric that **does not exist**; docs' "Available metrics" table has no KV-cache gauge | README §`GET /metrics` metric table (15 rows) + live `/metrics` | field kept but documented as `null` — never `0`, never guessed |
| 3 | `server/server.mjs:40` | `.env` was read from a hardcoded path while `LAMA_ENV_FILE` only affected *writes*; plus `process.env.X \|\| fileEnv.X` made an explicit empty value impossible — so the integration fixture's `LAMA_GATEWAY_ENV: ""` silently became the developer's real gateway env | `server/test/integration.mjs` passed `LAMA_ENV_FILE`, server ignored it for reads | `LAMA_ENV_FILE` now selects the read file and `hasOwnProperty(process.env, k)` decides precedence (empty = off) |
| 4 | `server/public/admin.html` (chat lab) | `embeddings` format was offered with no hint; on a chat model the engine answers **501** | live `POST /v1/embeddings` → `{"error":{"code":501,"message":"This server does not support embeddings. Start it with \`--embeddings\`","type":"not_supported_error"}}` | option now reads `engine needs --embeddings`; PROTOCOLS §11 records the exact error |
| 5 | `server/docs/PROTOCOLS.md` §1 | Claimed "the lama admin deliberately has no map button" — contradicted `mapToGateway`, `POST /api/map` and the `map` button in `renderModels` | `server/server.mjs` `mapToGateway` + route `/api/map` | doc rewritten; admin now also shows the **mapping id** (`llamacpp/<alias>`) per model |
| 6 | `server/docs/PROTOCOLS.md` §5 | Said engine TLS is off "current default" — stale after `LAMA_SSL_KEY/CERT` were configured | `.env:11-12`, live `POST /api/test {kind:https}` → `ok:true` | doc now separates "template default (off)" from "this machine (on)" |

## 2. Doc statements that were right but needed proof (kept, with the probe)

| Claim | Probe | Result |
| --- | --- | --- |
| `/health` → 200 `{"status":"ok"}` | `curl /health` through TLS and UDS | 200 `{"status":"ok"}` |
| `/v1/responses` exists and converts to chat | `POST /v1/responses {"max_output_tokens":8}` | 200, `object:"response"`, `output[0].type:"reasoning"`, `usage.input_tokens` |
| `/v1/messages` is Anthropic-shaped | self-test `anthropic` | 200, typed `content[]`, `stop_reason` |
| `stream_options.include_usage` is honoured | `stream:true` + `stream_options` | final chunk carries `usage{completion,prompt,total}` then `[DONE]` |
| `/tokenize` is **POST only** | `GET /tokenize` vs `POST /tokenize` | GET → 404 `File not found`; POST → 200 `{"tokens":[14556,1814]}` |
| `--host` accepts IP **and** unix paths in one value | live engine spawned with `--host 127.0.0.1,/tmp/llama-1000/llama.sock` | `https` test ok **and** `uds` test ok at the same time |
| `/slots` enabled by default | `/props.endpoint_slots` | `true` (help: `--slots` default enabled) |
| `/props` has no top-level `n_ctx` | live `/props` keys | `n_ctx` only inside `default_generation_settings` — `pickProps` already falls back |
| `--mcp-servers-config` is experimental | `llama serve --help` line 569 | "experimental: path to JSON file with MCP server definitions" |
| `/metrics` disabled → 501 JSON | docs "When /metrics or /slots endpoint is disabled" | body parsed as prometheus yields no keys; `props.metrics_enabled` tells the UI instead |

## 3. Version reporting (new)

Two sources, both quoted verbatim, compared instead of assumed equal:

```
llama --version   → version: 0.7.0-dev (build 11941, commit 19ff817fb)
/props.build_info → b11941-19ff817fb
```

- `GET /api/status` → `llama.version` = `{binary:{raw,version,build,commit}, props:{raw,build,commit}|null, build, commit, match, source}`
- `GET /api/runtime` → `engine.version` (same shape, `props` filled only while the engine is up)
- Admin topbar pill `llama.cpp 0.7.0-dev · b11941`; tooltip carries both raw strings, `match`, and the source.
  `match:false` renders amber — a binary on disk that differs from the running engine is a warning, not a silent success.
- Engine down → `props:null`, `match:null`, `source:"llama --version only …"`; nothing is invented.

## 4. Mapping ids (new)

`GET /api/models` returns, per model:

```json
"mapping": {
  "slug": "llamacpp/<alias>",        // id a gateway client must ask for
  "alias": "<alias>",                // value written into CP_LLAMACPP_MODELS
  "env_registered": true,
  "catalog_id": "llamacpp/<id>",     // live GET <gateway>/v1/models, or null
  "catalog_upstream": "<upstream_id>",
  "state": "live | pending-restart | catalog-only | not-mapped",
  "note": "…why…"
}
```

Live sample on this machine (proves the earlier confusion, does not hide it):

```
env aliases : qwen3-5-4b-ud-iq3-xxs, llama-3-2-1b-instruct-abliterated-q5-k-s
catalogue   : llamacpp/llama-3.2-1b-abliterated, ollama/qwen2:0.5b
=> qwen3-5-4b-ud-iq3-xxs        → pending-restart  (env yes, catalogue no)
=> llama-3-2-1b-instruct-…      → pending-restart  (env yes, catalogue has a different alias)
```

`pending-restart` is the honest label: the gateway reads `CP_LLAMACPP_MODELS` at
start, so a changed env needs a gateway restart/sync before its catalogue agrees.

## 5. Still open / not tested

- Windows path (`templates/start-server.bat`) — **NOT_TESTED**.
- Gateway catalogue is read unauthenticated from `LAMA_GATEWAY_BASE_URL`; if that
  gateway ever requires a token, `catalogue.ok` will be `false` with the HTTP status
  in `error` and the UI says so instead of showing empty mappings as "not mapped".
- Screenshots — **NOT_TESTED** (no visible desktop window); UI verified through DOM.
