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
  tool: ToolCall;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  durationMinutes?: number;
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

export type ToolName =
  | "file_read"
  | "file_write"
  | "file_modify"
  | "mkdir"
  | "git_add"
  | "npm_init"
  | "shell_exec";

export type ToolCall = {
  name: ToolName;
  args: Record<string, string>;
};

export type ToolResult = {
  success: boolean;
  output: string;
  error?: string;
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
  | { status: "rejected" };

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
