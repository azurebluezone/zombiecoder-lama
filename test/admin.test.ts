import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAdminServer } from "../src/admin.ts";
import { Store, seedStore } from "../src/db.ts";
import { EngineManager } from "../src/engine.ts";
import { testConfig, testOs } from "./helpers.ts";

async function withAdmin(
  run: (base: string, store: Store, cfg: ReturnType<typeof testConfig>) => Promise<void>,
  prepare?: (cfg: ReturnType<typeof testConfig>) => Promise<void>,
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-admin-"));
  const cfg = testConfig(root);
  cfg.webDir = path.resolve("web");
  const osInfo = testOs();
  const store = new Store(cfg.dbFile);
  seedStore(store, cfg, osInfo);
  if (prepare) await prepare(cfg);
  const engine = new EngineManager(store, cfg, osInfo);
  const server = createAdminServer({ store, cfg, os: osInfo, engine });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  try {
    await run(`http://127.0.0.1:${address.port}`, store, cfg);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const auth = { authorization: "Bearer test-token" };

test("admin API rejects missing and wrong tokens but accepts the configured one", async () => {
  await withAdmin(async (base) => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/api/state`, { headers: { authorization: "Bearer wrong" } })).status, 401);
    const state = await fetch(`${base}/api/state`, { headers: auth });
    assert.equal(state.status, 200);
    const body = (await state.json()) as { ok: boolean; transports: Array<{ id: string }>; engine: { status: string } };
    assert.equal(body.ok, true);
    assert.ok(body.transports.some((transport) => transport.id === "uds"));
    assert.equal(body.engine.status, "stopped");
  });
});

test("admin serves the login page and assets with a strict CSP", async () => {
  await withAdmin(async (base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    const script = await fetch(`${base}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /text\/javascript/);
    assert.equal((await fetch(`${base}/../../etc/passwd`)).status, 404);
  });
});

test("tool parser endpoint recovers a marker call and executes nothing", async () => {
  await withAdmin(async (base, store) => {
    const response = await fetch(`${base}/api/tools/parse`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ text: "TOOL: read_file\nPATH: notes/todo.txt\n" }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { calls: Array<{ name: string; source: string; arguments: Record<string, unknown> }> };
    assert.equal(body.calls.length, 1);
    assert.equal(body.calls[0]?.name, "read_file");
    assert.equal(body.calls[0]?.source, "marker");
    assert.equal(store.listAudit(10)[0]?.action, "tools.parse");
  });
});

test("invalid model paths and unknown tools are rejected without side effects", async () => {
  await withAdmin(async (base, store) => {
    const badModel = await fetch(`${base}/api/models`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "bad", path: "/does/not/exist.gguf" }),
    });
    assert.equal(badModel.status, 400);
    assert.equal(store.listModels().some((model) => model.id === "bad"), false);

    const badTool = await fetch(`${base}/api/tools/call`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "rm_rf", arguments: {} }),
    });
    assert.equal(badTool.status, 400);
  });
});

test("manager proxies the engine surface and stamps identity headers", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"object":"list","data":[{"id":"stub"}]}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("no upstream port");
  try {
    await withAdmin(
      async (base) => {
        const models = await fetch(`${base}/v1/models`);
        assert.equal(models.status, 200);
        assert.deepEqual(await models.json(), { object: "list", data: [{ id: "stub" }] });
        assert.equal(models.headers.get("x-system-identity"), "lama");
        assert.equal(models.headers.get("x-system-owner"), "Sahon Srabon");
        const admin = await fetch(`${base}/admin`, { redirect: "manual" });
        assert.equal(admin.status, 302);
        assert.equal(admin.headers.get("location"), "/");
      },
      async (cfg) => {
        cfg.engineUrl = `http://127.0.0.1:${address.port}`;
      },
    );
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
