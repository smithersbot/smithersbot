import { describe, expect, it } from "vitest";
import { computeDisplayStatuses, findRunnableSteps, isFullyBlocked } from "./execution-status.js";
import type { PlanStep } from "./types.js";

function step(overrides: Partial<PlanStep> & { id: string }): PlanStep {
  return {
    description: `Step ${overrides.id}`,
    dependsOn: [],
    tool: { name: "mkdir", args: {} },
    status: "pending",
    ...overrides,
  };
}

describe("computeDisplayStatuses", () => {
  it("maps statuses directly: blocked, done, in_progress", () => {
    const steps = [
      step({ id: "A", status: "blocked", blockedQuestion: "q" }),
      step({ id: "B", status: "done" }),
      step({ id: "C", status: "in_progress" }),
    ];
    const m = computeDisplayStatuses(steps);
    expect(m.get("A")).toBe("blocked");
    expect(m.get("B")).toBe("done");
    expect(m.get("C")).toBe("in_progress");
  });

  it("pending with blocked dep -> soft_blocked", () => {
    const steps = [
      step({ id: "A", status: "blocked", blockedQuestion: "q" }),
      step({ id: "B", status: "pending", dependsOn: ["A"] }),
    ];
    const m = computeDisplayStatuses(steps);
    expect(m.get("B")).toBe("soft_blocked");
  });

  it("pending with in_progress dep -> pending (NOT soft_blocked)", () => {
    const steps = [
      step({ id: "A", status: "in_progress" }),
      step({ id: "B", status: "pending", dependsOn: ["A"] }),
    ];
    const m = computeDisplayStatuses(steps);
    expect(m.get("B")).toBe("pending");
  });

  it("transitive: A blocked, B->A, C->B -> B and C both soft_blocked", () => {
    const steps = [
      step({ id: "A", status: "blocked", blockedQuestion: "q" }),
      step({ id: "B", status: "pending", dependsOn: ["A"] }),
      step({ id: "C", status: "pending", dependsOn: ["B"] }),
    ];
    const m = computeDisplayStatuses(steps);
    expect(m.get("A")).toBe("blocked");
    expect(m.get("B")).toBe("soft_blocked");
    expect(m.get("C")).toBe("soft_blocked");
  });

  it("diamond: A done, B blocked, C done, D(B,C) -> D soft_blocked", () => {
    const steps = [
      step({ id: "A", status: "done" }),
      step({ id: "B", status: "blocked", blockedQuestion: "q", dependsOn: ["A"] }),
      step({ id: "C", status: "done", dependsOn: ["A"] }),
      step({ id: "D", status: "pending", dependsOn: ["B", "C"] }),
    ];
    const m = computeDisplayStatuses(steps);
    expect(m.get("A")).toBe("done");
    expect(m.get("B")).toBe("blocked");
    expect(m.get("C")).toBe("done");
    expect(m.get("D")).toBe("soft_blocked");
  });

  it("pending with no blocked deps -> pending", () => {
    const steps = [
      step({ id: "A", status: "done" }),
      step({ id: "B", status: "pending", dependsOn: ["A"] }),
    ];
    const m = computeDisplayStatuses(steps);
    expect(m.get("B")).toBe("pending");
  });
});

describe("isFullyBlocked", () => {
  it("returns true when blocked exists and no runnable steps", () => {
    const steps = [
      step({ id: "A", status: "blocked", blockedQuestion: "q" }),
      step({ id: "B", status: "pending", dependsOn: ["A"] }),
    ];
    expect(isFullyBlocked(steps)).toBe(true);
  });

  it("returns false when runnable steps exist alongside blocked", () => {
    const steps = [
      step({ id: "A", status: "blocked", blockedQuestion: "q" }),
      step({ id: "B", status: "pending" }), // no deps -> runnable
    ];
    expect(isFullyBlocked(steps)).toBe(false);
  });

  it("returns false when no blocked steps", () => {
    const steps = [
      step({ id: "A", status: "done" }),
      step({ id: "B", status: "pending", dependsOn: ["A"] }),
    ];
    expect(isFullyBlocked(steps)).toBe(false);
  });

  it("returns false when all done", () => {
    const steps = [step({ id: "A", status: "done" })];
    expect(isFullyBlocked(steps)).toBe(false);
  });
});

describe("findRunnableSteps", () => {
  it("returns pending steps with all deps done", () => {
    const steps = [
      step({ id: "A", status: "done" }),
      step({ id: "B", status: "pending", dependsOn: ["A"] }),
      step({ id: "C", status: "pending", dependsOn: ["A"] }),
    ];
    const runnable = findRunnableSteps(steps);
    expect(runnable.map((s) => s.id)).toEqual(["B", "C"]);
  });

  it("excludes pending steps with unmet deps", () => {
    const steps = [
      step({ id: "A", status: "in_progress" }),
      step({ id: "B", status: "pending", dependsOn: ["A"] }),
    ];
    expect(findRunnableSteps(steps)).toEqual([]);
  });

  it("excludes blocked and done steps", () => {
    const steps = [
      step({ id: "A", status: "done" }),
      step({ id: "B", status: "blocked", blockedQuestion: "q" }),
    ];
    expect(findRunnableSteps(steps)).toEqual([]);
  });

  it("returns root pending steps with no deps", () => {
    const steps = [step({ id: "A", status: "pending" }), step({ id: "B", status: "pending" })];
    const runnable = findRunnableSteps(steps);
    expect(runnable.map((s) => s.id)).toEqual(["A", "B"]);
  });
});
