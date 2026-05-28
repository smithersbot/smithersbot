import { describe, expect, it } from "vitest";
import { computeCpm } from "./cpm.js";
import type { Plan, PlanStep } from "./types.js";

function step(overrides: Partial<PlanStep> & { id: string }): PlanStep {
  return {
    description: `Step ${overrides.id}`,
    dependsOn: [],
    status: "pending",
    ...overrides,
  };
}

function makePlan(steps: PlanStep[]): Plan {
  return { goal: "test", summary: "Test plan", steps };
}

describe("computeCpm", () => {
  it("linear chain A(1)->B(2)->C(3): total 6, all critical", () => {
    const plan = makePlan([
      step({ id: "A", durationMinutes: 1 }),
      step({ id: "B", durationMinutes: 2, dependsOn: ["A"] }),
      step({ id: "C", durationMinutes: 3, dependsOn: ["B"] }),
    ]);

    const result = computeCpm(plan);

    expect(result.totalDurationMinutes).toBe(6);
    expect(result.criticalPathStepIds).toEqual(["A", "B", "C"]);

    expect(result.steps.A).toEqual({
      durationMinutesEffective: 1,
      es: 0,
      ef: 1,
      ls: 0,
      lf: 1,
      slack: 0,
      isCritical: true,
    });
    expect(result.steps.B).toEqual({
      durationMinutesEffective: 2,
      es: 1,
      ef: 3,
      ls: 1,
      lf: 3,
      slack: 0,
      isCritical: true,
    });
    expect(result.steps.C).toEqual({
      durationMinutesEffective: 3,
      es: 3,
      ef: 6,
      ls: 3,
      lf: 6,
      slack: 0,
      isCritical: true,
    });
  });

  it("diamond: A(2)->B(2)->D(2), A(2)->C(1)->D(2): total 6, critical A-B-D", () => {
    const plan = makePlan([
      step({ id: "A", durationMinutes: 2 }),
      step({ id: "B", durationMinutes: 2, dependsOn: ["A"] }),
      step({ id: "C", durationMinutes: 1, dependsOn: ["A"] }),
      step({ id: "D", durationMinutes: 2, dependsOn: ["B", "C"] }),
    ]);

    const result = computeCpm(plan);

    expect(result.totalDurationMinutes).toBe(6);
    expect(result.criticalPathStepIds).toEqual(["A", "B", "D"]);

    // C has slack
    expect(result.steps.C.slack).toBe(1);
    expect(result.steps.C.isCritical).toBe(false);

    // A, B, D are critical
    expect(result.steps.A.isCritical).toBe(true);
    expect(result.steps.B.isCritical).toBe(true);
    expect(result.steps.D.isCritical).toBe(true);
  });

  it("multiple roots: A(2), B(5) independent: total 5, only B critical", () => {
    const plan = makePlan([
      step({ id: "A", durationMinutes: 2 }),
      step({ id: "B", durationMinutes: 5 }),
    ]);

    const result = computeCpm(plan);

    expect(result.totalDurationMinutes).toBe(5);
    expect(result.criticalPathStepIds).toEqual(["B"]);
    expect(result.steps.A.slack).toBe(3);
    expect(result.steps.A.isCritical).toBe(false);
    expect(result.steps.B.isCritical).toBe(true);
  });

  it("default duration heuristic: steps without durationMinutes default to 1", () => {
    const plan = makePlan([step({ id: "A" }), step({ id: "B", durationMinutes: 3 })]);

    const result = computeCpm(plan);

    expect(result.steps.A.durationMinutesEffective).toBe(1);
    expect(result.steps.B.durationMinutesEffective).toBe(3);
    expect(result.totalDurationMinutes).toBe(3);
  });

  it("single step: total=duration, step is critical", () => {
    const plan = makePlan([step({ id: "X", durationMinutes: 7 })]);

    const result = computeCpm(plan);

    expect(result.totalDurationMinutes).toBe(7);
    expect(result.criticalPathStepIds).toEqual(["X"]);
    expect(result.steps.X.isCritical).toBe(true);
    expect(result.steps.X.slack).toBe(0);
  });

  it("fractional duration: 1.7 rounds to 2", () => {
    const plan = makePlan([step({ id: "A", durationMinutes: 1.7 })]);

    const result = computeCpm(plan);

    expect(result.steps.A.durationMinutesEffective).toBe(2);
    expect(result.totalDurationMinutes).toBe(2);
  });
});
