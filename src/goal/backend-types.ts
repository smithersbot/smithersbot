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

/**
 * Structured output from any CLI worker, validated against a JSON schema.
 *
 * No separate "capability_denied" status — reuse "blocked" with optional
 * missingCapabilities array. The executor maps to blockedReason: "capability_denied"
 * when that field is present.
 */
export type GoalWorkerOutput =
  | { status: "complete"; summary: string }
  | { status: "blocked"; question: string; missingCapabilities?: string[] }
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

/** JSON Schema for GoalWorkerOutput, used by Codex --output-schema. */
export const GOAL_WORKER_OUTPUT_SCHEMA = {
  type: "object",
  oneOf: [
    {
      properties: {
        status: { type: "string", const: "complete" },
        summary: { type: "string" },
      },
      required: ["status", "summary"],
      additionalProperties: false,
    },
    {
      properties: {
        status: { type: "string", const: "blocked" },
        question: { type: "string" },
        missingCapabilities: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["status", "question"],
      additionalProperties: false,
    },
    {
      properties: {
        status: { type: "string", const: "failed" },
        reason: { type: "string" },
        whatTried: { type: "string" },
        errorType: { type: "string" },
        suggestedNext: { type: "string" },
        needsRevert: { type: "boolean" },
      },
      required: ["status", "reason", "whatTried", "errorType", "suggestedNext", "needsRevert"],
      additionalProperties: false,
    },
  ],
} as const;
