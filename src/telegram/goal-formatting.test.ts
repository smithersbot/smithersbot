import { describe, expect, it } from "vitest";

import {
  buildPlanningPreface,
  buildResumePreface,
  buildStartPreface,
  formatGoalLockedMessage,
  formatManualTestDetails,
  getGoalExecutionPreface,
  resolveGoalOperatorHonorific,
  sanitizeOperatorHonorific,
} from "./goal-formatting.js";

describe("formatGoalLockedMessage", () => {
  it("formats the run prefix and lock label", () => {
    expect(formatGoalLockedMessage("1234567890abcdef", "approve")).toBe(
      "Goal `12345678` is already being processed (approve).",
    );
  });

  it("falls back to unknown when lock label is absent", () => {
    expect(formatGoalLockedMessage("abcdef1234567890")).toBe(
      "Goal `abcdef12` is already being processed (unknown).",
    );
  });
});

describe("formatManualTestDetails", () => {
  it("defaults invalid criticality values to 5", () => {
    expect(
      formatManualTestDetails("abcdef12", [
        {
          description: "Check callback formatting",
          criticality: Number.NaN,
          detail: "Step 1. Open the done message.",
        },
      ]),
    ).toContain("Test 1: Check callback formatting [5/10 Critical]");
  });
});

describe("goal preface honorifics", () => {
  it("keeps the default sir preface when honorific is unset", () => {
    expect(buildPlanningPreface()).toBe("Right away, sir.");
    expect(buildStartPreface()).toBe("Right away, sir. Starting the goal now.");
    expect(buildResumePreface()).toBe("Right away, sir. Resuming the goal now.");
  });

  it("renders boss, first-name, and empty honorific variants", () => {
    expect(buildPlanningPreface("boss")).toBe("Right away, boss.");
    expect(buildPlanningPreface("Matthew")).toBe("Right away, Matthew.");
    expect(buildPlanningPreface("")).toBe("Right away.");
  });

  it("uses state-specific execution prefaces with the resolved honorific", () => {
    expect(getGoalExecutionPreface("awaiting_approval", "boss")).toBe(
      "Right away, boss. Starting the goal now.",
    );
    expect(getGoalExecutionPreface("blocked", "Matthew")).toBe(
      "Right away, Matthew. Resuming the goal now.",
    );
  });

  it("sanitizes markup/control characters and caps outbound honorific length", () => {
    expect(buildPlanningPreface("  <b>*boss*</b>\n")).toBe("Right away, bboss/b.");

    const sanitized = sanitizeOperatorHonorific("M".repeat(80));
    expect(sanitized).toHaveLength(48);
    expect(buildPlanningPreface("M".repeat(80))).toBe(`Right away, ${"M".repeat(48)}.`);
  });

  it("resolves honorifics from routed agent identity with a sir fallback", () => {
    expect(resolveGoalOperatorHonorific({})).toBe("sir");
    expect(
      resolveGoalOperatorHonorific({
        agents: { defaults: { identity: { operatorHonorific: "boss" } } },
      }),
    ).toBe("boss");
    expect(
      resolveGoalOperatorHonorific(
        {
          agents: {
            list: [
              { id: "main", identity: { operatorHonorific: "sir" } },
              { id: "ops", identity: { operatorHonorific: "boss" } },
            ],
          },
        },
        "ops",
      ),
    ).toBe("boss");
  });
});
