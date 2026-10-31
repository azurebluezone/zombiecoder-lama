import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { disableService, installService, serviceEnabled, unitPath } from "../src/service.ts";
import { testConfig, testOs } from "./helpers.ts";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lama-service-"));
}

test("each unit kind maps to its own name and script", () => {
  const root = tempRoot();
  const cfg = testConfig(root);
  const linux = { ...testOs(), home: root };

  assert.equal(unitPath(linux, "user", "engine"), path.join(root, ".config", "systemd", "user", "lama-engine.service"));
  assert.equal(unitPath(linux, "user", "manager"), path.join(root, ".config", "systemd", "user", "lama-mgmt.service"));
  assert.equal(unitPath(linux, "user", "status"), path.join(root, ".config", "systemd", "user", "lama-status.service"));
  assert.equal(unitPath(linux, "user", "admin"), path.join(root, ".config", "systemd", "user", "lama-admin.service"));

  // The manager and the status file are plain .mjs entry points; the engine and
  // the admin are main.ts subcommands. A wrong script here means a unit that
  // starts, exits, and restarts forever.
  const mac = { ...testOs(), platform: "darwin" as const, home: root };
  const managerPlist = unitPath(mac, "user", "manager");
  assert.match(managerPlist, /com\.lama\.lama-mgmt\.plist$/);

  const windows = { ...testOs(), platform: "win32" as const, home: root };
  const plan = installService(cfg, windows, "user", "status", { start: true });
  assert.equal(plan.ok, false);
  assert.ok(plan.needsRoot);
  assert.match(plan.commands?.join("\n") ?? "", /server[\\/]status\.mjs/);
  assert.match(plan.commands?.join("\n") ?? "", /lama-status/);
});

test("the admin unit is never started by an install", () => {
  const root = tempRoot();
  const cfg = testConfig(root);
  const windows = { ...testOs(), platform: "win32" as const, home: root };
  const admin = installService(cfg, windows, "user", "admin");
  const engine = installService(cfg, windows, "user", "engine");
  // start=false shows up as `start= demand` on Windows and as no --now on systemd.
  assert.match(admin.commands?.join("\n") ?? "", /start= demand/);
  assert.match(engine.commands?.join("\n") ?? "", /start= auto/);
});

test("disableService removes a launchd plist and is quiet when absent", () => {
  const root = tempRoot();
  const mac = { ...testOs(), platform: "darwin" as const, home: root };
  const plist = unitPath(mac, "user", "admin");
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, "<plist/>");

  const first = disableService(mac, "user", "admin");
  assert.equal(first.ok, true);
  assert.equal(fs.existsSync(plist), false);

  const second = disableService(mac, "user", "admin");
  assert.equal(second.ok, true);
});

test("serviceEnabled reads the unit file on darwin and nothing on windows", () => {
  const root = tempRoot();
  const mac = { ...testOs(), platform: "darwin" as const, home: root };
  assert.equal(serviceEnabled(mac, "user", "engine"), false);
  fs.mkdirSync(path.dirname(unitPath(mac, "user", "engine")), { recursive: true });
  fs.writeFileSync(unitPath(mac, "user", "engine"), "<plist/>");
  assert.equal(serviceEnabled(mac, "user", "engine"), true);
});
