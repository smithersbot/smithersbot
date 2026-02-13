import type { PlanStep } from "./types.js";

export type CriticalPathScores = Map<string, number>;

function buildSuccessors(steps: PlanStep[]): Map<string, string[]> {
  const successors = new Map<string, string[]>();
  for (const step of steps) {
    successors.set(step.id, []);
  }
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      const list = successors.get(dep);
      if (list) list.push(step.id);
    }
  }
  return successors;
}

function topoOrderByPlanOrder(steps: PlanStep[]): string[] {
  const inDegree = new Map<string, number>();
  const successors = buildSuccessors(steps);

  for (const step of steps) {
    inDegree.set(step.id, step.dependsOn.length);
  }

  const queue: string[] = [];
  for (const step of steps) {
    if ((inDegree.get(step.id) ?? 0) === 0) queue.push(step.id);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const child of successors.get(id) ?? []) {
      const newDeg = (inDegree.get(child) ?? 1) - 1;
      inDegree.set(child, newDeg);
      if (newDeg === 0) queue.push(child);
    }
  }

  if (order.length !== steps.length) {
    return steps.map((s) => s.id);
  }

  return order;
}

/**
 * Compute static critical-path scores weighted by estimated duration.
 * Score = durationMinutes + max(score of successors), so longer remaining
 * paths (by time) score higher — matching real CPM scheduling.
 */
export function computeCriticalPathScores(steps: PlanStep[]): CriticalPathScores {
  const successors = buildSuccessors(steps);
  const order = topoOrderByPlanOrder(steps);
  const stepMap = new Map(steps.map((s) => [s.id, s]));

  if (order.length !== steps.length) {
    return new Map(steps.map((s) => [s.id, s.durationMinutes ?? 1]));
  }

  const scores = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!;
    let maxChildScore = 0;
    for (const child of successors.get(id) ?? []) {
      const childScore = scores.get(child) ?? 0;
      if (childScore > maxChildScore) maxChildScore = childScore;
    }
    const duration = stepMap.get(id)?.durationMinutes ?? 1;
    scores.set(id, maxChildScore + duration);
  }

  return scores;
}

/**
 * Deterministic topological order that prioritizes higher critical-path scores,
 * then prefers successors of the last selected step, then plan order.
 */
export function orderStepIdsCriticalPathFirst(
  steps: PlanStep[],
  scores: CriticalPathScores = computeCriticalPathScores(steps),
): string[] {
  const indexMap = new Map(steps.map((s, i) => [s.id, i]));
  const successors = buildSuccessors(steps);
  const inDegree = new Map<string, number>();
  for (const step of steps) {
    inDegree.set(step.id, step.dependsOn.length);
  }

  const ready: string[] = [];
  for (const step of steps) {
    if ((inDegree.get(step.id) ?? 0) === 0) ready.push(step.id);
  }

  const result: string[] = [];
  let lastSelectedId: string | null = null;
  while (ready.length > 0) {
    let maxScore = Number.NEGATIVE_INFINITY;
    for (const id of ready) {
      const score = scores.get(id) ?? 0;
      if (score > maxScore) maxScore = score;
    }

    let candidates = ready.filter((id) => (scores.get(id) ?? 0) === maxScore);
    if (lastSelectedId) {
      const successorsOfLast = new Set(successors.get(lastSelectedId) ?? []);
      const successorCandidates = candidates.filter((id) => successorsOfLast.has(id));
      if (successorCandidates.length > 0) candidates = successorCandidates;
    }

    candidates.sort((a, b) => (indexMap.get(a) ?? 0) - (indexMap.get(b) ?? 0));
    const id = candidates[0]!;
    const readyIdx = ready.indexOf(id);
    if (readyIdx >= 0) ready.splice(readyIdx, 1);
    result.push(id);
    lastSelectedId = id;
    for (const child of successors.get(id) ?? []) {
      const newDeg = (inDegree.get(child) ?? 1) - 1;
      inDegree.set(child, newDeg);
      if (newDeg === 0) ready.push(child);
    }
  }

  if (result.length !== steps.length) {
    return steps.map((s) => s.id);
  }

  return result;
}

export function orderStepsCriticalPathFirst(
  steps: PlanStep[],
  scores?: CriticalPathScores,
): PlanStep[] {
  const stepMap = new Map(steps.map((s) => [s.id, s]));
  return orderStepIdsCriticalPathFirst(steps, scores)
    .map((id) => stepMap.get(id))
    .filter((step): step is PlanStep => step != null);
}
