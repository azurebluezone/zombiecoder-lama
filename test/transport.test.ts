import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { linkSocket, requestUds } from "../src/transport.ts";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lama-uds-"));
}

test("requestUds talks to a real HTTP server on a Unix socket", async () => {
  const root = tempRoot();
  const socket = path.join(root, "test.sock");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(socket, () => resolve()));
  try {
    const result = await requestUds(socket, "/health", { timeoutMs: 5000 });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.text), { ok: true });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(socket, { force: true });
  }
});

test("linkSocket creates a symlink and is idempotent", async () => {
  const root = tempRoot();
  const socket = path.join(root, "engine.sock");
  const gateway = path.join(root, "gateway");
  const server = http.createServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(socket, () => resolve()));
  try {
    const first = linkSocket(socket, gateway);
    assert.equal(first.changed, true);
    assert.equal(fs.readlinkSync(first.target), socket);
    const second = linkSocket(socket, gateway);
    assert.equal(second.changed, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(socket, { force: true });
  }
});
