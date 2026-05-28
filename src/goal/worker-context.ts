// Worker context for goal workers (CLI + PI).
//
// The canonical worker contract lives at
// `src/goal/worker-context/shared-worker-contract.md`. This module re-exports
// the loaded body from `src/prompts/worker/worker-context.ts` so existing
// imports keep resolving while the contract has a single source of truth.

export {
  WORKER_CLAUDE_CONTEXT,
  WORKER_AGENTS_CONTEXT,
  WORKER_CONTEXT,
  WORKER_DYNAMIC_CONTEXT_HEADER,
  WORKER_PROMPT_STATIC_INSTRUCTION_PREFIX,
  WORKER_CONTEXT_DIR,
  SHARED_WORKER_CONTRACT_FILE,
  WORKER_CLAUDE_CONTEXT_FILE,
  WORKER_AGENTS_CONTEXT_FILE,
  resolveSharedWorkerContractPath,
  resolveWorkerAgentsContextPath,
  resolveWorkerClaudeContextPath,
} from "../prompts/worker/worker-context.js";
