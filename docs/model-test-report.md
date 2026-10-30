# Model × transport test report

Generated: `2026-10-30T02:56:10.145Z`  ·  Host: `linux/x64 ubuntu 22.04`  ·  Service mode: `user`
Binary: `version: 0.7.0-dev (build 11941, commit 19ff817fb)`

## System prompt (one for every model)

id `system` · version 5 · 5246 chars · sha256 `45e43aa09ea0fad2cd377bcaa0b17351cc65ab8f9748afc5131b571d41c211f2`

## Ports

| Surface | URL | State | Detail |
| --- | --- | --- | --- |
| admin | http://127.0.0.1:9933 | up | lama-admin healthz 200 |
| legacy manager | http://127.0.0.1:9934 | up | HTTP 200 {"ok":true} |

## qwen2.5-0.5b (`qwen2-5-0-5b-instruct-q4-k-m`)

File: `/home/sahon/lama/models/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf` · ctx 4096

| Phase | Load | Load ms | Unload | Unload detail |
| --- | --- | --- | --- | --- |
| tls-off | PASS | 1083 | PASS | status stopped pid - |
| tls-on | PASS | 1088 | PASS | status stopped pid - |

Load detail: tls-off: ok status running pid 25730 · tls-on: ok status running pid 25993
Mmap: PASS (485453824 bytes, r--s)

| Transport | Phase | State | health | props | models | chat | Latency | Detail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| http | tls-off | PASS | 200 | 200 | 200 | 200 | 532 ms | health 200, props 200, models 200, chat 200 |
| uds | tls-off | PASS | 200 | 200 | 200 | 200 | 60 ms | health 200, props 200, models 200, chat 200 |
| https | tls-on | PASS | 200 | 200 | 200 | 200 | 474 ms | health 200, props 200, models 200, chat 200 |

Identity answer (system prompt + "Who are you?"):

> আমি lama, স্টক llama.cpp-এ চলা লোকাল অ্যাসিস্ট্যান্ট।

## qwen3.5-4b (`qwen3-5-4b-ud-iq3-xxs`)

File: `/home/sahon/lama/models/Qwen3.5-4B-UD-IQ3_XXS.gguf` · ctx 8192

| Phase | Load | Load ms | Unload | Unload detail |
| --- | --- | --- | --- | --- |
| tls-off | PASS | 3062 | PASS | status stopped pid - |
| tls-on | PASS | 3082 | PASS | status stopped pid - |

Load detail: tls-off: ok status running pid 25877 · tls-on: ok status running pid 26049
Mmap: PASS (1938083840 bytes, r--s)

| Transport | Phase | State | health | props | models | chat | Latency | Detail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| http | tls-off | PASS | 200 | 200 | 200 | 200 | 2777 ms | health 200, props 200, models 200, chat 200 |
| uds | tls-off | PASS | 200 | 200 | 200 | 200 | 1485 ms | health 200, props 200, models 200, chat 200 |
| https | tls-on | PASS | 200 | 200 | 200 | 200 | 2753 ms | health 200, props 200, models 200, chat 200 |

Identity answer (system prompt + "Who are you?"):

> আমি lama, স্টক llama.cpp-এ চলা লোকাল অ্যাসিস্ট্যান্ট। আমার মালিক Sahon Srabon, Developer Zone।

