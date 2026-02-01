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
    telegramQuestionMessages: partial.telegramQuestionMessages,
  };
}

describe("handleTelegramGoalRouting", () => {
  // ---- Approval guidance (intent D) ----

  it("'approve' with one awaiting_approval run returns approval guidance", async () => {
    const runs = [
      makeRun({
        runId: "r1",
        state: "awaiting_approval",
        telegramPlanMessage: { chatId: 9, messageId: 10 },
      }),
    ];

    const sendReply = vi.fn(async () => {});
    const sendPlanResult = vi.fn(async () => {});

    const handled = await handleTelegramGoalRouting({
      chatId: 9,
      threadId: undefined,
      messageText: "approve",
      replyToMessageId: undefined,
      runs,
      chatMode: "chat",
      sendReply,
      sendPlanResult,
      runHandlers: {
        edit: vi.fn(async () => ({ text: "plan" })),
        answer: vi.fn(async () => "answer"),
      },
    });

    expect(handled).toBe(true);
    expect(sendReply).toHaveBeenCalledWith(expect.stringContaining("/goal_approve"));
    expect(sendReply).toHaveBeenCalledWith(expect.stringContaining("r1".slice(0, 8)));
    expect(sendReply).toHaveBeenCalledWith(expect.stringMatching(/Approve button/));
    expect(sendReply).toHaveBeenCalledWith(expect.stringMatching(/react/));
    expect(sendPlanResult).not.toHaveBeenCalled();
  });

  it("'approve' with multiple awaiting_approval runs lists them", async () => {
    const runs = [
      makeRun({
        runId: "r1",
        state: "awaiting_approval",
        telegramPlanMessage: { chatId: 9, messageId: 10 },
      }),
      makeRun({
        runId: "r2",
        state: "awaiting_approval",
        telegramPlanMessage: { chatId: 9, messageId: 11 },
      }),
    ];

    const sendReply = vi.fn(async () => {});

    const handled = await handleTelegramGoalRouting({
      chatId: 9,
      threadId: undefined,
      messageText: "approve",
      replyToMessageId: undefined,
      runs,
      chatMode: "chat",
      sendReply,
      sendPlanResult: vi.fn(async () => {}),
      runHandlers: {
        edit: vi.fn(async () => ({ text: "plan" })),
        answer: vi.fn(async () => "answer"),
      },
    });

    expect(handled).toBe(true);
    expect(sendReply).toHaveBeenCalledWith(expect.stringContaining("/goal_list"));
    expect(sendReply).toHaveBeenCalledWith(expect.stringContaining("/goal_approve"));
  });

  it("'approve' with no awaiting runs replies with nothing-pending message", async () => {
    const sendReply = vi.fn(async () => {});

    const handled = await handleTelegramGoalRouting({
      chatId: 9,
      threadId: undefined,
      messageText: "approve",
      replyToMessageId: undefined,
      runs: [],
      chatMode: "chat",
      sendReply,
      sendPlanResult: vi.fn(async () => {}),
      runHandlers: {
        edit: vi.fn(async () => ({ text: "plan" })),
        answer: vi.fn(async () => "answer"),
      },
    });

    expect(handled).toBe(true);
    expect(sendReply).toHaveBeenCalledWith(expect.stringContaining("Nothing is awaiting approval"));
    expect(sendReply).toHaveBeenCalledWith(expect.stringContaining("/goal_list"));
  });

  it("'approve' ignores awaiting run from different chat (runs pre-scoped)", async () => {
    // params.runs is already chat/thread-scoped by the caller — pass empty to simulate
    const sendReply = vi.fn(async () => {});

    const handled = await handleTelegramGoalRouting({
      chatId: 9,
      threadId: undefined,
      messageText: "approve",
      replyToMessageId: undefined,
      runs: [],
      chatMode: "chat",
      sendReply,
      sendPlanResult: vi.fn(async () => {}),
      runHandlers: {
        edit: vi.fn(async () => ({ text: "plan" })),
        answer: vi.fn(async () => "answer"),
      },
    });

    // Cross-chat isolation: scoped runs are empty, so nothing-pending reply
    expect(handled).toBe(true);
    expect(sendReply).toHaveBeenCalledWith(expect.stringContaining("Nothing is awaiting approval"));
  });

  it("'approve' does not call any mutation handlers", async () => {
    const runs = [
      makeRun({
        runId: "r1",
        state: "awaiting_approval",
        telegramPlanMessage: { chatId: 9, messageId: 10 },
      }),
    ];

    const edit = vi.fn(async () => ({ text: "plan" }));
    const answer = vi.fn(async () => "answer");
    const sendPlanResult = vi.fn(async () => {});

    await handleTelegramGoalRouting({
      chatId: 9,
      threadId: undefined,
      messageText: "approve",
      replyToMessageId: undefined,
      runs,
      chatMode: "chat",
      sendReply: vi.fn(async () => {}),
      sendPlanResult,
      runHandlers: { edit, answer },
    });

    expect(edit).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
    expect(sendPlanResult).not.toHaveBeenCalled();
  });

  // ---- Reply routing (GOAL_ANSWER, GOAL_EDIT) ----

  it("routes reply to question message to GOAL_ANSWER", async () => {
    const runs = [
      makeRun({
        runId: "r1",
        state: "blocked",
        blocked: { prompt: "What DB?", requiredInputKey: "db_type" },
        telegramPlanMessage: { chatId: 9, messageId: 10 },
        telegramQuestionMessages: [{ chatId: 9, messageId: 20, requiredInputKey: "db_type" }],
      }),
    ];

    const sendReply = vi.fn(async () => {});
    const sendPlanResult = vi.fn(async () => {});
    const answer = vi.fn(async () => "answer saved");

    const handled = await handleTelegramGoalRouting({
      chatId: 9,
      threadId: undefined,
      messageText: "postgres",
      replyToMessageId: 20,
      runs,
      chatMode: "chat",
      sendReply,
      sendPlanResult,
      runHandlers: {
        edit: vi.fn(async () => ({ text: "plan" })),
        answer,
      },
    });

    expect(handled).toBe(true);
    expect(answer).toHaveBeenCalledWith("r1", "postgres");
    expect(sendReply).toHaveBeenCalledWith("answer saved");
  });

  it("routes reply to plan message to GOAL_EDIT", async () => {
    const runs = [
      makeRun({
        runId: "r1",
        state: "awaiting_approval",
        telegramPlanMessage: { chatId: 9, messageId: 10 },
      }),
    ];

    const sendReply = vi.fn(async () => {});
    const sendPlanResult = vi.fn(async () => {});
    const edit = vi.fn(async () => ({ text: "revised plan", runId: "r1", revision: 2 }));

    const handled = await handleTelegramGoalRouting({
      chatId: 9,
      threadId: undefined,
      messageText: "change step 1",
      replyToMessageId: 10,
      runs,
      chatMode: "chat",
      sendReply,
      sendPlanResult,
      runHandlers: {
        edit,
        answer: vi.fn(async () => "answer"),
      },
    });

    expect(handled).toBe(true);
    expect(edit).toHaveBeenCalledWith("r1", "change step 1");
    expect(sendPlanResult).toHaveBeenCalled();
  });

  // ---- Goal query intents (A, B) ----

  it("handles goal query 'list goals' directly", async () => {
    const sendReply = vi.fn(async () => {});
    const sendPlanResult = vi.fn(async () => {});

    const handled = await handleTelegramGoalRouting({
      chatId: 9,
      threadId: undefined,
      messageText: "list goals",
      replyToMessageId: undefined,
      runs: [],
      chatMode: "chat",
      sendReply,
      sendPlanResult,
      runHandlers: {
        edit: vi.fn(async () => ({ text: "plan" })),
        answer: vi.fn(async () => "answer"),
      },
    });

    expect(handled).toBe(true);
    expect(sendReply).toHaveBeenCalled();
  });

  it("'recent goals' is handled locally", async () => {
    const sendReply = vi.fn(async () => {});

    const handled = await handleTelegramGoalRouting({
      chatId: 9,
      threadId: undefined,
      messageText: "recent goals",
      replyToMessageId: undefined,
      runs: [],
      chatMode: "chat",
      sendReply,
      sendPlanResult: vi.fn(async () => {}),
      runHandlers: {
        edit: vi.fn(async () => ({ text: "plan" })),
        answer: vi.fn(async () => "answer"),
      },
    });

    expect(handled).toBe(true);
    expect(sendReply).toHaveBeenCalled();
  });

  it("'what goals have been run' is handled locally", async () => {
    const sendReply = vi.fn(async () => {});

    const handled = await handleTelegramGoalRouting({
      chatId: 9,
      threadId: undefined,
      messageText: "what goals have been run",
      replyToMessageId: undefined,
      runs: [],
      chatMode: "chat",
      sendReply,
      sendPlanResult: vi.fn(async () => {}),
      runHandlers: {
        edit: vi.fn(async () => ({ text: "plan" })),
        answer: vi.fn(async () => "answer"),
      },
    });

    expect(handled).toBe(true);
    expect(sendReply).toHaveBeenCalled();
  });

  // ---- Chat mode: non-goal text falls through to LLM ----

  it("chat mode: non-goal text falls through (handled=false)", async () => {
    const sendReply = vi.fn(async () => {});
    const sendPlanResult = vi.fn(async () => {});

    const handled = await handleTelegramGoalRouting({
      chatId: 9,
      threadId: undefined,
      messageText: "what is the weather like today",
      replyToMessageId: undefined,
      runs: [],
      chatMode: "chat",
      sendReply,
      sendPlanResult,
      runHandlers: {
        edit: vi.fn(async () => ({ text: "plan" })),
        answer: vi.fn(async () => "answer"),
      },
    });

    expect(handled).toBe(false);
    expect(sendReply).not.toHaveBeenCalled();
    expect(sendPlanResult).not.toHaveBeenCalled();
  });

  it("chat mode: sends blocked-run hint and falls through", async () => {
    const runs = [
      makeRun({
        runId: "r1",
        state: "blocked",
        blocked: { prompt: "Need input", requiredInputKey: "input_key" },
        telegramPlanMessage: { chatId: 9, messageId: 10 },
      }),
    ];

    const sendReply = vi.fn(async () => {});
    const sendPlanResult = vi.fn(async () => {});

    const handled = await handleTelegramGoalRouting({
      chatId: 9,
      threadId: undefined,
      messageText: "some text",
      replyToMessageId: undefined,
      runs,
      chatMode: "chat",
      sendReply,
      sendPlanResult,
      runHandlers: {
        edit: vi.fn(async () => ({ text: "plan" })),
        answer: vi.fn(async () => "answer"),
      },
    });

    expect(handled).toBe(false);
    expect(sendReply).toHaveBeenCalledWith(expect.stringContaining("/goal_answer"));
  });

  // ---- Help mode: non-goal text returns fallback help (never calls LLM) ----

  it("help mode: non-goal text returns help message (handled=true)", async () => {
    const sendReply = vi.fn(async () => {});
    const sendPlanResult = vi.fn(async () => {});

    const handled = await handleTelegramGoalRouting({
      chatId: 9,
      threadId: undefined,
      messageText: "what is the weather like today",
      replyToMessageId: undefined,
      runs: [],
      chatMode: "help",
      sendReply,
      sendPlanResult,
      runHandlers: {
        edit: vi.fn(async () => ({ text: "plan" })),
        answer: vi.fn(async () => "answer"),
      },
    });

    expect(handled).toBe(true);
    expect(sendReply).toHaveBeenCalledWith(expect.stringContaining("/new_goal"));
    expect(sendPlanResult).not.toHaveBeenCalled();
  });

  it("help mode: blocked-run hint then help message", async () => {
    const runs = [
      makeRun({
        runId: "r1",
        state: "blocked",
        blocked: { prompt: "Need input", requiredInputKey: "input_key" },
        telegramPlanMessage: { chatId: 9, messageId: 10 },
      }),
    ];

    const sendReply = vi.fn(async () => {});

    const handled = await handleTelegramGoalRouting({
      chatId: 9,
      threadId: undefined,
      messageText: "some text",
      replyToMessageId: undefined,
      runs,
      chatMode: "help",
      sendReply,
      sendPlanResult: vi.fn(async () => {}),
      runHandlers: {
        edit: vi.fn(async () => ({ text: "plan" })),
        answer: vi.fn(async () => "answer"),
      },
    });

    expect(handled).toBe(true);
    // Should get both the hint and the help message
    expect(sendReply).toHaveBeenCalledWith(expect.stringContaining("/goal_answer"));
    expect(sendReply).toHaveBeenCalledWith(expect.stringContaining("/new_goal"));
  });

  it("help mode: goal intents still handled locally", async () => {
    const sendReply = vi.fn(async () => {});

    const handled = await handleTelegramGoalRouting({
      chatId: 9,
      threadId: undefined,
      messageText: "list goals",
      replyToMessageId: undefined,
      runs: [],
      chatMode: "help",
      sendReply,
      sendPlanResult: vi.fn(async () => {}),
      runHandlers: {
        edit: vi.fn(async () => ({ text: "plan" })),
        answer: vi.fn(async () => "answer"),
      },
    });

    expect(handled).toBe(true);
    expect(sendReply).toHaveBeenCalled();
  });
});
