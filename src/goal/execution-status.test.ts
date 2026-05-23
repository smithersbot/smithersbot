import { describe, expect, it } from "vitest";
import {
  computeDisplayStatuses,
  findRunnableSteps,
  isFullyBlocked,
  isHardBlocked,
  isRetryableBlocked,
} from "./execution-status.js";
import type { PlanStep } from "./types.js";

function step(overrides: Partial<PlanStep> & { id: string }): PlanStep {
  return {
    description: `Step ${overrides.id}`,
    dependsOn: [],
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

describe("computeDisplayStatuses — resume visual state", () => {
  it("blocked goal resumed: user_input stays blocked, technical block becomes runnable", () => {
    // A genuine user-input blocker is the only true hard block. A second,
    // independent step blocked for a technical reason will be retried on resume.
    const steps = [
      step({ id: "A", status: "blocked", blockedReason: "user_input", blockedQuestion: "q" }),
      step({ id: "B", status: "blocked", blockedReason: "error", blockedQuestion: "boom" }),
    ];
    const m = computeDisplayStatuses(steps);
    expect(m.get("A")).toBe("blocked");
    expect(m.get("B")).toBe("pending");
  });

  it("failed step retried: an error-blocked step renders pending, not stale blocked", () => {
    const steps = [
      step({ id: "A", status: "blocked", blockedReason: "error", blockedQuestion: "x" }),
    ];
    const m = computeDisplayStatuses(steps);
    expect(m.get("A")).toBe("pending");
  });

  it("downstream steps of a retried failure return to waiting/runnable, not stale blocked", () => {
    // A failed step A (retryable) with downstream B, C that were left pending.
    const steps = [
      step({ id: "A", status: "blocked", blockedReason: "error", blockedQuestion: "boom" }),
      step({ id: "B", status: "pending", dependsOn: ["A"] }),
      step({ id: "C", status: "pending", dependsOn: ["B"] }),
    ];
    const m = computeDisplayStatuses(steps);
    expect(m.get("A")).toBe("pending");
    expect(m.get("B")).toBe("pending");
    expect(m.get("C")).toBe("pending");
  });

  it("cascade-blocked downstream steps (same technical reason) are not stale blocked", () => {
    // Mirrors the fatal-error cascade in agent-executor.ts where every pending
    // step is marked blocked with the same reason.
    const steps = [
      step({ id: "A", status: "blocked", blockedReason: "out_of_credits", blockedQuestion: "q" }),
      step({ id: "B", status: "blocked", blockedReason: "out_of_credits", dependsOn: ["A"] }),
    ];
    const m = computeDisplayStatuses(steps);
    expect(m.get("A")).toBe("pending");
    expect(m.get("B")).toBe("pending");
  });

  it("independent steps are not visually blocked after an unrelated step resumes", () => {
    // A is a real user-input blocker; B is independent and was cascade-blocked
    // for a technical reason. B must not look blocked just because A is.
    const steps = [
      step({ id: "A", status: "blocked", blockedReason: "user_input", blockedQuestion: "q" }),
      step({ id: "B", status: "blocked", blockedReason: "usage_limit" }),
      step({ id: "C", status: "pending" }),
    ];
    const m = computeDisplayStatuses(steps);
    expect(m.get("A")).toBe("blocked");
    expect(m.get("B")).toBe("pending");
    expect(m.get("C")).toBe("pending");
  });

  it("final step shows waiting (not blocked) when waiting on a true hard blocker", () => {
    const steps = [
      step({ id: "A", status: "done" }),
      step({
        id: "B",
        status: "blocked",
        blockedReason: "user_input",
        blockedQuestion: "q",
        dependsOn: ["A"],
      }),
      step({ id: "C", status: "pending", dependsOn: ["B"] }),
    ];
    const m = computeDisplayStatuses(steps);
    expect(m.get("B")).toBe("blocked");
    expect(m.get("C")).toBe("soft_blocked");
  });

  it("visual state matches scheduler behavior: retryable+deps-done renders runnable", () => {
    // Scheduler (findRunnableTasks/retryableBlockedIds) re-runs retryable blocks
    // once deps are done. The display must agree: such a step renders pending.
    const steps = [
      step({ id: "A", status: "done" }),
      step({ id: "B", status: "blocked", blockedReason: "timeout", dependsOn: ["A"] }),
    ];
    const m = computeDisplayStatuses(steps);
    expect(isRetryableBlocked(steps[1]!)).toBe(true);
    expect(m.get("B")).toBe("pending");
  });

  it("a hard-blocked dep still propagates waiting to a retryable downstream block", () => {
    // B is retryable but waits on hard-blocked A → B should render waiting.
    const steps = [
      step({ id: "A", status: "blocked", blockedReason: "user_input", blockedQuestion: "q" }),
      step({ id: "B", status: "blocked", blockedReason: "error", dependsOn: ["A"] }),
    ];
    const m = computeDisplayStatuses(steps);
    expect(m.get("A")).toBe("blocked");
    expect(m.get("B")).toBe("soft_blocked");
  });
});

describe("isHardBlocked / isRetryableBlocked", () => {
  it("user_input block is hard, not retryable", () => {
    const s = step({
      id: "A",
      status: "blocked",
      blockedReason: "user_input",
      blockedQuestion: "q",
    });
    expect(isHardBlocked(s)).toBe(true);
    expect(isRetryableBlocked(s)).toBe(false);
  });

  it("a block with no reason is hard, not retryable", () => {
    const s = step({ id: "A", status: "blocked", blockedQuestion: "q" });
    expect(isHardBlocked(s)).toBe(true);
    expect(isRetryableBlocked(s)).toBe(false);
  });

  it("technical reasons are retryable, not hard", () => {
    for (const reason of [
      "error",
      "timeout",
      "turn_limit",
      "usage_limit",
      "rate_limit",
      "process_lost",
      "out_of_credits",
    ] as const) {
      const s = step({ id: reason, status: "blocked", blockedReason: reason });
      expect(isRetryableBlocked(s)).toBe(true);
      expect(isHardBlocked(s)).toBe(false);
    }
  });

  it("non-blocked steps are neither hard nor retryable", () => {
    expect(isHardBlocked(step({ id: "A", status: "pending" }))).toBe(false);
    expect(isRetryableBlocked(step({ id: "A", status: "in_progress" }))).toBe(false);
    expect(isHardBlocked(step({ id: "A", status: "done" }))).toBe(false);
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
