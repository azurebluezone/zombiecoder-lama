# lama — llama.cpp manager (gateway + admin)

**একটা ছোট, জিরো-ডিপেন্ডেন্সি ম্যানেজার, যেটা আপনার মেশিনে `llama.cpp` চালায়, থামায়, টেস্ট করে আর
একটা OpenAI-কম্প্যাটিবল ঠিকানায় (`http://127.0.0.1:9933`) দিয়ে দেয়।** উপরে `zombie-gateway`
বসলে সে এই ঠিকানাটাকেই একটা প্রোভাইডার হিসেবে ব্যবহার করে।

```
client → zombie-gateway :5252 → lama manager :9933 → llama.cpp engine :9931 (TCP + TLS / UDS)
                                        └── admin UI  http://127.0.0.1:9933/admin
```

- কোড: শুধু Node.js built-in (`node:http`, `node:https`, `node:sqlite`, `node:child_process`)।
  `npm install` নেই, `node_modules` নেই।
- ইঞ্জিন স্টক `llama.cpp`-ই থাকে — TLS, UDS, MCP সবই ইঞ্জিনের নিজের flag দিয়ে, কোনো custom layer নেই।
- ম্যানেজার শুধু তিনটা কাজ করে: **lifecycle** (load/unload/TTL), **truth** (health, /proc maps, logs),
  আর **control plane** (prompts + MCP servers, SQLite-এ)।

> এই README-র প্রতিটি কমান্ড এই রেপোতে ২০২৬-১০-২৮ তারিখে চালানো ও যাচাই করা:
> `50/50 checks passed`, engine TLS `PASS 2ms`, gateway chat `HTTP 200`।
> যেখানে যাচাই করা যায়নি (যেমন Windows), সেখানে **NOT_TESTED** লেখা আছে।

---

## ১. যা যা লাগবে

| জিনিস | ভার্সন | যাচাই করার কমান্ড |
| --- | --- | --- |
| Linux (Ubuntu/Debian) | — | `uname -a` |
| Node.js | **22.5+** (tested: 24.21.0) — `node:sqlite` দরকার | `node -v` |
| llama.cpp binary | `serve` subcommand সহ (tested: `0.7.0-dev build 11941`) | `llama version` |
| openssl | যেকোনো (TLS সার্টিফিকেট বানাতে) | `openssl version` |
| Git | যেকোনো | `git --version` |

Node না থাকলে (Ubuntu/Debian):

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs openssl git
node -v          # v24.x হওয়া উচিত
```

`llama.cpp` না থাকলে:

```bash
curl -LsSf https://llama.app/install.sh | sh
llama version    # version: ... build ... দেখাবে
```

---

## ২. দ্রুত সেটআপ (copy-paste, ৬ ধাপ)

```bash
# 1) কোড নামান
git clone https://github.com/azurebluezone/zombiecoder-lama.git
cd zombiecoder-lama

# 2) .env + systemd unit তৈরি (llama binary নিজে খুঁজে নেবে)
node scripts/setup.mjs

# 3) ইঞ্জিন TLS সার্টিফিকেট (self-signed, loopback-only)
node scripts/gen-cert.mjs

# 4) ধাপ ৩ যা ছাপবে, সেই দুই লাইন .env-এ বসান
nano .env        # LAMA_SSL_KEY=... এবং LAMA_SSL_CERT=...

# 5) সার্ভিস চালু
systemctl --user daemon-reload
systemctl --user enable --now lama-mgmt.service
loginctl enable-linger "$USER"      # logout করলেও চলবে

# 6) যাচাই
curl -s http://127.0.0.1:9933/healthz
# → {"ok":true}
```

তারপর ব্রাউজারে খুলুন: **http://127.0.0.1:9933/admin**

> TLS না চাইলে ধাপ ৩–৪ বাদ দিন। তখন `https` self-test সৎভাবে **SKIPPED** দেখাবে
> ("engine-native TLS is off") — মিথ্যা PASS দেখাবে না।

---

## ৩. ধাপে ধাপে, কী হচ্ছে

### ৩.১ `node scripts/setup.mjs`

এটা করে:

1. `llama` binary খোঁজে (`LLAMA_BIN`, `~/.local/bin`, `/usr/local/bin`, `PATH`) এবং `llama version` চালিয়ে
   প্রমাণ করে যে binary সত্যিই চলে। না পেলে সাথে সাথে থামে — অনুমান করে এগোয় না।
2. `.env` বানায় `templates/env.template` থেকে (mode `0600`)। `.env` আগে থেকে থাকলে **হাত দেয় না**।
3. Linux-এ `~/.config/systemd/user/lama-mgmt.service` লেখে ও `daemon-reload` করে।

Flags: `--no-reload` (systemd reload হবে না), `--unit-only`।

### ৩.২ `.env` — সবচেয়ে গুরুত্বপূর্ণ ফাইল

কম করে এই ক'টা বদলাতে হতে পারে:

```ini
LLAMA_BIN=/home/<you>/.local/bin/llama
LLAMA_MODEL_CTX=4096          # কনটেক্সট সাইজ
LLAMA_THREADS=4               # CPU thread
LAMA_LLAMA_PORT=9931          # engine
LAMA_MGMT_PORT=9933           # manager + admin UI
LAMA_MODELS_DIR=.../models    # .gguf এখানে
LAMA_API_KEY=                 # খালি = loopback-এ auth নেই
LAMA_SSL_KEY=.../certs/localhost-key.pem
LAMA_SSL_CERT=.../certs/localhost-cert.pem
LAMA_GATEWAY_ENV=             # gateway-র .env path (ঐচ্ছিক, "map" badge-এর জন্য)
```

পুরো তালিকা নিচে §৯-এ।

### ৩.৩ ইঞ্জিন TLS (ঐচ্ছিক কিন্তু recommended)

```bash
node scripts/gen-cert.mjs
# gen-cert: created
#   subject=CN = localhost
#   X509v3 Subject Alternative Name: DNS:localhost, IP Address:127.0.0.1
#   key mode 600: /home/<you>/zombiecoder-lama/certs/localhost-key.pem
```

তারপর `.env`-এ:

```ini
LAMA_SSL_KEY=/home/<you>/zombiecoder-lama/certs/localhost-key.pem
LAMA_SSL_CERT=/home/<you>/zombiecoder-lama/certs/localhost-cert.pem
```

এবং রিস্টার্ট (আগে মডেল unload — §৫ দেখুন)। এখন ইঞ্জিন `https://127.0.0.1:9931`-এ শোনে,
আর ম্যানেজার ইঞ্জিনের সাথে TLS-এ কথা বলে (`rejectUnauthorized:false`, কারণ সার্টিফিকেট self-signed)।

### ৩.৪ সার্ভিস

```bash
systemctl --user status lama-mgmt.service
journalctl --user -u lama-mgmt.service -n 50 --no-pager
```

লগ ফাইল: `logs/mgmt.jsonl` (JSON lines), ইঞ্জিন লগ: `logs/llama-<alias>.log`।

---

## ৪. মডেল নামানো

**অ্যাডমিন থেকে:** Models → Download → HuggingFace repo (`org/name`) + file (`model.gguf`) → download।

**CLI থেকে:**

```bash
curl -s -X POST http://127.0.0.1:9933/api/download \
  -H 'content-type: application/json' \
  -d '{"repo":"bartowski/Qwen2.5-0.5B-Instruct-GGUF","file":"Qwen2.5-0.5B-Instruct-Q4_K_M.gguf"}'
```

একই `repo`+`file` দ্বিতীয়বার চাইলে আবার ডাউনলোড হয় না — `models/catalog.json` ledger-এ
রেকর্ড থাকে, response-এ `"cached":true` আসে। মডেল ফাইলগুলো `models/`-এ জমা হয়, এবং Models
পেজ ওই ফোল্ডার + `~/.cache/huggingface/hub` + `~/.cache/llama.cpp` স্ক্যান করে।

> বড় মডেল ডাউনলোড কয়েক GB হতে পারে; `logs/mgmt.jsonl`-এ `kind:"download"` লাইন দেখে অগ্রগতি বোঝা যায়।

---

## ৫. চালু / বন্ধ করা

```bash
# লোড (TTL ছাড়া)
curl -s -X POST http://127.0.0.1:9933/api/load \
  -H 'content-type: application/json' -d '{"name":"<model-name>"}'

# ২ ঘণ্টা পরে নিজে নিজে unload
curl -s -X POST http://127.0.0.1:9933/api/load \
  -H 'content-type: application/json' -d '{"name":"<model-name>","ttl_hours":2}'

# বন্ধ
curl -s -X POST http://127.0.0.1:9933/api/unload -H 'content-type: application/json' -d '{}'
```

`<model-name>` পাবেন `curl -s http://127.0.0.1:9933/api/models` থেকে (`models[].name`)।

**⚠️ রিস্টার্টের নিয়ম:** `lama-mgmt.service` রিস্টার্ট করলে তার child ইঞ্জিন orphan হয়ে যায়।
তাই:

```bash
curl -s -X POST http://127.0.0.1:9933/api/unload -d '{}' -H 'content-type: application/json'
systemctl --user restart lama-mgmt.service
# তারপর আবার load
```

---

## ৬. যাচাই — প্রমাণ ছাড়া "হয়ে গেছে" নয়

```bash
# ১) সব JS ফাইলের syntax
node --check server/server.mjs
node --check server/lib/db.mjs && node --check server/lib/mcp.mjs && node --check server/lib/runtime.mjs
node --check scripts/setup.mjs && node --check scripts/gen-cert.mjs && node --check scripts/lamactl.mjs

# ২) পুরো integration suite (temp DB + temp port ব্যবহার করে, লাইভ ডেটা ছোঁয় না)
node server/test/integration.mjs
# শেষ লাইন: 50/50 checks passed

# ৩) ম্যানেজার বেঁচে আছে?
curl -s http://127.0.0.1:9933/healthz
# {"ok":true}

# ৪) ইঞ্জিনের সত্যিকারের অবস্থা
curl -s http://127.0.0.1:9933/api/status | python3 -m json.tool
# "health": "ok", "tls": true/false, "alias": "<loaded model>"

# ৫) প্রোটোকল টেস্ট (একটা একটা করে)
curl -s -X POST http://127.0.0.1:9933/api/test -H 'content-type: application/json' -d '{"kind":"https"}'
# {"kind":"https","ok":true,"ms":2,"what":"GET https://127.0.0.1:9931/health (engine-native TLS)"}

curl -s -X POST http://127.0.0.1:9933/api/test -H 'content-type: application/json' -d '{"kind":"uds"}'
# {"kind":"uds","ok":true,...,"what":"GET unix:///tmp/llama-<uid>/llama.sock/health"}

curl -s -X POST http://127.0.0.1:9933/api/test -H 'content-type: application/json' -d '{"kind":"openai"}'
# {"ok":true,...,"finish":"length"}  — CPU-তে ৩০–৬০ সেকেন্ড লাগতে পারে
```

TLS চালু থাকলে `"kind":"http"` ইচ্ছাকৃতভাবে **FAIL** করবে:

```
"detail": "engine is TLS-only (LAMA_SSL_* set) — plaintext refused (socket hang up); run the HTTPS test"
```

এটা বাগ নয় — ইঞ্জিন তখন শুধু TLS-ই বলে, আর টেস্ট সত্যিটাই বলে।

### অ্যাডমিন UI চেকলিস্ট

| পেজ | যা দেখা উচিত |
| --- | --- |
| Models | লোডেড মডেল সবুজ `loaded`, বাকিগুলো লাল `unloaded`, gateway-তে রেজিস্টার্ড হলে সবুজ `map` |
| Self-tests | প্রতিটি প্রোটোকল বাটন; ক্লিক করলে Results টেবিলে route + PASS/FAIL/SKIPPED + ms + last time |
| System prompts | টেবিলে name/version/scope/default/bindings; **Edit** খুললে ফর্ম, Save করলে নতুন version + মডেল টেস্ট |
| MCP servers | **Add MCP** → transport → URL → API key → **Test**; success ছাড়া Save enable হয় না |

---

## ৭. অ্যাডমিন প্যানেল — কী কী কাজ

- **Overview** — engine pill, TTL, preflight, request metrics, self-test matrix।
- **Chat lab** — একই ইঞ্জিনে `openai` / `tools` / `anthropic` / `responses` / `embeddings` ফরম্যাটে
  চ্যাট পাঠিয়ে response, latency, TTFT, tokens দেখায়; প্রতিটি রান `chat_runs` টেবিলে জমা থাকে।
- **Metrics** — ম্যানেজার লগ থেকে request count, error, avg/max latency, bytes; মডেল-ভিত্তিক ভাঙা হিসাব।
- **Models** — scan, sync, download (catalog dedupe), load/unload, `map` badge।
- **Self-tests** — `http`, `https`, `uds`, `openai` (non-stream), `stream`, `anthropic`, `tools`।
  প্রতিটি বাটন আসল route-এ হিট করে shape যাচাই করে।
- **Logs** — ম্যানেজার JSONL, শুধু request ফিল্টার।
- **System prompts** — SQLite-এ immutable version; `Edit` = নতুন version append; `Save & test` =
  সাথে সাথে মডেলকে কল করে system prompt-টা সত্যিই কাজ করছে কিনা দেখে।
- **MCP servers** — test-first wizard; ব্যর্থ connection **কখনো** DB-তে ঢোকে না।

---

## ৮. MCP কীভাবে কাজ করে

llama.cpp নিজে MCP client: `--mcp-servers-config <json>` পেলে stdio server-গুলোর tools ব্যবহার করতে পারে।

- অ্যাডমিনে MCP server যোগ করলে সেটা SQLite-এ যায়, probe হয়, তারপর `data/mcp-servers.generated.json`
  তৈরি হয় (`apply to engine`)।
- **stdio** ট্রান্সপোর্ট সরাসরি ইঞ্জিনে যায়। **http / sse / uds / openai / anthropic** যায়
  `server/lib/bridge.mjs`-এর মাধ্যমে — মানে ইঞ্জিনের কাছে ওগুলোও stdio-ই দেখায়।
- API key কখনো engine config-এ লেখা হয় না; আলাদা `0600` spec ফাইলে থাকে।
- ইঞ্জিন বন্ধ থাকলে শুধু ওই MCP server-টা কাজ করে না — gateway/অন্য কিছু পড়ে না।

`apply to engine` করার পর মডেল reload করতে হবে, নইলে ইঞ্জিন নতুন config পড়বে না।

---

## ৯. সব environment variable

| Variable | ডিফল্ট | কাজ |
| --- | --- | --- |
| `LLAMA_BIN` | `llama` | llama.cpp binary-র path |
| `LLAMA_MODEL_CTX` | `4096` | ডিফল্ট context size |
| `LLAMA_THREADS` | `4` | CPU thread |
| `LAMA_LLAMA_HOST` | `127.0.0.1` | ইঞ্জিন bind host |
| `LAMA_LLAMA_PORT` | `9931` | ইঞ্জিন port |
| `LAMA_LLAMA_ARGS` | `--jinja --no-webui` | ইঞ্জিনে extra flag (space-separated) |
| `LAMA_UDS_SOCK` | `/tmp/llama-<uid>/llama.sock` | Unix socket path — সবসময় চালু; খালি রাখলে default path |
| `LAMA_SSL_KEY` | — | ইঞ্জিন TLS key (PEM) |
| `LAMA_SSL_CERT` | — | ইঞ্জিন TLS cert (PEM) |
| `LAMA_MGMT_HOST` | `127.0.0.1` | ম্যানেজার bind host |
| `LAMA_MGMT_PORT` | `9933` | ম্যানেজার + admin UI port |
| `LAMA_API_KEY` | — | `/api/*` + `/v1` proxy-র bearer token; খালি = auth নেই |
| `LAMA_MODELS_DIR` | `<repo>/models` | `.gguf` ফোল্ডার |
| `LAMA_LOG_DIR` | `<repo>/logs` | লগ ফোল্ডার |
| `LAMA_DATA_DIR` | `<repo>/data` | SQLite + generated config |
| `LAMA_DB` | `<repo>/data/lama.db` | SQLite ফাইল (WAL, `0600`) |
| `HF_TOKEN` | — | gated HuggingFace repo-র জন্য |
| `LAMA_GATEWAY_ENV` | — | gateway-র `.env` path; দিলে `map` badge + `/api/map` কাজ করে |
| `LAMA_MCP_CONFIG` | — | হাতে বানানো MCP config path (DB খালি থাকলে) |

`process.env` সবসময় `.env`-এর উপরে জেতে।

---

## ১০. gateway-র সাথে জোড়া

`zombie-gateway`-এর `.env`-এ প্রোভাইডার হিসেবে ম্যানেজারকেই দিতে হবে:

```ini
CP_LLAMACPP_KIND=llamacpp
CP_LLAMACPP_BASE_URL=http://127.0.0.1:9933
CP_LLAMACPP_TRANSPORT=http
CP_LLAMACPP_MODELS=<model-alias-1>, <model-alias-2>
```

গুরুত্বপূর্ণ: gateway **ম্যানেজারকে** দেখে, ইঞ্জিনকে নয়। তাই ইঞ্জিনে TLS চালু করলেও gateway-র
কিছু বদলাতে হয় না — ম্যানেজার ভেতরে ভেতরে `https` ব্যবহার করে। (এই মেশিনে যাচাই: gateway chat
`HTTP 200`, `"OK"`, `llamacpp/...` মডেলে।)

`LAMA_GATEWAY_ENV` সেট থাকলে অ্যাডমিনের Models পেজ `CP_LLAMACPP_MODELS` পড়ে `map` badge দেখায়,
আর `map` বাটন নতুন alias যোগ করে (gateway restart করলে কার্যকর)।

---

## ১১. সমস্যা ও সমাধান

| লক্ষণ | কারণ | সমাধান |
| --- | --- | --- |
| `EADDRINUSE :9933` | পুরনো ম্যানেজার বেঁচে আছে | `systemctl --user restart lama-mgmt.service` / `ss -ltnp \| grep 9933` |
| admin খোলে না, `curl /healthz` fail | সার্ভিস ডাউন | `journalctl --user -u lama-mgmt.service -n 50 --no-pager` |
| `https` test `SKIPPED` | `LAMA_SSL_KEY/CERT` খালি | `node scripts/gen-cert.mjs` → `.env` → restart |
| `http` test FAIL, detail "TLS-only" | TLS চালু, plaintext বন্ধ — এটাই ঠিক | `https` test চালান |
| `load` এর পর `health never turned ok` | মডেল/flag ভুল, RAM কম | `logs/llama-<alias>.log` দেখুন |
| `model not found: X` | scan-এ নেই | Models → sync, বা `LAMA_MODELS_DIR` ঠিক করুন |
| `ECONNREFUSED 127.0.0.1:9931` | ইঞ্জিন বন্ধ | মডেল load করুন |
| gateway 404 `not in the catalogue` | gateway-র model list পুরনো | gateway restart / sync |
| `node:sqlite` not found | Node পুরনো | Node 22.5+ (24 recommended) |
| UDS test fail | socket path/permission | `LAMA_UDS_SOCK`-এর dir `0700` ও socket `0660` কিনা দেখুন |
| ম্যানেজার restart-এর পর ইঞ্জিন "orphan" | child process বেঁচে যায় | unload → restart → load (§৫) |

---

## ১২. ফাইল কোথায় কী

```text
.
├── .env                        # সব config (0600, git-এ যাবে না)
├── certs/                      # engine TLS key+cert (0600, git-এ যাবে না)
├── models/                     # .gguf + catalog.json (git-এ যাবে না)
├── data/                       # lama.db (SQLite WAL) + generated MCP config (git-এ যাবে না)
├── logs/                       # mgmt.jsonl + llama-<alias>.log (git-এ যাবে না)
├── scripts/
│   ├── setup.mjs               # .env + systemd unit
│   ├── gen-cert.mjs            # self-signed TLS
│   └── lamactl.mjs             # CLI: status/models/load/unload/download/logs/requests
├── server/
│   ├── server.mjs              # manager: lifecycle + proxy + API
│   ├── public/admin.html       # পুরো admin UI (HTML+CSS+JS, একটাই ফাইল)
│   ├── lib/db.mjs              # SQLite: prompts, versions, bindings, MCP, runs, audit
│   ├── lib/mcp.mjs             # MCP normalize + probe (http/sse/uds/stdio/openai/anthropic)
│   ├── lib/bridge.mjs          # remote transport → stdio bridge
│   ├── lib/runtime.mjs         # /proc/<pid>/maps থেকে mmap সত্য
│   ├── docs/PROTOCOLS.md       # API/protocol রেফারেন্স
│   └── test/                   # integration.mjs (50 checks) + stub-servers.mjs
└── templates/                  # env.template, systemd unit, Windows bat
```

SQLite টেবিল: `system_prompts`, `system_prompt_versions` (append-only), `prompt_bindings`,
`mcp_servers`, `mcp_tools`, `mcp_probes`, `chat_runs`, `audit_events`, `app_settings`।

---

## ১৩. নিরাপত্তা

- ম্যানেজার ডিফল্টে `127.0.0.1`-এ bind করে। বাইরে খুলতে হলে `LAMA_MGMT_HOST=0.0.0.0`
  **এবং** `LAMA_API_KEY` — দুটো একসাথে, নইলে যে কেউ মডেল লোড/আনলোড করতে পারবে।
- `.env` ও `certs/*.pem` সবসময় `0600`; `data/` `0700`।
- TLS সার্টিফিকেট self-signed — শুধু loopback-এর জন্য। পাবলিক ডোমেইনে দিলে বাস্তব CA সার্টিফিকেট
  (Let's Encrypt) ব্যবহার করুন।
- MCP API key কখনো engine config-এ বা log-এ যায় না; admin API masked (`has_key`) ফেরত দেয়।
- প্রতিটি destructive action (`load`, `unload`, `mcp.create`, `prompt.version` …) `audit_events`-এ থাকে।

---

## ১৪. আনইনস্টল

```bash
systemctl --user disable --now lama-mgmt.service
rm ~/.config/systemd/user/lama-mgmt.service
systemctl --user daemon-reload
# তারপর রেপো ফোল্ডারটা মুছে ফেলুন। models/, data/, .env আলাদা করে রাখতে চাইলে রাখুন।
```

Windows-এর `templates/start-server.bat` পথটা দেওয়া আছে কিন্তু **NOT_TESTED** — Linux-এ বানানো,
Windows-এ চালিয়ে যাচাই করা হয়নি।

---

## ১৫. লাইসেন্স

এই রেপোতে আলাদা LICENSE ফাইল এখনো নেই। কোড শেয়ার/পুনর্ব্যবহারের আগে মালিকের অনুমতি নিন।
