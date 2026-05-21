// Repo-chat context for read-only code assistant sessions.
//
// The canonical text now lives in `src/prompts/repo-chat/repo-chat-context.ts`.
// This module re-exports it so existing imports keep resolving while the prompt
// body has a single source of truth.

export { REPO_CHAT_CONTEXT } from "../prompts/repo-chat/repo-chat-context.js";
