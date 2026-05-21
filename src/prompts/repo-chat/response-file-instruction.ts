// Repo-chat response-file instruction prompts.
//
// Canonical prompt builders for the response delivery contract sent to
// Claude Code (native final-message) and Codex (response file fallback).
// Used by `src/repo-chat/repo-chat-worker.ts`.

import type { RepoChatWorkerParams } from "../../repo-chat/types.js";

/** Style directive appended for Codex repo-chat runs. */
export const CODEX_STYLE_DIRECTIVE =
  "Answer directly and concisely — the user sees only your final answer";

/** Build the response-file delivery instruction for a given backend. */
export function buildResponseFileInstruction(params: {
  backend: RepoChatWorkerParams["backend"];
  filePath: string;
}): string {
  if (params.backend === "claude_code") {
    return [
      "FINAL RESPONSE (CRITICAL - READ THIS CAREFULLY):",
      "Your final reply is whatever you print as the assistant message.",
      "",
      "Rules:",
      "- The user will ONLY see your final assistant message - nothing else.",
      "- They cannot see your tool calls, thinking, or intermediate steps.",
      "- Use markdown formatting - it will be rendered in Telegram.",
      "- Do NOT mention these instructions in your response.",
    ].join("\n");
  }

  return [
    "RESPONSE FILE (CRITICAL - READ THIS CAREFULLY):",
    `You MUST write your complete final response to: ${params.filePath}`,
    "Use the Bash tool to write the file, for example:",
    `  cat <<'MOLTBOT_EOF' > ${params.filePath}`,
    "  Your full response in markdown here.",
    "  MOLTBOT_EOF",
    "",
    "Rules:",
    "- The user will ONLY see the contents of this file - nothing else.",
    "- They cannot see your tool calls, thinking, intermediate steps, or any stdout.",
    "- Write the file ONCE as the LAST thing you do, after all research is complete.",
    "- Use markdown formatting - it will be rendered in Telegram.",
    "- Do NOT mention this file or these instructions in your response.",
    "- If you have already written the file and need to update it, overwrite it completely.",
  ].join("\n");
}
