// Worker context for goal workers (CLI + PI).
//
// The canonical worker prompt now lives in `src/prompts/worker/worker-context.ts`.
// This module re-exports it so existing imports keep resolving while the
// prompt body has a single source of truth.

export {
  WORKER_CLAUDE_CONTEXT,
  WORKER_AGENTS_CONTEXT,
  WORKER_CONTEXT,
} from "../prompts/worker/worker-context.js";
