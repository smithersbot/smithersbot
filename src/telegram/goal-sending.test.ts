import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEnv } from "../runtime.js";
import type { BlockedDetail, Plan, PlanStep, SerializedRun } from "../goal/types.js";

let testGoalsDir: string;

const { mockRenderMermaidToPng, mockRepairMermaidDiagram } = vi.hoisted(() => ({
  mockRenderMermaidToPng: vi.fn(),
  mockRepairMermaidDiagram: vi.fn(),
}));

const mockRunCliProcess = vi.hoisted(() => vi.fn());
vi.mock("../goal/cli-process.js", () => ({
  runCliProcess: (...args: unknown[]) => mockRunCliProcess(...args),
}));

vi.mock("../goal/run-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../goal/run-store.js")>();
  return {
    ...actual,
    resolveGoalsDir: () => testGoalsDir,
    listRuns: (dir?: string) => actual.listRuns(dir ?? testGoalsDir),
    loadRun: (id: string, dir?: string) => actual.loadRun(id, dir ?? testGoalsDir),
    saveRun: (run: SerializedRun, dir?: string) => actual.saveRun(run, dir ?? testGoalsDir),
    resolveRunId: (partial: string, dir?: string) =>
      actual.resolveRunId(partial, dir ?? testGoalsDir),
  };
});

vi.mock("../goal/mermaid-png.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../goal/mermaid-png.js")>();
  return {
    ...actual,
    renderMermaidToPng: (...args: unknown[]) => mockRenderMermaidToPng(...args),
    repairMermaidDiagram: (...args: unknown[]) => mockRepairMermaidDiagram(...args),
  };
});

import { loadRun, saveRun } from "../goal/run-store.js";
import {
  sendBlockedNotification,
  sendDagPng,
  sendGoalDagWithFallback,
  sendGoalBackgroundResult,
  sendGoalPlanResult,
  sendGoalReply,
} from "./goal-sending.js";

function makeBlockedStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: "1",
    description: "Collect missing input",
    shortSummary: "Collect missing input",
    dependsOn: [],
    status: "blocked",
    durationMinutes: 1,
    blockedReason: "user_input",
    blockedQuestion: "Please provide API credentials.",
    ...overrides,
  };
}

function makePlan(steps: PlanStep[]): Plan {
  return {
    goal: "Test goal",
    workingDir: "/tmp/ws",
    summary: "Test summary",
    shortSummary: "Test summary",
    steps,
  };
}

function makeRun(runId: string, plan: Plan): SerializedRun {
  const now = new Date().toISOString();
  return {
    runId,
    goal: plan.goal,
    state: "blocked",
    plan,
    stepResults: {},
    blocked: {
      blockedAt: "execution",
      prompt: "Need more details.",
      requiredInputKey: "tasks:1:input",
    },
    answers: {},
    workingDir: plan.workingDir,
    model: undefined,
    dryRun: false,
    createdAt: now,
    updatedAt: now,
  };
}

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: () => {
      throw new Error("exit");
    },
  };
}

describe("sendBlockedNotification", () => {
  beforeEach(() => {
    testGoalsDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-sending-test-"));
    vi.clearAllMocks();
    mockRenderMermaidToPng.mockReturnValue({ buffer: Buffer.from("png") });
    mockRepairMermaidDiagram.mockResolvedValue(null);
  });

  afterEach(() => {
    fs.rmSync(testGoalsDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("persists question tracking when PNG delivery succeeds", async () => {
    const runId = "run-blocked-png-success";
    const steps = [makeBlockedStep()];
    const plan = makePlan(steps);
    saveRun(makeRun(runId, plan));

    const sendPhoto = vi.fn().mockResolvedValue({ message_id: 321 });
    const sendMessage = vi.fn();
    const bot = {
      api: {
        sendPhoto,
        sendMessage,
      },
    };
    const blockedDetail: BlockedDetail = {
      blockedAt: "execution",
      prompt: "Waiting for answers.",
      requiredInputKey: "tasks:1:input",
    };

    const sentId = await sendBlockedNotification({
      bot: bot as never,
      chatId: 1001,
      threadId: 77,
      runtime: createRuntime(),
      runId,
      plan,
      steps,
      stepResults: new Map(),
      blockedDetail,
    });

    expect(sentId).toBe(321);
    expect(sendPhoto).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
    const sendPhotoParams = sendPhoto.mock.calls[0]?.[2];
    expect(sendPhotoParams?.reply_markup?.inline_keyboard).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({ callback_data: expect.stringContaining("gAD:") }),
        ]),
        expect.arrayContaining([
          expect.objectContaining({ callback_data: expect.stringContaining("gResume:") }),
          expect.objectContaining({ callback_data: expect.stringContaining("gStop:") }),
        ]),
      ]),
    );

    const stored = loadRun(runId);
    expect(stored?.telegramQuestionMessages?.[0]).toEqual({
      chatId: 1001,
      messageId: 321,
      threadId: 77,
      requiredInputKey: "tasks:1:input",
    });
  });

  it("falls back to text with buttons and persists tracking when PNG delivery returns undefined", async () => {
    const runId = "run-blocked-png-fallback";
    const steps = [makeBlockedStep()];
    const plan = makePlan(steps);
    saveRun(makeRun(runId, plan));
    mockRenderMermaidToPng.mockReturnValue(null);

    const sendPhoto = vi.fn();
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 654 });
    const bot = {
      api: {
        sendPhoto,
        sendMessage,
      },
    };
    const blockedDetail: BlockedDetail = {
      blockedAt: "execution",
      prompt: "Need input for step 1.",
      requiredInputKey: "task:1:input",
      stepId: "1",
    };

    const sentId = await sendBlockedNotification({
      bot: bot as never,
      chatId: 2002,
      runtime: createRuntime(),
      runId,
      plan,
      steps,
      stepResults: new Map(),
      blockedDetail,
      replyToMessageId: 44,
    });

    expect(sentId).toBe(654);
    expect(sendPhoto).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      2002,
      expect.stringContaining("Step 1"),
      expect.objectContaining({
        parse_mode: "HTML",
        reply_parameters: { message_id: 44 },
        reply_markup: expect.objectContaining({
          inline_keyboard: expect.arrayContaining([
            expect.arrayContaining([
              expect.objectContaining({ callback_data: expect.stringContaining("gAD:") }),
            ]),
          ]),
        }),
      }),
    );
    const keyboard = sendMessage.mock.calls[0]?.[2]?.reply_markup?.inline_keyboard;
    const serializedKeyboard = JSON.stringify(keyboard);
    expect(serializedKeyboard).toContain("gStop:");
    expect(serializedKeyboard).not.toContain("gResume:");

    const stored = loadRun(runId);
    expect(stored?.telegramQuestionMessages?.[0]).toEqual({
      chatId: 2002,
      messageId: 654,
      requiredInputKey: "task:1:input",
    });
  });

  it("retries text fallback without reply_parameters when the reply target is stale", async () => {
    const runId = "run-blocked-stale-reply";
    const steps = [makeBlockedStep()];
    const plan = makePlan(steps);
    saveRun(makeRun(runId, plan));
    mockRenderMermaidToPng.mockReturnValue(null);

    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("Bad Request: replied message not found"))
      .mockResolvedValueOnce({ message_id: 655 });
    const bot = { api: { sendPhoto: vi.fn(), sendMessage } };

    const sentId = await sendBlockedNotification({
      bot: bot as never,
      chatId: 2003,
      runtime: createRuntime(),
      runId,
      plan,
      steps,
      stepResults: new Map(),
      blockedDetail: {
        blockedAt: "execution",
        prompt: "Need input for step 1.",
        requiredInputKey: "task:1:input",
        stepId: "1",
      },
      replyToMessageId: 44,
    });

    expect(sentId).toBe(655);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ reply_parameters: { message_id: 44 } }),
    );
    expect(sendMessage.mock.calls[1]?.[2]).not.toHaveProperty("reply_parameters");
    expect(loadRun(runId)?.telegramQuestionMessages?.[0]?.messageId).toBe(655);
  });

  it("selects a Resume keyboard and Paused copy for a retry-exhausted task block", async () => {
    const runId = "run-blocked-paused";
    const steps = [makeBlockedStep({ blockedReason: "rate_limit" })];
    const plan = makePlan(steps);
    saveRun(makeRun(runId, plan));
    mockRenderMermaidToPng.mockReturnValue(null);

    const sendMessage = vi.fn().mockResolvedValue({ message_id: 901 });
    const bot = { api: { sendPhoto: vi.fn(), sendMessage } };
    const blockedDetail: BlockedDetail = {
      blockedAt: "execution",
      prompt: "Worker hit a provider limit.",
      requiredInputKey: "resume_execution",
      stepId: "1",
    };

    await sendBlockedNotification({
      bot: bot as never,
      chatId: 7007,
      runtime: createRuntime(),
      runId,
      plan,
      steps,
      stepResults: new Map(),
      blockedDetail,
    });

    const text = sendMessage.mock.calls[0]?.[1] as string;
    expect(text).toContain("TASK PAUSED");
    expect(text).toContain("Resume");
    const keyboard = JSON.stringify(sendMessage.mock.calls[0]?.[2]?.reply_markup?.inline_keyboard);
    expect(keyboard).toContain("gResume:");
    expect(keyboard).toContain("gStop:");
    expect(keyboard).not.toContain("gAD:");
  });

  it("selects a Stop-only keyboard and Failed copy for a non-retryable task block", async () => {
    const runId = "run-blocked-failed";
    const steps = [makeBlockedStep({ blockedReason: "auth" })];
    const plan = makePlan(steps);
    saveRun(makeRun(runId, plan));
    mockRenderMermaidToPng.mockReturnValue(null);

    const sendMessage = vi.fn().mockResolvedValue({ message_id: 902 });
    const bot = { api: { sendPhoto: vi.fn(), sendMessage } };
    const blockedDetail: BlockedDetail = {
      blockedAt: "execution",
      prompt: "Worker authentication failed.",
      requiredInputKey: "resume_execution",
      stepId: "1",
    };

    await sendBlockedNotification({
      bot: bot as never,
      chatId: 7008,
      runtime: createRuntime(),
      runId,
      plan,
      steps,
      stepResults: new Map(),
      blockedDetail,
    });

    const text = sendMessage.mock.calls[0]?.[1] as string;
    expect(text).toContain("TASK FAILED");
    expect(text).toMatch(/fix/i);
    const keyboard = JSON.stringify(sendMessage.mock.calls[0]?.[2]?.reply_markup?.inline_keyboard);
    expect(keyboard).toContain("gStop:");
    expect(keyboard).toContain("gResume:");
    expect(keyboard).toContain("gAD:");
  });

  it("threads replyToMessageId into overflow DAG caption replies", async () => {
    const plan = makePlan([makeBlockedStep()]);
    const sendPhoto = vi.fn().mockResolvedValue({ message_id: 777 });
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 778 });
    const bot = {
      api: {
        sendPhoto,
        sendMessage,
      },
    };

    const sentId = await sendDagPng({
      bot: bot as never,
      chatId: 3003,
      threadId: 88,
      runtime: createRuntime(),
      plan,
      steps: plan.steps,
      caption: "A".repeat(1300),
      replyToMessageId: 55,
    });

    expect(sentId).toBe(777);
    expect(sendPhoto).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      3003,
      expect.any(String),
      expect.objectContaining({
        parse_mode: "HTML",
        message_thread_id: 88,
        reply_parameters: { message_id: 55 },
      }),
    );
  });

  it("keeps reply_parameters when Telegram accepts the reply target", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 779 });
    const bot = { api: { sendMessage } };

    const sentId = await sendGoalReply(
      bot as never,
      3004,
      "Accepted reply",
      createRuntime(),
      89,
      56,
    );

    expect(sentId).toBe(779);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        message_thread_id: 89,
        reply_parameters: { message_id: 56 },
      }),
    );
  });

  it("retries sendPhoto without reply_parameters when the reply target is stale", async () => {
    const plan = makePlan([makeBlockedStep()]);
    const sendPhoto = vi
      .fn()
      .mockRejectedValueOnce(new Error("Bad Request: message to reply not found"))
      .mockResolvedValueOnce({ message_id: 780 });
    const bot = { api: { sendPhoto, sendMessage: vi.fn() } };

    const sentId = await sendDagPng({
      bot: bot as never,
      chatId: 3005,
      threadId: 90,
      runtime: createRuntime(),
      plan,
      steps: plan.steps,
      caption: "caption",
      replyToMessageId: 57,
    });

    expect(sentId).toBe(780);
    expect(sendPhoto).toHaveBeenCalledTimes(2);
    expect(sendPhoto.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        message_thread_id: 90,
        reply_parameters: { message_id: 57 },
      }),
    );
    expect(sendPhoto.mock.calls[1]?.[2]).not.toHaveProperty("reply_parameters");
  });

  it("retries overflow caption remainder without reply_parameters when stale", async () => {
    const plan = makePlan([makeBlockedStep()]);
    const sendPhoto = vi.fn().mockResolvedValue({ message_id: 781 });
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("Bad Request: message to reply not found"))
      .mockResolvedValueOnce({ message_id: 782 });
    const bot = { api: { sendPhoto, sendMessage } };

    const sentId = await sendDagPng({
      bot: bot as never,
      chatId: 3006,
      threadId: 91,
      runtime: createRuntime(),
      plan,
      steps: plan.steps,
      caption: "B".repeat(1300),
      replyToMessageId: 58,
    });

    expect(sentId).toBe(781);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ reply_parameters: { message_id: 58 } }),
    );
    expect(sendMessage.mock.calls[1]?.[2]).not.toHaveProperty("reply_parameters");
  });

  it("retries minimal fallback without reply_parameters when stale", async () => {
    const plan = makePlan([makeBlockedStep()]);
    mockRenderMermaidToPng.mockReturnValue(null);
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("Bad Request: replied message not found"))
      .mockResolvedValueOnce({ message_id: 783 });
    const bot = { api: { sendPhoto: vi.fn(), sendMessage } };

    const result = await sendGoalDagWithFallback({
      bot: bot as never,
      chatId: 3007,
      runtime: createRuntime(),
      plan,
      steps: plan.steps,
      caption: "",
      textMarkdown: "",
      minimalMarkdown: "Minimal fallback",
      minimalReplyToMessageId: 59,
    });

    expect(result).toEqual({ ok: true, path: "minimal", messageId: 783 });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ reply_parameters: { message_id: 59 } }),
    );
    expect(sendMessage.mock.calls[1]?.[2]).not.toHaveProperty("reply_parameters");
  });

  it("persists render-timeout image failures distinctly", async () => {
    const runId = "run-image-timeout";
    const plan = makePlan([makeBlockedStep()]);
    saveRun(makeRun(runId, plan));
    mockRenderMermaidToPng.mockReturnValue(null);

    await sendDagPng({
      bot: { api: { sendPhoto: vi.fn(), sendMessage: vi.fn() } } as never,
      chatId: 4000,
      runtime: createRuntime(),
      plan,
      steps: plan.steps,
      caption: "caption",
      runId,
    });

    expect(loadRun(runId)?.imageFailure?.reason).toBe("render-timeout");
  });

  it("logs syntax failure and persists repair-unavailable when plannerBackendUsed is missing", async () => {
    const runId = "run-image-repair-unavailable";
    const runtime = createRuntime();
    const plan = makePlan([makeBlockedStep()]);
    saveRun(makeRun(runId, plan));
    mockRenderMermaidToPng.mockReturnValue({ error: "Parse error on line 2" });

    await sendDagPng({
      bot: { api: { sendPhoto: vi.fn(), sendMessage: vi.fn() } } as never,
      chatId: 4001,
      runtime,
      plan,
      steps: plan.steps,
      caption: "caption",
      runId,
    });

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("render-syntax-failure"));
    expect(loadRun(runId)?.imageFailure).toEqual(
      expect.objectContaining({
        reason: "repair-unavailable",
        error: expect.stringContaining("plannerBackendUsed"),
      }),
    );
    expect(loadRun(runId)?.imageFailure?.events?.map((event) => event.reason)).toEqual([
      "render-syntax-failure",
      "repair-unavailable",
    ]);
  });

  it("persists repair-failure image failures distinctly", async () => {
    const runId = "run-image-repair-failure";
    const plan = makePlan([makeBlockedStep()]);
    saveRun({ ...makeRun(runId, plan), plannerBackendUsed: "codex" });
    mockRenderMermaidToPng.mockReturnValue({ error: "Parse error" });
    mockRepairMermaidDiagram.mockResolvedValue(null);

    await sendDagPng({
      bot: { api: { sendPhoto: vi.fn(), sendMessage: vi.fn() } } as never,
      chatId: 4002,
      runtime: createRuntime(),
      plan,
      steps: plan.steps,
      caption: "caption",
      runId,
    });

    expect(loadRun(runId)?.imageFailure?.reason).toBe("repair-failure");
  });

  it("persists photo-send-failure image failures distinctly", async () => {
    const runId = "run-image-photo-failure";
    const plan = makePlan([makeBlockedStep()]);
    saveRun(makeRun(runId, plan));
    const sendPhoto = vi.fn().mockRejectedValue(new Error("Telegram photo rejected"));

    await sendDagPng({
      bot: { api: { sendPhoto, sendMessage: vi.fn() } } as never,
      chatId: 4003,
      runtime: createRuntime(),
      plan,
      steps: plan.steps,
      caption: "caption",
      runId,
    });

    expect(loadRun(runId)?.imageFailure).toEqual(
      expect.objectContaining({
        reason: "photo-send-failure",
        error: "Telegram photo rejected",
      }),
    );
  });

  it("strips forbidden credential env keys from Codex mermaid repair", async () => {
    const forbiddenKeys = [
      "TELEGRAM_BOT_TOKEN",
      "SMITHERSBOT_GATEWAY_TOKEN",
      "CLAWDBOT_GATEWAY_TOKEN",
      "MOLTBOT_GATEWAY_TOKEN",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GITHUB_TOKEN",
    ];
    for (const key of forbiddenKeys) {
      vi.stubEnv(key, `${key.toLowerCase()}-secret`);
    }
    const plan = makePlan([makeBlockedStep()]);
    const runId = "run-codex-repair-env";
    saveRun({
      ...makeRun(runId, plan),
      plannerBackendUsed: "codex",
    });
    mockRenderMermaidToPng.mockReturnValueOnce({ error: "parse error" });
    mockRepairMermaidDiagram.mockImplementationOnce(async ({ askFn }) => {
      await askFn("repair this diagram");
      return Buffer.from("repaired-png");
    });
    mockRunCliProcess.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "graph TD\nA-->B",
      stderr: "",
    });
    const sendPhoto = vi.fn().mockResolvedValue({ message_id: 987 });
    const bot = {
      api: {
        sendPhoto,
        sendMessage: vi.fn(),
      },
    };

    await sendDagPng({
      bot: bot as never,
      chatId: 4004,
      runtime: createRuntime(),
      plan,
      steps: plan.steps,
      caption: "caption",
      runId,
    });

    expect(mockRunCliProcess).toHaveBeenCalledOnce();
    const env = mockRunCliProcess.mock.calls[0]?.[0]?.env as Record<string, string | undefined>;
    for (const key of forbiddenKeys) {
      expect(env).not.toHaveProperty(key);
    }
  });

  it("redacts secret values from agent-derived background replies", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "FAKE_TELEGRAM_SECRET_123");
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 111 });
    const bot = {
      api: {
        sendMessage,
      },
    };

    await sendGoalBackgroundResult(
      {
        bot: bot as never,
        chatId: 5005,
        runtime: createRuntime(),
      },
      "Agent output includes FAKE_TELEGRAM_SECRET_123",
    );

    const sentText = sendMessage.mock.calls[0]?.[1] as string;
    expect(sentText).toContain("[REDACTED]");
    expect(sentText).not.toContain("FAKE_TELEGRAM_SECRET_123");
  });

  function savePlanRun(runId: string, plan: Plan): void {
    saveRun({
      ...makeRun(runId, plan),
      state: "awaiting_approval",
      blocked: null,
      planRevision: 1,
    });
  }

  function savePlanRunWithBrief(runId: string, plan: Plan, goalBriefPath: string): void {
    saveRun({
      ...makeRun(runId, plan),
      state: "awaiting_approval",
      blocked: null,
      planRevision: 1,
      goalBriefPath,
    });
  }

  async function captureApprovalPhoto(
    runId: string,
    plan: Plan,
    chatId: number,
  ): Promise<{ caption: string; keyboard: Array<Array<{ text: string; callback_data: string }>> }> {
    const sendPhoto = vi.fn().mockResolvedValue({ message_id: 900 });
    await sendGoalPlanResult({
      bot: { api: { sendPhoto, sendMessage: vi.fn() } } as never,
      chatId,
      runtime: createRuntime(),
      result: { runId, revision: 1, plan, text: "Plan ready" },
    });
    const options = sendPhoto.mock.calls[0]?.[2] as {
      caption?: string;
      reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> };
    };
    return {
      caption: options?.caption ?? "",
      keyboard: options?.reply_markup?.inline_keyboard ?? [],
    };
  }

  it("uses the Goal Brief's Goal Summary and places the Plan line directly beneath it", async () => {
    const runId = "plan-brief-summary";
    const plan = makePlan([makeBlockedStep({ status: "pending", blockedReason: undefined })]);
    const goalBriefPath = path.join(testGoalsDir, `${runId}-goal-brief.md`);
    fs.writeFileSync(
      goalBriefPath,
      [
        "## Goal Summary",
        "Two-stage file goal: create goal1.txt in Plan 1, then goal2.txt in Plan 2.",
        "",
        "## Long Goal Summary",
        "A longer description that must not appear on the caption.",
      ].join("\n"),
      "utf8",
    );
    savePlanRunWithBrief(runId, plan, goalBriefPath);

    const { caption } = await captureApprovalPhoto(runId, plan, 9100);

    // Goal Summary comes from the brief; the Plan line (plan-specific summary)
    // sits immediately after it and before the Goal ID.
    expect(caption).toContain(
      "<b>Goal Summary:</b> Two-stage file goal: create goal1.txt in Plan 1, then goal2.txt in Plan 2.\n<b>Plan 1:</b> Test summary\n<b>Goal ID:</b>",
    );
    expect(caption).not.toContain("A longer description that must not appear on the caption.");
  });

  it("falls back to the plan summary on the Goal Summary line when the Goal Brief is absent", async () => {
    const runId = "plan-brief-missing";
    const plan = makePlan([makeBlockedStep({ status: "pending", blockedReason: undefined })]);
    savePlanRun(runId, plan);

    const { caption } = await captureApprovalPhoto(runId, plan, 9101);

    expect(caption).toContain("<b>Goal Summary:</b> Test summary");
    expect(caption).toContain("<b>Plan 1:</b> Test summary");
  });

  it("omits the Reject button (and its gr: callback) from the approval inline keyboard", async () => {
    const runId = "plan-no-reject";
    const plan = makePlan([makeBlockedStep({ status: "pending", blockedReason: undefined })]);
    savePlanRun(runId, plan);

    const { keyboard } = await captureApprovalPhoto(runId, plan, 9102);

    const buttons = keyboard.flat();
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.some((button) => button.text.includes("Reject"))).toBe(false);
    expect(buttons.some((button) => button.callback_data.startsWith("gr:"))).toBe(false);
  });

  it("persists telegramPlanMessage when /new_goal DAG/photo delivery succeeds", async () => {
    const runId = "plan-photo-success";
    const plan = makePlan([makeBlockedStep({ status: "pending", blockedReason: undefined })]);
    savePlanRun(runId, plan);
    const sendPhoto = vi.fn().mockResolvedValue({ message_id: 701 });
    const sendMessage = vi.fn();

    await sendGoalPlanResult({
      bot: { api: { sendPhoto, sendMessage } } as never,
      chatId: 9001,
      threadId: 12,
      replyToMessageId: 44,
      runtime: createRuntime(),
      result: { runId, revision: 1, plan, text: "Plan ready" },
    });

    expect(sendPhoto).toHaveBeenCalledOnce();
    expect(sendPhoto.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        message_thread_id: 12,
        reply_parameters: { message_id: 44 },
        reply_markup: expect.any(Object),
      }),
    );
    const options = sendPhoto.mock.calls[0]?.[2] as {
      caption?: string;
      reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> };
    };
    expect(options.caption?.startsWith("<b>Goal Summary:</b> Test summary")).toBe(true);
    expect(options.reply_markup?.inline_keyboard).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({ text: "✏️ Edit Plan", callback_data: "ge:plan-pho:1" }),
          expect.objectContaining({ text: "📘 Goal Brief", callback_data: "gB:plan-pho:1" }),
        ]),
      ]),
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(loadRun(runId)?.telegramPlanMessage).toEqual({
      chatId: 9001,
      messageId: 701,
      threadId: 12,
      messageHistory: [],
    });
  });

  it("falls back to text DAG delivery independent of the original reply target and persists tracking", async () => {
    const runId = "plan-text-fallback";
    const plan = makePlan([makeBlockedStep({ status: "pending", blockedReason: undefined })]);
    savePlanRun(runId, plan);
    mockRenderMermaidToPng.mockReturnValue(null);
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 702 });

    await sendGoalPlanResult({
      bot: { api: { sendPhoto: vi.fn(), sendMessage } } as never,
      chatId: 9002,
      replyToMessageId: 45,
      runtime: createRuntime(),
      result: { runId, revision: 1, plan, text: "Plan ready" },
    });

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain("<pre><code>");
    expect(sendMessage.mock.calls[0]?.[2]).not.toHaveProperty("reply_parameters");
    expect(loadRun(runId)?.telegramPlanMessage?.messageId).toBe(702);
    expect(loadRun(runId)?.deliveryFailed).toBeUndefined();
  });

  it("treats /new_goal minimal fallback as a tracked success without setting deliveryFailed", async () => {
    const runId = "plan-minimal-fallback";
    const plan = makePlan([makeBlockedStep({ status: "pending", blockedReason: undefined })]);
    savePlanRun(runId, plan);
    mockRenderMermaidToPng.mockReturnValue(null);
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("text html failed"))
      .mockRejectedValueOnce(new Error("text plain failed"))
      .mockResolvedValueOnce({ message_id: 703 });

    await sendGoalPlanResult({
      bot: { api: { sendPhoto: vi.fn(), sendMessage } } as never,
      chatId: 9003,
      runtime: createRuntime(),
      result: { runId, revision: 1, plan, text: "Plan ready" },
    });

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(String(sendMessage.mock.calls[2]?.[1])).toContain("Plan ready for review");
    expect(loadRun(runId)?.telegramPlanMessage?.messageId).toBe(703);
    expect(loadRun(runId)?.deliveryFailed).toBeUndefined();
    expect(loadRun(runId)?.deliveryError).toBeUndefined();
  });

  it("persists deliveryFailed for /new_goal only when image, text, and minimal fallback all fail", async () => {
    const runId = "plan-total-failure";
    const plan = makePlan([makeBlockedStep({ status: "pending", blockedReason: undefined })]);
    savePlanRun(runId, plan);
    mockRenderMermaidToPng.mockReturnValue(null);
    const sendMessage = vi.fn().mockRejectedValue(new Error("message unavailable"));

    await sendGoalPlanResult({
      bot: { api: { sendPhoto: vi.fn(), sendMessage } } as never,
      chatId: 9004,
      runtime: createRuntime(),
      result: { runId, revision: 1, plan, text: "Plan ready" },
    });

    const stored = loadRun(runId);
    expect(stored?.telegramPlanMessage).toBeUndefined();
    expect(stored?.deliveryFailed).toBe(true);
    expect(stored?.deliveryError).toContain("minimal fallback threw: message unavailable");
  });

  it("redacts secret values from agent-derived plan result text", async () => {
    vi.stubEnv("SMITHERSBOT_GATEWAY_TOKEN", "FAKE_GATEWAY_SECRET_456");
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 222 });
    const bot = {
      api: {
        sendMessage,
      },
    };

    await sendGoalPlanResult({
      bot: bot as never,
      chatId: 5006,
      runtime: createRuntime(),
      result: {
        text: "Planner output includes FAKE_GATEWAY_SECRET_456",
      },
    });

    const sentText = sendMessage.mock.calls[0]?.[1] as string;
    expect(sentText).toContain("[REDACTED]");
    expect(sentText).not.toContain("FAKE_GATEWAY_SECRET_456");
  });

  it("attaches the Make Decision(s) button to blocked planning decisions", async () => {
    const runId = "decision-button-run-1234";
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 333 });
    const decisions = [
      {
        id: "first-plan-scope",
        question: "What should the first Plan do toward this Goal?",
        options: [
          {
            key: "A",
            label:
              "Research and propose a shortlist of promising business directions based on your constraints",
            recommended: true,
          },
          { key: "B", label: "Draft a business plan for a specific idea you provide" },
          {
            key: "C",
            label:
              "Build a first MVP, landing page, or other computer-based artifact for a specific idea you provide",
          },
        ],
      },
    ];

    await sendGoalPlanResult({
      bot: { api: { sendMessage } } as never,
      chatId: 5007,
      threadId: 22,
      replyToMessageId: 44,
      runtime: createRuntime(),
      result: {
        runId,
        blocked: true,
        decisions,
        text: [
          "**Decision(s) Needed:**",
          "**Decision 1.** What should the first Plan do toward this Goal?",
          "**(A)** Research and propose a shortlist of promising business directions based on your constraints **(Recommended)**",
          "**(B)** Draft a business plan for a specific idea you provide",
          "**(C)** Build a first MVP, landing page, or other computer-based artifact for a specific idea you provide",
          "",
          `**Goal ID:** ${runId.slice(0, 8)}`,
        ].join("\n"),
      },
    });

    expect(sendMessage).toHaveBeenCalledOnce();
    const sentText = String(sendMessage.mock.calls[0]?.[1] ?? "");
    expect(sentText).toContain("<b>Goal ID:</b>");
    expect(sentText).not.toContain("Answer: /goal_answer");
    expect(sentText).not.toContain("/goal_answer &lt;your answer&gt;");
    const options = sendMessage.mock.calls[0]?.[2] as {
      reply_markup?: {
        inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>>;
      };
    };
    const buttons = options.reply_markup?.inline_keyboard?.flat() ?? [];
    expect(buttons).toHaveLength(1);
    const makeDecisions = buttons.find((button) => button.text === "☑️ Make Decision(s)");
    expect(makeDecisions).toEqual(
      expect.objectContaining({ callback_data: `gAD:${runId.slice(0, 8)}` }),
    );
    expect(makeDecisions?.callback_data).toMatch(/^gAD:/);
  });
});
