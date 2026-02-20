// Types for CLI worker backends used by /goal execution.

/** Supported execution backends for goal steps. */
export type GoalBackendId = "pi" | "codex" | "claude_code";

/** Result of probing whether a CLI backend is available. */
export type BackendAvailability = {
  id: GoalBackendId;
  available: boolean;
  /** Why unavailable (e.g. "codex found but missing --output-schema flag"). */
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

/** JSON Schema for GoalWorkerOutput, used by Codex --output-schema.
 *
 * Flat (no oneOf/anyOf) — structured output APIs reject those.
 * All properties are required; unused fields for a given status should be
 * empty strings / empty arrays / false.
 */
export const GOAL_WORKER_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["complete", "blocked", "ralph", "failed"],
      description: "Task outcome",
    },
    summary: { type: "string", description: "Completion summary (when status=complete)" },
    question: { type: "string", description: "What is needed (when status=blocked)" },
    approachTried: { type: "string", description: "What was attempted before ralphing" },
    specificErrors: { type: "string", description: "Exact errors encountered before ralphing" },
    keyInsight: {
      type: "string",
      description: "Key insight learned that changes the approach",
    },
    suggestedApproach: { type: "string", description: "Suggested next attempt strategy" },
    reason: { type: "string", description: "Failure reason (when status=failed)" },
    whatTried: { type: "string", description: "What was attempted (when status=failed)" },
    errorType: { type: "string", description: "Error classification (when status=failed)" },
    suggestedNext: { type: "string", description: "Suggested next step (when status=failed)" },
    needsRevert: { type: "boolean", description: "Whether to revert changes (when status=failed)" },
  },
  required: [
    "status",
    "summary",
    "question",
    "approachTried",
    "specificErrors",
    "keyInsight",
    "suggestedApproach",
    "reason",
    "whatTried",
    "errorType",
    "suggestedNext",
    "needsRevert",
  ],
  additionalProperties: false,
} as const;
