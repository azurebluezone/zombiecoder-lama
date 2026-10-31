# lama as an LLM API — TCP and Unix socket

> সারমর্ম: ক্লায়েন্ট সরাসরি llama.cpp-এর সাথে কথা বলে না। সকেট খোলে আমাদের
> manager (TCP, token) অথবা ইঞ্জিনের Unix socket (লোকাল, দ্রুত)। দুটোরই কল
> উদাহরণ, auth, status code আর SSH দিয়ে নৈতিকভাবে ক্লায়েন্ট বাঁধার নিয়ম নিচে।

This document is for another project that wants to treat this machine as an LLM
API. It covers the two supported doors, the exact request shape, and the honest
way to bind a remote client to a loopback-only server.

## 1. Who owns the socket

```
client ──TCP 9934──▶ lama manager ──TCP 9931 or UDS──▶ llama.cpp engine
client ──UDS──────────────────────────────────────────▶ llama.cpp engine
                                 lama-engine.service ──▶ llama.cpp engine
```

- The **engine** (stock `llama.cpp`) listens on `127.0.0.1:9931` and on a Unix
  socket (`LAMA_UDS_SOCK`, default `/tmp/llama-<uid>/llama.sock`, mode `0660`
  inside a `0700` directory). It has no token of its own: the socket permission
  and the loopback bind are the boundary.
- **`lama-engine.service`** owns the engine process (`engine-run` supervisor).
  `engine load` writes the selected model into `engine_state` and restarts the
  unit; the supervisor spawns the stock binary and keeps its output in
  `logs/engine-<model>.log`.
- The **manager** (`server/server.mjs`) owns the public TCP port, checks
  `LAMA_API_KEY`, and proxies `/v1/*`, `/props`, `/tokenize`, `/detokenize`,
  `/slots`, `/metrics`, `/health` to the engine. It runs without the admin app.
- The **admin app** (`npm start`) is an on-demand client. It has no systemd unit
  enabled, it does not need to be running for anything above, and stopping it
  leaves the engine untouched.

The manager is the only component that should be reachable from another host.
The engine port and the Unix socket are local-only by design.

## 2. Pick a door

| | Manager TCP `:9934` | Engine UDS |
|---|---|---|
| Who can connect | any local process, or a remote host through the nginx door | processes that can open the socket file (same uid/group) |
| Auth | `Authorization: Bearer $LAMA_API_KEY` (when set) | file permission only |
| Path | `/v1/chat/completions` | `/v1/chat/completions` |
| Cost | one extra HTTP hop, JSON re-serialised | no TCP, no TLS, no proxy |
| Use it for | other machines, other languages, long-lived clients | same-machine workers, batch jobs, low latency |
| Availability | `systemctl --user status lama-mgmt` | engine process only |

Both speak the OpenAI-compatible schema (`/v1/chat/completions`,
`/v1/completions`, `/v1/models`, `/v1/embeddings` when the model supports it).

## 3. TCP — manager on 9934

```bash
TOKEN="$(grep '^LAMA_API_KEY=' .env | cut -d= -f2)"
curl -sS http://127.0.0.1:9934/v1/chat/completions \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model":"qwen2.5-0.5b","messages":[{"role":"user","content":"Say OK"}],"max_tokens":4,"temperature":0}'
```

Python (stdlib only):

```python
import json, urllib.request

req = urllib.request.Request(
    "http://127.0.0.1:9934/v1/chat/completions",
    data=json.dumps({
        "model": "qwen2.5-0.5b",
        "messages": [{"role": "user", "content": "Say OK"}],
        "max_tokens": 4,
        "temperature": 0,
    }).encode(),
    headers={
        "content-type": "application/json",
        "authorization": "Bearer " + token,   # omit when LAMA_API_KEY is empty
    },
)
with urllib.request.urlopen(req, timeout=120) as res:
    print(json.load(res)["choices"][0]["message"]["content"])
```

Streaming (SSE): add `"stream": true` and read lines starting with `data: `.
The manager passes the stream through without buffering.

```bash
curl -sS -N http://127.0.0.1:9934/v1/chat/completions \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"model":"qwen2.5-0.5b","messages":[{"role":"user","content":"count to 3"}],"stream":true}'
```

`GET /healthz` is the manager's own liveness endpoint and needs no token.
`GET /` returns a small JSON identity, not an admin page.

## 4. UDS — the same API without TCP

curl can speak HTTP over a Unix socket directly:

```bash
SOCK="${LAMA_UDS_SOCK:-/tmp/llama-$(id -u)/llama.sock}"
curl -sS --unix-socket "$SOCK" http://localhost/health
curl -sS --unix-socket "$SOCK" http://localhost/v1/models
curl -sS --unix-socket "$SOCK" http://localhost/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"qwen2.5-0.5b","messages":[{"role":"user","content":"Say OK"}],"max_tokens":4,"temperature":0}'
```

Python, raw HTTP over `AF_UNIX` (no third-party client):

```python
import json, socket

sock_path = "/tmp/llama-1000/llama.sock"
body = json.dumps({
    "model": "qwen2.5-0.5b",
    "messages": [{"role": "user", "content": "Say OK"}],
    "max_tokens": 4,
    "temperature": 0,
}).encode()

request = (
    b"POST /v1/chat/completions HTTP/1.1\r\n"
    b"Host: localhost\r\n"
    b"Content-Type: application/json\r\n"
    b"Content-Length: " + str(len(body)).encode() + b"\r\n"
    b"Connection: close\r\n\r\n" + body
)

with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
    client.settimeout(120)
    client.connect(sock_path)
    client.sendall(request)
    chunks = []
    while True:
        chunk = client.recv(65536)
        if not chunk:
            break
        chunks.append(chunk)

raw = b"".join(chunks)
head, _, payload = raw.partition(b"\r\n\r\n")
print(head.decode().splitlines()[0])          # HTTP/1.1 200 OK
print(json.loads(payload)["choices"][0]["message"]["content"])
```

Node, same idea:

```js
import http from "node:http";

const req = http.request(
  { socketPath: process.env.LAMA_UDS_SOCK, path: "/v1/chat/completions", method: "POST",
    headers: { "content-type": "application/json" } },
  (res) => {
    let text = "";
    res.on("data", (c) => (text += c));
    res.on("end", () => console.log(JSON.parse(text).choices[0].message.content));
  },
);
req.end(JSON.stringify({ model: "qwen2.5-0.5b", messages: [{ role: "user", content: "Say OK" }], max_tokens: 4 }));
```

Keep `Content-Length` correct: `llama.cpp` reads the body by length, not by EOF.
A missing or wrong length is the most common reason a raw-socket call hangs.

## 5. Status codes and failures

| Code | Meaning | What to do |
|---|---|---|
| `200` | answered | read `choices[0].message.content` |
| `400` | bad JSON, unknown field, model not loaded | fix the body; `GET /v1/models` lists what is loaded |
| `401` | manager token missing/wrong | send `Authorization: Bearer $LAMA_API_KEY` |
| `404` | wrong path, or `/admin` on the manager | check §2; the admin app is not part of the API |
| `503` | engine not reachable from the manager | `systemctl --user status lama-engine`; check `GET /healthz` |
| timeout | model still loading, or huge prompt | first token after a cold load can take minutes |

A completion is not proof of correctness. For a health check use `/health`
(engine) or `/healthz` (manager); for a real check send a 4-token request with
`temperature: 0` and assert on the status code.

## 6. Binding a remote client — one authenticated nginx door

The manager binds `127.0.0.1:9934` and stays there. A remote client reaches it
through nginx, the only listener that faces the network:

```
client ──http──> server:8081 (nginx, Bearer key) ──> 127.0.0.1:9934 (manager) ──> engine
```

The engine port (`:9931`) and the admin app (`:9933`) are never proxied. There is
no SSH account to hand out, no tunnel process to babysit, and the door comes back
by itself after a reboot because nginx is a system service.

### Install it (one command, idempotent)

```bash
sudo ./scripts/install-nginx-proxy.sh                 # 0.0.0.0:8081
sudo LAMA_PROXY_LISTEN=127.0.0.1:8081 ./scripts/install-nginx-proxy.sh
sudo ./scripts/install-nginx-proxy.sh --show-key      # print the token
```

It renders `deploy/nginx/lama.conf` into `/etc/nginx/conf.d/lama.conf`, writes a
48-character token to `/etc/nginx/lama.key` (0600 root), removes the stock
Ubuntu site, runs `nginx -t`, enables nginx at boot and reloads it. Re-running
rotates nothing; `sudo rm /etc/nginx/lama.key` then re-running rotates the token.

What the proxy allows, by design:

| path | auth | result |
|---|---|---|
| `/healthz` | none | 200 (liveness only) |
| `/v1/*` | `authorization: Bearer <key>` | proxied to the manager |
| everything else | — | 404 |

Streaming is not buffered (`proxy_buffering off`) and the timeouts are 900s,
because a 1B model on CPU is slow.

### Measured on this machine (2026-10-31)

Through the proxy, from loopback:

```
GET  :8081/healthz           -> 200
GET  :8081/v1/models         -> 401   (no key)
GET  :8081/v1/models         -> 200   (Bearer key)
GET  :8081/admin             -> 404   (admin is not proxied)
POST :8081/v1/chat/completions -> 200
POST :8081/v1/chat/completions stream=true -> 10 data: chunks
```

And from a **different network stack** (a `veth` pair and a network namespace,
`10.200.0.2` -> `10.200.0.1`, so not loopback and not a localhost shortcut):

```
healthz            -> 200
/v1/models no key  -> 401
/v1/models with key-> 200
chat completion    -> 200, content "OK", usage 39
SSE                -> 10 chunks
```

That is a real remote POST over TCP with a real bearer check. It is still one
kernel on one machine: a second physical host, its firewall and its DNS are
`NOT_TESTED`.

### Client side

```bash
KEY="$(cat /etc/nginx/lama.key)"          # copy it to the client, 0600
curl -sS http://server:8081/healthz
curl -sS http://server:8081/v1/chat/completions \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"llama-3-2-1b","messages":[{"role":"user","content":"Say OK"}],"max_tokens":4}'
```

Python: set `LAMA_BASE_URL=http://server:8081` and `LAMA_API_KEY=<key>`; the
client in section 8 already sends the header.

### Why the SSH tunnel is gone

The tunnel needed an SSH account on the server, a key on every client, and it
died with the session. The nginx door is a package-managed service with one
rotatable token, it survives reboot, and it can be rate-limited or moved behind
TLS later without touching the manager. If you want it loopback-only, set
`LAMA_PROXY_LISTEN=127.0.0.1:8081` and keep using a tunnel for the few cases
where SSH is the only allowed protocol.

## 7. Verified on this machine (2026-10-31)

Engine over UDS, real completion:

```
$ curl -sS --unix-socket /tmp/llama-999/llama.sock http://localhost/v1/chat/completions \
    -H 'content-type: application/json' \
    -d '{"model":"qwen2.5-0.5b","messages":[{"role":"user","content":"Say OK"}],"max_tokens":4,"temperature":0}'
{"choices":[{"finish_reason":"length","index":0,"message":{"role":"assistant","content":"OK, thank you"}}], ...}
[200] 0.345s
```

Manager without the admin app (`LAMA_MGMT_PORT=19934 node server/server.mjs`):

```
GET /healthz   -> {"ok":true} [200]
GET /          -> {"name":"lama-manager","ok":true,"health":"/healthz","status":"/api/status", ...}
GET /v1/models -> {"models":[{"name":"qwen2.5-0.5b", ...}]}
GET /admin     -> 404 "no admin UI here; the admin app is optional"
```

What was **not** tested: a remote host over SSH (no second machine here), TLS on
the manager (`LAMA_SSL_KEY`/`LAMA_SSL_CERT` are for the engine), and HTTP/3.
Treat those as `NOT_TESTED` until someone runs them.

## 8. Python client — every format, one real task (verified 2026-10-31)

`examples/python/lama_client.py` is standard-library only (no `requests`, no
`openai`, no `anthropic` SDK). Copy that one file into another project and you
have all six surfaces; delete the functions you do not need.

```bash
cp ~/lama/examples/python/lama_client.py myproject/lama_client.py
```

| command | surface | response shape |
|---|---|---|
| `chat "..."` | manager `:9934` `/v1/chat/completions` | OpenAI `chat.completion` |
| `stream "..."` | manager `:9934`, `stream: true` | OpenAI SSE `chat.completion.chunk` + `[DONE]` |
| `anthropic "..."` | manager `:9934` `/v1/messages` | Anthropic `message` (`content[].text`, `stop_reason`, `usage`) |
| `uds "..."` | engine Unix socket, raw HTTP/1.1 over `AF_UNIX` | OpenAI `chat.completion` |
| `mcp list` / `mcp call NAME JSON` | MCP stdio (`node src/mcp/server.ts`) | JSON-RPC `tools/list` / `tools/call` |
| `task "..."` | model → MCP tool → model | final text, tool result in stderr |
| `shape` | manager, all three formats | field-by-field validation, exit 1 on any missing field |
| `job` | all of the above, one task | `workspace/report.txt` |

Environment (all optional):

```
LAMA_BASE_URL   http://127.0.0.1:9934    manager
LAMA_ENGINE_URL http://127.0.0.1:9931    engine, direct TCP
LAMA_API_KEY    (empty)                  set when the manager has a token
LAMA_MODEL      llama-3-2-1b
LAMA_UDS_SOCK   /tmp/llama-<uid>/llama.sock
LAMA_REPO       ~/lama                   where the MCP stdio server lives
LAMA_MCP_TOOLS  (all)                    comma list; small models need this
LAMA_TOOLS_ALLOW_WRITE   (unset)         1 enables write_file
```

Real output, run from `/tmp/opencode/pyclient` (a directory that contains only
the client file, so nothing depends on the repo layout):

```
$ python3 lama_client.py chat "Reply with exactly: tcp works"
TCP (Transmission Control Protocol) works.

$ python3 lama_client.py stream "Count to three"
1, 2, 3

$ python3 lama_client.py anthropic "Reply with exactly: anthropic works"
stop_reason=end_turn usage={'cache_read_input_tokens': 30, 'input_tokens': 12, 'output_tokens': 50}
Anthropic works are hypothetical scientific theories that attempt to explain ...

$ python3 lama_client.py uds "Reply with exactly: uds works"
uds works

$ python3 lama_client.py mcp call read_file '{"path":"facts.txt"}'
{"path":"/home/xubuntu/lama/workspace/facts.txt","content":"PROJECT_CODENAME=neel\nPORT=4242\n"}
```

One task, every surface, one artifact — the whole point:

```
$ LAMA_MCP_TOOLS=read_file LAMA_TOOLS_ALLOW_WRITE=1 python3 lama_client.py job
[mcp] read facts.txt: '{"path":"/home/xubuntu/lama/workspace/facts.txt","content":"PROJECT_CODENAME=nee'
[tcp] 200 CODENAME=neel PORT=4242
[anthropic] 200 "Secure Login and Password Recovery"
[sse] 200 I'm reporting complete.
[engine] 200 Engine direct works.
[uds] 200 OK
[mcp] wrote report.txt: {"path":"/home/xubuntu/lama/workspace/report.txt","bytes":319}
# "Secure Login and Password Recovery"

- facts: {"path":"/home/xubuntu/lama/workspace/facts.txt","content":"PROJECT_CODENAME=neel\nPORT=4242\n"}
- model line: CODENAME=neel PORT=4242
- anthropic title: "Secure Login and Password Recovery"
- stream: I'm reporting complete.
- engine tcp: Engine direct works.
- uds: OK
```

The title changes between runs (sampling); the facts line does not — it is read
from `workspace/facts.txt` by the model, not echoed by the script.

Machine-checkable form, used as the acceptance gate:

```bash
./scripts/verify-client-job.sh
stages=5 codes=200,200,200,200,200 mcp_read=yes mcp_write=yes \
  tcp=CODENAME=neel PORT=4242 modelline=CODENAME=neel PORT=4242 report_bytes=313 exit=0 OK
```

### Are the response shapes actually correct?

`shape` checks the fields a client is allowed to depend on, one line per format:

```
$ python3 lama_client.py shape
[openai] object=chat.completion finish=stop usage=40/2 OK
[anthropic] type=message blocks=1 stop=end_turn usage=1/2 id=chatcmpl-VQELNWwVqTudndY02kcsgCg6eB8URuNN OK
[sse] object=chat.completion.chunk chunks=9 done=True OK
shape: OK (openai=chat.completion, anthropic=message, sse=chat.completion.chunk)
```

Checked for OpenAI: `object`, `choices[0].message.role/content`,
`choices[0].finish_reason` ∈ {stop, length, tool_calls}, `usage.prompt_tokens`,
`usage.completion_tokens`. For Anthropic: `type=message`, `role=assistant`,
`content[]` text blocks, `stop_reason` ∈ {end_turn, max_tokens, stop_sequence,
tool_use}, `stop_sequence` present, `usage.input_tokens`/`output_tokens`. For
SSE: `object=chat.completion.chunk`, delta fields, more than one chunk, and a
terminating `[DONE]`.

One honest deviation: the Anthropic message `id` is `chatcmpl-...`, because
llama.cpp reuses its own completion id. Anthropic's real ids look like `msg_...`;
clients that only store the id are fine, clients that validate the prefix are not.
### Applying it from another Python project

```python
from lama_client import chat, stream, anthropic, uds_post, Mcp

print(chat("Summarise this log line: ...")["choices"][0]["message"]["content"])

for _, data in stream("/v1/chat/completions", {"model": "llama-3-2-1b",
        "messages": [{"role": "user", "content": "hi"}], "max_tokens": 32}):
    if data != "[DONE]":
        print(data)

print(anthropic("Give me a title")["content"][0]["text"])

mcp = Mcp(workspace="/srv/app/workspace")
print(mcp.call("read_file", {"path": "facts.txt"}))
mcp.close()
```

Point `LAMA_BASE_URL` at `http://127.0.0.1:9934` when the client runs on the same
host. From another machine, point it at the nginx door (section 6):

```bash
export LAMA_BASE_URL=http://server:8081
export LAMA_API_KEY="$(cat /etc/nginx/lama.key)"   # copied to the client, 0600
```

### Two gates a small model forces

1. `LAMA_MCP_TOOLS=read_file` — handing a 1B model five tool schemas at once
   makes llama.cpp answer `500 The model produced output that does not match the
   expected peg-native format`. Restrict the list to the tools the task needs.
2. After a tool result, the client stops re-sending `tools` for the answer round
   (`LAMA_TOOLS_ALWAYS=1` overrides). Same parser, same reason.

`write_file` needs `LAMA_TOOLS_ALLOW_WRITE=1` in the environment of the process
that spawns `src/mcp/server.ts`; without it the tool is absent, not failing.

## 9. Surviving a power cut

The failure the operator actually fears is "the machine dies and nothing comes
back". Three things make that survivable, and one of them was missing until now.

**1. User services must outlive the login session.** Without lingering, systemd
stops `--user` units when the last session ends, and a headless reboot never
starts them at all:

```
$ loginctl show-user xubuntu -p Linger
Linger=yes                     # was: no
```

**2. The units are enabled, not just started.**

```
engine  enabled/active    lama-engine.service
mgmt    enabled/active    lama-mgmt.service
status  enabled/active    lama-status.service
admin   disabled/inactive lama-admin.service
```

**3. State lives on disk, not in the process.** The selected model, its context
size and the TTL are rows in SQLite; `report.txt` is a file; the engine log is
`logs/engine-<id>.log`.

### Crash test, run for real

`SIGKILL` to all three units — no shutdown hook, no cleanup, the same shape as a
power cut for these processes:

```
$ systemctl --user kill -s KILL lama-engine lama-mgmt lama-status
$ sleep 10
engine  enabled/active
mgmt    enabled/active
status  enabled/active
$ sqlite: select model_id,pid,status from engine_state
{"model_id":"llama-3-2-1b","pid":56195,"status":"running"}
$ ./scripts/verify-client-job.sh | head -1
stages=5 codes=200,200,200,200,200 mcp_read=yes mcp_write=yes \
  tcp=CODENAME=neel PORT=4242 modelline=CODENAME=neel PORT=4242 report_bytes=316 exit=0 OK
```

systemd restarted the three units, the supervisor re-read the model row and
respawned llama.cpp, and the full client job passed again without a human.

### The bug this exposed: a dead admin could block every load

After a crash the engine lock (`data/engine.lock`) can name a pid that is alive
but is **not** the supervisor — a leftover `node src/main.ts serve` from an
earlier admin session. The load then failed with:

```
$ node src/main.ts engine load llama-3-2-1b
lama: engine is already managed by pid 51525        # that pid was `main.ts serve`
```

That is the admin owning the engine by accident, which is exactly what this
system is built to prevent. Fixed in `src/engine.ts`: when a supervisor unit
owns the engine, only that supervisor (or the pid systemd reports for it) may
hold the lock; any other live claimant is recorded as `engine.lock.steal` in the
audit log and the load proceeds through systemd.

**Not tested:** an actual power-cycle reboot (it would kill this session). The
evidence here is enablement + lingering + SIGKILL recovery, not a cold boot.

### When an editor gives up, the engine must too

An editor that times out (OpenCode retries a request up to three times) leaves a
client connection that is already dead. The manager used to keep the upstream
request alive, so llama.cpp kept generating for nobody and its **single slot**
stayed busy for minutes. Every later request queued behind it and timed out as
well — a self-inflicted traffic jam that looked like "the model is slow".

Fixed in `server/server.mjs` (`proxy()`): the upstream request is destroyed when
the client connection closes before the response ends, and the manager writes
`{"kind":"proxy","action":"client_abort"}` to `logs/manager.log`. llama.cpp then
logs `stop: cancel task` and frees the slot.

Measured: after a client abort the engine logs the cancellation within the same
second instead of finishing the abandoned completion.

This matters most with a slow CPU model, where one abandoned 16k-token prompt
otherwise blocks the machine for ten minutes.

## 10. Editor binding — OpenCode to lama (verified 2026-10-31)

```
opencode (agent lama-chat) -> lama provider -> manager :9934 -> engine :9931
```

```bash
./scripts/verify-opencode-session.sh
# opencode session PASS: lama/llama-3-2-1b (lama-chat) answered "lama is alive"
```

Measured: 10-13 s, 235 prompt tokens, answer `lama is alive`; the same text is in
`opencode session export`. Second prompt `four` answered `Four.`

Three measured failure modes and their fixes:

| symptom | cause | fix |
|---|---|---|
| `request (16183 tokens) exceeds the available context size (4096)` | full agent doctrine injected | lean agent + `leanProviders` |
| answers empty, `tool_calls: [skill {"id":"hi"}]` | 1B model handed a tool schema | `LAMA_STRIP_TOOLS=llama-3-2-1b` in `.env` |
| never returns, prompt keeps growing, one slot busy | background editor retrying an abandoned request | `--standalone` for tests + client-abort propagation (§9) |

`LAMA_STRIP_TOOLS` is implemented in `server/server.mjs` (`proxy()`): the request
body is parsed, `tools`/`tool_choice` are removed for the listed model ids, and
`{"kind":"proxy","action":"tools_stripped"}` is written to `logs/mgmt.jsonl`.
The engine then answers in text instead of emitting a bogus call.
