import { describe, expect, it } from "vitest";
import {
  computeDisplayStatuses,
  findRunnableSteps,
  isFullyBlocked,
  isHardBlocked,
  isRetryableBlocked,
  isUsageLimitedBlocked,
} from "./execution-status.js";
import { normalizeAnsweredUserInputBlocks } from "./resume-state.js";
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

  it("collider: both answered user-input parents normalize to runnable, no stale blocked node, child waits then completes", () => {
    // Two independent parents blocked on user input with answers, plus a child
    // depending on both. After resume normalization neither parent renders as a
    // hard `blocked` node, and the child is not needs-input blocked.
    const steps = [
      step({
        id: "collider-parent-a",
        status: "blocked",
        blockedReason: "user_input",
        blockedQuestion: "Detail for A?",
      }),
      step({
        id: "collider-parent-b",
        status: "blocked",
        blockedReason: "user_input",
        blockedQuestion: "Detail for B?",
      }),
      step({
        id: "collider-child",
        status: "pending",
        dependsOn: ["collider-parent-a", "collider-parent-b"],
      }),
    ];
    const answers = {
      "task:collider-parent-a:input": "A details",
      "task:collider-parent-b:input": "B details",
    };

    const reset = normalizeAnsweredUserInputBlocks(steps, answers);
    expect(reset.sort()).toEqual(["collider-parent-a", "collider-parent-b"]);

    const m = computeDisplayStatuses(steps);
    expect([...m.values()].some((v) => v === "blocked")).toBe(false);
    expect(m.get("collider-parent-a")).toBe("pending");
    expect(m.get("collider-parent-b")).toBe("pending");
    expect(m.get("collider-child")).toBe("pending");

    // Once both parents complete, the child runs and the final graph is all done.
    steps[0]!.status = "done";
    steps[1]!.status = "done";
    steps[2]!.status = "done";
    const final = computeDisplayStatuses(steps);
    expect([...final.values()].every((v) => v === "done")).toBe(true);
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

  it("cascade-blocked downstream steps (usage-limit reason) render usage_limited", () => {
    // Mirrors the cascade in agent-executor.ts where every pending step is
    // marked blocked with the same usage-limit reason. These are real, visible
    // backend limits — not plain pending — but stay retryable on resume.
    const steps = [
      step({ id: "A", status: "blocked", blockedReason: "out_of_credits", blockedQuestion: "q" }),
      step({ id: "B", status: "blocked", blockedReason: "out_of_credits", dependsOn: ["A"] }),
    ];
    const m = computeDisplayStatuses(steps);
    expect(m.get("A")).toBe("usage_limited");
    expect(m.get("B")).toBe("usage_limited");
  });

  it("retryable technical block still renders pending during resume (not usage_limited)", () => {
    // error/timeout/etc. are re-run on resume and must render as runnable.
    const steps = [
      step({ id: "A", status: "blocked", blockedReason: "error", blockedQuestion: "boom" }),
      step({ id: "B", status: "blocked", blockedReason: "timeout" }),
    ];
    const m = computeDisplayStatuses(steps);
    expect(m.get("A")).toBe("pending");
    expect(m.get("B")).toBe("pending");
  });

  it("independent runnable sibling stays pending while a usage_limited sibling is blocked", () => {
    // A is a real user-input blocker; B is independent and usage-limit blocked;
    // C is independent and runnable. B is visibly usage_limited, but C (and the
    // scheduler) must not be held back just because a sibling is exhausted.
    const steps = [
      step({ id: "A", status: "blocked", blockedReason: "user_input", blockedQuestion: "q" }),
      step({ id: "B", status: "blocked", blockedReason: "usage_limit" }),
      step({ id: "C", status: "pending" }),
    ];
    const m = computeDisplayStatuses(steps);
    expect(m.get("A")).toBe("blocked");
    expect(m.get("B")).toBe("usage_limited");
    expect(m.get("C")).toBe("pending");
  });

  it("each usage-limit reason renders usage_limited", () => {
    for (const reason of ["usage_limit", "rate_limit", "out_of_credits"] as const) {
      const steps = [step({ id: reason, status: "blocked", blockedReason: reason })];
      const m = computeDisplayStatuses(steps);
      expect(m.get(reason)).toBe("usage_limited");
    }
  });

  it("usage_limited dep propagates waiting (soft_blocked) to its dependent", () => {
    const steps = [
      step({ id: "A", status: "blocked", blockedReason: "usage_limit" }),
      step({ id: "B", status: "pending", dependsOn: ["A"] }),
    ];
    const m = computeDisplayStatuses(steps);
    expect(m.get("A")).toBe("usage_limited");
    expect(m.get("B")).toBe("soft_blocked");
  });

  it("graph state matches scheduler: usage_limited stays retryable on resume", () => {
    // The display distinguishes usage_limited, but the scheduler must still
    // treat it as a retryable block (re-run on a compatible available backend).
    const s = step({ id: "A", status: "blocked", blockedReason: "out_of_credits" });
    expect(isUsageLimitedBlocked(s)).toBe(true);
    expect(isRetryableBlocked(s)).toBe(true);
    expect(isHardBlocked(s)).toBe(false);
    expect(computeDisplayStatuses([s]).get("A")).toBe("usage_limited");
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

describe("computeDisplayStatuses — recomputes all nodes + terminal states", () => {
  it("recomputes the display state for EVERY node, not just the first", () => {
    // A mixed resume snapshot: done, usage-limit, retryable technical, hard
    // user-input block, and a downstream of the hard block. computeDisplayStatuses
    // must produce a recomputed entry for every node.
    const steps = [
      step({ id: "A", status: "done" }),
      step({ id: "B", status: "blocked", blockedReason: "usage_limit" }),
      step({ id: "C", status: "blocked", blockedReason: "error" }),
      step({ id: "D", status: "blocked", blockedReason: "user_input", blockedQuestion: "q" }),
      step({ id: "E", status: "pending", dependsOn: ["D"] }),
    ];
    const m = computeDisplayStatuses(steps);
    expect(m.size).toBe(steps.length);
    expect(m.get("A")).toBe("done");
    expect(m.get("B")).toBe("usage_limited");
    expect(m.get("C")).toBe("pending");
    expect(m.get("D")).toBe("blocked");
    expect(m.get("E")).toBe("soft_blocked");
  });

  it("a done goal has no stale blocked or usage-limited nodes", () => {
    const steps = [
      step({ id: "A", status: "done" }),
      step({ id: "B", status: "done", dependsOn: ["A"] }),
    ];
    const m = computeDisplayStatuses(steps);
    expect([...m.values()]).toEqual(["done", "done"]);
  });

  it("a cancelled goal's steps keep their underlying states (done/pending), no stale blocked", () => {
    // No per-step "cancelled" status exists; completed steps stay done and
    // not-started steps stay pending — none should appear blocked/usage_limited.
    const steps = [
      step({ id: "A", status: "done" }),
      step({ id: "B", status: "pending", dependsOn: ["A"] }),
    ];
    const m = computeDisplayStatuses(steps);
    expect(m.get("A")).toBe("done");
    expect(m.get("B")).toBe("pending");
    expect([...m.values()]).not.toContain("blocked");
    expect([...m.values()]).not.toContain("usage_limited");
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

describe("isUsageLimitedBlocked", () => {
  it("is true only for usage-limit-class blocked steps", () => {
    for (const reason of ["usage_limit", "rate_limit", "out_of_credits"] as const) {
      expect(
        isUsageLimitedBlocked(step({ id: reason, status: "blocked", blockedReason: reason })),
      ).toBe(true);
    }
  });

  it("is false for non-usage-limit reasons and non-blocked steps", () => {
    for (const reason of ["user_input", "error", "timeout", "process_lost", "auth"] as const) {
      expect(
        isUsageLimitedBlocked(step({ id: reason, status: "blocked", blockedReason: reason })),
      ).toBe(false);
    }
    expect(isUsageLimitedBlocked(step({ id: "p", status: "pending" }))).toBe(false);
    // A non-blocked step with a usage-limit reason set is not "usage limited".
    expect(
      isUsageLimitedBlocked(
        step({ id: "ip", status: "in_progress", blockedReason: "usage_limit" }),
      ),
    ).toBe(false);
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
