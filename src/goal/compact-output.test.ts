import { describe, expect, it } from "vitest";

import {
  buildGoalRetrySummary,
  buildRunBlockerSummary,
  formatAttemptBadge,
  formatCompactGoalCompletionSummary,
  formatCompactGoalOutput,
  formatGoalSectionTitle,
  formatGoalStateIndicator,
  resolveCompactGoalRenderOptions,
  truncateSingleLine,
} from "./compact-output.js";
import type { RunBlockerInput } from "./compact-output.js";

function findLineIndex(lines: string[], prefix: string): number {
  return lines.findIndex((line) => line.startsWith(prefix));
}

function getStepLines(lines: string[]): string[] {
  return lines.filter((line) => line.startsWith("- "));
}

function getNumberedLines(lines: string[]): string[] {
  return lines.filter((line) => /^(?:\d+\.\s|\*\*Test \d+:\*\*\s)/.test(line));
}

describe("formatAttemptBadge", () => {
  it("hides zero-attempt and 1/1 badges", () => {
    expect(formatAttemptBadge({ attemptsUsed: 0, attemptsTotal: 3 })).toBe("");
    expect(formatAttemptBadge({ attemptsUsed: 1, attemptsTotal: 1 })).toBe("");
    expect(formatAttemptBadge({ attemptsUsed: 0 })).toBe("");
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

describe("buildRunBlockerSummary", () => {
  const usageLimitText =
    "You've hit your usage limit. Upgrade at https://example.com/upgrade or wait for reset.";

  function run(overrides: Partial<RunBlockerInput>): RunBlockerInput {
    return { state: "executing", blocked: null, ...overrides };
  }

  it("renders a clear blocker for an actually-blocked run with a structured blocker", () => {
    expect(
      buildRunBlockerSummary(
        run({
          state: "blocked",
          blocked: {
            blockedAt: "execution",
            prompt: usageLimitText,
            requiredInputKey: "none",
          },
        }),
      ),
    ).toBe(`Execution: ${usageLimitText} (key: none)`);
  });

  it("renders needs-input detail for a user-input-blocked run", () => {
    expect(
      buildRunBlockerSummary(
        run({
          state: "blocked",
          blocked: {
            blockedAt: "execution",
            prompt: "Need the database password",
            requiredInputKey: "db_password",
          },
        }),
      ),
    ).toBe("Execution: Need the database password (key: db_password)");
  });

  it("does NOT render a stale blocker for a done run", () => {
    expect(
      buildRunBlockerSummary(
        run({
          state: "done",
          blocked: {
            blockedAt: "execution",
            prompt: usageLimitText,
            requiredInputKey: "none",
          },
          lastError: usageLimitText,
        }),
      ),
    ).toBeUndefined();
  });

  it("does NOT render a stale blocker for an executing run that has runnable work", () => {
    expect(
      buildRunBlockerSummary(
        run({
          state: "executing",
          blocked: {
            blockedAt: "execution",
            prompt: usageLimitText,
            requiredInputKey: "none",
          },
          lastError: usageLimitText,
        }),
      ),
    ).toBeUndefined();
  });

  it("does NOT render stale lastError after resolution (cancelled/awaiting_approval)", () => {
    expect(
      buildRunBlockerSummary(run({ state: "cancelled", lastError: usageLimitText })),
    ).toBeUndefined();
    expect(
      buildRunBlockerSummary(run({ state: "awaiting_approval", lastError: usageLimitText })),
    ).toBeUndefined();
  });

  it("still surfaces planning failures via lastError", () => {
    expect(
      buildRunBlockerSummary(
        run({ state: "planning", lastError: "Planner failed to produce a plan" }),
      ),
    ).toBe("Planner failed to produce a plan");
  });

  it("falls back to lastError when blocked state lacks a structured blocker", () => {
    expect(
      buildRunBlockerSummary(
        run({ state: "blocked", blocked: null, lastError: "Execution stalled" }),
      ),
    ).toBe("Execution stalled");
  });
});

describe("formatCompactGoalOutput", () => {
  it("omits step section when no steps are provided", () => {
    const result = formatCompactGoalOutput({
      state: "executing",
      title: "Prepare release",
      progress: { completed: 2, total: 5 },
      blockerSummary: "Waiting on environment approval",
      retrySummary: "1 retry across 1 step",
    });

    expect(findLineIndex(result.lines, "**Top Steps**")).toBe(-1);
    expect(result.lines.some((line) => line.startsWith("- "))).toBe(false);
    expect(result.hiddenStepCount).toBe(0);
    expect(result.shownStepCount).toBe(0);
  });

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

    const headlineIndex = findLineIndex(result.lines, "\u26D4 Blocked:");
    const progressIndex = findLineIndex(result.lines, "**Progress** 3/9");
    const blockerIndex = findLineIndex(result.lines, "**Blocker**");
    const retriesIndex = findLineIndex(result.lines, "**Retries**");
    const stepsHeaderIndex = findLineIndex(result.lines, "**Top Steps**");
    expect(headlineIndex).toBe(0);
    expect(progressIndex).toBeGreaterThan(headlineIndex);
    expect(blockerIndex).toBeGreaterThan(progressIndex);
    expect(retriesIndex).toBeGreaterThan(blockerIndex);
    expect(stepsHeaderIndex).toBeGreaterThan(retriesIndex);

    const bulletLines = getStepLines(result.lines);
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

  it("truncates step bullets to a single line with a deterministic width cap", () => {
    const result = formatCompactGoalOutput({
      state: "executing",
      title: "Run deployment",
      progress: { completed: 1, total: 2 },
      retrySummary: "1 retry across 1 step",
      maxStepTextChars: 20,
      steps: [
        {
          id: "1",
          text: "Long line one\nline two\tline three and more",
          attempt: { attemptsUsed: 2, attemptsTotal: 3 },
        },
      ],
    });

    const stepLine = getStepLines(result.lines)[0];
    expect(stepLine).toContain("Long line one line …");
    expect(stepLine).toContain("[2/3]");
    expect(stepLine.includes("\n")).toBe(false);
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
    expect(findLineIndex(result.lines, "\u23F3 Executing:")).toBe(0);
    expect(findLineIndex(result.lines, "**Progress** 4/20")).toBe(1);
    expect(findLineIndex(result.lines, "**Blocker**")).toBe(2);
    expect(findLineIndex(result.lines, "**Retries**")).toBe(3);
    expect(findLineIndex(result.lines, "**Top Steps**")).toBe(4);
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

  it("uses expanded Telegram truncation budgets", () => {
    const telegram = resolveCompactGoalRenderOptions({ channel: "telegram" });
    expect(telegram.maxTitleChars).toBe(100);
    expect(telegram.maxStepTextChars).toBe(120);
  });
});

describe("buildGoalRetrySummary", () => {
  it("uses turns when available and falls back to worker attempt counts", () => {
    const summary = buildGoalRetrySummary({
      steps: [{ id: "1", turnsUsed: 2 }, { id: "2", turnsUsed: 1 }, { id: "3" }],
      attemptsTotal: 5,
      resolveStepAttemptsUsed: (stepId) => {
        if (stepId === "2") return 4;
        if (stepId === "3") return 1;
        return 0;
      },
    });

    expect(summary.text).toBe("4 retries across 2 steps");
    expect(summary.attemptsByStepId.get("1")).toEqual({ attemptsUsed: 2, attemptsTotal: 5 });
    expect(summary.attemptsByStepId.get("2")).toEqual({ attemptsUsed: 4 });
    expect(summary.attemptsByStepId.has("3")).toBe(false);
  });
});

describe("formatCompactGoalCompletionSummary", () => {
  it("renders a compact done summary with capped highlights and retry badges", () => {
    const result = formatCompactGoalCompletionSummary({
      title: "Ship the release rollout and confirm all environments are healthy",
      attemptsTotal: 4,
      steps: [
        {
          id: "1",
          description: "Prepare schema",
          summary: "Created migration files",
          status: "done",
        },
        {
          id: "2",
          description: "Run migrations",
          summary: "Applied migrations to staging and production",
          status: "done",
          turnsUsed: 2,
        },
        {
          id: "3",
          description: "Write tests",
          summary: "Added regression coverage",
          status: "done",
        },
        { id: "4", description: "Update docs", summary: "Updated release notes", status: "done" },
        {
          id: "5",
          description: "Announce rollout",
          summary: "Shared deployment update",
          status: "done",
        },
        {
          id: "6",
          description: "Follow up with support",
          summary: "Sent support handoff message",
          status: "done",
        },
      ],
    });

    const headlineIndex = findLineIndex(result.lines, "\u2705 Done:");
    const progressIndex = findLineIndex(result.lines, "**Progress** 6/6");
    const retriesIndex = findLineIndex(result.lines, "**Retries** 1 retry across 1 step");
    const stepsHeaderIndex = findLineIndex(result.lines, "**Top Steps**");
    expect(headlineIndex).toBe(0);
    expect(progressIndex).toBeGreaterThan(headlineIndex);
    expect(retriesIndex).toBeGreaterThan(progressIndex);
    expect(stepsHeaderIndex).toBeGreaterThan(retriesIndex);
    expect(result.lines).toContain("+ 1 more steps not shown");
    expect(result.lines.find((line) => line.includes("2."))).toContain("[2/4]");
    expect(getStepLines(result.lines)).toHaveLength(5);
  });

  it("renders manual tests as numbered lines with criticality labels", () => {
    const result = formatCompactGoalCompletionSummary({
      title: "Ship the release rollout and confirm all environments are healthy",
      steps: [
        {
          id: "1",
          description: "Prepare schema",
          summary: "Created migration files",
          status: "done",
        },
      ],
      manualTests: [
        {
          description: "Run the release flow end-to-end from staging to production",
          criticality: 9,
          detail: "Validate staging + production deployment paths and confirm health checks.",
        },
        {
          description: "Verify rollback restores the prior version cleanly",
          criticality: 8,
          detail: "Trigger rollback and confirm traffic and metrics recover.",
        },
      ],
    });

    expect(findLineIndex(result.lines, "**Manual Tests**")).toBeGreaterThan(-1);
    expect(findLineIndex(result.lines, "**Top Steps**")).toBe(-1);
    expect(getStepLines(result.lines)).toHaveLength(0);
    const numbered = getNumberedLines(result.lines);
    expect(numbered).toHaveLength(2);
    expect(numbered[0]).toMatch(/^\*\*Test 1:\*\*/);
    expect(numbered[1]).toMatch(/^\*\*Test 2:\*\*/);
    expect(numbered[0]).toContain("[9/10 Critical]");
    expect(numbered[1]).toContain("[8/10 Critical]");
  });

  it("renders a no-tests-needed manual-test section when manualTests is an empty array", () => {
    const result = formatCompactGoalCompletionSummary({
      title: "Release verification",
      steps: [{ id: "1", description: "Ship release", status: "done" }],
      manualTests: [],
    });

    expect(findLineIndex(result.lines, "**Manual Tests**")).toBeGreaterThan(-1);
    expect(findLineIndex(result.lines, "**Top Steps**")).toBe(-1);
    expect(result.lines.some((line) => line.includes("No manual tests needed"))).toBe(true);
  });

  it("preserves manual test criticality suffixes when descriptions are truncated", () => {
    const result = formatCompactGoalCompletionSummary({
      title: "Release verification",
      maxStepTextChars: 30,
      steps: [{ id: "1", description: "Ship release", status: "done" }],
      manualTests: [
        {
          description:
            "Walk through the longest possible end-to-end flow so the description must truncate",
          criticality: 10,
          detail: "Validate all checkpoints.",
        },
      ],
    });

    const numbered = getNumberedLines(result.lines);
    expect(numbered).toHaveLength(1);
    expect(numbered[0]).toMatch(/^\*\*Test 1:\*\*/);
    expect(numbered[0]).toContain("[10/10 Critical]");
    expect(numbered[0]).not.toContain("[10/10 Critica…");
  });

  it("keeps completion summaries within Telegram's default line budget", () => {
    const result = formatCompactGoalCompletionSummary({
      title: "Finish every cleanup task",
      steps: Array.from({ length: 30 }, (_, index) => ({
        id: String(index + 1),
        description: `Complete cleanup task number ${index + 1} with long explanatory text`,
        summary: `Completed cleanup task number ${index + 1} with long explanatory text`,
        status: "done",
      })),
    });

    expect(result.lines.length).toBeLessThanOrEqual(15);
    expect(result.lines[result.lines.length - 1]).toMatch(/^\+ \d+ more steps not shown$/);
  });
});
