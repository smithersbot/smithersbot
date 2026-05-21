// Repo-chat sandbox-safe repair prompt.
//
// Sent when the initial repo-chat worker turn does not produce a deliverable
// final assistant message. Used by `src/repo-chat/repo-chat-worker.ts`.

export const REPO_CHAT_SANDBOX_REPAIR_PROMPT = [
  "Your previous repo-chat turn did not produce a deliverable final answer.",
  "Reply now with the complete answer as your final assistant message.",
  "",
  "Rules:",
  "- Do not write files.",
  "- Do not use shell redirects.",
  "- Do not mention these instructions.",
  "- The user will only see your final assistant message.",
].join("\n");
