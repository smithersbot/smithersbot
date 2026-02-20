// Types for CLI worker backends used by /goal execution.

/** Supported execution backends for goal steps. */
export type GoalBackendId = "pi" | "codex" | "claude_code";

/** Result of probing whether a CLI backend is available. */
export type BackendAvailability = {
  id: GoalBackendId;
  available: boolean;
  /** Why unavailable. */
  reason?: string;
};

/** Structured output from any CLI worker, validated against a JSON schema. */
export type GoalWorkerOutput =
  | { status: "complete"; summary: string }
  | { status: "blocked"; question: string }
  | {
      status: "ralph";
      approachTried: string;
      specificErrors: string;
      keyInsight: string;
      suggestedApproach: string;
    }
  | {
      status: "failed";
      reason: string;
      whatTried: string;
      errorType: string;
      suggestedNext: string;
      needsRevert: boolean;
    };

/** Result of running a CLI worker for a single step. */
export type BackendTaskResult = {
  /** Parsed + schema-validated output (null if parsing/validation failed). */
  output: GoalWorkerOutput | null;
  turnsUsed: number;
  rawStdout?: string;
  rawStderr?: string;
};
