export type RepoChatBackend = "codex" | "claude_code";

export type RepoChatMessageRef = {
  chatId: number;
  messageId: number;
};

export type RepoChatSession = {
  id: string;
  backend: RepoChatBackend;
  workingDir: string;
  /**
   * Backend session/thread id used for follow-up prompts.
   * - Claude Code: --resume <session-id>
   * - Codex: exec resume <thread-id>
   */
  cliSessionId?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Telegram message ids associated with this chat session. This doubles as
   * the lookup source for reply-based session resume.
   */
  messageRefs: RepoChatMessageRef[];
};

export type RepoChatWorkerParams = {
  backend: RepoChatBackend;
  prompt: string;
  workingDir: string;
  cliSessionId?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  model?: string;
};

export type RepoChatWorkerResult = {
  backend: RepoChatBackend;
  text: string;
  cliSessionId?: string;
  durationMs: number;
  stdout: string;
  stderr: string;
};
