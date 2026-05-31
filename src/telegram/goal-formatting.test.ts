import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Bot } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadRun, saveRun } from "../goal/run-store.js";
import type { SerializedRun } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  buildOnStatusChange,
  buildPlanningPreface,
  buildResumePreface,
  buildStartPreface,
  formatGoalDoneCaption,
  formatGoalLockedMessage,
  formatManualTestDetails,
  getGoalExecutionPreface,
  cleanWorkingDirInstructionPath,
  parseWorkingDirInstruction,
  resolveBlockedRequiredInputKey,
  resolveGoalOperatorHonorific,
  sanitizeOperatorHonorific,
} from "./goal-formatting.js";

vi.mock("../goal/mermaid-png.js", () => ({
  renderMermaidToPng: () => ({ buffer: Buffer.from("png") }),
  repairMermaidDiagram: vi.fn(),
}));

let testStateDir: string;
let testManagedRoot: string;
let previousStateDir: string | undefined;
let previousManagedRoot: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.SMITHERSBOT_STATE_DIR;
  previousManagedRoot = process.env.SMITHERSBOT_GOALS_ROOT;
  testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-formatting-state-"));
  testManagedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goal-formatting-managed-"));
  process.env.SMITHERSBOT_STATE_DIR = testStateDir;
  process.env.SMITHERSBOT_GOALS_ROOT = testManagedRoot;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.SMITHERSBOT_STATE_DIR;
  else process.env.SMITHERSBOT_STATE_DIR = previousStateDir;
  if (previousManagedRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
  else process.env.SMITHERSBOT_GOALS_ROOT = previousManagedRoot;
  fs.rmSync(testStateDir, { recursive: true, force: true });
  fs.rmSync(testManagedRoot, { recursive: true, force: true });
});

function buildRun(overrides: Partial<SerializedRun>): SerializedRun {
  return {
    runId: "rrr-fmt",
    goal: "goal",
    state: "blocked",
    plan: null,
    stepResults: {},
    blocked: null,
    answers: {},
    workingDir: "/tmp",
    model: undefined,
    dryRun: false,
    createdAt: "2026-01-30T00:00:00.000Z",
    updatedAt: "2026-01-30T00:00:00.000Z",
    ...overrides,
  };
}

function captureRuntime(): RuntimeEnv & { errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    log: vi.fn(),
    error: (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    },
    exit: (() => {
      throw new Error("exit called");
    }) as never,
  };
}

describe("formatGoalLockedMessage", () => {
  it("names the in-flight operation from the lock label", () => {
    expect(formatGoalLockedMessage("1234567890abcdef", "approve")).toBe(
      "Goal `12345678` is already resuming. Try again after the current operation finishes.",
    );
  });

  it("falls back to a generic phrase when lock label is absent", () => {
    expect(formatGoalLockedMessage("abcdef1234567890")).toBe(
      "Goal `abcdef12` is already being processed. Try again after the current operation finishes.",
    );
  });

  it("names the active step and retry command when provided", () => {
    expect(
      formatGoalLockedMessage("edbda8e4ffff0000", "resume", {
        activeStep: "fix-usage-status-refresh",
        retryCommand: "/goal_resume",
      }),
    ).toBe(
      "Goal `edbda8e4` is already resuming (currently on step `fix-usage-status-refresh`). " +
        "Try /goal_resume again after the current operation finishes.",
    );
  });

  it("maps each lock label to a distinct operation phrase", () => {
    expect(formatGoalLockedMessage("aaaaaaaa1111", "answer")).toContain(
      "is already applying your last answer",
    );
    expect(formatGoalLockedMessage("aaaaaaaa1111", "edit")).toContain(
      "is already updating its plan",
    );
    expect(formatGoalLockedMessage("aaaaaaaa1111", "feedback")).toContain(
      "is already incorporating your feedback",
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

describe("formatGoalDoneCaption", () => {
  it("adds the branch review URL when available", () => {
    const caption = formatGoalDoneCaption({
      summary: "Goal complete.",
      manualTestsStatus: "generated",
      reviewUrl:
        "https://github.com/smithers/test-private/tree/smithersbot/20260525-120000Z-run-github-push-success",
    });

    expect(caption).toContain(
      "📎 Review on GitHub: https://github.com/smithers/test-private/tree/smithersbot/20260525-120000Z-run-github-push-success",
    );
    expect(caption).not.toContain("/pull/");
  });
});

describe("buildOnStatusChange", () => {
  it("records completion delivery failure while preserving final artifacts", async () => {
    const runId = "delivery-failure-run";
    const reviewUrl =
      "https://github.com/smithers/test-private/tree/smithersbot/20260525-120000Z-delivery-failure-run";
    const plan = {
      goal: "Reliable delivery",
      workingDir: "/tmp/ws",
      summary: "Reliable delivery plan",
      shortSummary: "Reliable delivery",
      steps: [
        {
          id: "1",
          description: "Finish delivery",
          shortSummary: "Finish delivery",
          dependsOn: [],
          status: "done" as const,
        },
      ],
    };
    saveRun(
      buildRun({
        runId,
        goal: "Reliable delivery",
        state: "done",
        plan,
        stepResults: { "1": { stepId: "1", success: true, output: "", durationMs: 1 } },
        completionSummary: "✅ Done: Reliable delivery\n**Progress** 1/1\n**Goal ID:** delivery",
        githubPushOutcome: {
          enabled: true,
          branch: "smithersbot/20260525-120000Z-delivery-failure-run",
          remote: "origin",
          attempted: true,
          succeeded: true,
          pushedSha: "feedfacecafebeef1234567890abcdef12345678",
          reviewUrl,
          message: "Run branch pushed to origin (feedfac)",
          timestamp: "2026-05-25T12:34:56.000Z",
        },
      }),
    );
    const sendPhoto = vi.fn().mockRejectedValue(new Error("photo unavailable"));
    const sendMessage = vi.fn().mockRejectedValue(new Error("message unavailable"));
    const bot = { api: { sendPhoto, sendMessage } } as unknown as Bot;
    const runtime = captureRuntime();
    const onStatusChange = buildOnStatusChange({
      bot,
      chatId: 42,
      runtime,
      runId,
    });

    await onStatusChange({
      type: "all_done",
      steps: plan.steps,
      summary: "✅ Done: Reliable delivery\n**Progress** 1/1\n**Goal ID:** delivery",
      manualTests: [
        {
          description: "Run recovery smoke test",
          criticality: 8,
          detail: "Confirm /goal_status shows completion artifacts.",
        },
      ],
    });

    expect(sendPhoto).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalled();
    const persisted = loadRun(runId);
    expect(persisted?.completionSummary).toContain("✅ Done: Reliable delivery");
    expect(persisted?.githubPushOutcome?.reviewUrl).toBe(reviewUrl);
    expect(persisted?.manualTests?.[0]?.description).toBe("Run recovery smoke test");
    expect(persisted?.deliveryFailed).toBe(true);
    expect(persisted?.deliveryError).toContain("message unavailable");
    expect(runtime.errors.some((line) => line.includes("telegram goal sendPhoto failed"))).toBe(
      true,
    );
    expect(
      runtime.errors.some((line) =>
        line.includes("[goal] completion delivery failed for delivery: message unavailable"),
      ),
    ).toBe(true);
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

  it("resolves blocked-required input key, preferring task:<stepId>:input when stepId is set", () => {
    // run.blocked.stepId is the canonical routing target. Override stale
    // 'none' / 'resume_execution' keys so persisted question messages route
    // replies into the worker's task answer slot.
    expect(
      resolveBlockedRequiredInputKey(
        buildRun({
          blocked: {
            blockedAt: "execution",
            prompt: "Final build gate failed",
            requiredInputKey: "none",
            stepId: "done-step",
          },
        }),
      ),
    ).toBe("task:done-step:input");

    expect(
      resolveBlockedRequiredInputKey(
        buildRun({
          blocked: {
            blockedAt: "execution",
            prompt: "Final build gate failed",
            requiredInputKey: "resume_execution",
            stepId: "done-step",
          },
        }),
      ),
    ).toBe("task:done-step:input");

    // When stepId is set and the canonical key is already task:<stepId>:input, preserve it.
    expect(
      resolveBlockedRequiredInputKey(
        buildRun({
          blocked: {
            blockedAt: "execution",
            prompt: "Final build gate failed",
            requiredInputKey: "task:done-step:input",
            stepId: "done-step",
          },
        }),
      ),
    ).toBe("task:done-step:input");

    // No stepId on run.blocked, persisted key is real → use it as-is.
    expect(
      resolveBlockedRequiredInputKey(
        buildRun({
          blocked: {
            blockedAt: "execution",
            prompt: "Need creds",
            requiredInputKey: "creds_key",
          },
        }),
      ),
    ).toBe("creds_key");
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

describe("parseWorkingDirInstruction working-directory parser", () => {
  it("does not treat assertion/preflight wording with 'exactly' as a working-directory directive", () => {
    // Regression for: Could not resolve working directory:
    // "exactly /home/matt/smithersbot-dev-home/agent/workspaces/smithersbot-dev"
    expect(
      parseWorkingDirInstruction(
        "Please confirm the working directory is exactly /home/matt/smithersbot-dev-home/agent/workspaces/smithersbot-dev before running anything.",
        "/tmp",
      ),
    ).toBeUndefined();

    expect(
      parseWorkingDirInstruction("working directory is exactly /path", "/tmp"),
    ).toBeUndefined();
    expect(parseWorkingDirInstruction("pwd should be exactly /path", "/tmp")).toBeUndefined();
  });

  it("strips a leading 'exactly' modifier from a captured path", () => {
    expect(cleanWorkingDirInstructionPath("exactly /home/matt/foo")).toBe("/home/matt/foo");
    expect(cleanWorkingDirInstructionPath("/home/matt/foo")).toBe("/home/matt/foo");
  });

  it("still honors an explicit 'In working directory /path' launch directive", () => {
    const existingDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-wd-directive-"));
    try {
      const hint = parseWorkingDirInstruction(`In working directory ${existingDir}`, "/tmp");
      expect(hint).toBeDefined();
      expect(hint?.requestedPath).toBe(existingDir);
      expect(hint?.resolvedPath).toBe(path.resolve(existingDir));
    } finally {
      fs.rmSync(existingDir, { recursive: true, force: true });
    }
  });
});
