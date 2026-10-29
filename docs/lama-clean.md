# lama-clean — stock llama.cpp supervisor (TypeScript)

The `src/` app is the current manager. The older zero-dependency JS manager in `server/` is kept
for reference only; do not mix files between the two.

`llama.cpp` is the product. This app never re-implements the engine: no TLS proxy, no model
loader, no chat template engine. It only installs a stock binary, keeps the process alive, records
state in SQLite and exposes one authenticated admin API/UI.

## Commands

```bash
npm run setup                 # create dirs + .env, generate LAMA_ADMIN_TOKEN
npm run install:llama         # download the stock release for this OS/arch/accel
npm run doctor                # binary, TLS linkage, engine state, DB counts
npm start                     # admin API + UI on http://127.0.0.1:9933
npm run check                 # tsc --noEmit + node --test
node src/main.ts engine load <model-id> --ttl 4
node src/main.ts engine reload [model-id] --ttl 4
node src/main.ts engine unload
node src/main.ts service install user|system [--admin] [--start|--no-start]
node src/main.ts service start|stop|restart|status user|system [--admin]
```

`service install` defaults: engine = enabled but not started (the unit idles until a model is
selected), admin = enabled and started.

Node 24+ (`node:sqlite`, `fetch`, native TypeScript execution). No runtime dependencies.

## Portability

`.env` carries tunables only — no absolute paths. The root is the folder holding `package.json`;
`data/`, `models/`, `logs/`, `run/`, `certs/`, `web/`, `workspace/` and `data/manager.db` are derived
from it. The socket defaults to `$TMPDIR/llama-<uid>/llama.sock` on POSIX and is disabled (empty)
on Windows, where there are no unix sockets. The binary is resolved from `PATH`, then
`~/.local/bin/llama` (`%LOCALAPPDATA%\llama`), so `LAMA_LLAMA_BIN` is only an override.
Systemd unit files are generated per machine and therefore do contain absolute paths, which is
what systemd requires.

## Headless by design

`web/` holds static files only; all logic lives behind the HTTP API. Removing the UI changes nothing
except `GET /` (404): `/api/*`, `/v1/*`, `/health`, `/tools` and the engine keep working. The UI calls
that same API for every action, so the manager can be driven by curl or another program.

## Design

- **One model at a time.** `engine_state` in SQLite is the lock; `data/engine.lock` prevents two
  supervisors. TTL is stored per load and enforced by a 30s loop in the admin process.
- **Reload is a restart.** mmap and load flags are fixed at process start, so a reload stops and
  starts the engine (via systemd when service mode is `user`/`system`, otherwise a direct spawn).
- **mmap is proven, not assumed.** `/proc/<pid>/maps` is parsed for the model file; the UI shows
  bytes and permissions.
- **MCP is stdio-only into llama.cpp.** `--mcp-servers-config` is generated from SQLite. HTTP/SSE
  MCP rows are stored for the orchestrator and are never written into the engine config.
- **Tool fallback is three stages.** Native `tool_calls` → `TOOL:/ARGS:`/`PATH:` markers → bare
  JSON blocks, with a schema-echo guard and mislabel hint. Parsing never executes a tool;
  `/api/tools/call` is a separate audited endpoint. Tool use by the model is never guaranteed.

## Transport rules (gateway side)

- **HTTP:** the gateway is a separate connection. Add `http://127.0.0.1:9931` (the engine, always-on
  data plane) as an HTTP provider there, so chat survives an admin restart. `http://127.0.0.1:9933`
  is the control plane and an optional `/v1` proxy with identity headers. Do not pass the lama URL
  to llama.cpp as an environment variable — llama.cpp is the model runner, not the gateway.
- **UDS:** symlink the engine socket into the gateway's own folder
  (`ln -s <LAMA_UDS_SOCK> <gateway>/llama.sock`) or use *Link socket* in the admin UI. The gateway
  then talks to `http://localhost/v1` over that socket. The socket path is not an env var for
  llama.cpp.
- **HTTPS:** only the stock `--ssl-key-file/--ssl-cert-file` flags. Stock builds are often
  statically linked, so `ldd` cannot prove OpenSSL support; run a TLS probe before enabling it.
  `ensureTls` checks expiry and key/cert match, and never claims support it did not observe.
- Because the gateway keeps running, engine restarts do not require a gateway restart; reload only
  the engine connection.

## Security

- `LAMA_ADMIN_TOKEN` is required for `/api/*`; an empty token is accepted only on loopback.
- `.env`, DB and generated MCP config are mode `0600`; data dirs `0700`.
- Writes are rejected cross-origin; static assets are served with a strict CSP and `nosniff`.
- MCP tools are workspace-scoped: path escapes, secret-looking paths, shell metacharacters and
  non-allowlisted commands are refused.
- `system` service install never runs `sudo` by itself; it prints the exact commands instead.

## Verification

`npm run check` runs 40 tests: parser stages, release asset mapping, SQLite seed/versioning,
UDS request + symlink idempotency, MCP server `initialize`/`tools/list`, admin auth/CSP/route
validation, engine proxy + identity headers, seed/identity/legacy-DB guard, TLS cert/key matching,
binary resolution and engine argument construction.
