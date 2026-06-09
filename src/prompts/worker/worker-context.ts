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

export const WORKER_DYNAMIC_CONTEXT_HEADER = "DYNAMIC TASK CONTEXT:";

export type WorkerPromptVerificationMode = "full" | "docs-only";

const WORKER_PROMPT_STATIC_INSTRUCTION_PREFIX_HEADER = [
  "You are a goal worker: an autonomous coding agent executing one task from a multi-step plan. Complete your assigned task independently, verify your work, then report the result.",
  "",
  "Use the worker guidelines, project conventions, capability bounds, and security instructions supplied with this launch as controlling instructions. Focus only on the assigned task in the dynamic context below.",
  "",
];

const WORKER_PROMPT_FULL_VERIFICATION_BLOCK = [
  "VERIFICATION:",
  "Before reporting completion, run the project's build and test commands to verify your changes work. Do not mark complete without verification.",
  "",
];

const WORKER_PROMPT_DOCS_ONLY_VERIFICATION_BLOCK = [
  "VERIFICATION:",
  "For documentation-only tasks, verify the changed docs with the focused command named in this task, or report the exact limitation if no docs verification command exists. Do not force unrelated build, runtime, or gateway checks unless this task explicitly requires them.",
  "",
];

const WORKER_PROMPT_RESULT_PROTOCOL_BLOCK = [
  "RESULT PROTOCOL:",
  "When you are done, write your result to the exact worker_result.json path provided in the dynamic context below.",
  "In worker_result.json, write a concise outcome summary.",
  "",
  "The file must contain valid JSON with one of these shapes:",
  '  Complete (task done): { "status": "complete", "summary": "<brief summary of what was done>" }',
  "",
  "  Ralph (stuck after genuine attempt — use only when continuing is slower than reverting and retrying with a different strategy):",
  '  { "status": "ralph", "approachTried": "...", "specificErrors": "...", "keyInsight": "...", "suggestedApproach": "..." }',
  "",
  '  Blocked (need user input): { "status": "blocked", "question": "<what you need from the user>" }',
  "",
  '  Failed (impossible/out of scope): { "status": "failed", "reason": "...", "whatTried": "...", "errorType": "...", "suggestedNext": "...", "needsRevert": false }',
  "Write the file using your file-writing tool. This is how the orchestrator knows you are done.",
  "Do NOT rely on printing JSON to stdout as your result mechanism.",
];

export function buildWorkerPromptStaticInstructionPrefix(
  mode: WorkerPromptVerificationMode = "full",
): string {
  return [
    ...WORKER_PROMPT_STATIC_INSTRUCTION_PREFIX_HEADER,
    ...(mode === "docs-only"
      ? WORKER_PROMPT_DOCS_ONLY_VERIFICATION_BLOCK
      : WORKER_PROMPT_FULL_VERIFICATION_BLOCK),
    ...WORKER_PROMPT_RESULT_PROTOCOL_BLOCK,
  ].join("\n");
}

export const WORKER_PROMPT_STATIC_INSTRUCTION_PREFIX =
  buildWorkerPromptStaticInstructionPrefix("full");

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
