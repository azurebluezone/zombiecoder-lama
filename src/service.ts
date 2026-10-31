import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Config } from "./config.ts";
import type { OsInfo } from "./types.ts";

/**
 * Four units, four jobs. The engine and the two serving processes are resident;
 * the admin is deliberately not part of a normal install — it is a client you
 * start when you want it, and it must never be the thing that owns the engine.
 */
export type UnitKind = "engine" | "manager" | "status" | "admin";

export interface ServiceResult {
  ok: boolean;
  detail: string;
  path?: string;
  needsRoot?: boolean;
  commands?: string[];
}

const UNIT: Record<UnitKind, string> = {
  engine: "lama-engine",
  manager: "lama-mgmt",
  status: "lama-status",
  admin: "lama-admin",
};

interface KindSpec {
  description: string;
  script: string;
  args: string[];
}

function spec(cfg: Config, kind: UnitKind): KindSpec {
  switch (kind) {
    case "engine":
      return { description: "lama engine runner (stock llama.cpp)", script: path.join(cfg.root, "src", "main.ts"), args: ["engine-run"] };
    case "manager":
      return { description: "lama manager (/v1 proxy, no admin)", script: path.join(cfg.root, "server", "server.mjs"), args: [] };
    case "status":
      return { description: "lama status file (read-only polling)", script: path.join(cfg.root, "server", "status.mjs"), args: [] };
    case "admin":
      return { description: "lama admin API and UI (optional, on-demand only)", script: path.join(cfg.root, "src", "main.ts"), args: ["serve"] };
  }
}

function run(command: string, args: string[]): { status: number; text: string } {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 20_000 });
  return { status: result.status ?? 1, text: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

export function unitPath(os: OsInfo, mode: "user" | "system", kind: UnitKind = "engine"): string {
  const name = UNIT[kind];
  if (os.platform === "linux") {
    return mode === "user"
      ? path.join(os.home, ".config", "systemd", "user", `${name}.service`)
      : `/etc/systemd/system/${name}.service`;
  }
  if (os.platform === "darwin") {
    return mode === "user"
      ? path.join(os.home, "Library", "LaunchAgents", `com.lama.${name}.plist`)
      : `/Library/LaunchDaemons/com.lama.${name}.plist`;
  }
  return path.join(os.home, "AppData", "Local", "lama", `${name}.service.txt`);
}

function systemdUnit(cfg: Config, kind: UnitKind): string {
  const { description, script, args } = spec(cfg, kind);
  return `[Unit]
Description=${description}
After=network.target

[Service]
Type=simple
WorkingDirectory=${cfg.root}
Environment=LAMA_ENV_FILE=${cfg.envFile}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:%h/.local/bin
ExecStart=${[process.execPath, script, ...args].join(" ")}
Restart=on-failure
RestartSec=2
KillMode=mixed
TimeoutStopSec=20
LimitNOFILE=65535

[Install]
WantedBy=default.target
`;
}

function launchdPlist(cfg: Config, kind: UnitKind): string {
  const { script, args } = spec(cfg, kind);
  const name = UNIT[kind];
  const programArguments = [process.execPath, script, ...args].map((value) => `    <string>${value}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.lama.${name}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>WorkingDirectory</key><string>${cfg.root}</string>
  <key>EnvironmentVariables</key>
  <dict><key>LAMA_ENV_FILE</key><string>${cfg.envFile}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(cfg.logsDir, `${name}.log`)}</string>
  <key>StandardErrorPath</key><string>${path.join(cfg.logsDir, `${name}.err.log`)}</string>
</dict>
</plist>
`;
}

export function installService(
  cfg: Config,
  os: OsInfo,
  mode: "user" | "system",
  kind: UnitKind = "engine",
  options: { start?: boolean } = {},
): ServiceResult {
  const name = UNIT[kind];
  // Resident by default for the three serving units; the admin is never started
  // by an install — the operator starts it when they actually want it.
  const start = options.start ?? kind !== "admin";
  if (mode === "system" && !os.isRoot) {
    const target = unitPath(os, mode, kind);
    return {
      ok: false,
      needsRoot: true,
      detail: "system service needs root; no sudo was executed",
      path: target,
      commands: [
        `sudo mkdir -p ${path.dirname(target)}`,
        `sudo tee ${target} >/dev/null <<'EOF'\n${systemdUnit(cfg, kind)}EOF`,
        "sudo systemctl daemon-reload",
        `sudo systemctl enable${start ? " --now" : ""} ${name}`,
      ],
    };
  }

  if (os.platform === "linux") {
    const target = unitPath(os, mode, kind);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.writeFileSync(target, systemdUnit(cfg, kind), { mode: 0o644 });
    const scope = mode === "user" ? ["--user"] : [];
    const reload = run("systemctl", [...scope, "daemon-reload"]);
    if (reload.status !== 0) return { ok: false, detail: reload.text, path: target };
    const enable = run("systemctl", [...scope, "enable", ...(start ? ["--now"] : []), `${name}.service`]);
    return { ok: enable.status === 0, detail: enable.text || `enabled ${name}`, path: target };
  }

  if (os.platform === "darwin") {
    const target = unitPath(os, mode, kind);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.writeFileSync(target, launchdPlist(cfg, kind), { mode: 0o644 });
    const domain = mode === "user" ? `gui/${process.getuid?.() ?? 0}` : "system";
    const load = run("launchctl", ["bootstrap", domain, target]);
    return { ok: load.status === 0, detail: load.text || "loaded", path: target };
  }

  const target = unitPath(os, mode, kind);
  const { script, args } = spec(cfg, kind);
  return {
    ok: false,
    needsRoot: true,
    detail: "Windows service install needs an elevated shell; no elevation was attempted",
    path: target,
    commands: [
      `sc.exe create ${name} binPath= "${[process.execPath, script, ...args].join(" ")}" start= ${start ? "auto" : "demand"}`,
      `sc.exe ${start ? "start" : "description"} ${name}`,
    ],
  };
}

export function serviceAction(
  os: OsInfo,
  mode: "user" | "system",
  action: "start" | "stop" | "restart" | "status",
  kind: UnitKind = "engine",
): ServiceResult {
  const name = UNIT[kind];
  if (os.platform === "linux") {
    const scope = mode === "user" ? ["--user"] : [];
    const args = action === "status" ? [...scope, "is-active", `${name}.service`] : [...scope, action, `${name}.service`];
    const result = run("systemctl", args);
    return { ok: result.status === 0, detail: result.text };
  }
  if (os.platform === "darwin") {
    const domain = mode === "user" ? `gui/${process.getuid?.() ?? 0}` : "system";
    const args =
      action === "restart"
        ? ["kickstart", "-k", `${domain}/com.lama.${name}`]
        : action === "start"
          ? ["kickstart", `${domain}/com.lama.${name}`]
          : action === "stop"
            ? ["kill", "SIGTERM", `${domain}/com.lama.${name}`]
            : ["print", `${domain}/com.lama.${name}`];
    const result = run("launchctl", args);
    return { ok: result.status === 0, detail: result.text };
  }
  if (action === "status") {
    const result = run("sc.exe", ["query", name]);
    return { ok: result.status === 0, detail: result.text };
  }
  const result = run("sc.exe", [action === "stop" ? "stop" : "start", name]);
  return { ok: result.status === 0, detail: result.text };
}

export function servicePid(os: OsInfo, mode: "user" | "system", kind: UnitKind = "engine"): number | null {
  const name = UNIT[kind];
  if (os.platform === "linux") {
    const scope = mode === "user" ? ["--user"] : [];
    const result = run("systemctl", [...scope, "show", "-p", "MainPID", "--value", `${name}.service`]);
    const pid = Number(result.text.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }
  if (os.platform === "darwin") {
    const domain = mode === "user" ? `gui/${process.getuid?.() ?? 0}` : "system";
    const result = run("launchctl", ["print", `${domain}/com.lama.${name}`]);
    const match = /pid = (\d+)/.exec(result.text);
    return match ? Number(match[1]) : null;
  }
  return null;
}

/**
 * True when the unit is installed *and* enabled at boot, whether or not it is
 * running right now. The engine uses this to decide who owns the process: once a
 * supervisor unit is enabled, no admin/CLI call may spawn its own engine.
 */
export function serviceEnabled(os: OsInfo, mode: "user" | "system", kind: UnitKind = "engine"): boolean {
  const name = UNIT[kind];
  if (os.platform === "linux") {
    const scope = mode === "user" ? ["--user"] : [];
    const result = run("systemctl", [...scope, "is-enabled", `${name}.service`]);
    return result.status === 0 && /^enabled|^static|^indirect/im.test(result.text.trim());
  }
  if (os.platform === "darwin") {
    return fs.existsSync(unitPath(os, mode, kind));
  }
  return run("sc.exe", ["query", name]).status === 0;
}

/** Disable (and optionally stop) a unit without failing when it was never installed. */
export function disableService(
  os: OsInfo,
  mode: "user" | "system",
  kind: UnitKind = "engine",
  options: { stop?: boolean } = {},
): ServiceResult {
  const name = UNIT[kind];
  if (os.platform === "linux") {
    const scope = mode === "user" ? ["--user"] : [];
    if (options.stop) run("systemctl", [...scope, "stop", `${name}.service`]);
    const result = run("systemctl", [...scope, "disable", `${name}.service`]);
    run("systemctl", [...scope, "reset-failed", `${name}.service`]);
    return { ok: result.status === 0 || /No such file|not loaded/i.test(result.text), detail: result.text || "disabled" };
  }
  if (os.platform === "darwin") {
    const target = unitPath(os, mode, kind);
    const domain = mode === "user" ? `gui/${process.getuid?.() ?? 0}` : "system";
    if (options.stop) run("launchctl", ["bootout", `${domain}/com.lama.${name}`]);
    try {
      fs.rmSync(target, { force: true });
    } catch {
      // already gone
    }
    return { ok: true, detail: `removed ${target}`, path: target };
  }
  const result = run("sc.exe", ["delete", name]);
  return { ok: result.status === 0 || /1060/.test(result.text), detail: result.text || "deleted" };
}

export function serviceAvailable(os: OsInfo): boolean {
  if (os.platform === "linux") return fs.existsSync("/run/systemd/system");
  return os.platform === "darwin" || os.platform === "win32";
}
