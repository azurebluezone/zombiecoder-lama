import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ROOT, loadConfig } from "../src/config.ts";

const KEYS = [
  "LAMA_HOME",
  "LAMA_DATA_DIR",
  "LAMA_MODELS_DIR",
  "LAMA_DB",
  "LAMA_WEB_DIR",
  "LAMA_UDS_SOCK",
  "LAMA_ADMIN_PORT",
  "LAMA_ENGINE_PORT",
  "LAMA_LLAMA_BIN",
];

function withEnvFile(lines: string[], run: (cfg: ReturnType<typeof loadConfig>) => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lama-config-"));
  const file = path.join(dir, "env");
  fs.writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  process.env.LAMA_ENV_FILE = file;
  try {
    run(loadConfig());
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete process.env.LAMA_ENV_FILE;
  }
}

test("a tunables-only env file derives every path from the project root", () => {
  // This is the .env shape setup writes: no absolute paths, no comments.
  withEnvFile(["LAMA_ENGINE_PORT=9931", "LAMA_ADMIN_PORT=9933", "LAMA_TLS=0"], (cfg) => {
    assert.equal(cfg.root, ROOT);
    assert.equal(cfg.dataDir, path.join(ROOT, "data"));
    assert.equal(cfg.dbFile, path.join(ROOT, "data", "manager.db"));
    assert.equal(cfg.modelsDir, path.join(ROOT, "models"));
    assert.equal(cfg.webDir, path.join(ROOT, "web"));
    assert.equal(cfg.envFile, process.env.LAMA_ENV_FILE);
    assert.equal(cfg.udsPath, path.join(os.tmpdir(), `llama-${process.getuid?.() ?? "user"}`, "llama.sock"));
    assert.equal(cfg.llamaBin, "", "no hardcoded binary path; resolveBinary finds it");
  });
});

test("an explicit empty LAMA_UDS_SOCK disables the unix socket (Windows shape)", () => {
  withEnvFile(["LAMA_UDS_SOCK="], (cfg) => {
    assert.equal(cfg.udsPath, "");
  });
});

test("a relative root override resolves against the working directory, not a home path", () => {
  withEnvFile(["LAMA_HOME=./tmp-root"], (cfg) => {
    assert.equal(cfg.root, path.resolve("./tmp-root"));
    assert.equal(cfg.dataDir, path.resolve("./tmp-root", "data"));
  });
});
