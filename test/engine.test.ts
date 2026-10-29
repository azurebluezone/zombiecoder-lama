import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ensureTls, relinkLocalSymlinks, shipsAssets, tlsSupport } from "../src/installer.ts";
import { buildEngineArgs, resolveBinary } from "../src/engine.ts";
import { testConfig, testOs } from "./helpers.ts";

const openssl = spawnSync("openssl", ["version"], { encoding: "utf8" }).status === 0;

test("ensureTls generates a matching cert/key once, then reuses it", { skip: !openssl }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-tls-"));
  const cfg = testConfig(root);
  const first = ensureTls(cfg);
  assert.equal(first.ok, true, first.detail);
  assert.equal(first.generated, true);
  const second = ensureTls(cfg);
  assert.equal(second.ok, true, second.detail);
  assert.equal(second.generated, false);
});

test("ensureTls detects a certificate/key mismatch", { skip: !openssl }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-tls-"));
  const cfg = testConfig(root);
  assert.equal(ensureTls(cfg).ok, true);
  // Replace the key with a fresh one that does not belong to the certificate.
  const other = path.join(root, "other-key.pem");
  const result = spawnSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=other", "-keyout", other, "-out", path.join(root, "other-cert.pem")],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  fs.copyFileSync(other, cfg.tlsKey);
  const checked = ensureTls(cfg);
  assert.equal(checked.ok, false);
  assert.match(checked.detail, /do not match/);
});

test("resolveBinary accepts the unified llama binary and adds the serve prefix", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-bin-"));
  const binary = path.join(root, "llama");
  fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const cfg = testConfig(root);
  cfg.llamaBin = "";
  const previous = process.env.PATH;
  process.env.PATH = `${root}${path.delimiter}${previous ?? ""}`;
  try {
    const resolved = resolveBinary(cfg);
    assert.equal(resolved.command, binary);
    assert.deepEqual(resolved.prefix, ["serve"]);
  } finally {
    process.env.PATH = previous;
  }
});


test("resolveBinary finds the project bin link created by install:llama", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-bin-"));
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const binary = path.join(binDir, "llama-server");
  fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const cfg = testConfig(root);
  cfg.llamaBin = "";
  const savedPath = process.env.PATH;
  const savedHome = process.env.HOME;
  // Hide any real PATH or ~/.local/bin install so only <root>/bin can answer.
  process.env.PATH = "/nonexistent";
  process.env.HOME = root;
  try {
    const resolved = resolveBinary(cfg);
    assert.equal(resolved.command, binary);
    assert.deepEqual(resolved.prefix, []);
  } finally {
    process.env.PATH = savedPath;
    process.env.HOME = savedHome;
  }
});

test("resolveBinary honours an explicit override and fails loudly", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-bin-"));
  const cfg = testConfig(root);
  cfg.llamaBin = path.join(root, "missing-binary");
  assert.throws(() => resolveBinary(cfg), /llama binary not found/);
});

test("buildEngineArgs serves HTTP and UDS in one stock command", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-args-"));
  const cfg = testConfig(root);
  const model = path.join(root, "model.gguf");
  fs.writeFileSync(model, "not a real model");
  const binary = path.join(root, "llama-server");
  fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  cfg.llamaBin = binary;
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(path.join(cfg.dataDir, "mcp-servers.generated.json"), '{"mcpServers":{"x":{"command":"y"}}}');
  const built = buildEngineArgs(cfg, {
    id: "m1",
    provider_id: "llamacpp",
    name: "m1",
    model_id: "m1",
    path: model,
    context: 2048,
    max_tokens: 128,
    temperature: 0.7,
    quant: null,
    load_mode: "auto",
    ttl_hours: 1,
    enabled: 1,
    metadata_json: "{}",
    created_at: "",
    updated_at: "",
  });
  assert.equal(built.command, binary);
  assert.equal(built.args[built.args.indexOf("--host") + 1], `127.0.0.1,${cfg.udsPath}`);
  assert.ok(built.args.includes("--jinja"));
  assert.ok(built.args.includes("--mcp-servers-config"));
  assert.equal(built.args[built.args.indexOf("--port") + 1], "19931");
});

test("tlsSupport reports static binaries as undetermined instead of guessing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-ldd-"));
  const binary = path.join(root, "llama");
  fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const result = tlsSupport(binary, {
    platform: "linux",
    arch: "x64",
    distro: "test",
    distroVersion: "",
    glibc: null,
    isRoot: false,
    serviceManager: "systemd",
    home: root,
    pathSep: "/",
  });
  assert.equal(result.supported, null);
  assert.match(result.detail, /not a dynamic executable/);
});

test("shipsAssets skips a release that is still uploading and names the gap", () => {
  const os = testOs();
  // b11985 on GitHub had only the cudart companions — no CPU tarball yet.
  assert.equal(shipsAssets("b11985", ["cudart-llama-b11985-bin-ubuntu-cuda-13.4-x64.tar.gz"], os, "cpu"), false);
  assert.equal(shipsAssets("b11982", ["llama-b11982-bin-ubuntu-x64.tar.gz"], os, "cpu"), true);
  assert.equal(
    shipsAssets("b11982", ["llama-b11982-bin-ubuntu-cuda-13.4-x64.tar.gz"], os, "cuda"),
    false,
    "cuda must refuse without its cudart companion",
  );
  assert.equal(shipsAssets("b11982", ["llama-b11982-bin-macos-x64.tar.gz"], os, "cpu"), false, "wrong platform asset is not a match");
});

test("relinkLocalSymlinks repairs the absolute links fs.cpSync leaves behind", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-symlink-"));
  const temp = path.join(root, "temp", "llama-b0");
  const installDir = path.join(root, "bin", "llama", "b0");
  fs.mkdirSync(temp, { recursive: true });
  fs.writeFileSync(path.join(temp, "libllama-common.so.0.8.0"), "elf");
  fs.symlinkSync("libllama-common.so.0.8.0", path.join(temp, "libllama-common.so.0")); // as the archive ships it
  fs.cpSync(temp, installDir, { recursive: true });
  fs.rmSync(path.join(root, "temp"), { recursive: true, force: true }); // install cleans its staging dir
  const link = path.join(installDir, "libllama-common.so.0");
  assert.equal(path.isAbsolute(fs.readlinkSync(link)), true, "cpSync absolutized the link");
  assert.equal(fs.existsSync(link), false, "and it dangles once the temp dir is gone");
  assert.equal(relinkLocalSymlinks(installDir), 1);
  assert.equal(fs.readlinkSync(link), "libllama-common.so.0.8.0");
  assert.equal(fs.existsSync(link), true);
});
