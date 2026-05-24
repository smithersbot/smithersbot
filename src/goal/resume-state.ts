import { hasAnswerForTask } from "./agent-executor.js";
import type { PlanStep } from "./types.js";

/**
 * Normalize answered user-input blocks back to `pending` on resume.
 *
 * A step blocked on user input (`blockedReason === "user_input"`, or a hard
 * block with no actionable reason at all) is the one block {@link
 * resetRetryableBlockedSteps} intentionally leaves alone — it genuinely needs an
 * operator answer first. But once that answer arrives, the scheduler already
 * treats the step as runnable: `findRunnableTasks` in agent-executor.ts picks any
 * blocked step for which {@link hasAnswerForTask} is true. The persisted step,
 * however, still reads `status: "blocked"` + `blockedReason: "user_input"`, so
 * the DAG / status renderers (which read raw step status) keep drawing it as a
 * hard `blocked` node even though resume will run it. That is the scheduler-vs-
 * renderer divergence behind the collider repro: an answered parent stays
 * visually blocked while the run actually proceeds past it.
 *
 * This helper closes that gap by mutating the step the same way the scheduler
 * does when it picks an answered block (agent-executor.ts: clears reason /
 * question / failedDetail, zeroes the spent turn counter, flips to `pending`),
 * but BEFORE rendering — so captions, blockers, status summaries and the graph
 * all agree with what the executor will do. It is applied to EVERY matching
 * step, not just the first.
 *
 * What it deliberately does NOT touch:
 *  - Unanswered user-input blocks stay hard `blocked` (still need an answer).
 *  - Retryable technical / usage-limit blocks (owned by
 *    {@link resetRetryableBlockedSteps} and the usage-limit recheck) are skipped
 *    via the `blockedReason` filter.
 *  - Done / in_progress / pending steps are skipped (status filter), so completed
 *    stays done and cancelled runs (never reaching the executing transition) keep
 *    their persisted blocked steps untouched.
 *
 * The answer is NOT consumed here: the scheduler still calls
 * `consumeAnswerForTask` when it actually runs the step, so consuming it now
 * would strip the very answer that makes the step runnable.
 *
 * @returns the ids of the steps that were reset to `pending`.
 */
export function normalizeAnsweredUserInputBlocks(
  steps: PlanStep[],
  answers: Record<string, string>,
): string[] {
  const reset: string[] = [];
  for (const step of steps) {
    if (step.status !== "blocked") continue;
    // user-input-required = the explicit "user_input" reason, or a hard block
    // with no actionable reason at all (both are what isHardBlocked treats as
    // needing the operator). Retryable technical / usage-limit reasons are left
    // to their own recovery paths.
    const isUserInputBlock = step.blockedReason == null || step.blockedReason === "user_input";
    if (!isUserInputBlock) continue;
    if (!hasAnswerForTask(step.id, answers)) continue;

    step.status = "pending";
    step.blockedReason = undefined;
    step.blockedQuestion = undefined;
    step.failedDetail = undefined;
    step.turnsUsed = 0;
    reset.push(step.id);
  }
  return reset;
}
