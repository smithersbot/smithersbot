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
  sendGoalBackgroundResult,
  sendGoalPlanResult,
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
    expect(keyboard).not.toContain("gResume:");
    expect(keyboard).not.toContain("gAD:");
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
});
