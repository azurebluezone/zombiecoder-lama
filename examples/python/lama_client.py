#!/usr/bin/env python3
"""lama client — standard library only.

One file, five ways to talk to the server, so another Python project can copy it
and delete what it does not need:

  chat       OpenAI /v1/chat/completions over TCP (the normal path)
  stream     the same call with SSE streaming
  anthropic  Anthropic /v1/messages (different response shape)
  uds        OpenAI call over the engine's Unix socket (no TCP)
  mcp        MCP stdio: list tools and call one (no model involved)
  task       the full loop: model -> MCP tool -> model -> answer
  job        one real task over every protocol (TCP, SSE, Anthropic, UDS, MCP)
  shape      validate the OpenAI and Anthropic response shapes field by field

Environment:
  LAMA_BASE_URL   default http://127.0.0.1:9934   (the manager)
  LAMA_API_KEY    default empty                   (set when the manager has a token)
  LAMA_MODEL      default llama-3-2-1b            (see: node src/main.ts model list)
  LAMA_UDS_SOCK   default /tmp/llama-<uid>/llama.sock
  LAMA_REPO       default ~/lama                  (for the MCP stdio server)

Examples:
  python3 lama_client.py chat "Say OK"
  python3 lama_client.py stream "Count to three"
  python3 lama_client.py anthropic "Say OK"
  python3 lama_client.py uds "Say OK"
  python3 lama_client.py mcp list
  python3 lama_client.py mcp call read_file '{"path":"facts.txt"}'
  python3 lama_client.py task "What is PROJECT_CODENAME in facts.txt?"
"""

import json
import os
import socket
import subprocess
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("LAMA_BASE_URL", "http://127.0.0.1:9934").rstrip("/")
TOKEN = os.environ.get("LAMA_API_KEY", "")
MODEL = os.environ.get("LAMA_MODEL", "llama-3-2-1b")
ENGINE = os.environ.get("LAMA_ENGINE_URL", "http://127.0.0.1:9931").rstrip("/")
UDS = os.environ.get("LAMA_UDS_SOCK", "/tmp/llama-%d/llama.sock" % os.getuid())
REPO = os.environ.get("LAMA_REPO", os.path.expanduser("~/lama"))


def _headers(extra=None):
    head = {"content-type": "application/json"}
    if TOKEN:
        head["authorization"] = "Bearer " + TOKEN
    if extra:
        head.update(extra)
    return head


# Last HTTP status seen, so a run can print what it actually got instead of
# trusting a boolean.
STATUS = {"code": 0}


def post_json(path, payload, timeout=180, base=None):
    body = json.dumps(payload).encode()
    req = urllib.request.Request((base or BASE) + path, data=body, headers=_headers())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            STATUS["code"] = res.status
            return json.load(res)
    except urllib.error.HTTPError as error:
        STATUS["code"] = error.code
        detail = error.read().decode("utf-8", "replace")[:500]
        raise SystemExit("HTTP %s on %s: %s" % (error.code, path, detail))


def stream(path, payload):
    """Yield (event, data) pairs from an SSE response."""
    body = json.dumps(dict(payload, stream=True)).encode()
    req = urllib.request.Request(BASE + path, data=body, headers=_headers({"accept": "text/event-stream"}))
    with urllib.request.urlopen(req, timeout=180) as res:
        STATUS["code"] = res.status
        event = None
        for raw in res:
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                yield event, line[5:].strip()


def uds_post(path, payload, timeout=180):
    """One HTTP/1.1 request over AF_UNIX; returns the parsed JSON body."""
    body = json.dumps(payload).encode()
    request = (
        b"POST " + path.encode() + b" HTTP/1.1\r\n"
        b"Host: localhost\r\n"
        b"Content-Type: application/json\r\n"
        b"Content-Length: " + str(len(body)).encode() + b"\r\n"
        b"Connection: close\r\n\r\n" + body
    )
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(timeout)
        client.connect(UDS)
        client.sendall(request)
        chunks = []
        while True:
            chunk = client.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
    raw = b"".join(chunks)
    head, _, payload = raw.partition(b"\r\n\r\n")
    status = head.split(b"\r\n", 1)[0].decode()
    code = int(status.split()[1]) if len(status.split()) > 1 else 0
    STATUS["code"] = code
    if code != 200:
        raise SystemExit("%s from UDS %s: %s" % (status, path, payload[:300].decode("utf-8", "replace")))
    if b"transfer-encoding: chunked" in head.lower():
        payload = _dechunk(payload)
    return json.loads(payload)


def _dechunk(data):
    out, rest = [], data
    while True:
        line, _, rest = rest.partition(b"\r\n")
        size = int(line.split(b";")[0], 16)
        if size == 0:
            return b"".join(out)
        out.append(rest[:size])
        rest = rest[size + 2:]


class Mcp:
    """Minimal MCP stdio client: initialize, tools/list, tools/call."""

    def __init__(self, workspace=None):
        env = dict(os.environ)
        env["LAMA_WORKSPACE"] = workspace or os.path.join(REPO, "workspace")
        self.proc = subprocess.Popen(
            ["node", os.path.join(REPO, "src", "mcp", "server.ts")],
            cwd=REPO,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        self.next_id = 0
        self.request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "lama-python-client", "version": "0.1"},
        })
        self.notify("notifications/initialized", {})

    def _send(self, message):
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def notify(self, method, params):
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def request(self, method, params):
        self.next_id += 1
        self._send({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params})
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise SystemExit("MCP server closed the pipe during " + method)
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if message.get("id") != self.next_id:
                continue
            if "error" in message:
                raise SystemExit("MCP error on %s: %s" % (method, message["error"]))
            return message["result"]

    def tools(self):
        return self.request("tools/list", {}).get("tools", [])

    def call(self, name, arguments):
        result = self.request("tools/call", {"name": name, "arguments": arguments})
        parts = []
        for item in result.get("content", []):
            if item.get("type") == "text":
                parts.append(item.get("text", ""))
        return "\n".join(parts)

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


def chat(prompt, system=None):
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    return post_json("/v1/chat/completions", {
        "model": MODEL, "messages": messages, "max_tokens": 200, "temperature": 0,
    })


def anthropic(prompt):
    body = json.dumps({
        "model": MODEL,
        "max_tokens": 200,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request(
        BASE + "/v1/messages",
        data=body,
        headers=_headers({"anthropic-version": "2023-06-01"}),
    )
    with urllib.request.urlopen(req, timeout=180) as res:
        STATUS["code"] = res.status
        return json.load(res)


def task(question, system=None):
    """Model chooses a tool, MCP executes it, model answers with the result."""
    mcp = Mcp()
    try:
        # Small models (1B) break the tool parser when handed five schemas at
        # once. LAMA_MCP_TOOLS lets a project expose only what the task needs.
        allow = [name.strip() for name in os.environ.get("LAMA_MCP_TOOLS", "").split(",") if name.strip()]
        tools = [{
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool.get("description", ""),
                "parameters": tool.get("inputSchema", {"type": "object"}),
            },
        } for tool in mcp.tools() if not allow or tool["name"] in allow]

        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": question})

        for round_number in range(1, 4):
            # After a tool result, ask for the final answer without re-sending the
            # tool schemas. llama.cpp's Llama-3.2 parser rejects some follow-up
            # outputs as "peg-native" errors; dropping the schemas removes the
            # parser from the answer round. Set LAMA_TOOLS_ALWAYS=1 to keep them
            # for models that need multi-round tool use.
            answered = any(message.get("role") == "tool" for message in messages)
            payload = {
                "model": MODEL,
                "messages": messages,
                "max_tokens": 300,
                "temperature": 0,
            }
            if not answered or os.environ.get("LAMA_TOOLS_ALWAYS") == "1":
                payload["tools"] = tools
                payload["tool_choice"] = "auto"
            reply = post_json("/v1/chat/completions", payload)
            message = reply["choices"][0]["message"]
            calls = message.get("tool_calls") or []
            if not calls:
                return reply["choices"][0]["message"].get("content", "")
            messages.append(message)
            for call in calls:
                name = call["function"]["name"]
                arguments = json.loads(call["function"].get("arguments") or "{}")
                print("  [round %d] tool %s %s" % (round_number, name, arguments), file=sys.stderr)
                output = mcp.call(name, arguments)
                print("  [round %d] result %r" % (round_number, output[:120]), file=sys.stderr)
                messages.append({
                    "role": "tool",
                    "tool_call_id": call.get("id", ""),
                    "name": name,
                    "content": output,
                })
        return "(stopped after three tool rounds)"
    finally:
        mcp.close()


def job():
    """One real task, every protocol, one artifact on disk.

    Stage 1 MCP stdio  read the facts from the workspace (tool, not the model)
    Stage 2 TCP        model turns the facts into a single structured line
    Stage 3 Anthropic  model writes a title in the Anthropic response shape
    Stage 4 SSE        model streams a closing line (chunked, not one blob)
    Stage 5 engine     engine TCP :9931 directly (no manager in the path)
    Stage 6 UDS        engine health over the Unix socket (no TCP, no manager)
    Stage 7 MCP stdio  write report.txt back into the workspace
    """
    mcp = Mcp()
    try:
        facts = mcp.call("read_file", {"path": "facts.txt"})
        print("[mcp] read facts.txt: %r" % facts[:80], file=sys.stderr)

        body = post_json("/v1/chat/completions", {
            "model": MODEL,
            "messages": [{
                "role": "user",
                "content": "These are key=value facts:\n%s\nReply with exactly one line: "
                           "CODENAME=<codename> PORT=<port>. No other words." % facts,
            }],
            "max_tokens": 40,
            "temperature": 0,
        })
        line = body["choices"][0]["message"]["content"].strip().replace("\n", " ")
        print("[tcp] %s %s" % (STATUS["code"], line), file=sys.stderr)

        title = anthropic("Reply with a five-word title for a service described by: " + line)
        heading = title["content"][0]["text"].strip().replace("\n", " ")
        print("[anthropic] %s %s" % (STATUS["code"], heading), file=sys.stderr)

        streamed = []
        for _, data in stream("/v1/chat/completions", {
            "model": MODEL,
            "messages": [{"role": "user", "content": "Say exactly: report complete"}],
            "max_tokens": 12,
            "temperature": 0,
        }):
            if data == "[DONE]":
                break
            try:
                delta = (json.loads(data).get("choices") or [{}])[0].get("delta", {}).get("content") or ""
            except json.JSONDecodeError:
                continue
            if delta:
                streamed.append(delta)
        closing = "".join(streamed).strip()
        print("[sse] %s %s" % (STATUS["code"], closing), file=sys.stderr)

        direct = post_json("/v1/chat/completions", {
            "model": MODEL,
            "messages": [{"role": "user", "content": "Reply with exactly: engine direct works"}],
            "max_tokens": 12,
            "temperature": 0,
        }, base=ENGINE)
        engine_line = direct["choices"][0]["message"]["content"].strip().replace("\n", " ")
        print("[engine] %s %s" % (STATUS["code"], engine_line), file=sys.stderr)

        health = uds_post("/v1/chat/completions", {
            "model": MODEL,
            "messages": [{"role": "user", "content": "Say OK"}],
            "max_tokens": 4,
            "temperature": 0,
        })
        engine_says = health["choices"][0]["message"]["content"].strip()
        print("[uds] %s %s" % (STATUS["code"], engine_says), file=sys.stderr)

        report = "# %s\n\n- facts: %s\n- model line: %s\n- anthropic title: %s\n- stream: %s\n- engine tcp: %s\n- uds: %s\n" % (
            heading, facts.strip().replace("\n", "; "), line, heading, closing, engine_line, engine_says,
        )
        written = mcp.call("write_file", {"path": "report.txt", "content": report})
        print("[mcp] wrote report.txt: %s" % written[:120], file=sys.stderr)
        print(report)
        return 0
    finally:
        mcp.close()


def shape():
    """Check the two response formats against the fields a client may rely on.

    OpenAI chat.completion and Anthropic message are different objects; a client
    written for one must not be pointed at the other. This prints one line per
    format, so a wrong field name is visible instead of silently empty.
    """
    problems = []

    openai = chat("Reply with exactly: shape")
    message = (openai.get("choices") or [{}])[0].get("message") or {}
    finish = (openai.get("choices") or [{}])[0].get("finish_reason")
    usage = openai.get("usage") or {}
    checks = [
        ("object", openai.get("object") == "chat.completion"),
        ("choices[0].message.role", message.get("role") == "assistant"),
        ("choices[0].message.content", isinstance(message.get("content"), str)),
        ("choices[0].finish_reason", finish in {"stop", "length", "tool_calls"}),
        ("usage.prompt_tokens", isinstance(usage.get("prompt_tokens"), int)),
        ("usage.completion_tokens", isinstance(usage.get("completion_tokens"), int)),
    ]
    for name, ok in checks:
        if not ok:
            problems.append("openai." + name)
    print("[openai] object=%s finish=%s usage=%s %s" % (
        openai.get("object"), finish,
        "%s/%s" % (usage.get("prompt_tokens"), usage.get("completion_tokens")),
        "OK" if all(ok for _, ok in checks) else "FAIL " + ",".join(problems)))

    anth = anthropic("Reply with exactly: shape")
    blocks = anth.get("content") or []
    text_blocks = [block for block in blocks if block.get("type") == "text"]
    usage = anth.get("usage") or {}
    checks = [
        ("type", anth.get("type") == "message"),
        ("role", anth.get("role") == "assistant"),
        ("content[].type", bool(text_blocks) and isinstance(text_blocks[0].get("text"), str)),
        ("stop_reason", anth.get("stop_reason") in {"end_turn", "max_tokens", "stop_sequence", "tool_use"}),
        ("stop_sequence", "stop_sequence" in anth),
        ("usage.input_tokens", isinstance(usage.get("input_tokens"), int)),
        ("usage.output_tokens", isinstance(usage.get("output_tokens"), int)),
    ]
    for name, ok in checks:
        if not ok:
            problems.append("anthropic." + name)
    print("[anthropic] type=%s blocks=%d stop=%s usage=%s/%s id=%s %s" % (
        anth.get("type"), len(blocks), anth.get("stop_reason"),
        usage.get("input_tokens"), usage.get("output_tokens"), anth.get("id"),
        "OK" if all(ok for _, ok in checks) else "FAIL " + ",".join(problems)))

    chunks, done = [], False
    for _, data in stream("/v1/chat/completions", {
        "model": MODEL,
        "messages": [{"role": "user", "content": "Count to three"}],
        "max_tokens": 20,
        "temperature": 0,
    }):
        if data == "[DONE]":
            done = True
            break
        try:
            chunks.append(json.loads(data))
        except json.JSONDecodeError:
            problems.append("sse.bad_json")
    first = chunks[0] if chunks else {}
    delta = ((first.get("choices") or [{}])[0].get("delta") or {})
    checks = [
        ("object", first.get("object") == "chat.completion.chunk"),
        ("delta.role", delta.get("role") in {"assistant", None}),
        ("delta.content", isinstance(delta.get("content"), (str, type(None)))),
        ("chunks>1", len(chunks) > 1),
        ("[DONE]", done),
    ]
    for name, ok in checks:
        if not ok:
            problems.append("sse." + name)
    print("[sse] object=%s chunks=%d done=%s %s" % (
        first.get("object"), len(chunks), done,
        "OK" if all(ok for _, ok in checks) else "FAIL " + ",".join(problems)))

    if problems:
        print("shape: FAIL " + ",".join(problems))
        return 1
    print("shape: OK (openai=chat.completion, anthropic=message, sse=chat.completion.chunk)")
    return 0


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    command, rest = argv[0], argv[1:]
    if command == "chat":
        reply = chat(" ".join(rest) or "Say OK")
        print(reply["choices"][0]["message"]["content"])
    elif command == "stream":
        text = []
        for event, data in stream("/v1/chat/completions", {
            "model": MODEL,
            "messages": [{"role": "user", "content": " ".join(rest) or "Count to three"}],
            "max_tokens": 80,
            "temperature": 0,
        }):
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                continue
            delta = (chunk.get("choices") or [{}])[0].get("delta", {}).get("content") or ""
            if delta:
                text.append(delta)
                sys.stdout.write(delta)
                sys.stdout.flush()
        print()
    elif command == "anthropic":
        reply = anthropic(" ".join(rest) or "Say OK")
        print(reply["content"][0]["text"])
        print("stop_reason=%s usage=%s" % (reply.get("stop_reason"), reply.get("usage")), file=sys.stderr)
    elif command == "uds":
        reply = uds_post("/v1/chat/completions", {
            "model": MODEL,
            "messages": [{"role": "user", "content": " ".join(rest) or "Say OK"}],
            "max_tokens": 40,
            "temperature": 0,
        })
        print(reply["choices"][0]["message"]["content"])
    elif command == "mcp":
        mcp = Mcp()
        try:
            action = rest[0] if rest else "list"
            if action == "list":
                for tool in mcp.tools():
                    print("%-28s %s" % (tool["name"], tool.get("description", "")[:70]))
            elif action == "call":
                name = rest[1]
                arguments = json.loads(rest[2]) if len(rest) > 2 else {}
                print(mcp.call(name, arguments))
            else:
                return 2
        finally:
            mcp.close()
    elif command == "task":
        print(task(" ".join(rest), system="You are a precise agent. Use the provided tool instead of guessing."))
    elif command == "job":
        return job()
    elif command == "shape":
        return shape()
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
