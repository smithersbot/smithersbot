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
import { sendBlockedNotification } from "./goal-sending.js";

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
});
