export type ClaudeCodeAuthMode = "subscription" | "api_key";
export type ClaudeDriver = "direct" | "tui-pilot";
/**
 * Logical Claude prompt-run call sites. Each site passes its id to the seam
 * (`runCliProcess`) so the driver can be selected per-site. This is what lets
 * S3 canary tui-pilot for only the long agentic sites while everything else
 * stays on the global default.
 */
export type ClaudeDriverSite =
  | "cli-worker"
  | "cli-planner"
  | "post-execution-report"
  | "repo-chat-worker"
  | "lessons"
  | "manual-tests"
  | "nightwatch"
  | "goal-sending"
  | "plan-autocheck";
/** Fail-closed preflight enforcement when a tui-pilot prompt-run is required. */
export type TuiPilotPreflightMode = "off" | "warn" | "enforce";
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

/**
 * Operational controls for the installed tui-pilot driver. All fields default
 * at runtime (see TUI_PILOT_OPS_DEFAULTS in src/goal/tui-pilot-driver.ts), so an
 * absent `goal.tuiPilot` block keeps the productionized defaults.
 */
export type TuiPilotOpsConfig = {
  /**
   * Pinned tui-pilot version that setup installs and preflight enforces
   * (e.g. "0.8.60"). When set, preflight checks `tui-pilot --version` matches.
   */
  version?: string;
  /** Fail-closed preflight enforcement when a tui-pilot run is required. Default "enforce". */
  preflight?: TuiPilotPreflightMode;
  /** Max concurrent tui-pilot (tmux) sessions. Default 3. Must be >= 1. */
  maxConcurrent?: number;
  /**
   * Max runs allowed to wait for a session slot before failing closed. Default 64.
   * 0 disables queueing (saturated runs fail closed immediately).
   */
  maxQueued?: number;
  /** Max ms a run may wait in the queue before failing closed (timeout). Default 600000. */
  queueTimeoutMs?: number;
  /**
   * Per-site driver overrides (site id -> driver). A site present here overrides
   * the global `goal.claudeDriver`. This drives the S3 canary: set the four long
   * agentic sites to "tui-pilot" while the global default stays "direct".
   */
  sites?: Partial<Record<ClaudeDriverSite, ClaudeDriver>>;
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
  /**
   * Claude prompt-run driver. Default: "direct" during tui-pilot S1 migration.
   * "tui-pilot" is an installed-tool opt-in and must not become the default
   * until shadow parity and canary gates pass.
   */
  claudeDriver?: ClaudeDriver;
  /** Optional override for the installed/local tui-pilot executable. */
  tuiPilotBinary?: string;
  /**
   * Operational controls for the tui-pilot driver leg (S2 productionization).
   * These only affect prompt runs routed through the "tui-pilot" driver; the
   * direct `claude -p` path is unaffected.
   */
  tuiPilot?: TuiPilotOpsConfig;
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
