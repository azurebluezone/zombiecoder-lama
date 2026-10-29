import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store, seedStore } from "../src/db.ts";
import { testConfig, testOs } from "./helpers.ts";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lama-db-"));
}

test("schema seeds provider, transports, documents, prompt and the llama-tools MCP row", () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, "models"), { recursive: true });
  fs.writeFileSync(path.join(root, "models", "tiny-model.Q4_K_M.gguf"), "not a real model");
  const cfg = testConfig(root);
  const store = new Store(cfg.dbFile);
  seedStore(store, cfg, testOs());

  assert.equal(store.getProvider("llamacpp")?.id, "llamacpp");
  assert.ok(store.getTransport("http"));
  assert.ok(store.getTransport("uds"));
  assert.ok(store.getDocumentBySlug("openai-http"));
  assert.ok(store.getDocumentBySlug("anthropic-http"));
  assert.ok(store.defaultPrompt());
  assert.equal(store.getMcp("lama-tools")?.transport, "stdio");
  assert.equal(store.listModels().length, 1);
  assert.equal(store.listModels()[0]?.id, "tiny-model-q4-k-m");
});

test("prompt update increments the stored version", () => {
  const root = tempRoot();
  const cfg = testConfig(root);
  const store = new Store(cfg.dbFile);
  seedStore(store, cfg, testOs());
  store.upsertPrompt({ id: "default", name: "default", content: "first", version: 1, is_default: 1, metadata_json: "{}" });
  assert.equal(store.getPrompt("default")?.version, 2);
  store.upsertPrompt({ id: "default", name: "default", content: "second", version: 1, is_default: 1, metadata_json: "{}" });
  assert.equal(store.getPrompt("default")?.version, 3);
});

test("engine state round-trips through SQLite", () => {
  const root = tempRoot();
  const cfg = testConfig(root);
  const store = new Store(cfg.dbFile);
  store.setEngineState({
    model_id: "m1",
    pid: 1234,
    status: "running",
    started_at: "2026-01-01T00:00:00.000Z",
    expires_at: "2026-01-01T04:00:00.000Z",
    load_mode: "auto",
    socket_path: cfg.udsPath,
    port: 19931,
    build: "b11982",
    last_error: null,
  });
  const state = store.engineState();
  assert.equal(state.model_id, "m1");
  assert.equal(state.status, "running");
  assert.equal(state.load_mode, "auto");
  assert.equal(store.listAudit().length, 0);
});
