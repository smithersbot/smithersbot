import type { ClaudeCodeAuthMode } from "../config/types.goal.js";

export type RepoChatBackend = "codex" | "claude_code";

export type RepoChatMessageRef = {
  chatId: number;
  messageId: number;
};

export type RepoChatReplyChunk = {
  html: string;
  text: string;
};

export type RepoChatOverflowReply = {
  id: string;
  chunks: RepoChatReplyChunk[];
  createdAt: string;
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
  /**
   * Stable sandbox-state key for Codex repo-chat turns. The generated CODEX_HOME
   * is derived from this value so `codex exec resume` can find prior rollout state.
   */
  codexSandboxRunId?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Telegram message ids associated with this chat session. This doubles as
   * the lookup source for reply-based session resume.
   */
  messageRefs: RepoChatMessageRef[];
  /**
   * Telegram-ready overflow chunks for long repo-chat replies. These chunks are
   * already redacted and safe-length split by the normal markdown renderer.
   */
  overflowReplies?: RepoChatOverflowReply[];
};

export type RepoChatWorkerParams = {
  backend: RepoChatBackend;
  sessionId?: string;
  prompt: string;
  workingDir: string;
  cliSessionId?: string;
  codexSandboxRunId?: string;
  /** Claude Code auth mode (defaults to subscription). */
  claudeCodeAuth?: ClaudeCodeAuthMode;
  /**
   * Explicit set of OTHER gateway instances this repo-chat run may observe
   * (read-only), e.g. `["dev"]`. Threaded from `gateway.observedInstances` so the
   * worker grants read-scope to the observed instance's agent root WITHOUT relying
   * on the `SMITHERSBOT_OBSERVED_INSTANCES` env var. An empty array is an explicit
   * opt-out; `undefined` falls back to the env signal in the resolvers.
   */
  observedInstances?: string[];
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
