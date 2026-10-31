import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import type { McpRow } from "../types.ts";

export function engineMcpConfigPath(cfg: Config): string {
  return path.join(cfg.dataDir, "mcp-servers.generated.json");
}

function outside(relative: string): boolean {
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/**
 * llama.cpp spawns a stdio MCP server with this cwd. The seed used to carry an
 * absolute path from the developer's machine (/home/sahon/lama), so on every
 * other host the spawn failed with ENOENT and every workspace tool looked broken.
 * A cwd is now trusted only when it is a real directory inside this repo; a stale
 * or escaping value falls back to the repo root instead of being handed to the engine.
 */
export function safeMcpCwd(raw: string, cfg: Config): string {
  const value = String(raw ?? "").trim();
  if (!value) return cfg.root;
  if (value.includes("\0")) throw new Error("mcp cwd contains NUL");
  const resolved = path.resolve(cfg.root, value);
  if (outside(path.relative(cfg.root, resolved))) return cfg.root;
  try {
    const real = fs.realpathSync(resolved);
    if (!fs.statSync(real).isDirectory()) return cfg.root;
    if (outside(path.relative(fs.realpathSync(cfg.root), real))) return cfg.root;
    return real;
  } catch {
    return cfg.root;
  }
}

export function engineMcpConfig(store: Store, cfg: Config): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  for (const row of store.listMcp()) {
    if (!row.enabled || row.transport !== "stdio" || !row.command) continue;
    servers[row.name] = {
      command: row.command,
      args: JSON.parse(row.args_json || "[]") as string[],
      env: JSON.parse(row.env_json || "{}") as Record<string, string>,
      cwd: safeMcpCwd(row.cwd ?? "", cfg),
      timeout_ms: row.timeout_ms,
    };
  }
  return { mcpServers: servers };
}

export function writeEngineMcpConfig(store: Store, cfg: Config): { path: string; count: number } {
  const config = engineMcpConfig(store, cfg);
  const servers = config.mcpServers as Record<string, unknown>;
  const target = engineMcpConfigPath(cfg);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { path: target, count: Object.keys(servers).length };
}

export function mcpSummary(row: McpRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    command: row.command,
    args: JSON.parse(row.args_json || "[]"),
    env_keys: Object.keys(JSON.parse(row.env_json || "{}") as Record<string, unknown>),
    cwd: row.cwd,
    url: row.url,
    timeout_ms: row.timeout_ms,
    enabled: Boolean(row.enabled),
    status: row.status,
    active: Boolean(row.enabled) && row.status === "active",
    last_probe_at: row.last_probe_at,
    last_probe_detail: row.last_probe_detail,
    use_count: row.use_count,
    tools_count: row.tools_count,
  };
}
