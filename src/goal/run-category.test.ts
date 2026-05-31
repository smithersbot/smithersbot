import { describe, expect, it } from "vitest";
import {
  classifyRunCategory,
  classifyStepCategory,
  isResumableCategory,
  type RunCategory,
} from "./run-category.js";
import type { PlanStep } from "./types.js";

function makeStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: "1",
    description: "Do thing",
    shortSummary: "Do thing",
    dependsOn: [],
    status: "pending",
    ...overrides,
  };
}

describe("classifyRunCategory", () => {
  it("maps a genuine user-input block to 'blocked'", () => {
    expect(classifyRunCategory({ status: "blocked", blockedReason: "user_input" })).toBe("blocked");
  });

  it("maps non-retryable auth/config/capability/sandbox reasons to 'failed'", () => {
    expect(classifyRunCategory({ status: "blocked", blockedReason: "auth" })).toBe("failed");
    expect(classifyRunCategory({ status: "blocked", blockedReason: "capability_blocked" })).toBe(
      "failed",
    );
    expect(classifyRunCategory({ status: "blocked", blockedReason: "sandbox_blocked" })).toBe(
      "failed",
    );
    expect(classifyRunCategory({ status: "blocked", blockedReason: "task_failed" })).toBe("failed");
  });

  it("maps retryable backend/system reasons (auto-retries exhausted) to 'paused'", () => {
    const pausedReasons: PlanStep["blockedReason"][] = [
      "rate_limit",
      "usage_limit",
      "out_of_credits",
      "network",
      "timeout",
      "process_lost",
      "turn_limit",
      "error",
      "other",
    ];
    for (const reason of pausedReasons) {
      expect(classifyRunCategory({ status: "blocked", blockedReason: reason })).toBe("paused");
    }
  });

  it("reads as 'retrying' while actively auto-retrying, even for a retryable reason", () => {
    // A transient blip mid auto-retry must never look like a user-visible block.
    expect(
      classifyRunCategory({ status: "blocked", blockedReason: "rate_limit", autoRetrying: true }),
    ).toBe("retrying");
    expect(classifyRunCategory({ status: "in_progress", autoRetrying: true })).toBe("retrying");
  });

  it("treats a block with no recognized reason as needing the user ('blocked')", () => {
    expect(classifyRunCategory({ status: "blocked" })).toBe("blocked");
  });

  it("treats a non-blocked, non-retrying step as normal in-progress ('retrying')", () => {
    expect(classifyRunCategory({ status: "in_progress" })).toBe("retrying");
    expect(classifyRunCategory({ status: "pending" })).toBe("retrying");
  });
});

describe("classifyStepCategory", () => {
  it("classifies a PlanStep from its persisted fields", () => {
    expect(classifyStepCategory(makeStep({ status: "blocked", blockedReason: "auth" }))).toBe(
      "failed",
    );
    expect(
      classifyStepCategory(makeStep({ status: "blocked", blockedReason: "usage_limit" })),
    ).toBe("paused");
    expect(classifyStepCategory(makeStep({ status: "blocked", blockedReason: "user_input" }))).toBe(
      "blocked",
    );
  });

  it("honors the autoRetrying override", () => {
    expect(
      classifyStepCategory(makeStep({ status: "blocked", blockedReason: "rate_limit" }), true),
    ).toBe("retrying");
  });
});

describe("isResumableCategory", () => {
  it("is true only for 'paused'", () => {
    const cases: Array<[RunCategory, boolean]> = [
      ["paused", true],
      ["blocked", false],
      ["failed", false],
      ["retrying", false],
    ];
    for (const [category, expected] of cases) {
      expect(isResumableCategory(category)).toBe(expected);
    }
  });
});
