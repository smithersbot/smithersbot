import type { Plan, PlanStep } from "./types.js";

export type ComputedStepTiming = {
  durationMinutesEffective: number;
  es: number;
  ef: number;
  ls: number;
  lf: number;
  slack: number;
  isCritical: boolean;
};

export type CpmResult = {
  totalDurationMinutes: number;
  steps: Record<string, ComputedStepTiming>;
  /** One valid critical path (start-to-end order), not all critical steps. */
  criticalPathStepIds: string[];
};

/** Resolve effective duration for a step. */
function effectiveDuration(step: PlanStep): number {
  if (step.durationMinutes != null) return Math.round(step.durationMinutes);
  if (step.tool.name === "shell_exec") return 2;
  return 1;
}

/**
 * Deterministic topological sort via Kahn's algorithm.
 * Tie-break: when multiple nodes have zero in-degree, process in
 * lexicographic id order (localeCompare).
 */
function topoSort(steps: PlanStep[]): string[] {
  const ids = new Set(steps.map((s) => s.id));
  const inDegree = new Map<string, number>();
  const successors = new Map<string, string[]>();

  for (const step of steps) {
    inDegree.set(step.id, step.dependsOn.length);
    for (const dep of step.dependsOn) {
      if (!ids.has(dep)) {
        throw new Error(`Step ${step.id}: depends on unknown step "${dep}"`);
      }
      const list = successors.get(dep) ?? [];
      list.push(step.id);
      successors.set(dep, list);
    }
  }

  const ready: string[] = [];
  for (const step of steps) {
    if ((inDegree.get(step.id) ?? 0) === 0) ready.push(step.id);
  }
  ready.sort((a, b) => a.localeCompare(b));

  const order: string[] = [];
  while (ready.length > 0) {
    const current = ready.shift()!;
    order.push(current);
    for (const child of successors.get(current) ?? []) {
      const newDeg = (inDegree.get(child) ?? 1) - 1;
      inDegree.set(child, newDeg);
      if (newDeg === 0) {
        // Insert in sorted position (maintain sorted ready list)
        const idx = ready.findIndex((r) => child.localeCompare(r) < 0);
        if (idx === -1) {
          ready.push(child);
        } else {
          ready.splice(idx, 0, child);
        }
      }
    }
  }

  if (order.length !== steps.length) {
    throw new Error("Plan contains a dependency cycle");
  }

  return order;
}

export function computeCpm(plan: Plan): CpmResult {
  const stepMap = new Map(plan.steps.map((s) => [s.id, s]));
  const durations = new Map<string, number>();
  for (const step of plan.steps) {
    durations.set(step.id, effectiveDuration(step));
  }

  // Build successor adjacency
  const successors = new Map<string, string[]>();
  for (const step of plan.steps) {
    for (const dep of step.dependsOn) {
      const list = successors.get(dep) ?? [];
      list.push(step.id);
      successors.set(dep, list);
    }
  }

  const order = topoSort(plan.steps);

  // Forward pass: ES/EF + track chosenPred for critical path extraction
  const es = new Map<string, number>();
  const ef = new Map<string, number>();
  const chosenPred = new Map<string, string | null>();

  for (const id of order) {
    const step = stepMap.get(id)!;
    const dur = durations.get(id)!;

    if (step.dependsOn.length === 0) {
      es.set(id, 0);
      ef.set(id, dur);
      chosenPred.set(id, null);
    } else {
      let maxEf = -1;
      let bestPred: string | null = null;
      for (const dep of step.dependsOn) {
        const depEf = ef.get(dep)!;
        if (
          depEf > maxEf ||
          (depEf === maxEf && (bestPred === null || dep.localeCompare(bestPred) < 0))
        ) {
          maxEf = depEf;
          bestPred = dep;
        }
      }
      es.set(id, maxEf);
      ef.set(id, maxEf + dur);
      chosenPred.set(id, bestPred);
    }
  }

  // Project duration
  let totalDuration = 0;
  for (const id of order) {
    const stepEf = ef.get(id)!;
    if (stepEf > totalDuration) totalDuration = stepEf;
  }

  // Backward pass: LS/LF (process in reverse topo order)
  const ls = new Map<string, number>();
  const lf = new Map<string, number>();

  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const dur = durations.get(id)!;
    const children = successors.get(id) ?? [];

    if (children.length === 0) {
      // Sink node
      lf.set(id, totalDuration);
      ls.set(id, totalDuration - dur);
    } else {
      let minLs = Number.POSITIVE_INFINITY;
      for (const child of children) {
        const childLs = ls.get(child)!;
        if (childLs < minLs) minLs = childLs;
      }
      lf.set(id, minLs);
      ls.set(id, minLs - dur);
    }
  }

  // Compute per-step timing
  const steps: Record<string, ComputedStepTiming> = {};
  for (const id of order) {
    const slack = ls.get(id)! - es.get(id)!;
    steps[id] = {
      durationMinutesEffective: durations.get(id)!,
      es: es.get(id)!,
      ef: ef.get(id)!,
      ls: ls.get(id)!,
      lf: lf.get(id)!,
      slack,
      isCritical: slack === 0,
    };
  }

  // Build ONE critical path by walking backward from the sink with max EF
  let sinkId: string | null = null;
  let sinkEf = -1;
  for (const id of order) {
    const children = successors.get(id) ?? [];
    if (children.length === 0) {
      const stepEf = ef.get(id)!;
      if (
        stepEf > sinkEf ||
        (stepEf === sinkEf && (sinkId === null || id.localeCompare(sinkId) < 0))
      ) {
        sinkEf = stepEf;
        sinkId = id;
      }
    }
  }

  const criticalPathStepIds: string[] = [];
  if (sinkId !== null) {
    let current: string | null = sinkId;
    while (current !== null) {
      criticalPathStepIds.push(current);
      current = chosenPred.get(current) ?? null;
    }
    criticalPathStepIds.reverse();
  }

  return { totalDurationMinutes: totalDuration, steps, criticalPathStepIds };
}
