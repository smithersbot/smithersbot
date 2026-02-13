// Telegram command menu entries for repo chat controls.
export const REPO_CHAT_COMMAND_SPECS: Array<{ command: string; description: string }> = [
  { command: "repo_chat", description: "Ask a repository question (read-only)." },
  {
    command: "chat_backend",
    description: "Set repo chat backend: codex, claude_code, or off.",
  },
];
