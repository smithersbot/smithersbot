import { describe, expect, it } from "vitest";

import {
  formatAttemptBadge,
  formatCompactGoalOutput,
  formatGoalSectionTitle,
  formatGoalStateIndicator,
  resolveCompactGoalRenderOptions,
  truncateSingleLine,
} from "./compact-output.js";

describe("formatAttemptBadge", () => {
  it("hides zero-attempt and 1/1 badges", () => {
    expect(formatAttemptBadge({ attemptsUsed: 0, attemptsTotal: 3 })).toBe("");
    expect(formatAttemptBadge({ attemptsUsed: 1, attemptsTotal: 1 })).toBe("");
    expect(formatAttemptBadge(undefined)).toBe("");
  });

  it("shows used/total when total is known", () => {
    expect(formatAttemptBadge({ attemptsUsed: 2, attemptsTotal: 4 })).toBe("[2/4]");
    // Clamp impossible used > total to a deterministic badge.
    expect(formatAttemptBadge({ attemptsUsed: 7, attemptsTotal: 3 })).toBe("[3/3]");
  });

  it("shows attempt count when total is unknown", () => {
    expect(formatAttemptBadge({ attemptsUsed: 1 })).toBe("[1 attempt]");
    expect(formatAttemptBadge({ attemptsUsed: 3 })).toBe("[3 attempts]");
  });
});

describe("truncateSingleLine", () => {
  it("collapses whitespace and truncates with ellipsis", () => {
    expect(truncateSingleLine("line one\nline two\tline three", 22)).toBe("line one line two lin…");
  });
});

describe("goal visual helpers", () => {
  it("renders section titles for markdown and plain text", () => {
    expect(formatGoalSectionTitle("Progress", "markdown")).toBe("**Progress**");
    expect(formatGoalSectionTitle("Progress", "plain")).toBe("Progress:");
  });

  it("renders state indicators in emoji and text variants", () => {
    expect(formatGoalStateIndicator("done", "emoji")).toBe("\u2705 Done");
    expect(formatGoalStateIndicator("blocked", "text")).toBe("Blocked");
  });
});

describe("formatCompactGoalOutput", () => {
  it("enforces hierarchy, top-5 step cap, and overflow line", () => {
    const result = formatCompactGoalOutput({
      state: "blocked",
      title: "Prepare release and verify all the integrations are still healthy",
      progress: { completed: 3, total: 9 },
      blockerSummary: "Missing production API key for step 6",
      retrySummary: "2 retries used",
      steps: [
        { id: "1", text: "Audit dependencies and make sure there are no unresolved issues" },
        { id: "2", text: "Run integration tests\nand upload artifacts" },
        {
          id: "3",
          text: "Verify iOS build signatures",
          attempt: { attemptsUsed: 2, attemptsTotal: 3 },
        },
        { id: "4", text: "Update release notes", attempt: { attemptsUsed: 1, attemptsTotal: 1 } },
        { id: "5", text: "Prepare rollout checklist", attempt: { attemptsUsed: 4 } },
        { id: "6", text: "Coordinate with support team" },
        { id: "7", text: "Post status update to channel" },
      ],
    });

    expect(result.lines[0]).toContain("Blocked:");
    expect(result.lines[1]).toBe("**Progress** 3/9");
    expect(result.lines[2]).toContain("**Blocker**");
    expect(result.lines[3]).toContain("**Retries**");
    expect(result.lines[4]).toBe("**Top Steps**");

    const bulletLines = result.lines.filter((line) => line.startsWith("- "));
    expect(bulletLines).toHaveLength(5);
    expect(result.lines).toContain("+ 2 more steps not shown");
    expect(result.hiddenStepCount).toBe(2);
    expect(result.shownStepCount).toBe(5);

    // Newlines are flattened so bullets always stay single-line.
    expect(bulletLines.some((line) => line.includes("\n"))).toBe(false);
    expect(bulletLines.find((line) => line.includes("2."))).toContain(
      "Run integration tests and upload artifacts",
    );
    // [1/1] is intentionally hidden.
    expect(bulletLines.find((line) => line.includes("4."))).not.toContain("[1/1]");
    // Unknown total keeps explicit attempt count.
    expect(bulletLines.find((line) => line.includes("5."))).toContain("[4 attempts]");
  });

  it("keeps telegram output near 15 lines by shrinking step list", () => {
    const steps = Array.from({ length: 20 }, (_, index) => ({
      id: String(index + 1),
      text: `Step ${index + 1} description that should be shortened for telegram readability`,
      attempt: { attemptsUsed: index + 1, attemptsTotal: 30 },
    }));

    const result = formatCompactGoalOutput({
      state: "executing",
      title: "Execute deployment plan",
      progress: { completed: 4, total: 20 },
      blockerSummary: "Waiting on canary signal",
      retrySummary: "4 retries used across 2 steps",
      steps,
      channel: "telegram",
    });

    expect(result.lines.length).toBeLessThanOrEqual(15);
    expect(result.lines[0]).toContain("Executing:");
    expect(result.lines[1]).toBe("**Progress** 4/20");
    expect(result.hiddenStepCount).toBeGreaterThan(0);
    expect(result.lines[result.lines.length - 1]).toMatch(/^\+ \d+ more steps not shown$/);
  });

  it("defaults to concise mode while exposing mode-aware options", () => {
    const defaults = resolveCompactGoalRenderOptions();
    const verbose = resolveCompactGoalRenderOptions({ mode: "verbose" });
    const full = resolveCompactGoalRenderOptions({ mode: "full" });

    expect(defaults.mode).toBe("concise");
    expect(defaults.maxSteps).toBe(5);
    expect(verbose.mode).toBe("verbose");
    expect(verbose.maxSteps).toBeGreaterThan(defaults.maxSteps);
    expect(full.mode).toBe("full");
    expect(Number.isFinite(full.maxSteps)).toBe(false);
  });
});
