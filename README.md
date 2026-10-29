# lama

A lifecycle manager for a **stock llama.cpp** server, written in TypeScript on Node 24 built-ins.
It owns the boring parts — install, systemd units, model registry, TTL, transports, admin API —
and never re-implements the engine.

```
control plane   :9933  admin API + UI (writes, auth, identity headers, optional /v1 proxy)
data plane      :9931  stock llama.cpp (OpenAI + Anthropic surfaces)
unix socket     /tmp/llama-1000/llama.sock   dir 0700, socket 0660
registry        data/manager.db              SQLite (WAL), migrations in lama_manager_migrations
identity        identity.json                SSI-Core manifest, mode 0444
seeds           db/seed/lama.json            declarative rows, applied on boot
```

Node 24+ only (`node:sqlite`, `fetch`, native TypeScript execution). **Zero runtime dependencies.**

## Install on Linux — copy-paste guide

You need a Linux machine (desktop or server, x86_64 or ARM64) and one `sudo` password. Nothing else
has to be installed first. Run the blocks in order; each one is safe to paste into a terminal.

### 1. System tools

```bash
sudo apt update && sudo apt install -y curl git xz-utils
# Fedora: sudo dnf install -y curl git xz
```

### 2. Node.js 24 in your home folder (no sudo)

```bash
case "$(uname -m)" in x86_64) NODE_ARCH=x64;; aarch64|arm64) NODE_ARCH=arm64;; *) echo "Unsupported CPU";; esac
NODE_FILE=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep -o "node-v24[0-9.]*-linux-$NODE_ARCH.tar.xz" | head -1)
mkdir -p "$HOME/.local"
curl -fsSL "https://nodejs.org/dist/latest-v24.x/$NODE_FILE" -o /tmp/node.tar.xz
tar -xJf /tmp/node.tar.xz -C "$HOME/.local"
ln -sfn "$HOME/.local/${NODE_FILE%.tar.xz}" "$HOME/.local/node"
grep -q '.local/node/bin' "$HOME/.bashrc" || echo 'export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
node -v
```

`node -v` must print `v24.x`. If it prints an older version, close and reopen the terminal.

### 3. Download lama and its dev dependencies

```bash
git clone https://github.com/azurebluezone/zombiecoder-lama.git "$HOME/lama"
cd "$HOME/lama"
npm install
```

### 4. Download the stock llama.cpp engine

```bash
npm run install:llama
```

This fetches the official llama.cpp release for your OS/arch, verifies its checksum and links the
binary at `bin/llama-server` inside the project — no `PATH` edit needed. On an NVIDIA box add
`-- --accel cuda` (or `vulkan`) to the same command.

### 5. Create the config, token and database

```bash
npm run setup
grep '^LAMA_ADMIN_TOKEN=' .env
```

Copy the value after `=`. That token is the only password; the file is `0600` and contains no paths.

### 6. Install the systemd user units and start the admin

```bash
node src/main.ts service install user --admin
systemctl --user status lama-admin --no-pager
```

`lama-admin` starts now, `lama-engine` is enabled but idles until a model is selected (so it never
crash-loops). To keep it running after you log out: `loginctl enable-linger "$USER"`.

### 7. Open the admin UI

Open <http://127.0.0.1:9933> in a browser and paste the token. On a headless server use a tunnel:
`ssh -L 9933:127.0.0.1:9933 user@server`, then open the same localhost URL.

### 8. Add one model

```bash
mkdir -p models
curl -L --fail -o "models/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf" \
  "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf"
```

The seed already registered this row, so open **Model List**, find
`Qwen2.5-0.5B-Instruct-Q4_K_M` and press **Load**. Prefer the terminal?

```bash
TOKEN=$(grep '^LAMA_ADMIN_TOKEN=' .env | cut -d= -f2)
curl -sS -X POST http://127.0.0.1:9933/api/engine/load \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"model_id":"qwen2-5-0-5b-instruct-q4-k-m","ttl_hours":4}'
```

### 9. Check it

```bash
npm run doctor
curl -s http://127.0.0.1:9933/healthz
```

`doctor` prints the OS, stock binary, engine state, database and admin URL.

### Stop, restart, update

```bash
systemctl --user stop lama-admin lama-engine      # stop
systemctl --user restart lama-admin               # restart after a config change
cd "$HOME/lama" && git pull && npm install && npm run check \
  && systemctl --user restart lama-admin lama-engine
```

## Headless by design

`web/` is only static files (`index.html`, `app.js`, `style.css`) and the UI keeps no business logic.
Every button calls the same public API, so the manager is fully usable with the UI deleted, with
curl, or from another program. Verified on this machine: with no `web/` content, `GET /` returns
`404` while `GET /api/state`, `GET /v1/models`, `POST /v1/chat/completions` and `GET /tools` all
return `200`. The UI has nine views — Overview (with the audit trail), Model List, Playground,
Runtime, Transports & Docs, MCP Servers, Prompts, Tool Parser, Connection & Auth — and no demo rows.

## What it does

- **Stock binary, no fork.** `llama install` resolves the official release asset for the detected
  OS/arch/accel and verifies the extracted binary. Nothing patches llama.cpp.
- **One model at a time.** `engine_state` in SQLite is the lock, `data/engine.lock` stops two
  supervisors. `ttl_hours` is stored per load and enforced by a 30s loop in the admin process
  (verified: a 36s TTL unloaded the model on the next tick, port closed, socket removed).
- **Reload is a restart.** mmap/mlock flags are fixed at process start, so a reload stops and
  starts the engine — through `systemctl --user` when service mode is `user`/`system`, otherwise a
  detached spawn. The gateway never needs a restart.
- **mmap is proven, not assumed.** `/proc/<pid>/maps` is parsed for the model file and the UI shows
  bytes and permissions (`r--s` for a mapped GGUF).
- **Two service units, user scope.** `lama-admin` (`serve`, starts by default) and `lama-engine`
  (`engine-run`, enable-only; it idles until the manager selects a model, so it never crash-loops).
- **MCP is stdio-only into llama.cpp.** `data/mcp-servers.generated.json` is generated from SQLite
  and passed with `--mcp-servers-config`. HTTP/SSE rows are stored for orchestrators and never
  written into the engine config.
- **Tool fallback in three stages.** Native `tool_calls` → `TOOL:`/`ARGS:`/`PATH:` markers → bare
  JSON blocks, with a schema-echo guard and a mislabel hint. Parsing never executes a tool;
  `/api/tools/call` is a separate audited endpoint. Tool use by a small model is never guaranteed.

## CLI

```bash
node src/main.ts setup [--service user|system]
node src/main.ts install [--build bNNNNN] [--accel cpu|cuda|vulkan|rocm|openvino|sycl] [--force]
node src/main.ts tls [--check]
node src/main.ts doctor [--json]
node src/main.ts seed
node src/main.ts serve
node src/main.ts engine-run
node src/main.ts engine load <model-id> [--ttl HOURS]
node src/main.ts engine unload
node src/main.ts engine reload [model-id] [--ttl HOURS]
node src/main.ts engine status
node src/main.ts service install user|system [--admin] [--start|--no-start]
node src/main.ts service start|stop|restart|status user|system [--admin]
node src/main.ts mcp
```

`service install` defaults: **engine = enabled, not started**; **admin = enabled and started**.
`system` install never runs `sudo` by itself — it prints the exact commands and exits non-zero.

## Configuration

`.env` is a plain key=value map next to `package.json`, mode `0600`, **no comments and no absolute
paths**. Every path is derived at runtime from the project root (the directory that holds
`package.json`), so the same file works in any folder, for any user, on any OS. `process.env` wins
over the file; `LAMA_ENV_FILE` points the units at a different file.

| Key | Default (derived) | Meaning |
| --- | --- | --- |
| `LAMA_HOME` | the folder holding `package.json` | project root, only needed to relocate the app |
| `LAMA_DATA_DIR` | `<root>/data` | SQLite and runtime state |
| `LAMA_DB` | `<root>/data/manager.db` | registry file; the legacy `data/lama.db` is refused on purpose |
| `LAMA_MODELS_DIR` | `<root>/models` | GGUF files |
| `LAMA_LOG_DIR`, `LAMA_RUN_DIR`, `LAMA_CERTS_DIR` | `<root>/logs`, `<root>/run`, `<root>/certs` | runtime dirs |
| `LAMA_WEB_DIR` | `<root>/web` | static admin UI |
| `LAMA_WORKSPACE` | `<root>/workspace` | MCP tool sandbox |
| `LAMA_ADMIN_HOST`, `LAMA_ADMIN_PORT` | `127.0.0.1:9933` | admin bind |
| `LAMA_ENGINE_HOST`, `LAMA_ENGINE_PORT` | `127.0.0.1:9931` | engine bind |
| `LAMA_UDS_SOCK` | `$TMPDIR/llama-<uid>/llama.sock` on POSIX, empty on Windows | dir `0700`, socket `0660`; empty disables UDS |
| `LAMA_LLAMA_BIN` | resolved from `PATH`, then `~/.local/bin/llama` (`%LOCALAPPDATA%\llama`) | stock binary override |
| `LAMA_ADMIN_TOKEN` | generated by `setup` | admin API token; required for `/api/*` |
| `LAMA_API_KEY` | empty | optional token for the `/v1` proxy off-loopback |
| `LAMA_ENGINE_API_KEY` | empty | optional `--api-key` passed to the engine |
| `LAMA_SERVICE_MODE` | `none` (`setup --service user` sets `user`) | `user`, `system` or `none` |
| `LAMA_TLS`, `LAMA_SSL_KEY`, `LAMA_SSL_CERT` | off, `<root>/certs/...` | engine-native TLS flags only |
| `LAMA_DEFAULT_TTL_HOURS` | `4` | default model TTL |

A generated `.env` is therefore just this (paths intentionally absent):

```ini
LAMA_ENGINE_HOST=127.0.0.1
LAMA_ENGINE_PORT=9931
LAMA_ADMIN_HOST=127.0.0.1
LAMA_ADMIN_PORT=9933
LAMA_LOAD_MODE=auto
LAMA_ACCEL=cpu
LAMA_SERVICE_MODE=user
LAMA_TLS=0
LAMA_DEFAULT_TTL_HOURS=4
LAMA_ADMIN_TOKEN=<generated>
```

## Surfaces

| Surface | Route | Auth |
| --- | --- | --- |
| UI | `GET /` (`/admin` → 302 `/`) | shell is public; the tab asks for the token |
| admin API | `GET /api/state`, `POST /api/engine/*`, `/api/models`, `/api/mcp`, `/api/prompts`, `/api/transports`, `/api/documents`, `/api/tools*`, `/api/audit` | `Authorization: Bearer <LAMA_ADMIN_TOKEN>` or `x-admin-token` |
| proxied engine | `/v1/*`, `/health`, `/props`, `/slots`, `/metrics`, `/tools`, `/tokenize`, `/apply-template`, `/embedding*` | loopback, or `LAMA_API_KEY` off-loopback |
| liveness | `GET /healthz` | public |
| identity | every response | `x-system-identity`, `x-system-version`, `x-system-owner`, `x-powered-by` |

A wrong or missing token returns `401`; the UI keeps the token in `sessionStorage` for the tab only.

## Gateway wiring (:5252)

The gateway is a separate application and is not modified here.

- **Data plane:** point the `llamacpp` provider at `http://127.0.0.1:9931`. Chat keeps working when
  the admin is stopped (verified: admin `inactive`, gateway chat still `200`).
- **Model ids:** clients see `llamacpp/<alias>`; a provider sync picks up the loaded model.
- **Control plane:** `http://127.0.0.1:9933` is the admin API and an optional `/v1` proxy with
  identity headers. Use it when you need auth/identity at the edge and accept that it is a control
  plane dependency.
- **If `LAMA_ENGINE_API_KEY` is set**, register that env var in the gateway as `api_key_env`.
- **UDS:** symlink the engine socket into the gateway folder (`web` → *Link socket*, or
  `ln -s /tmp/llama-1000/llama.sock <gateway>/llama.sock`). Never pass the socket path to llama.cpp
  as an environment variable.
- Engine restarts do not require a gateway restart; re-sync only the provider.

## Identity (SSI-Core)

`identity.json` is the immutable manifest (name, version, owner, contact, license). It is validated
on boot, enforced `0444`, mirrored into `system_identity` in SQLite, stamped on every HTTP response,
rendered in the UI footer, and anchored into the default system prompt so a model cannot invent a
different owner.

## Seeds

`db/seed/lama.json` (`schema: lama.seed/v1`) declares providers, transports, MCP servers, transport
documents, the default prompt and models. `applySeeds()` validates every field, resolves
`127.0.0.1:9933` / `127.0.0.1:9931` / the socket path to the live config, and is idempotent —
an unchanged prompt is skipped instead of version-bumped. Boot applies seeds; `node src/main.ts seed`
does it on demand.

## Security model

- `LAMA_ADMIN_TOKEN` gates `/api/*`. An empty token is accepted only on loopback.
- `/v1` proxy is loopback-only unless `LAMA_API_KEY` is set.
- `.env`, DB, generated MCP config are `0600`; data dirs `0700`; socket dir `0700`, socket `0660`
  (even though `/tmp` itself is world-writable with the sticky bit).
- Writes are rejected cross-origin; static assets use a strict CSP, `nosniff`, `no-referrer`.
- MCP tools are workspace-scoped: path escapes, secret-looking paths, shell metacharacters and
  non-allowlisted commands are refused.
- The legacy JS manager refuses to serve its old admin and the new store refuses the legacy DB
  schema, so the two generations cannot silently corrupt each other.

## Verification

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test test/*.test.ts  → 40 tests
```

Covered: portable config derivation, parser stages, release asset mapping, SQLite seed/migrations/legacy guard, UDS request +
symlink idempotency, MCP `initialize`/`tools/list`, admin auth/CSP/route validation, proxy + identity
headers, TLS cert/key matching, binary resolution, engine argument construction.

Live on this machine (build `11941`, `0.7.0-dev`):

| Check | Result |
| --- | --- |
| `GET /healthz`, `/`, `/api/state` | `200`, `200`, `200` with token / `401` without |
| `GET /v1/models`, `/props`, `/slots`, `/metrics`, `/tools` | `200` |
| `POST /v1/chat/completions`, `/v1/messages` (engine, manager, UDS, gateway) | `200` with content |
| UDS `curl --unix-socket /tmp/llama-1000/llama.sock` | `200` |
| mmap proof | `mapped: true`, `r--s`, model present in `/proc/<pid>/maps` |
| TTL expiry (0.01h) | unloaded by the loop, port `9931` closed, socket removed |
| admin stopped | engine `200`, gateway chat `200` |

## Not tested here

- Windows and macOS paths (no hardware): code exists, behaviour is `UNVERIFIED`.
- `system` (root) service install: only the printed command set was produced, nothing was executed.
- Tool calling by `Qwen2.5-0.5B`: the wiring is proven end to end, the model's reliability is not.

## Layout

```
src/            manager: config, db, engine, admin, service, installer, seed, identity, transport, mcp/, tools/
web/            admin UI (index.html, app.js, style.css) — no build step
db/seed/        declarative seed rows
test/           node:test suites
docs/           current + legacy documentation
server/         legacy zero-dependency JS manager (reference only)
scripts/, templates/  legacy helper scripts referenced by the legacy docs
identity.json   SSI-Core manifest
data/           SQLite + runtime state (gitignored)
models/         GGUF files (gitignored)
logs/, run/, workspace/, certs/  runtime dirs (gitignored)
```

Docs: [docs/README.md](docs/README.md).
