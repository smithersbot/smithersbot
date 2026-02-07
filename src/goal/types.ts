import type { CapabilityGrant, CapabilityPolicy } from "./capability-types.js";
import type { GoalBackendId } from "./backend-types.js";

// State machine for the goal execution loop.
export type GoalState =
  | "init"
  | "planning"
  | "needs_clarification"
  | "awaiting_approval"
  | "rejected"
  | "cancelled"
  | "executing"
  | "done"
  | "blocked"
  | "failed";

/** Structured blocked state with a machine-readable key. */
export type BlockedDetail = {
  prompt: string;
  requiredInputKey: string;
};

export type GoalSession = {
  goal: string;
  state: GoalState;
  plan: Plan | null;
  stepResults: Map<string, StepResult>;
  blocked: BlockedDetail | null;
  answers: Record<string, string>;
  lastError?: string;
};

export type PlanStep = {
  id: string;
  description: string;
  dependsOn: string[];
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
    | "out_of_credits"
    | "auth"
    | "network"
    | "capability_denied"
    | "other";
  /** Completion summary from mark_task_complete tool. */
  taskSummary?: string;
  /** Structured failure detail from mark_task_failed tool. */
  failedDetail?: {
    whatTried: string;
    errorType: string;
    suggestedNext: string;
    needsRevert: boolean;
  };
  /** Extra capabilities requested by the planner for this step. */
  requestedCapabilities?: CapabilityGrant[];
  /** Planner hint for which backend to use. */
  preferredBackend?: GoalBackendId;
  /** Sticky: set once a backend is chosen, persisted across retries/resume. */
  executedBackend?: GoalBackendId;
};

export type Plan = {
  goal: string;
  steps: PlanStep[];
  summary: string;
};

export type StepResult = {
  stepId: string;
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
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
  | { status: "blocked"; question: string; requiredInputKey: string }
  | { status: "needs_clarification"; question: string; requiredInputKey: string }
  | { status: "rejected" }
  | { status: "failed"; error: string; errorKind: string };

export type RetryConfig = {
  maxAttempts: number; // default 2 (one retry)
  retryDelayMs: number; // default 1000
};

export type GitCheckpointConfig = {
  enabled: boolean; // default false
  resetOnRetry: boolean; // default true
};

export type DiagramMode = "none" | "ascii" | "mermaid" | "both";
export type OutputFormat = "md" | "json";

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
  planHistory?: Array<{ revision: number; plan: Plan; editInstructions?: string }>;
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
  /** PI agent session file path (JSONL transcript). */
  agentSessionFile?: string;
  /** Stable session ID for the PI agent. */
  agentSessionId?: string;
  /** Maximum agent prompt cycles per task. */
  agentMaxTurnsPerTask?: number;
  scoutStatus?: "success" | "skipped" | "error" | "needs_clarification";
  scoutSkipReason?: string;
  /** Capability policy snapshot — immutable for the lifetime of the run. */
  capabilityPolicy?: CapabilityPolicy;
  /** CLI backend override from --backend flag. */
  backendOverride?: GoalBackendId;
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
