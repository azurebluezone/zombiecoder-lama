#!/usr/bin/env node
/**
 * Cross-platform setup for the lama decoration layer. Node built-ins only.
 *
 * What it does:
 *   1. Locate the llama.cpp binary (env LLAMA_BIN, PATH, known install dirs).
 *   2. Probe `llama version` so we fail loudly instead of guessing.
 *   3. Write <lama>/.env from templates/env.template with computed values.
 *   4. Linux: install a systemd --user unit from templates/lama-mgmt.service.
 *      Windows: persist env vars with `setx` (service via templates/start-server.bat).
 *
 * Usage:  node scripts/setup.mjs [--unit-only] [--no-reload]
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LAMA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = os.homedir();
const PLATFORM = process.platform; // linux | darwin | win32
const args = new Set(process.argv.slice(2));

const die = (msg) => { process.stderr.write(`setup: ${msg}\n`); process.exit(1); };
const say = (msg) => process.stdout.write(`setup: ${msg}\n`);
const isWin = PLATFORM === "win32";

function findLlamaBinary() {
  if (process.env.LLAMA_BIN && fs.existsSync(process.env.LLAMA_BIN)) return process.env.LLAMA_BIN;
  const names = isWin ? ["llama.exe", "llama.cmd", "llama.bat", "llama"] : ["llama"];
  const roots = isWin
    ? [path.join(process.env.LOCALAPPDATA || HOME, "Programs", "llama"),
       path.join(process.env.LOCALAPPDATA || HOME, "llama"),
       HOME]
    : [path.join(HOME, ".local", "bin"), "/usr/local/bin", "/usr/bin"];
  for (const root of roots) for (const n of names) {
    const p = path.join(root, n);
    if (fs.existsSync(p)) return p;
  }
  // Fall back to PATH lookup via `where`/`command -v`.
  const probe = spawnSync(isWin ? "where" : "bash",
    isWin ? ["llama"] : ["-c", "command -v llama"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim().split(/\r?\n/)[0];
  return null;
}

function probeVersion(bin) {
  try {
    return execFileSync(bin, ["version"], { encoding: "utf8", timeout: 20_000 }).trim();
  } catch (e) {
    return die(`cannot run "${bin} version": ${e.message.split("\n")[0]}`);
  }
}

function renderTemplate(rel, vars) {
  const src = fs.readFileSync(path.join(LAMA, "templates", rel), "utf8");
  return src.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) die(`template ${rel} needs ${k}`);
    return vars[k];
  });
}

// --- 1. llama binary ---------------------------------------------------------
const bin = findLlamaBinary();
if (!bin) {
  say("llama binary NOT found. Install first, then re-run:");
  say(isWin ? "  https://llama.app (Windows installer)" : "  curl -LsSf https://llama.app/install.sh | sh");
  process.exit(2);
}
const version = probeVersion(bin);
say(`llama found: ${bin}`);
say(version.split("\n")[0]);

// --- 2. .env -----------------------------------------------------------------
const envPath = path.join(LAMA, ".env");
if (fs.existsSync(envPath)) {
  say(`.env already exists — keeping it: ${envPath}`);
} else {
  const envText = renderTemplate("env.template", {
    LLAMA_BIN: bin,
    LAMA_DIR: LAMA,
  });
  fs.writeFileSync(envPath, envText, { mode: 0o600 });
  say(`wrote ${envPath} (mode 600)`);
}

// --- 3. service ---------------------------------------------------------------
if (isWin) {
  // Persist user-level env vars (survive new terminals). NOT_TESTED on Windows here.
  const pairs = { LLAMA_BIN: bin, LAMA_DIR: LAMA };
  for (const [k, v] of Object.entries(pairs)) {
    const r = spawnSync("setx", [k, v], { encoding: "utf8" });
    if (r.status !== 0) die(`setx ${k} failed: ${r.stderr}`);
    say(`setx ${k}=${v}`);
  }
  const bat = path.join(LAMA, "start-server.bat");
  fs.writeFileSync(bat, renderTemplate("start-server.bat", {}));
  say(`wrote ${bat} (double-click or schedule it to run the manager)`);
  say("Windows path is delivered but NOT tested on this Linux box.");
} else if (!args.has("--unit-only") || true) {
  const unitDir = path.join(HOME, ".config", "systemd", "user");
  fs.mkdirSync(unitDir, { recursive: true });
  const unitPath = path.join(unitDir, "lama-mgmt.service");
  const unit = renderTemplate("lama-mgmt.service", { LAMA_DIR: LAMA, HOME });
  fs.writeFileSync(unitPath, unit);
  say(`wrote ${unitPath}`);
  if (!args.has("--no-reload")) {
    const r = spawnSync("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
    if (r.status !== 0) say(`daemon-reload failed (loginctl enable-linger may be needed): ${r.stderr}`);
    else say("systemd user daemon reloaded");
  }
}

say("done. Start with: systemctl --user enable --now lama-mgmt.service");
