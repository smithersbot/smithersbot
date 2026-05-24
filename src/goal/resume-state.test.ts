import { describe, expect, it } from "vitest";
import { normalizeAnsweredUserInputBlocks } from "./resume-state.js";
import { computeDisplayStatuses } from "./execution-status.js";
import type { PlanStep } from "./types.js";

function step(overrides: Partial<PlanStep> & { id: string }): PlanStep {
  return {
    description: `Step ${overrides.id}`,
    dependsOn: [],
    status: "pending",
    ...overrides,
  };
}

describe("normalizeAnsweredUserInputBlocks", () => {
  it("resets a single answered user-input block to pending and clears stale fields", () => {
    const steps = [
      step({
        id: "needs-input",
        status: "blocked",
        blockedReason: "user_input",
        blockedQuestion: "Which database?",
        turnsUsed: 4,
        failedDetail: {
          whatTried: "x",
          errorType: "user_input",
          suggestedNext: "ask",
          needsRevert: false,
        },
      }),
    ];
    const answers = { "task:needs-input:input": "Postgres" };

    const reset = normalizeAnsweredUserInputBlocks(steps, answers);

    expect(reset).toEqual(["needs-input"]);
    expect(steps[0]!.status).toBe("pending");
    expect(steps[0]!.blockedReason).toBeUndefined();
    expect(steps[0]!.blockedQuestion).toBeUndefined();
    expect(steps[0]!.failedDetail).toBeUndefined();
    expect(steps[0]!.turnsUsed).toBe(0);
  });

  it("resets a hard block with no actionable reason when an answer exists", () => {
    const steps = [step({ id: "noreason", status: "blocked" })];
    const answers = { "task:noreason:input": "go" };

    const reset = normalizeAnsweredUserInputBlocks(steps, answers);

    expect(reset).toEqual(["noreason"]);
    expect(steps[0]!.status).toBe("pending");
    expect(steps[0]!.blockedReason).toBeUndefined();
  });

  it("leaves an unanswered user-input block hard blocked", () => {
    const steps = [
      step({
        id: "needs-input",
        status: "blocked",
        blockedReason: "user_input",
        blockedQuestion: "Which database?",
      }),
    ];

    const reset = normalizeAnsweredUserInputBlocks(steps, {});

    expect(reset).toEqual([]);
    expect(steps[0]!.status).toBe("blocked");
    expect(steps[0]!.blockedReason).toBe("user_input");
    expect(steps[0]!.blockedQuestion).toBe("Which database?");
  });

  it("never resets a retryable technical block even if an answer happens to exist", () => {
    const reasons = ["error", "timeout", "task_failed", "auth", "network", "other"] as const;
    const steps = reasons.map((reason, i) =>
      step({ id: `tech-${i}`, status: "blocked", blockedReason: reason }),
    );
    const answers = Object.fromEntries(steps.map((s) => [`task:${s.id}:input`, "x"]));

    const reset = normalizeAnsweredUserInputBlocks(steps, answers);

    expect(reset).toEqual([]);
    expect(steps.every((s) => s.status === "blocked")).toBe(true);
    expect(steps.map((s) => s.blockedReason)).toEqual([...reasons]);
  });

  it("never resets a usage-limit block even with an answer present", () => {
    const reasons = ["out_of_credits", "usage_limit", "rate_limit"] as const;
    const steps = reasons.map((reason, i) =>
      step({ id: `u-${i}`, status: "blocked", blockedReason: reason }),
    );
    const answers = Object.fromEntries(steps.map((s) => [`task:${s.id}:input`, "x"]));

    const reset = normalizeAnsweredUserInputBlocks(steps, answers);

    expect(reset).toEqual([]);
    expect(steps.every((s) => s.status === "blocked")).toBe(true);
  });

  it("leaves done / in_progress / pending steps untouched even when an answer exists", () => {
    const steps = [
      step({ id: "d", status: "done" }),
      step({ id: "ip", status: "in_progress" }),
      step({ id: "p", status: "pending" }),
    ];
    const answers = {
      "task:d:input": "x",
      "task:ip:input": "x",
      "task:p:input": "x",
    };

    const reset = normalizeAnsweredUserInputBlocks(steps, answers);

    expect(reset).toEqual([]);
    expect(steps.map((s) => s.status)).toEqual(["done", "in_progress", "pending"]);
  });

  it("does NOT consume the answer (scheduler consumes it later)", () => {
    const steps = [step({ id: "a", status: "blocked", blockedReason: "user_input" })];
    const answers = { "task:a:input": "value" };

    normalizeAnsweredUserInputBlocks(steps, answers);

    expect(answers["task:a:input"]).toBe("value");
  });

  it("recognizes a combined 'tasks:a,b:input' answer key", () => {
    const steps = [
      step({ id: "a", status: "blocked", blockedReason: "user_input" }),
      step({ id: "b", status: "blocked", blockedReason: "user_input" }),
    ];
    const answers = { "tasks:a,b:input": "shared answer" };

    const reset = normalizeAnsweredUserInputBlocks(steps, answers);

    expect(reset.sort()).toEqual(["a", "b"]);
    expect(steps.every((s) => s.status === "pending")).toBe(true);
    // Combined key remains intact — the scheduler consumes per-task on run.
    expect(answers["tasks:a,b:input"]).toBe("shared answer");
  });

  describe("collider regression (two answered parents + one child)", () => {
    function colliderSteps(): PlanStep[] {
      return [
        step({
          id: "collider-parent-a",
          status: "blocked",
          blockedReason: "user_input",
          blockedQuestion: "Detail for A?",
          turnsUsed: 2,
        }),
        step({
          id: "collider-parent-b",
          status: "blocked",
          blockedReason: "user_input",
          blockedQuestion: "Detail for B?",
          turnsUsed: 2,
        }),
        step({
          id: "collider-child",
          status: "pending",
          dependsOn: ["collider-parent-a", "collider-parent-b"],
        }),
      ];
    }

    it("resets BOTH answered parents (not just the first) and leaves no hard blocked node", () => {
      const steps = colliderSteps();
      const answers = {
        "task:collider-parent-a:input": "A details",
        "task:collider-parent-b:input": "B details",
      };

      const reset = normalizeAnsweredUserInputBlocks(steps, answers);

      expect(reset.sort()).toEqual(["collider-parent-a", "collider-parent-b"]);
      const byId = new Map(steps.map((s) => [s.id, s]));
      expect(byId.get("collider-parent-a")!.status).toBe("pending");
      expect(byId.get("collider-parent-b")!.status).toBe("pending");
      expect(byId.get("collider-parent-a")!.blockedReason).toBeUndefined();
      expect(byId.get("collider-parent-b")!.blockedReason).toBeUndefined();

      // No raw step remains hard-blocked.
      expect(steps.some((s) => s.status === "blocked")).toBe(false);

      // Rendered display: no node shows hard `blocked`; the child waits on its
      // (now pending) parents rather than appearing needs-input blocked.
      const display = computeDisplayStatuses(steps);
      expect([...display.values()].some((v) => v === "blocked")).toBe(false);
      expect(display.get("collider-parent-a")).toBe("pending");
      expect(display.get("collider-parent-b")).toBe("pending");
      expect(display.get("collider-child")).not.toBe("blocked");
      expect(display.get("collider-child")).toBe("pending");
    });

    it("works through a combined 'tasks:a,b:input' answer key for both parents", () => {
      const steps = colliderSteps();
      const answers = { "tasks:collider-parent-a,collider-parent-b:input": "shared" };

      const reset = normalizeAnsweredUserInputBlocks(steps, answers);

      expect(reset.sort()).toEqual(["collider-parent-a", "collider-parent-b"]);
      expect(
        steps.filter((s) => s.id !== "collider-child").every((s) => s.status === "pending"),
      ).toBe(true);
      expect(steps.some((s) => s.status === "blocked")).toBe(false);
    });

    it("once both parents complete, the child becomes runnable and the graph is all done", () => {
      const steps = colliderSteps();
      const answers = {
        "task:collider-parent-a:input": "A details",
        "task:collider-parent-b:input": "B details",
      };
      normalizeAnsweredUserInputBlocks(steps, answers);

      // Simulate the scheduler completing both parents.
      const byId = new Map(steps.map((s) => [s.id, s]));
      byId.get("collider-parent-a")!.status = "done";
      byId.get("collider-parent-b")!.status = "done";

      // Child is now runnable; once it runs, the final graph is all done.
      const display = computeDisplayStatuses(steps);
      expect(display.get("collider-child")).toBe("pending");
      byId.get("collider-child")!.status = "done";

      const finalDisplay = computeDisplayStatuses(steps);
      expect([...finalDisplay.values()].every((v) => v === "done")).toBe(true);
    });
  });
});
