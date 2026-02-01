import { describe, expect, it, vi } from "vitest";

import { handleTelegramGoalRouting } from "./bot-handlers.js";
import type { SerializedRun } from "../goal/types.js";

const now = new Date().toISOString();

function makeRun(partial: Partial<SerializedRun>): SerializedRun {
  return {
    runId: partial.runId ?? "run-1",
    goal: "Test goal",
    state: partial.state ?? "awaiting_approval",
    plan: null,
    stepResults: {},
    blocked: partial.blocked ?? null,
    answers: {},
    workingDir: "/tmp",
    model: undefined,
    dryRun: false,
    createdAt: now,
    updatedAt: now,
    telegramPlanMessage: partial.telegramPlanMessage,
  };
}

describe("handleTelegramGoalRouting", () => {
  it("routes approval intent through handler and sends reply", async () => {
    const runs = [
      makeRun({
        runId: "r1",
        state: "awaiting_approval",
        telegramPlanMessage: { chatId: 9, messageId: 10 },
      }),
    ];

    const sendReply = vi.fn(async () => {});
    const sendPlanResult = vi.fn(async () => {});
    const approve = vi.fn(async () => "approved");

    const handled = await handleTelegramGoalRouting({
      chatId: 9,
      threadId: undefined,
      messageText: "approve",
      replyToMessageId: undefined,
      runs,
      sendReply,
      sendPlanResult,
      runHandlers: {
        create: vi.fn(async () => ({ text: "plan" })),
        edit: vi.fn(async () => ({ text: "plan" })),
        answer: vi.fn(async () => "answer"),
        approve,
        reject: vi.fn(async () => "reject"),
      },
    });

    expect(handled).toBe(true);
    expect(approve).toHaveBeenCalledWith("r1");
    expect(sendReply).toHaveBeenCalledWith("approved");
    expect(sendPlanResult).not.toHaveBeenCalled();
  });
});
