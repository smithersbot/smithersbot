import type { PlanStep } from "./types.js";

export type ExecutionDisplayStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "blocked"
  | "soft_blocked";

/**
 * A blocked step the scheduler will automatically re-run on resume.
 *
 * Mirrors the `retryableBlockedIds` rule in agent-executor.ts
 * (`findRunnableTasks`): any block whose reason is set and is not `user_input`
 * is retried once on resume. Such a step is NOT a hard blocker for display —
 * once its dependencies are satisfied resume will run it, so visually it
 * behaves like a pending/runnable step rather than a red "blocked" node.
 *
 * This is what stops a fatal-error cascade (where every pending step is marked
 * `blocked`, agent-executor.ts ~L893-901) from leaving downstream and
 * independent steps looking permanently blocked after a resume.
 */
export function isRetryableBlocked(step: PlanStep): boolean {
  return (
    step.status === "blocked" && step.blockedReason != null && step.blockedReason !== "user_input"
  );
}

/**
 * True only for a *hard* block: the goal genuinely cannot proceed without the
 * user (blocked for input) or there is no actionable reason to auto-retry.
 *
 * Hard blocks are the only ones that render as `blocked` and the only ones that
 * propagate the waiting (`soft_blocked`) state to dependents.
 */
export function isHardBlocked(step: PlanStep): boolean {
  return step.status === "blocked" && !isRetryableBlocked(step);
}

/**
 * Compute per-step display status including the virtual "soft_blocked" state.
 *
 * Visual state is recomputed from the actual run state plus dependencies so it
 * matches what the scheduler will do on resume:
 *  - Only *hard* blocks (user input / no actionable reason) render `blocked`.
 *  - Retryable (technical) blocks — error, timeout, turn/usage limits, process
 *    loss, out-of-credits, etc. — are treated like pending steps because resume
 *    re-runs them; they no longer show as stale `blocked`.
 *  - `soft_blocked` propagates only from hard `blocked` deps (not from
 *    `in_progress` or retryable blocks). A pending step waiting on an
 *    in_progress or retryable-blocked dep remains `pending`.
 */
export function computeDisplayStatuses(steps: PlanStep[]): Map<string, ExecutionDisplayStatus> {
  const result = new Map<string, ExecutionDisplayStatus>();
  const stepMap = new Map(steps.map((s) => [s.id, s]));
  // Only hard blocks keep dependents waiting; retryable blocks are re-run on
  // resume, so they must not cascade a stale "blocked"/"waiting" visual state.
  const hardBlockedIds = new Set(steps.filter(isHardBlocked).map((s) => s.id));

  // Memoized check: does this step have a transitive hard-blocked dep?
  const softBlockedCache = new Map<string, boolean>();
  function hasTransitiveBlockedDep(stepId: string, visited: Set<string>): boolean {
    if (softBlockedCache.has(stepId)) return softBlockedCache.get(stepId)!;
    if (visited.has(stepId)) return false;
    visited.add(stepId);

    const step = stepMap.get(stepId);
    if (!step) return false;

    for (const depId of step.dependsOn) {
      if (hardBlockedIds.has(depId)) {
        softBlockedCache.set(stepId, true);
        return true;
      }
      const dep = stepMap.get(depId);
      if (dep && dep.status !== "done" && hasTransitiveBlockedDep(depId, visited)) {
        softBlockedCache.set(stepId, true);
        return true;
      }
    }
    softBlockedCache.set(stepId, false);
    return false;
  }

  for (const step of steps) {
    if (isHardBlocked(step)) {
      result.set(step.id, "blocked");
    } else if (step.status === "done") {
      result.set(step.id, "done");
    } else if (step.status === "in_progress") {
      result.set(step.id, "in_progress");
    } else {
      // pending OR a retryable (technical) block — both will run on resume once
      // dependencies are satisfied. Render as waiting only when a real
      // hard-blocked dependency is upstream; otherwise pending/runnable.
      if (hasTransitiveBlockedDep(step.id, new Set())) {
        result.set(step.id, "soft_blocked");
      } else {
        result.set(step.id, "pending");
      }
    }
  }
  return result;
}

/** True iff at least one step is blocked AND no runnable steps exist. */
export function isFullyBlocked(steps: PlanStep[]): boolean {
  const hasBlocked = steps.some((s) => s.status === "blocked");
  if (!hasBlocked) return false;
  return findRunnableSteps(steps).length === 0;
}

/** Runnable = pending AND all deps are done. */
export function findRunnableSteps(steps: PlanStep[]): PlanStep[] {
  const stepMap = new Map(steps.map((step) => [step.id, step]));
  return steps.filter((step) => {
    if (step.status !== "pending") return false;
    return step.dependsOn.every((depId) => {
      const dep = stepMap.get(depId);
      return dep?.status === "done";
    });
  });
}
