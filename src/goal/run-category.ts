import type { PlanStep } from "./types.js";

/**
 * Derived, user-facing category for a goal/task surface. This is NOT a persisted
 * enum — it is computed from existing run/task fields (status, blockedReason,
 * and whether the executor is actively auto-retrying). The four categories drive
 * consistent blocked/interrupted UX and copy:
 *
 *  - blocked   SmithersBot needs actual user input (a decision, permission,
 *              workspace choice). Action: reply / Add Details / /goal_answer.
 *  - retrying  SmithersBot hit a temporary backend/system issue and is
 *              automatically retrying with backoff. Action: none.
 *  - paused    SmithersBot exhausted automatic retries for a retryable issue and
 *              is waiting for the user to resume later. Action: Resume /
 *              /goal_resume <goalId>.
 *  - failed    SmithersBot hit a non-retryable problem that requires fixing
 *              something (auth/config/capability/sandbox) before it can proceed.
 *              Action: fix config/auth/capability or replan.
 */
export type RunCategory = "blocked" | "retrying" | "paused" | "failed";

/**
 * Blocked reasons that mean a non-retryable problem requiring a fix
 * (missing auth, unsupported/denied capability, sandbox restriction) or a task
 * the worker explicitly declared failed. These surface as "failed": resuming
 * alone will not help — the user must fix something or replan.
 */
const FAILED_REASONS: ReadonlySet<NonNullable<PlanStep["blockedReason"]>> = new Set([
  "auth",
  "capability_blocked",
  "sandbox_blocked",
  "task_failed",
]);

/**
 * Retryable backend/system reasons. Once one is persisted as a block (meaning the
 * executor already exhausted its in-run auto-retries), it surfaces as "paused":
 * resume will re-run the step, so the user's next action is Resume.
 */
const PAUSED_REASONS: ReadonlySet<NonNullable<PlanStep["blockedReason"]>> = new Set([
  "rate_limit",
  "usage_limit",
  "out_of_credits",
  "network",
  "timeout",
  "process_lost",
  "turn_limit",
  "error",
  "other",
]);

export interface RunCategoryInput {
  /** Persisted step status, when classifying a specific task. */
  status?: PlanStep["status"];
  /** Persisted blocked reason. */
  blockedReason?: PlanStep["blockedReason"] | null;
  /**
   * True while the executor is actively auto-retrying this step (in-flight, not
   * yet surfaced as a user-visible block). Overrides the persisted-block mapping
   * so a transient blip reads as "retrying", never "blocked".
   */
  autoRetrying?: boolean;
}

/**
 * Map existing run/task fields into a single user-facing {@link RunCategory}.
 *
 * Precedence: an active auto-retry always reads as "retrying"; otherwise the
 * persisted blockedReason decides — user_input → blocked, non-retryable →
 * failed, retryable backend/system → paused. A block with no recognized reason
 * is treated as needing the user (blocked). A step that is neither blocked nor
 * auto-retrying is making normal progress (retrying/in-progress).
 */
export function classifyRunCategory(input: RunCategoryInput): RunCategory {
  if (input.autoRetrying) return "retrying";

  const reason = input.blockedReason ?? undefined;
  if (reason === "user_input") return "blocked";
  if (reason && FAILED_REASONS.has(reason)) return "failed";
  if (reason && PAUSED_REASONS.has(reason)) return "paused";

  // Blocked with no actionable/recognized reason → default to needing the user.
  if (input.status === "blocked") return "blocked";

  // Not blocked and not auto-retrying: normal in-progress work.
  return "retrying";
}

/** Convenience wrapper: classify a {@link PlanStep}, optionally mid auto-retry. */
export function classifyStepCategory(step: PlanStep, autoRetrying = false): RunCategory {
  return classifyRunCategory({
    status: step.status,
    blockedReason: step.blockedReason,
    autoRetrying,
  });
}

/**
 * True when the category is resumable by the user via the Resume button /
 * /goal_resume (paused), as opposed to needing input (blocked) or a fix (failed).
 */
export function isResumableCategory(category: RunCategory): boolean {
  return category === "paused";
}
