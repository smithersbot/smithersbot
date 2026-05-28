import { isUsageLimitClassReason } from "./error-patterns.js";
import type { PlanStep } from "./types.js";

export type ExecutionDisplayStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "blocked"
  | "usage_limited"
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
 * Hard blocks render as `blocked` and propagate the waiting (`soft_blocked`)
 * state to dependents.
 */
export function isHardBlocked(step: PlanStep): boolean {
  return step.status === "blocked" && !isRetryableBlocked(step);
}

/**
 * True for a backend usage-limit block (out_of_credits / usage_limit /
 * rate_limit). These stay retryable on resume (see {@link isRetryableBlocked})
 * so the scheduler re-runs them on a compatible available backend, but they get
 * a distinct `usage_limited` display state — visibly blocked rather than plain
 * pending — and, like hard blocks, hold up their dependents until they clear.
 */
export function isUsageLimitedBlocked(step: PlanStep): boolean {
  return step.status === "blocked" && isUsageLimitClassReason(step.blockedReason);
}

/**
 * Compute per-step display status including the virtual "soft_blocked" state.
 *
 * Visual state is recomputed from the actual run state plus dependencies so it
 * matches what the scheduler will do on resume:
 *  - *Hard* blocks (user input / no actionable reason) render `blocked`.
 *  - Backend usage-limit blocks (out_of_credits / usage_limit / rate_limit)
 *    render `usage_limited` — visibly blocked, never plain pending — so a real
 *    out-of-credits blocker is never disguised as runnable.
 *  - Other retryable (technical) blocks — error, timeout, turn limit, process
 *    loss, network, etc. — are treated like pending steps because resume re-runs
 *    them; they no longer show as stale `blocked`.
 *  - `soft_blocked` propagates from hard `blocked` AND `usage_limited` deps (not
 *    from `in_progress` or other retryable blocks). An INDEPENDENT pending step
 *    stays `pending` even when a sibling is usage-limited; only a step waiting on
 *    a blocking dep becomes `soft_blocked`.
 */
export function computeDisplayStatuses(steps: PlanStep[]): Map<string, ExecutionDisplayStatus> {
  const result = new Map<string, ExecutionDisplayStatus>();
  const stepMap = new Map(steps.map((s) => [s.id, s]));
  // Hard blocks and usage-limit blocks keep dependents waiting; other retryable
  // blocks are re-run on resume, so they must not cascade a stale "waiting"
  // visual state. Independent runnable steps are unaffected by either.
  const blockingIds = new Set(
    steps.filter((s) => isHardBlocked(s) || isUsageLimitedBlocked(s)).map((s) => s.id),
  );

  // Memoized check: does this step have a transitive blocking dep?
  const softBlockedCache = new Map<string, boolean>();
  function hasTransitiveBlockedDep(stepId: string, visited: Set<string>): boolean {
    if (softBlockedCache.has(stepId)) return softBlockedCache.get(stepId)!;
    if (visited.has(stepId)) return false;
    visited.add(stepId);

    const step = stepMap.get(stepId);
    if (!step) return false;

    for (const depId of step.dependsOn) {
      if (blockingIds.has(depId)) {
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
    if (isUsageLimitedBlocked(step)) {
      // A backend usage limit is a real, visible blocker (not pending) but stays
      // retryable on resume once a compatible backend is available again.
      result.set(step.id, "usage_limited");
    } else if (isHardBlocked(step)) {
      result.set(step.id, "blocked");
    } else if (step.status === "done") {
      result.set(step.id, "done");
    } else if (step.status === "in_progress") {
      result.set(step.id, "in_progress");
    } else {
      // pending OR a retryable (technical) block — both will run on resume once
      // dependencies are satisfied. Render as waiting only when a real blocking
      // dependency is upstream; otherwise pending/runnable.
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
