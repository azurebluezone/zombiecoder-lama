# lama — llama.cpp decoration layer

The engine stays **stock**: same binary, same flags, same defaults. This folder
only adds a management wrapper, so the engine can be re-pointed at any future
llama.cpp version without a rewrite.

```
lama/
  scripts/setup.mjs     cross-OS setup: finds llama, writes .env, systemd unit / setx
  scripts/lamactl.mjs   CLI: status | models | load | unload | download | logs | requests
  server/server.mjs     the manager (Node built-ins only, zero npm deps)
  server/public/        admin UI (browser)
  templates/            systemd unit, .env template, Windows starter, MCP config
  models/               GGUFs land here (also the scan source)
  logs/                 mgmt.jsonl + llama-<alias>.log
```

## Run (Linux, systemd user unit)

```sh
node scripts/setup.mjs                      # finds llama, writes .env, installs unit
systemctl --user enable --now lama-mgmt.service
node scripts/lamactl.mjs status
node scripts/lamactl.mjs models
node scripts/lamactl.mjs load llama-3-2-1b-instruct-abliterated-q5-k-s
node scripts/lamactl.mjs requests 5
```

Admin UI: `http://127.0.0.1:9933/admin`

## Run (Windows)

```sh
node scripts\setup.mjs      # setx LLAMA_BIN/LAMA_DIR + start-server.bat (NOT_TESTED here)
start-server.bat
```

The manager spawns `llama serve -m <model> --host 127.0.0.1 --port 9931 --jinja
--no-webui …` with args from `.env` (`LAMA_LLAMA_ARGS`). Change nothing else —
every engine flag is still yours to pass through.

## HTTP surface (manager, default 9933)

| Route | What |
| --- | --- |
| `GET /api/status` | manager uptime + llama health/alias/model/pid, DB path, MCP config, default prompt |
| `GET /api/models` | GGUF scan: `lama/models`, `~/.cache/huggingface/hub`, `~/.cache/llama.cpp`, `$LAMA_EXTRA_DIRS` |
| `GET /api/runtime` | live engine truth: `/props`, `/slots`, `/metrics` counters, mmap truth from `/proc/<pid>/maps`, chat totals |
| `GET /api/config` | DB path, data dir, bridge path, generated MCP config, transports, default prompt |
| `POST /api/load` | `{name}` or `{path}`, optional `{ctx}` — one model at a time |
| `POST /api/unload` | SIGTERM (SIGKILL after 5s) |
| `POST /api/download` | `{repo, file}` — HuggingFace → `lama/models`, streamed |
| `GET /api/logs?n=` / `GET /api/requests?n=` | JSONL tails (load/unload/request with ms + bytes + tokens) |
| `GET /api/mcp` | stored MCP servers (api keys masked as `has_key`) |
| `POST /api/mcp` | `{name, transport, url, api_key?, command?, args?, env?, headers?}` — probes first, stores only on success |
| `POST /api/mcp/test` | probe an unsaved form (URL alone is valid when there is no key) |
| `POST /api/mcp/:id/test` | re-probe a stored server, cache its tools |
| `PATCH/DELETE /api/mcp/:id` | enable/disable or remove |
| `POST /api/mcp/apply` | regenerate the engine config + `LAMA_MCP_CONFIG` (`.env` backup first) |
| `GET/POST /api/prompts` | list / create a system prompt (v1) |
| `POST /api/prompts/:id/versions` | append an immutable version and move the pointer |
| `POST /api/prompts/:id/default` / `:id/bind` | set default / bind to model, MCP server or global |
| `POST /api/chat/test` | `{model, format, stream, prompt, max_tokens}` — run one protocol probe, store the run |
| `GET /api/chat/runs` / `GET /api/chat/stats` | history + per-model tokens/calls/latency |
| `/v1/*`, `/props`, `/tokenize`, `/detokenize`, `/slots`, `/metrics` | streamed proxy to the engine (incl. SSE; usage parsed into the log) |
| `GET /healthz` | manager liveness (no auth) |
| `GET /admin` | UI |

If `LAMA_API_KEY` is set, `/api/*` and every proxied route need
`Authorization: Bearer <key>`.

## Vercel AI SDK (openai-compatible provider)

The SDK expects an OpenAI-compatible `/v1/chat/completions` — the manager's
proxy already speaks it, so the SDK just points at the manager:

```js
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
const llama = createOpenAICompatible({
  name: "llama", baseURL: process.env.LLAMA_SERVER_BASE_URL + "/v1",
});
// LLAMA_SERVER_BASE_URL=http://127.0.0.1:9933  (the manager, not the engine)
```

Set only `LLAMA_SERVER_BASE_URL` and the gateway/agent never touches ports,
paths or process management — that is the whole decoration contract.

## Database (`data/lama.db`, SQLite via `node:sqlite`)

| Table | Purpose |
| --- | --- |
| `system_prompts` | prompt identity: name, slug, scope, default flag, current version pointer |
| `system_prompt_versions` | immutable content + checksum + note; editing appends, never rewrites |
| `prompt_bindings` | prompt → `global` / `model` / `mcp_server`, with priority |
| `mcp_servers` | transport (`stdio`/`http`/`sse`/`uds`/`openai`/`anthropic`), URL, key, args/env, last probe |
| `mcp_tools` | tools discovered by the last successful probe |
| `mcp_probes` | append-only probe history (ok, latency, detail, tool count) |
| `chat_runs` | one row per chat-lab run: format, stream, tokens, latency, TTFT, finish, error |
| `audit_events` | config changes (create/update/delete/probe/apply) |
| `app_settings` | small key/value store (`default_prompt_id`, …) |

`data/` is `0700`, the DB file is `0600`. MCP keys are stored locally and never
returned by the list API (`has_key: true` instead). Regenerate the schema by
starting the manager — migrations are numbered and idempotent.

## MCP (all transports, one honest constraint)

llama.cpp's own MCP client is **stdio only** (verified on 0.7.0-dev: entries
without `command` are skipped). So the DB accepts six transports and the
generated config always ends up stdio:

| DB transport | Engine entry |
| --- | --- |
| `stdio` | the command itself |
| `http` / `sse` / `uds` | `node server/lib/bridge.mjs <spec>` — stdio ↔ remote MCP JSON-RPC |
| `openai` / `anthropic` | same bridge, exposes `openai_chat` / `anthropic_messages` tools |

`server/lib/mcp.mjs` probes before storing: stdio spawns the command and runs
`initialize` + `tools/list`; HTTP/SSE/UDS run the same JSON-RPC handshake over
POST (SSE replies parsed); OpenAI/Anthropic probe `/v1/models` and fall back to
a one-token call. A failing probe stores nothing and returns the exact error.

`POST /api/mcp/apply` writes `data/mcp-servers.generated.json` plus one `0600`
spec file per bridged server, then points `LAMA_MCP_CONFIG` at the config
(`.env` backed up first). Model load automatically uses the DB-generated
config whenever at least one server is enabled, even if `.env` is untouched.

Legacy `templates/mcp-gateway.json` still works as a manual override
(`LAMA_MCP_CONFIG`), but the DB path is the normal one now.

## Chat lab + prompts

`Chat lab` runs one model across `openai` (non-stream/stream), `tools`,
`anthropic`, `responses` and `embeddings`, recording latency, TTFT, prompt /
completion / total tokens and the finish reason in `chat_runs`. Usage comes
from the engine response — never estimated.

`embeddings` needs the engine started with `--embeddings` (llama.cpp: pooling
must not be `none`). Without it the engine answers `501 not_supported_error`
and that exact message is stored — the UI does not pretend otherwise.

`/v1/responses` has no top-level `output_text` field (SDK convenience); the
manager reads `output[].content[].type == "output_text"` and falls back to
`reasoning_text` / `summary_text`.

## Engine version + mapping ids

`/api/status` and `/api/runtime` expose `version` from both published sources —
`llama --version` and `/props.build_info` — with `match` comparing them; the
admin topbar shows the build and turns amber on a mismatch.

`/api/models` adds `mapping` per model: `slug` (`llamacpp/<alias>`), `alias`,
`env_registered` (CP_LLAMACPP_MODELS), `catalog_id` (live `GET /v1/models` on
the gateway) and `state` = `live | pending-restart | catalog-only | not-mapped`.
See `docs/AUDIT.md` for the code-vs-docs audit that produced these fixes. Reasoning models show their
`reasoning_content` / `thinking` blocks labelled as such when the visible
content is empty.

System prompts are versioned: create writes v1, "save new version" appends v2
and moves the pointer; history stays. `prompt_bindings` decide which prompt a
model/MCP server gets; the chat lab uses the resolved prompt for the selected
model unless you type your own.

## Metrics

`--metrics` is on by default in `templates/env.template` so the engine exposes
`llamacpp:prompt_tokens_total`, `llamacpp:tokens_predicted_total`,
`llamacpp:requests_processing` and friends. The manager also parses usage out
of proxied responses (JSON and SSE) into `logs/mgmt.jsonl`, so per-model token
totals survive even if the engine metrics flag is off.

## Known limits (honest)

- One active model at a time; after a manager restart the running engine is
  orphaned-but-alive (proxy still works; `/api/unload` then targets nothing).
- `llama download`'s own cache dir was not pinned by evidence — that is why our
  downloader writes `lama/models` explicitly and the scanner treats
  `~/.cache/llama.cpp` as a candidate only if it exists.
- Windows path delivered but **NOT_TESTED** (no Windows on this box).

## lamactl

```sh
node scripts/lamactl.mjs status|models|load <name> [ctx]|unload|download <repo> <file>|logs [n]|requests [n]
```
