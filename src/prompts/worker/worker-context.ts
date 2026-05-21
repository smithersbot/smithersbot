// Worker context for goal workers (CLI + PI).
//
// The canonical worker contract lives on disk at
// `src/goal/worker-context/shared-worker-contract.md` and is mirrored byte-for-byte
// into `AGENTS.md` (Codex) and `CLAUDE.md` (Claude Code) in the same directory.
// Loading from disk here keeps the TS export, the shared contract, and both
// backend-specific copies on a single source of truth — drift is enforced by
// `src/prompts/prompts.test.ts`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));

export const WORKER_CONTEXT_DIR = path.resolve(moduleDir, "..", "..", "goal", "worker-context");

export const SHARED_WORKER_CONTRACT_FILE = "shared-worker-contract.md";
export const WORKER_CLAUDE_CONTEXT_FILE = "CLAUDE.md";
export const WORKER_AGENTS_CONTEXT_FILE = "AGENTS.md";

function readContractFile(name: string): string {
  return fs.readFileSync(path.join(WORKER_CONTEXT_DIR, name), "utf8");
}

const SHARED = readContractFile(SHARED_WORKER_CONTRACT_FILE);

/**
 * Canonical worker contract body sourced from `shared-worker-contract.md`.
 *
 * Claude Code and Codex receive equivalent rules from this single string — there
 * are no backend-specific appendices. If a backend ever needs different rules,
 * add an appendix module here and cover it with a drift test in
 * `src/prompts/prompts.test.ts`.
 */
export const WORKER_CONTEXT = SHARED;

/** Claude Code (CLAUDE.md) worker-context body — identical to {@link WORKER_CONTEXT}. */
export const WORKER_CLAUDE_CONTEXT = WORKER_CONTEXT;

/** Codex (AGENTS.md) worker-context body — identical to {@link WORKER_CONTEXT}. */
export const WORKER_AGENTS_CONTEXT = WORKER_CONTEXT;

/** Absolute path to the canonical shared worker contract markdown file. */
export function resolveSharedWorkerContractPath(): string {
  return path.join(WORKER_CONTEXT_DIR, SHARED_WORKER_CONTRACT_FILE);
}

/** Absolute path to the worker AGENTS.md mirror file. */
export function resolveWorkerAgentsContextPath(): string {
  return path.join(WORKER_CONTEXT_DIR, WORKER_AGENTS_CONTEXT_FILE);
}

/** Absolute path to the worker CLAUDE.md mirror file. */
export function resolveWorkerClaudeContextPath(): string {
  return path.join(WORKER_CONTEXT_DIR, WORKER_CLAUDE_CONTEXT_FILE);
}
