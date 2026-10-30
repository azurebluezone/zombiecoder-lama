# HTTP + UDS transport surface report

Generated: `2026-10-30T03:04:14.569Z` · Host: `linux/x64 ubuntu 22.04` · Binary: `version: 0.7.0-dev (build 11941, commit 19ff817fb)`
System prompt: `system` v5 (5246 chars)

`PASS` = 2xx · `N/A` = build/model does not implement it (real status recorded) · `FAIL` = unexpected.

## qwen2.5-0.5b (`qwen2-5-0-5b-instruct-q4-k-m`)

Load PASS (1896 ms, pid 27110) · mmap 485453824 bytes · unload PASS

| Endpoint | http | uds | Verdict | Detail |
| --- | --- | --- | --- | --- |
| health | 200 (2 ms) | 200 (1 ms) | PASS |  |
| props | 200 (1 ms) | 200 (1 ms) | PASS |  |
| models | 200 (1 ms) | 200 (0 ms) | PASS |  |
| metrics | 200 (1 ms) | 200 (1 ms) | PASS | # HELP llamacpp:prompt_tokens_total Number of prompt tokens  |
| slots | 200 (1 ms) | 200 (1 ms) | PASS | slots=1 |
| tokenize | 200 (1 ms) | 200 (1 ms) | PASS | tokens=3 |
| detokenize | 200 (1 ms) | 200 (1 ms) | PASS | lama transport probe |
| chat | 200 (512 ms) | 200 (195 ms) | PASS | Ok |
| chat-stream | 200 (215 ms) | 200 (208 ms) | PASS | chunks=3 first=156ms |
| completions | 200 (273 ms) | 200 (287 ms) | PASS | , I have a list of 1 |
| chat-tools | 200 (2960 ms) | 200 (791 ms) | PASS | tool_calls returned |
| embeddings | 501 (1 ms) | 501 (1 ms) | N/A |  |
| messages | 200 (451 ms) | 200 (515 ms) | PASS |  |
| responses | 200 (481 ms) | 200 (437 ms) | PASS |  |
| infill | 400 (1 ms) | 400 (1 ms) | N/A |  |

Identity over http: আমি lama, স্টক llama.cpp-এ চলা লোকাল অ্যাসিস্ট্যান্ট।
Identity over uds: আমি lama, স্টক llama.cpp-এ চলা লোকাল অ্যাসিস্ট্যান্ট।

## qwen3.5-4b (`qwen3-5-4b-ud-iq3-xxs`)

Load PASS (3066 ms, pid 27226) · mmap 1938083840 bytes · unload PASS

| Endpoint | http | uds | Verdict | Detail |
| --- | --- | --- | --- | --- |
| health | 200 (0 ms) | 200 (2 ms) | PASS |  |
| props | 200 (1 ms) | 200 (1 ms) | PASS |  |
| models | 200 (0 ms) | 200 (0 ms) | PASS |  |
| metrics | 200 (1 ms) | 200 (1 ms) | PASS | # HELP llamacpp:prompt_tokens_total Number of prompt tokens  |
| slots | 200 (0 ms) | 200 (1 ms) | PASS | slots=1 |
| tokenize | 200 (1 ms) | 200 (0 ms) | PASS | tokens=3 |
| detokenize | 200 (0 ms) | 200 (0 ms) | PASS | lama transport probe |
| chat | 200 (2748 ms) | 200 (1622 ms) | PASS | ok |
| chat-stream | 200 (3105 ms) | 200 (1871 ms) | PASS | chunks=3 first=2455ms |
| completions | 200 (2926 ms) | 200 (2950 ms) | PASS | . <think> Thinking Process: |
| chat-tools | 200 (27964 ms) | 200 (12398 ms) | PASS | tool_calls returned |
| embeddings | 501 (1 ms) | 501 (1 ms) | N/A |  |
| messages | 200 (7970 ms) | 200 (6149 ms) | PASS |  |
| responses | 200 (6124 ms) | 200 (6103 ms) | PASS |  |
| infill | 400 (1 ms) | 400 (1 ms) | N/A |  |

Identity over http: আমি lama, স্টক llama.cpp-এ চলা লোকাল অ্যাসিস্ট্যান্ট। আমার মালিক Sahon Srabon, Developer Zone।
Identity over uds: আমি lama, স্টক llama.cpp-এ চলা লোকাল অ্যাসিস্ট্যান্ট। আমার মালিক Sahon Srabon, Developer Zone।

