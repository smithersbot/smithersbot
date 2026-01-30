// State machine for the goal execution loop.
export type GoalState =
  | "init"
  | "planning"
  | "awaiting_approval"
  | "rejected"
  | "executing"
  | "done"
  | "blocked";

export type GoalSession = {
  goal: string;
  state: GoalState;
  plan: Plan | null;
  stepResults: Map<string, StepResult>;
  blockReason: string | null;
};

export type PlanStep = {
  id: string;
  description: string;
  dependsOn: string[];
  tool: ToolCall;
  status: "pending" | "running" | "done" | "failed" | "skipped";
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
  | { status: "blocked"; question: string }
  | { status: "rejected" };

export type DiagramMode = "none" | "ascii" | "mermaid" | "both";
export type OutputFormat = "md" | "json";
