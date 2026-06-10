export type ClaudeCodeAuthMode = "subscription" | "api_key";
export type PlanAutocheckMode = "codex" | "claude_code" | "off";
export type SemgrepMode = "off" | "step" | "goal";
export type CliWorkerId = "codex" | "claude_code";
export type EnabledWorkers = CliWorkerId[];
export type DevCapabilitiesMode = "auto" | "off";

export type GitHubPushConfig = {
  /** Enable pushing run branches to GitHub after goal completion. Default: false. */
  enabled?: boolean;
  /** Git remote name to push to. Default: "origin". */
  remote?: string;
};

export type GoalConfig = {
  /** Default working directory when --working-dir is not specified. */
  defaultWorkingDir?: string;
  /** Default managed workspace name for new goal workspaces. */
  defaultWorkspaceName?: string;
  /**
   * Deprecated compatibility flag retained for older configs. Goal execution is
   * always constrained to the current instance's managed agent/workspaces root.
   */
  allowLegacyWorkingDir?: boolean;
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
  /**
   * SmithersBot-dev guidance/policy capability mode. Default: "auto".
   *
   * This only controls prompt guidance and dev-aware policy affordances for goal
   * workers. It NEVER changes the running gateway's runtime instance selection;
   * that boundary is owned by src/config/gateway-instance.ts.
   */
  devCapabilities?: DevCapabilitiesMode;
  /** Require backend-native sandbox support before launching managed workspace workers. */
  requireNativeSandbox?: boolean;
  /** GitHub push integration for completed goal runs. */
  githubPush?: GitHubPushConfig;
  /**
   * When true, inject the workspace's private/env/<workspace>/.env values into
   * Claude Code goal workers (merged after credential stripping). Default: false.
   * Toggled via the /goal_secrets slash command. Off preserves the historical
   * behavior of never passing project secrets to workers.
   */
  injectWorkspaceEnv?: boolean;
};
