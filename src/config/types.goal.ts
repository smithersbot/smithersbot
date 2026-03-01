export type ClaudeCodeAuthMode = "subscription" | "api_key";
export type PlanAutocheckMode = "codex" | "claude_code" | "off";
export type SemgrepMode = "off" | "step" | "goal";
export type CliWorkerId = "codex" | "claude_code";
export type EnabledWorkers = CliWorkerId[];

export type GitHubPushConfig = {
  /** Enable pushing run branches to GitHub after goal completion. Default: false. */
  enabled?: boolean;
  /** Create a pull request after push. Default: true. */
  createPr?: boolean;
  /** Git remote name to push to. Default: "origin". */
  remote?: string;
  /** Base branch for PR creation. Default: "main". */
  baseBranch?: string;
};

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
  /** When Semgrep SAST runs during goal execution. */
  semgrep?: SemgrepMode;
  /** Enabled CLI workers for goal planning and execution. */
  enabledWorkers?: EnabledWorkers;
  /** GitHub push integration for completed goal runs. */
  githubPush?: GitHubPushConfig;
};
