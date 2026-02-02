import type { PlanStep } from "./types.js";

export type ExecutionDisplayStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "blocked"
  | "soft_blocked";

/**
 * Compute per-step display status including the virtual "soft_blocked" state.
 *
 * soft_blocked propagates only from hard `blocked` deps (not from `in_progress`).
 * A pending step waiting on an in_progress dep remains `pending`.
 */
export function computeDisplayStatuses(steps: PlanStep[]): Map<string, ExecutionDisplayStatus> {
  const result = new Map<string, ExecutionDisplayStatus>();
  const stepMap = new Map(steps.map((s) => [s.id, s]));
  const blockedIds = new Set(steps.filter((s) => s.status === "blocked").map((s) => s.id));

  // Memoized check: does this step have a transitive hard-blocked dep?
  const softBlockedCache = new Map<string, boolean>();
  function hasTransitiveBlockedDep(stepId: string, visited: Set<string>): boolean {
    if (softBlockedCache.has(stepId)) return softBlockedCache.get(stepId)!;
    if (visited.has(stepId)) return false;
    visited.add(stepId);

    const step = stepMap.get(stepId);
    if (!step) return false;

    for (const depId of step.dependsOn) {
      if (blockedIds.has(depId)) {
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
    if (step.status === "blocked") {
      result.set(step.id, "blocked");
    } else if (step.status === "done") {
      result.set(step.id, "done");
    } else if (step.status === "in_progress") {
      result.set(step.id, "in_progress");
    } else {
      // pending — check for transitive hard-blocked dependency
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
  return steps.filter((step) => {
    if (step.status !== "pending") return false;
    return step.dependsOn.every((depId) => {
      const dep = steps.find((s) => s.id === depId);
      return dep?.status === "done";
    });
  });
}
