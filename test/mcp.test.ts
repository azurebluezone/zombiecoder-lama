import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { callTool } from "../src/mcp/tools.ts";
import { safeMcpCwd } from "../src/mcp/config.ts";
import { probeStdio } from "../src/mcp/probe.ts";
import { testConfig } from "./helpers.ts";
import type { McpRow } from "../src/types.ts";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lama-mcp-"));
}

function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return run().finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("workspace tools write and read inside the root", async () => {
  const root = tempRoot();
  await withEnv({ LAMA_WORKSPACE: root, LAMA_TOOLS_ALLOW_WRITE: "1" }, async () => {
    const written = (await callTool("write_file", { path: "notes/a.txt", content: "hello" })) as { bytes: number };
    assert.equal(written.bytes, 5);
    const read = (await callTool("read_file", { path: "notes/a.txt" })) as { content: string };
    assert.equal(read.content, "hello");
  });
});

test("write_file is read-only by default", async () => {
  const root = tempRoot();
  await withEnv({ LAMA_WORKSPACE: root, LAMA_TOOLS_ALLOW_WRITE: undefined }, async () => {
    await assert.rejects(() => callTool("write_file", { path: "a.txt", content: "x" }), /disabled by default/);
  });
});

test("path escape and secret paths are refused", async () => {
  const root = tempRoot();
  await withEnv({ LAMA_WORKSPACE: root }, async () => {
    await assert.rejects(() => callTool("read_file", { path: "../outside.txt" }), /escapes the workspace/);
    await assert.rejects(() => callTool("read_file", { path: ".ssh/id_rsa" }), /secret-looking/);
  });
});

test("run_shell refuses metacharacters and non-allowlisted commands", async () => {
  // callTool is async, so failures surface as rejections, not synchronous throws.
  await assert.rejects(() => callTool("run_shell", { cmd: "ls; rm -rf /" }), /metacharacters/);
  await assert.rejects(() => callTool("run_shell", { cmd: "bash -c id" }), /allow-list/);
});

test("run_shell cannot leave the workspace through an absolute path", async () => {
  const root = tempRoot();
  await withEnv({ LAMA_WORKSPACE: root, LAMA_TOOLS_ALLOW_SHELL: "1" }, async () => {
    await assert.rejects(() => callTool("run_shell", { cmd: "cat /etc/passwd" }), /escapes the workspace/);
    await assert.rejects(() => callTool("run_shell", { cmd: "cat ../../etc/passwd" }), /escapes the workspace/);
    await assert.rejects(() => callTool("run_shell", { cmd: "cat ~/.ssh/id_rsa" }), /home-relative|secret-looking/);
  });
});

test("run_shell refuses flags that execute another program", async () => {
  const root = tempRoot();
  await withEnv({ LAMA_WORKSPACE: root, LAMA_TOOLS_ALLOW_SHELL: "1" }, async () => {
    await assert.rejects(() => callTool("run_shell", { cmd: "rg --pre=sh TODO ." }), /runs or writes another program/);
    await assert.rejects(() => callTool("run_shell", { cmd: "find . -exec id ;" }), /metacharacters|runs or writes/);
  });
});

test("run_shell is off unless the operator enables it", async () => {
  const root = tempRoot();
  await withEnv({ LAMA_WORKSPACE: root, LAMA_TOOLS_ALLOW_SHELL: undefined }, async () => {
    await assert.rejects(() => callTool("run_shell", { cmd: "ls ." }), /disabled by default/);
  });
});

test("http_fetch refuses loopback, private and metadata targets", async () => {
  await assert.rejects(() => callTool("http_fetch", { url: "http://localhost/" }), /refusing local hostname/);
  await assert.rejects(
    () => callTool("http_fetch", { url: "http://169.254.169.254/latest/meta-data" }),
    /refusing private address/,
  );
  await assert.rejects(
    () => callTool("http_fetch", { url: "http://127.0.0.1:9933/api/state" }),
    /port 9933 is not allowed/,
  );
  await assert.rejects(() => callTool("http_fetch", { url: "http://10.0.0.5/" }), /refusing private address/);
});

test("a stale MCP cwd from another machine falls back to the repo root", () => {
  const root = tempRoot();
  const cfg = testConfig(root);
  fs.mkdirSync(path.join(root, "workspace"), { recursive: true });
  assert.equal(safeMcpCwd("/home/sahon/lama", cfg), cfg.root);
  assert.equal(safeMcpCwd("/etc", cfg), cfg.root);
  assert.equal(safeMcpCwd("workspace", cfg), fs.realpathSync(path.join(root, "workspace")));
  assert.equal(safeMcpCwd("", cfg), cfg.root);
});

test("the MCP server answers initialize and tools/list over stdio", async () => {
  const row: McpRow = {
    id: "lama-tools",
    name: "lama-tools",
    transport: "stdio",
    command: process.execPath,
    args_json: JSON.stringify([path.resolve("src/mcp/server.ts")]),
    env_json: "{}",
    cwd: process.cwd(),
    url: null,
    api_key_ref: null,
    timeout_ms: 5000,
    enabled: 1,
    status: "unknown",
    last_probe_at: null,
    last_probe_detail: "",
    use_count: 0,
    tools_count: 0,
    metadata_json: "{}",
    created_at: "",
    updated_at: "",
  };
  const result = await probeStdio(row, 5000);
  assert.equal(result.ok, true, result.detail);
  assert.ok(result.tools.some((tool) => tool.name === "read_file"));
  assert.ok(result.tools.some((tool) => tool.name === "run_shell"));
});
