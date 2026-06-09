import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Bot } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadRun, saveRun } from "../goal/run-store.js";
import type { SerializedRun } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  buildDoneSummaryWithManualTests,
  buildGoalDoneInlineKeyboard,
  buildContinuationApprovePreface,
  buildOnStatusChange,
  buildPlanningPreface,
  buildReportingFailedCaption,
  buildReportingFailedInlineKeyboard,
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
import { markdownToTelegramHtml } from "./format.js";

const { mockRenderMermaidToPng } = vi.hoisted(() => ({
  mockRenderMermaidToPng: vi.fn(() => ({ buffer: Buffer.from("png") })),
}));

vi.mock("../goal/mermaid-png.js", () => ({
  renderMermaidToPng: (...args: unknown[]) => mockRenderMermaidToPng(...args),
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
  mockRenderMermaidToPng.mockReturnValue({ buffer: Buffer.from("png") });
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
    expect(caption).not.toContain("\n\n");
  });

  it("renders the Plan Done headline with HTML-bold intent", () => {
    const caption = formatGoalDoneCaption({
      summary: "✅ Done: Ship the feature\n**Progress** 1/1\n**Goal ID:** plandone1",
      manualTestsStatus: "generated",
    });
    expect(caption.startsWith("**Goal Summary:** Ship the feature\n")).toBe(true);
    expect(caption).toContain("✅ **Plan Done:** Ship the feature");
    expect(caption).not.toContain("✅ Done:");
    // The send path converts markdown bold to real HTML <b>...</b> for Telegram.
    expect(
      markdownToTelegramHtml(caption).startsWith("<b>Goal Summary:</b> Ship the feature\n"),
    ).toBe(true);
    expect(markdownToTelegramHtml(caption)).toContain("✅ <b>Plan Done:</b> Ship the feature");
    expect(markdownToTelegramHtml(caption)).not.toContain("&lt;b&gt;");
  });

  it("folds the goal-achieved block into the Plan Done surface when achieved", () => {
    const caption = formatGoalDoneCaption({
      summary: "✅ Done: Ship the feature\n**Progress** 1/1\n**Goal ID:** plandone1",
      manualTestsStatus: "generated",
      goalAchieved: true,
    });
    expect(caption.startsWith("**Goal Summary:** Ship the feature\n")).toBe(true);
    expect(caption).toContain("✅ **Plan Done:** Ship the feature");
    expect(caption).toContain("✅ **Goal appears achieved**");
    expect(caption).toContain("No next plan is recommended right now.");
    expect(markdownToTelegramHtml(caption)).toContain("✅ <b>Goal appears achieved</b>");
    expect(caption).not.toContain("\n\n");
  });
});

describe("Plan Done surface", () => {
  function buildDoneRun(overrides: Partial<SerializedRun> = {}): SerializedRun {
    return buildRun({
      runId: "donerun1-2345-6789-abcd-ef0123456789",
      goal: "Improve the login flow",
      state: "done",
      plan: {
        goal: "Improve the login flow",
        workingDir: "/tmp/ws",
        summary: "Login plan",
        shortSummary: "Login flow",
        steps: [
          {
            id: "1",
            description: "Wire login",
            shortSummary: "Wire login",
            dependsOn: [],
            status: "done" as const,
          },
        ],
      },
      ...overrides,
    });
  }

  it("renders manual tests from report-derived manualTests on the Plan Done surface", () => {
    const summary = buildDoneSummaryWithManualTests(
      buildDoneRun({
        manualTests: [
          {
            description: "Verify login redirect",
            criticality: 7,
            detail: "Log in and confirm redirect to dashboard.",
          },
        ],
      }),
    );
    expect(summary.startsWith("**Goal Summary:** Login flow\n")).toBe(true);
    expect(summary).toContain("✅ **Plan Done:**");
    expect(summary).toContain("Verify login redirect");
    expect(summary).not.toContain("✅ Done:");
  });

  it("folds the achieved block when the report says the goal is achieved", () => {
    const summary = buildDoneSummaryWithManualTests(
      buildDoneRun({
        postExecutionReport: {
          planCompleted: true,
          goalAchieved: true,
          summary: "All done.",
          filesChanged: [],
          verificationCommands: [],
          manualTests: [],
          nextPlanRecommended: false,
          nextPlanSummary: null,
          nextPlanPrompt: null,
          decisionsNeeded: [],
          failureOrBlockedReason: null,
        },
      }),
    );
    expect(summary.startsWith("**Goal Summary:** Login flow\n")).toBe(true);
    expect(summary).toContain("✅ **Plan Done:**");
    expect(summary).toContain("✅ **Goal appears achieved**");
  });

  it("keeps Test Detail and Incorporate Feedback on top and View Report full-width when not achieved", () => {
    const keyboard = buildGoalDoneInlineKeyboard("donerun1");
    const rows = keyboard?.inline_keyboard ?? [];
    expect(rows).toEqual([
      [
        { text: "🔍 Test Detail", callback_data: "gTD:donerun1" },
        { text: "🔄 Incorporate Feedback", callback_data: "gIF:donerun1" },
      ],
      [{ text: "📄 View Report", callback_data: "gVR:donerun1" }],
    ]);
  });

  it("keeps Test Detail and Incorporate Feedback on top and View Report + Continue Goal on bottom when achieved", () => {
    const keyboard = buildGoalDoneInlineKeyboard("donerun1", { goalAchieved: true });
    const rows = keyboard?.inline_keyboard ?? [];
    expect(rows).toEqual([
      [
        { text: "🔍 Test Detail", callback_data: "gTD:donerun1" },
        { text: "🔄 Incorporate Feedback", callback_data: "gIF:donerun1" },
      ],
      [
        { text: "📄 View Report", callback_data: "gVR:donerun1" },
        { text: "🧭 Continue Goal", callback_data: "gCG:donerun1" },
      ],
    ]);
  });

  it("renders the reporting-failed copy and a Resume Post Execution button", () => {
    const caption = buildReportingFailedCaption("usage limit hit on both backends");
    expect(caption).toContain("⚠️ **Post Execution Reporting Failed**");
    expect(caption).toContain("usage limit hit on both backends");
    expect(markdownToTelegramHtml(caption)).toContain("⚠️ <b>Post Execution Reporting Failed</b>");

    const flat = (buildReportingFailedInlineKeyboard("donerun1")?.inline_keyboard ?? []).flat();
    expect(flat.map((b) => b.text)).toEqual(["▶️ Resume Post Execution"]);
    expect(flat[0]?.callback_data).toBe("gRP:donerun1");
  });
});

describe("buildOnStatusChange", () => {
  it("delivers revised plans through the shared fallback path without approval UI and preserves plan history", async () => {
    const runId = "plan-revised-run";
    const plan = {
      goal: "Revise goal",
      workingDir: "/tmp/ws",
      summary: "Revised plan",
      shortSummary: "Revised",
      steps: [
        {
          id: "unsafe-step/1",
          description: "Apply feedback",
          shortSummary: "Apply feedback",
          dependsOn: [],
          status: "pending" as const,
        },
      ],
    };
    saveRun(
      buildRun({
        runId,
        goal: "Revise goal",
        state: "running",
        plan,
        planRevision: 2,
        telegramPlanMessage: {
          chatId: 42,
          messageId: 10,
          threadId: 3,
          messageHistory: [8, 9],
        },
      }),
    );
    mockRenderMermaidToPng.mockReturnValue(null);
    const sendPhoto = vi.fn();
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 101 });
    const bot = { api: { sendPhoto, sendMessage } } as unknown as Bot;
    const onStatusChange = buildOnStatusChange({
      bot,
      chatId: 42,
      threadId: 3,
      runtime: captureRuntime(),
      runId,
    });

    await onStatusChange({
      type: "plan_revised",
      revision: 2,
      summary: "Auto-executing new fix steps.",
      steps: plan.steps,
    });

    expect(sendPhoto).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledOnce();
    const text = String(sendMessage.mock.calls[0]?.[1] ?? "");
    const options = sendMessage.mock.calls[0]?.[2];
    expect(text).toContain("Auto-executing new fix steps.");
    expect(text).toContain("<pre><code>");
    expect(JSON.stringify(options?.reply_markup ?? {})).not.toContain("Approve");
    expect(text.toLowerCase()).not.toContain("approval required");
    expect(loadRun(runId)?.telegramPlanMessage).toEqual({
      chatId: 42,
      messageId: 101,
      threadId: 3,
      messageHistory: [8, 9, 10],
    });
  });

  it("persists revised-plan delivery failure only after minimal fallback also fails", async () => {
    const runId = "plan-revised-fail-run";
    const plan = {
      goal: "Revise failure goal",
      workingDir: "/tmp/ws",
      summary: "Revised failure plan",
      shortSummary: "Revised failure",
      steps: [
        {
          id: "1",
          description: "Apply feedback",
          shortSummary: "Apply feedback",
          dependsOn: [],
          status: "pending" as const,
        },
      ],
    };
    saveRun(
      buildRun({
        runId,
        goal: "Revise failure goal",
        state: "running",
        plan,
      }),
    );
    mockRenderMermaidToPng.mockReturnValue(null);
    const sendMessage = vi.fn().mockRejectedValue(new Error("revised message unavailable"));
    const runtime = captureRuntime();
    const onStatusChange = buildOnStatusChange({
      bot: { api: { sendPhoto: vi.fn(), sendMessage } } as unknown as Bot,
      chatId: 42,
      runtime,
      runId,
    });

    await onStatusChange({
      type: "plan_revised",
      revision: 2,
      summary: "Auto-executing new fix steps.",
      steps: plan.steps,
    });

    expect(sendMessage).toHaveBeenCalled();
    expect(loadRun(runId)?.telegramPlanMessage).toBeUndefined();
    expect(loadRun(runId)?.deliveryFailed).toBe(true);
    expect(loadRun(runId)?.deliveryError).toContain("revised message unavailable");
    expect(runtime.errors.some((line) => line.includes("revised plan delivery failed"))).toBe(true);
  });

  it("sends a separate continuation surface after the Done message", async () => {
    const runId = "continuation-surface-run";
    const plan = {
      goal: "Reliable continuation",
      workingDir: "/tmp/ws",
      summary: "Reliable continuation plan",
      shortSummary: "Reliable continuation",
      steps: [
        {
          id: "1",
          description: "Finish implementation",
          shortSummary: "Finish implementation",
          dependsOn: [],
          status: "done" as const,
        },
      ],
    };
    saveRun(
      buildRun({
        runId,
        goal: "Reliable continuation",
        state: "done",
        plan,
        stepResults: { "1": { stepId: "1", success: true, output: "", durationMs: 1 } },
        completionSummary: "✅ Done: Reliable continuation\n**Progress** 1/1\n**Goal ID:** continu",
        planRevision: 2,
        planNumber: 1,
      }),
    );
    const sendPhoto = vi.fn().mockResolvedValue({ message_id: 100 });
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 101 });
    const bot = { api: { sendPhoto, sendMessage } } as unknown as Bot;
    const runtime = captureRuntime();
    const continuationClient = {
      complete: vi.fn(async () => ({
        text: JSON.stringify({
          outcome: "continuation-recommended-now",
          goalAchieved: false,
          briefSummary: "Verify the post-Done continuation surface.",
          proposedPrompt: "Create Plan 2 to verify the post-Done continuation surface.",
          decisions: [
            {
              question: "Should Plan 2 use the harness?",
              options: ["Yes", "No"],
              recommendedOption: "Yes",
              rationale: "It exercises the trusted gateway path.",
            },
          ],
          runAt: "now",
        }),
      })),
    };
    const onStatusChange = buildOnStatusChange({
      bot,
      chatId: 42,
      runtime,
      runId,
      continuationClient,
    });

    await onStatusChange({
      type: "all_done",
      steps: plan.steps,
      summary: "✅ Done: Reliable continuation\n**Progress** 1/1\n**Goal ID:** continu",
    });

    expect(sendPhoto).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      42,
      expect.stringContaining("🧭 <b>Continue this goal with a new plan?</b>"),
      expect.objectContaining({
        reply_parameters: { message_id: 100 },
        reply_markup: expect.objectContaining({
          inline_keyboard: [
            [
              expect.objectContaining({ text: "❤️ Approve" }),
              expect.objectContaining({ text: "🔍 View Prompt" }),
            ],
            [expect.objectContaining({ text: "📝 Request Edit" })],
          ],
        }),
      }),
    );
    const continuationText = String(sendMessage.mock.calls.at(-1)?.[1] ?? "");
    expect(continuationText).toContain("<b>Next Plan Summary:</b>");
    expect(continuationText).toContain("<b>When:</b> Now");
    expect(continuationText).toContain("<b>(A): (Recommended)</b> Yes");
    expect(continuationText).toContain("<b>Goal ID:</b> continua");
    expect(continuationText).not.toContain("\n\n");
    expect(continuationText).not.toContain("Another plan is recommended.");
    expect(continuationText).not.toContain("🔁");
    expect(continuationText.toLowerCase()).not.toContain("cycle");
    expect(loadRun(runId)?.pendingContinuation).toMatchObject({
      fromPlanNumber: 1,
      fromRevision: 2,
      briefSummary: "Verify the post-Done continuation surface.",
      status: "pending",
    });
    const persisted = loadRun(runId);
    expect(persisted?.continuationDelivery).toMatchObject({
      proposalId: persisted?.pendingContinuation?.proposalId,
      chatId: 42,
      messageId: 101,
      deliveredAt: expect.any(String),
    });
    expect(persisted?.pendingContinuation?.notify).toEqual({
      chatId: 42,
      messageId: 101,
      threadId: undefined,
    });
  });

  it("records a continuation delivery failure after the Done message", async () => {
    const runId = "continuation-delivery-failure-run";
    const plan = {
      goal: "Recover continuation delivery",
      workingDir: "/tmp/ws",
      summary: "Recovery plan",
      shortSummary: "Recover delivery",
      steps: [
        {
          id: "1",
          description: "Finish work",
          shortSummary: "Finish",
          dependsOn: [],
          status: "done" as const,
        },
      ],
    };
    saveRun(
      buildRun({
        runId,
        goal: "Recover continuation delivery",
        state: "done",
        plan,
        stepResults: { "1": { stepId: "1", success: true, output: "", durationMs: 1 } },
        planRevision: 3,
        planNumber: 2,
      }),
    );
    const sendPhoto = vi.fn().mockResolvedValue({ message_id: 500 });
    const sendMessage = vi.fn().mockRejectedValue(new Error("continuation send unavailable"));
    const runtime = captureRuntime();
    const continuationClient = {
      complete: vi.fn(async () => ({
        text: JSON.stringify({
          outcome: "continuation-recommended-now",
          goalAchieved: false,
          briefSummary: "Retry the continuation surface.",
          proposedPrompt: "Create the next plan after a failed continuation send.",
          decisions: [],
          runAt: "now",
        }),
      })),
    };
    const onStatusChange = buildOnStatusChange({
      bot: { api: { sendPhoto, sendMessage } } as unknown as Bot,
      chatId: 42,
      runtime,
      runId,
      continuationClient,
    });

    await onStatusChange({
      type: "all_done",
      steps: plan.steps,
      summary: "✅ Done: Recover continuation delivery",
    });

    expect(sendPhoto).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalled();
    const persisted = loadRun(runId);
    expect(persisted?.pendingContinuation).toMatchObject({
      briefSummary: "Retry the continuation surface.",
      status: "pending",
    });
    expect(persisted?.continuationDelivery).toMatchObject({
      proposalId: persisted?.pendingContinuation?.proposalId,
      chatId: 42,
      failed: true,
      error: "continuation send unavailable",
      failedAt: expect.any(String),
    });
    expect(persisted?.pendingContinuation?.notify).toBeUndefined();
    expect(
      runtime.errors.some((line) =>
        line.includes("[goal] continuation prompt delivery failed for continu"),
      ),
    ).toBe(true);
  });

  it("does not send a duplicate continuation surface when the current proposal is delivered", async () => {
    const runId = "continuation-idempotent-run";
    const plan = {
      goal: "Avoid duplicate continuation",
      workingDir: "/tmp/ws",
      summary: "Idempotent continuation plan",
      shortSummary: "Avoid duplicate",
      steps: [
        {
          id: "1",
          description: "Finish work",
          shortSummary: "Finish",
          dependsOn: [],
          status: "done" as const,
        },
      ],
    };
    saveRun(
      buildRun({
        runId,
        goal: "Avoid duplicate continuation",
        state: "done",
        plan,
        stepResults: { "1": { stepId: "1", success: true, output: "", durationMs: 1 } },
        pendingContinuation: {
          proposalId: "proposal-current",
          fromPlanNumber: 1,
          fromRevision: 1,
          goalAchieved: false,
          briefSummary: "Already delivered continuation.",
          proposedPrompt: "Continue with the already delivered proposal.",
          runAt: "now",
          status: "pending",
          createdAt: "2026-01-30T00:00:00.000Z",
          notify: { chatId: 42, messageId: 600 },
        },
        continuationDelivery: {
          proposalId: "proposal-current",
          chatId: 42,
          messageId: 600,
          deliveredAt: "2026-01-30T00:00:00.000Z",
        },
      }),
    );
    const sendPhoto = vi.fn().mockResolvedValue({ message_id: 601 });
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 602 });
    const onStatusChange = buildOnStatusChange({
      bot: { api: { sendPhoto, sendMessage } } as unknown as Bot,
      chatId: 42,
      runtime: captureRuntime(),
      runId,
    });

    await onStatusChange({
      type: "all_done",
      steps: plan.steps,
      summary: "✅ Done: Avoid duplicate continuation",
    });

    expect(sendPhoto).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(loadRun(runId)?.continuationDelivery).toMatchObject({
      proposalId: "proposal-current",
      messageId: 600,
    });
  });

  it("stores an achieved/no-next-plan continuation without sending a separate achieved mini-message", async () => {
    const runId = "achieved-surface-run";
    const plan = {
      goal: "Read only goal",
      workingDir: "/tmp/ws",
      summary: "Read only plan",
      shortSummary: "Read only",
      steps: [
        {
          id: "1",
          description: "Inspect state",
          shortSummary: "Inspect state",
          dependsOn: [],
          status: "done" as const,
        },
      ],
    };
    saveRun(
      buildRun({
        runId,
        goal: "Read only goal",
        state: "done",
        plan,
        stepResults: { "1": { stepId: "1", success: true, output: "", durationMs: 1 } },
        completionSummary: "✅ Done: Read only goal\n**Progress** 1/1\n**Goal ID:** achieve",
        planRevision: 5,
        planNumber: 2,
      }),
    );
    const sendPhoto = vi.fn().mockResolvedValue({ message_id: 200 });
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 201 });
    const bot = { api: { sendPhoto, sendMessage } } as unknown as Bot;
    const runtime = captureRuntime();
    const continuationClient = {
      complete: vi.fn(async () => ({
        text: JSON.stringify({
          outcome: "goal-achieved-no-continuation",
          goalAchieved: true,
          briefSummary: "The goal is complete and no next plan is useful.",
        }),
      })),
    };
    const onStatusChange = buildOnStatusChange({
      bot,
      chatId: 42,
      runtime,
      runId,
      continuationClient,
    });

    await onStatusChange({
      type: "all_done",
      steps: plan.steps,
      summary: "✅ Done: Read only goal\n**Progress** 1/1\n**Goal ID:** achieve",
    });

    expect(sendPhoto).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(loadRun(runId)?.pendingContinuation).toMatchObject({
      goalAchieved: true,
      proposedPrompt: "",
      fromPlanNumber: 2,
      fromRevision: 5,
      status: "pending",
    });
  });

  it("does not send or store a continuation when no LLM client exists", async () => {
    const runId = "no-client-continuation-run";
    const plan = {
      goal: "Complete without continuation client",
      workingDir: "/tmp/ws",
      summary: "No client plan",
      shortSummary: "No client",
      steps: [
        {
          id: "1",
          description: "Finish work",
          shortSummary: "Finish",
          dependsOn: [],
          status: "done" as const,
        },
      ],
    };
    saveRun(
      buildRun({
        runId,
        goal: "Complete without continuation client",
        state: "done",
        plan,
        stepResults: { "1": { stepId: "1", success: true, output: "", durationMs: 1 } },
        completionSummary: "✅ Done: Complete without continuation client",
        planRevision: 4,
        planNumber: 2,
      }),
    );
    const sendPhoto = vi.fn().mockResolvedValue({ message_id: 300 });
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 301 });
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
      summary: "✅ Done: Complete without continuation client",
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(loadRun(runId)?.pendingContinuation).toBeUndefined();
    expect(loadRun(runId)?.continuationDelivery).toBeUndefined();
    expect(
      runtime.errors.some((line) =>
        line.includes("Continuation proposal failed because no continuation backend was available"),
      ),
    ).toBe(true);
  });

  it("persists telegramDoneMessage when all_done falls back to text DAG delivery", async () => {
    const runId = "done-text-fallback-run";
    const plan = {
      goal: "Complete with text fallback",
      workingDir: "/tmp/ws",
      summary: "Done fallback plan",
      shortSummary: "Done fallback",
      steps: [
        {
          id: "done-step/1",
          description: "Finish work",
          shortSummary: "Finish",
          dependsOn: [],
          status: "done" as const,
        },
      ],
    };
    saveRun(
      buildRun({
        runId,
        goal: "Complete with text fallback",
        state: "done",
        plan,
        stepResults: {
          "done-step/1": { stepId: "done-step/1", success: true, output: "", durationMs: 1 },
        },
      }),
    );
    mockRenderMermaidToPng.mockReturnValue(null);
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 401 });
    const onStatusChange = buildOnStatusChange({
      bot: { api: { sendPhoto: vi.fn(), sendMessage } } as unknown as Bot,
      chatId: 42,
      runtime: captureRuntime(),
      runId,
    });

    await onStatusChange({
      type: "all_done",
      steps: plan.steps,
      summary: "✅ Done: Complete with text fallback",
    });

    expect(sendMessage).toHaveBeenCalled();
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain("<pre><code>");
    expect(loadRun(runId)?.telegramDoneMessage).toEqual({
      chatId: 42,
      messageId: 401,
      threadId: undefined,
    });
    expect(loadRun(runId)?.deliveryFailed).toBeUndefined();
  });

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
    expect(runtime.errors.some((line) => line.includes("photo-send-failure"))).toBe(true);
    expect(
      runtime.errors.some((line) =>
        line.includes("[goal] completion delivery failed for delivery:"),
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

  it("renders continuation approval prefaces with the next plan number", () => {
    expect(buildContinuationApprovePreface({ planNumber: 1 })).toBe(
      "Right away, sir. Drafting Plan 2 now.",
    );
    expect(buildContinuationApprovePreface({ planNumber: 3 }, "Matthew")).toBe(
      "Right away, Matthew. Drafting Plan 4 now.",
    );
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

describe("Goal Brief Telegram rendering", () => {
  const brief = [
    "# Goal Brief",
    "",
    "## Objective",
    "",
    "Ship the login flow improvements.",
    "",
    "## Scope",
    "",
    "In scope: auth. Out of scope: billing.",
    "",
  ].join("\n");

  it("renders headings bold and compacts blank lines with the opt-in option", () => {
    const html = markdownToTelegramHtml(brief, { headingStyle: "bold", compact: true });
    expect(html).toContain("<b>Goal Brief</b>");
    expect(html).toContain("<b>Objective</b>");
    expect(html).toContain("<b>Scope</b>");
    // Compaction collapses paragraph-separator blank lines.
    expect(html).not.toContain("\n\n");
    // Heading sits directly above its body text with a single newline.
    expect(html).toContain("<b>Objective</b>\nShip the login flow improvements.");
  });

  it("leaves the default render path unchanged (no bold headings, blank lines kept)", () => {
    const html = markdownToTelegramHtml(brief);
    expect(html).not.toContain("<b>Goal Brief</b>");
    expect(html).not.toContain("<b>Objective</b>");
    expect(html).toContain("Goal Brief");
    // Default behavior keeps the paragraph-separator blank lines.
    expect(html).toContain("\n\n");
  });
});
