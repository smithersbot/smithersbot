import { PlanParseError } from "./planner.js";

// Error classification for goal planner/LLM failures.

export type GoalErrorKind = "network" | "auth" | "parse" | "internal";

/** Typed error for LLM/planner call failures with a machine-readable kind. */
export class GoalLlmError extends Error {
  readonly kind: GoalErrorKind;
  constructor(message: string, kind: GoalErrorKind, cause?: unknown) {
    super(message, { cause });
    this.name = "GoalLlmError";
    this.kind = kind;
  }
}

const NETWORK_PATTERNS =
  /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|socket hang up|network|EAI_AGAIN/i;
const AUTH_PATTERNS =
  /401|403|unauthorized|forbidden|invalid.*key|authentication|credit balance|billing/i;

/** Classify a raw error into a GoalErrorKind. */
export function classifyGoalError(err: unknown): GoalErrorKind {
  if (err instanceof GoalLlmError) return err.kind;
  if (err instanceof PlanParseError) return "parse";
  if (!(err instanceof Error)) return "internal";
  const msg = err.message;
  if (NETWORK_PATTERNS.test(msg)) return "network";
  if (AUTH_PATTERNS.test(msg)) return "auth";
  return "internal";
}

/** Produce a concise, honest user-facing error message. */
export function formatGoalError(err: unknown, runId?: string): string {
  const kind = classifyGoalError(err);
  switch (kind) {
    case "network":
      return "Network error reaching the planner API. Check your connection and try again.";
    case "auth":
      return "Authentication failed. Verify your auth configuration and try again.";
    case "parse": {
      const hint = runId
        ? `Debug: cat $STATE_DIR/goals/${runId}/plan-raw.txt`
        : "Debug: ls -lt $STATE_DIR/goals/*/plan-raw.txt";
      return `Failed to parse the planner response. ${hint}`;
    }
    case "internal":
      return `Planning failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
