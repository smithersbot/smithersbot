export type ClaudeCodeAuthMode = "subscription" | "api_key";
export type PlanAutocheckMode = "codex" | "claude_code" | "off";

export type GoalConfig = {
  /** Default working directory when --working-dir is not specified. */
  defaultWorkingDir?: string;
  /** Extra directories the agent can read (read-only). Hard denies still apply. */
  readOnlyRoots?: string[];
  /**
   * How Claude Code workers authenticate with the Anthropic API.
   * - "subscription" (default): strips ANTHROPIC_API_KEY from worker env so Claude Code uses its own subscription auth.
   * - "api_key": passes the gateway's ANTHROPIC_API_KEY through to the worker.
   */
  claudeCodeAuth?: ClaudeCodeAuthMode;
  /** Auto-review backend for plans before sending them to users. */
  planAutocheck?: PlanAutocheckMode;
};
