import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import type { PromptRow } from "./types.ts";

/**
 * The system prompt is authored in the repository, seeded into SQLite, and editable from the
 * admin. The engine itself never stores a prompt — llama.cpp has no "default system prompt"
 * setting — so every client must send it as the first `system` message. This module keeps
 * the file, the DB row and the metadata (`edited`, `source_sha`) consistent.
 */
export const PROMPT_ID = "system";
export const PROMPT_FILE = "prompts/lama-system.md";

export function promptFile(cfg: Config): string {
  return path.join(cfg.root, PROMPT_FILE);
}

export function readPromptFile(cfg: Config): { file: string; content: string; sha: string } | null {
  const file = promptFile(cfg);
  try {
    const content = fs.readFileSync(file, "utf8");
    return { file, content, sha: createHash("sha256").update(content).digest("hex") };
  } catch {
    return null;
  }
}

function metadata(prompt: PromptRow | undefined): Record<string, unknown> {
  if (!prompt) return {};
  try {
    const parsed: unknown = JSON.parse(prompt.metadata_json || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface PromptState {
  prompt: PromptRow | undefined;
  action: "missing-file" | "created" | "updated" | "unchanged" | "kept-edits";
  file: string | null;
  source_sha: string | null;
  edited: boolean;
}

export function syncSystemPrompt(store: Store, cfg: Config): PromptState {
  const file = readPromptFile(cfg);
  if (!file) {
    const existing = store.getPrompt(PROMPT_ID);
    return {
      prompt: existing,
      action: "missing-file",
      file: null,
      source_sha: existing ? String(metadata(existing).source_sha ?? "") || null : null,
      edited: Boolean(metadata(existing).edited),
    };
  }
  const existing = store.getPrompt(PROMPT_ID);
  const meta = metadata(existing);
  const edited = meta.edited === true;
  if (existing && edited) {
    return { prompt: existing, action: "kept-edits", file: file.file, source_sha: meta.source_sha as string ?? null, edited };
  }
  if (existing && meta.source_sha === file.sha) {
    return { prompt: existing, action: "unchanged", file: file.file, source_sha: file.sha, edited };
  }
  store.upsertPrompt({
    id: PROMPT_ID,
    name: PROMPT_ID,
    content: file.content.trim(),
    version: existing?.version ?? 1,
    is_default: 1,
    metadata_json: JSON.stringify({ source: PROMPT_FILE, source_sha: file.sha, edited: false }),
  });
  return {
    prompt: store.getPrompt(PROMPT_ID),
    action: existing ? "updated" : "created",
    file: file.file,
    source_sha: file.sha,
    edited: false,
  };
}

export function resetSystemPrompt(store: Store, cfg: Config): PromptState {
  const file = readPromptFile(cfg);
  const existing = store.getPrompt(PROMPT_ID);
  if (!file) {
    return {
      prompt: existing,
      action: "missing-file",
      file: null,
      source_sha: existing ? String(metadata(existing).source_sha ?? "") || null : null,
      edited: Boolean(metadata(existing).edited),
    };
  }
  store.upsertPrompt({
    id: PROMPT_ID,
    name: PROMPT_ID,
    content: file.content.trim(),
    version: existing?.version ?? 1,
    is_default: 1,
    metadata_json: JSON.stringify({ source: PROMPT_FILE, source_sha: file.sha, edited: false }),
  });
  return {
    prompt: store.getPrompt(PROMPT_ID),
    action: "updated",
    file: file.file,
    source_sha: file.sha,
    edited: false,
  };
}

export function saveSystemPrompt(store: Store, content: string): PromptRow {
  const sha = createHash("sha256").update(content).digest("hex");
  store.upsertPrompt({
    id: PROMPT_ID,
    name: PROMPT_ID,
    content,
    version: store.getPrompt(PROMPT_ID)?.version ?? 1,
    is_default: 1,
    metadata_json: JSON.stringify({ source: PROMPT_FILE, source_sha: sha, edited: true }),
  });
  return store.getPrompt(PROMPT_ID)!;
}

export function promptMeta(prompt: PromptRow | undefined, cfg: Config): Record<string, unknown> {
  if (!prompt) return { id: PROMPT_ID, exists: false, file: promptFile(cfg) };
  const meta = metadata(prompt);
  return {
    id: prompt.id,
    name: prompt.name,
    version: prompt.version,
    is_default: Boolean(prompt.is_default),
    edited: meta.edited === true,
    source: meta.source ?? null,
    source_sha: meta.source_sha ?? null,
    file: promptFile(cfg),
    content_chars: prompt.content.length,
    updated_at: prompt.updated_at,
  };
}

/**
 * How a caller is expected to use the prompt. This is documentation returned by the API so
 * a third-party integration does not have to guess; it deliberately contains no secret.
 */
export const PROMPT_USAGE = {
  summary:
    "llama.cpp stores no system prompt. The manager authors and versions this text, and the caller must send it as the first `system` message of every conversation.",
  fetch: "GET /api/system-prompt.txt (Bearer LAMA_ADMIN_TOKEN) returns the current text as text/markdown.",
  openai: "Send {\"role\":\"system\",\"content\":\"<prompt>\"} as messages[0] to POST /v1/chat/completions.",
  anthropic: "Send the prompt in the top-level \"system\" field of POST /v1/messages.",
  playground: "The Playground injects the managed prompt by default and records the run in Prompts.",
  editable: "PUT /api/system-prompt with {content} creates a new version and marks the row as edited, so a restart will not overwrite it.",
};
