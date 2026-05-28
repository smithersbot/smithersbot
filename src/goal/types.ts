import type { GoalBackendId } from "./backend-types.js";

// State machine for the goal execution loop.
export type GoalState =
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "blocked"
  | "done"
  | "cancelled";

/** Structured blocked state with a machine-readable key. */
export type BlockedDetail = {
  blockedAt: "planning" | "execution";
  prompt: string;
  requiredInputKey: string;
  stepId?: string;
};

export type GoalSession = {
  goal: string;
  state: GoalState;
  plan: Plan | null;
  stepResults: Map<string, StepResult>;
  blocked: BlockedDetail | null;
  answers: Record<string, string>;
  lastError?: string;
  taskCheckpoints?: Record<string, TaskCheckpoint>;
  buildGateConfig?: PlanBuildGate;
  stepRalphCounts?: Record<string, number>;
  buildGateFixCounts?: Record<string, number>;
  buildGateFixSignatures?: Record<string, string>;
  buildGateResults?: {
    [stepId: string]: {
      passed: boolean;
      failedCommand?: string;
      output?: string;
      timestamp: string;
    };
  };
  githubPushOutcome?: GithubPushOutcome;
  /** Final compact completion report persisted before notification delivery. */
  completionSummary?: string;
  /** Suggested manual verification tests shown after completion. */
  manualTests?: ManualTestSuggestion[];
  /** Why manual test generation failed when suggestions are unavailable. */
  manualTestsError?: string;
  /** Last Telegram completion notification failed; final report remains in run state. */
  deliveryFailed?: boolean;
  deliveryError?: string;
};

export type FailedDetail = {
  whatTried: string;
  errorType: string;
  suggestedNext: string;
  needsRevert: boolean;
};

export type RalphDetail = {
  approachTried: string;
  specificErrors: string;
  keyInsight: string;
  suggestedApproach: string;
};

export type PlanStep = {
  id: string;
  description: string;
  /** Concise human-readable task headline for compact UI surfaces. */
  shortSummary: string;
  dependsOn: string[];
  /** Verifiable done-when condition for this step. */
  successCriteria?: string;
  /** Explicitly disallowed approaches for this step. */
  constraints?: string[];
  status: "pending" | "in_progress" | "done" | "blocked";
  durationMinutes?: number;
  /** Number of agent prompt cycles used for this task (agent executor). */
  turnsUsed?: number;
  /** Question from the agent when the task is blocked on user input. */
  blockedQuestion?: string;
  /** Why this task is blocked. */
  blockedReason?:
    | "user_input"
    | "turn_limit"
    | "timeout"
    | "error"
    | "task_failed"
    | "rate_limit"
    | "usage_limit"
    | "process_lost"
    | "out_of_credits"
    | "auth"
    | "network"
    | "other";
  /** Completion summary from mark_task_complete tool. */
  taskSummary?: string;
  /** Structured failure detail from mark_task_failed tool. */
  failedDetail?: FailedDetail;
  /** Strategic reset guidance captured from a ralph result. */
  ralphDetail?: RalphDetail;
  /** Planner-selected backend for this step. */
  backend?: GoalBackendId;
  /** Sticky: set once a backend is chosen, persisted across retries/resume. */
  executedBackend?: GoalBackendId;
  /** Opt in to network access for Codex worker execution. Defaults to false. */
  requiresNetwork?: boolean;
};

export type PlanBuildGate = {
  commands: string[];
  runBetweenSteps: boolean;
  /**
   * Inert: the LLM post-execution diff review was removed from the goal
   * lifecycle. Retained only so older serialized plans (and planner output that
   * still emits it) keep parsing; it no longer drives any behavior.
   */
  postExecutionReview?: boolean;
};

export type Plan = {
  goal: string;
  workingDir: string;
  steps: PlanStep[];
  summary: string;
  /** Concise human-readable goal headline for compact UI surfaces. */
  shortSummary: string;
  /** Post-step and/or final verification commands chosen by the planner. */
  buildGate?: PlanBuildGate;
};

export type StepResult = {
  stepId: string;
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
};

export type ManualTestSuggestion = {
  description: string;
  criticality: number;
  /** Why this test requires manual verification. */
  reason?: string;
  detail: string;
};

export type GoalLlmResponse = {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
};

export type GoalLlmClient = {
  complete(params: {
    systemPrompt: string;
    userMessage: string;
    maxTokens?: number;
  }): Promise<GoalLlmResponse>;
};

export type GoalOutcome =
  | { status: "done"; summary: string }
  | {
      status: "blocked";
      question: string;
      requiredInputKey: string;
      blockedAt: BlockedDetail["blockedAt"];
    }
  | { status: "cancelled" }
  | { status: "failed"; error: string; errorKind: string };

export type RetryConfig = {
  maxAttempts: number; // default 2 (one retry)
  retryDelayMs: number; // default 1000
  maxRalphAttempts: number; // default 2
};

export type GitCheckpointConfig = {
  enabled: boolean; // default false
};

export type TaskCheckpoint = {
  baseSha: string;
  beforeCommit?: string;
  afterCommit?: string;
};

export type GithubPushOutcome = {
  enabled: boolean;
  branch: string;
  remote?: string;
  attempted: boolean;
  succeeded: boolean;
  pushedSha?: string;
  reviewUrl?: string;
  message?: string;
  timestamp: string;
};

export type DiagramMode = "none" | "ascii" | "mermaid" | "both";
export type OutputFormat = "md" | "json";

export type PlannerBackendId = "claude_code" | "codex";
export type PlannerDegradedReason =
  | "anthropic_rate_limit"
  | "anthropic_usage_limit"
  | "anthropic_overloaded"
  | "planner_backend_unavailable";

/** Serialized form of a goal session persisted to disk. */
export type SerializedRun = {
  runId: string;
  goal: string;
  state: GoalState;
  plan: Plan | null;
  stepResults: Record<string, StepResult>;
  blocked: BlockedDetail | null;
  answers: Record<string, string>;
  lastError?: string;
  workingDir: string;
  model: string | undefined;
  dryRun: boolean;
  createdAt: string;
  updatedAt: string;
  /** Plan revision number (starts at 1). */
  planRevision?: number;
  /** Currently active plan revision number. */
  activePlanRevision?: number;
  /** History of previous plans (append-only). */
  planHistory?: Array<{
    revision: number;
    plan: Plan;
    editInstructions?: string;
    source?: "user" | "autocheck";
  }>;
  /** Number of autocheck-driven replans applied before user review. */
  autocheckRounds?: number;
  /** Configured cap for autocheck rounds. */
  autocheckMaxRounds?: number;
  /** Reviewer backend used for autocheck rounds. */
  autocheckBackend?: "codex" | "claude_code";
  /** Stable CLI session ID for autocheck reviewer resume. */
  autocheckSessionId?: string;
  /** Suggested manual verification tests shown after completion. */
  manualTests?: ManualTestSuggestion[];
  /** Why manual test generation failed when suggestions are unavailable. */
  manualTestsError?: string;
  /** Final compact completion report persisted before notification delivery. */
  completionSummary?: string;
  /** Last Telegram completion notification failed; final report remains in run state. */
  deliveryFailed?: boolean;
  deliveryError?: string;
  /** Telegram plan message tracking for reply-to-plan and reaction detection. */
  telegramPlanMessage?: {
    chatId: number;
    messageId: number;
    threadId?: number;
    /** Message IDs from older revisions. */
    messageHistory?: number[];
  };
  /** Telegram question/clarification messages for reply-to-answer detection. Newest first, capped. */
  telegramQuestionMessages?: Array<{
    chatId: number;
    messageId: number;
    threadId?: number;
    requiredInputKey?: string;
  }>;
  /** Telegram edit-prompt messages sent via the "Request changes" button. Replies to these route to GOAL_EDIT. */
  telegramEditPromptMessages?: Array<{
    chatId: number;
    messageId: number;
    threadId?: number;
  }>;
  /** Telegram done message that includes manual test suggestions and action buttons. */
  telegramDoneMessage?: {
    chatId: number;
    messageId: number;
    threadId?: number;
  };
  /** Telegram feedback-prompt ForceReply messages sent via "Incorporate Feedback". */
  telegramFeedbackPromptMessages?: Array<{
    chatId: number;
    messageId: number;
    threadId?: number;
  }>;
  /** PI agent session file path (JSONL transcript). */
  agentSessionFile?: string;
  /** Stable session ID for the PI agent. */
  agentSessionId?: string;
  /** Maximum agent prompt cycles per task. */
  agentMaxTurnsPerTask?: number;
  scoutStatus?: "success" | "skipped" | "error" | "needs_clarification";
  scoutSkipReason?: string;
  /** CLI backend override from --backend flag. */
  backendOverride?: GoalBackendId;
  /** Planner backend that produced the current persisted plan. */
  plannerBackendUsed?: PlannerBackendId;
  /** Why planner degraded away from Claude Code for this run. */
  plannerDegradedReason?: PlannerDegradedReason;
  /** Human-readable reset hint extracted from planner errors (for user messaging). */
  plannerDegradedResetHint?: string;
  /** Per-task git checkpoint bookkeeping. */
  taskCheckpoints?: Record<string, TaskCheckpoint>;
  /** Build-gate config from the planner (post-execution verification). */
  buildGateConfig?: PlanBuildGate;
  /** Ralph count per step (key = step id). */
  stepRalphCounts?: Record<string, number>;
  /** Build-gate fix cycle count per step (key = step id). */
  buildGateFixCounts?: Record<string, number>;
  /** Build-gate command signature per step (key = step id). */
  buildGateFixSignatures?: Record<string, string>;
  /** Most recent build-gate result per step. */
  buildGateResults?: {
    [stepId: string]: {
      passed: boolean;
      failedCommand?: string;
      output?: string;
      timestamp: string;
    };
  };
  /** GitHub push result recorded at completed goal finalization. */
  githubPushOutcome?: GithubPushOutcome;
};

/** Result of executing a single task with the agent. */
export type TaskExecutionResult = {
  taskId: string;
  turnsUsed: number;
  durationMs: number;
  outcome: "done" | "blocked" | "task_failed";
  summary?: string;
  blockedQuestion?: string;
  blockedReason?: string;
};

/** Lightweight summary returned by listRuns(). */
export type RunSummary = {
  runId: string;
  goal: string;
  state: GoalState;
  createdAt: string;
  updatedAt: string;
  stepCount: number;
  completedSteps: number;
  dryRun: boolean;
};
