import { describe, expect, it } from "vitest";

import { formatGoalLockedMessage } from "./goal-formatting.js";

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
