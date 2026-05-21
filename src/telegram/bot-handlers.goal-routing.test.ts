import { describe, expect, it, vi } from "vitest";

const mockRuns = vi.hoisted(() => [] as SerializedRun[]);
const mockHandleGoalEdit = vi.hoisted(() => vi.fn());
const mockHandleGoalAnswer = vi.hoisted(() => vi.fn());
const mockHandleGoalFeedback = vi.hoisted(() => vi.fn());

vi.mock("../goal/run-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../goal/run-store.js")>();
  return {
    ...actual,
    listRuns: () => mockRuns.map((run) => ({ runId: run.runId })),
    loadRun: (runId: string) => mockRuns.find((run) => run.runId === runId) ?? null,
  };
});

vi.mock("./goal-commands.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./goal-commands.js")>();
  return {
    ...actual,
    handleGoalEdit: (...args: unknown[]) => mockHandleGoalEdit(...args),
    handleGoalAnswer: (...args: unknown[]) => mockHandleGoalAnswer(...args),
    handleGoalFeedback: (...args: unknown[]) => mockHandleGoalFeedback(...args),
  };
});

import { handleTelegramGoalRouting, registerTelegramHandlers } from "./bot-handlers.js";
import { acquireGoalOpLock } from "../goal/goal-lock.js";
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
    telegramDoneMessage: partial.telegramDoneMessage,
    telegramFeedbackPromptMessages: partial.telegramFeedbackPromptMessages,
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
        edit: vi.fn(),
        answer: vi.fn(),
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
        edit: vi.fn(),
        answer: vi.fn(),
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
        edit: vi.fn(),
        answer: vi.fn(),
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
        edit: vi.fn(),
        answer: vi.fn(),
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
        blocked: {
          blockedAt: "execution",
          prompt: "What DB?",
          requiredInputKey: "db_type",
        },
        telegramPlanMessage: { chatId: 9, messageId: 10 },
        telegramQuestionMessages: [{ chatId: 9, messageId: 20, requiredInputKey: "db_type" }],
      }),
    ];

    const sendReply = vi.fn(async () => {});
    const sendPlanResult = vi.fn(async () => {});
    const answer = vi.fn();

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
        edit: vi.fn(),
        answer,
      },
    });

    expect(handled).toBe(true);
    expect(answer).toHaveBeenCalledWith("r1", "postgres");
    // Result delivery is now fire-and-forget inside the handler
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
    const edit = vi.fn();

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
        answer: vi.fn(),
      },
    });

    expect(handled).toBe(true);
    expect(edit).toHaveBeenCalledWith("r1", "change step 1");
    // Result delivery is now fire-and-forget inside the handler
  });

  it("routes reply to feedback prompt to GOAL_FEEDBACK", async () => {
    const runs = [
      makeRun({
        runId: "r1",
        state: "done",
        telegramPlanMessage: { chatId: 9, messageId: 10 },
        telegramFeedbackPromptMessages: [{ chatId: 9, messageId: 30 }],
      }),
    ];

    const feedback = vi.fn();

    const handled = await handleTelegramGoalRouting({
      chatId: 9,
      threadId: undefined,
      messageText: "Manual test failed on step 2",
      replyToMessageId: 30,
      runs,
      chatMode: "chat",
      sendReply: vi.fn(async () => {}),
      sendPlanResult: vi.fn(async () => {}),
      runHandlers: {
        edit: vi.fn(),
        answer: vi.fn(),
        feedback,
      },
    });

    expect(handled).toBe(true);
    expect(feedback).toHaveBeenCalledWith("r1", "Manual test failed on step 2");
  });

  it("routes reply to done message to GOAL_FEEDBACK", async () => {
    const runs = [
      makeRun({
        runId: "r1",
        state: "done",
        telegramDoneMessage: { chatId: 9, messageId: 35 },
      }),
    ];

    const feedback = vi.fn();

    const handled = await handleTelegramGoalRouting({
      chatId: 9,
      threadId: undefined,
      messageText: "Manual test failed on step 2",
      replyToMessageId: 35,
      runs,
      chatMode: "chat",
      sendReply: vi.fn(async () => {}),
      sendPlanResult: vi.fn(async () => {}),
      runHandlers: {
        edit: vi.fn(),
        answer: vi.fn(),
        feedback,
      },
    });

    expect(handled).toBe(true);
    expect(feedback).toHaveBeenCalledWith("r1", "Manual test failed on step 2");
  });

  // ---- Goal query intents (A) ----

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
        edit: vi.fn(),
        answer: vi.fn(),
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
        edit: vi.fn(),
        answer: vi.fn(),
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
        blocked: {
          blockedAt: "execution",
          prompt: "Need input",
          requiredInputKey: "input_key",
        },
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
        edit: vi.fn(),
        answer: vi.fn(),
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
        edit: vi.fn(),
        answer: vi.fn(),
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
        blocked: {
          blockedAt: "execution",
          prompt: "Need input",
          requiredInputKey: "input_key",
        },
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
        edit: vi.fn(),
        answer: vi.fn(),
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
        edit: vi.fn(),
        answer: vi.fn(),
      },
    });

    expect(handled).toBe(true);
    expect(sendReply).toHaveBeenCalled();
  });
});

describe("registerTelegramHandlers goal-router reply threading", () => {
  function makeBotHarness() {
    mockHandleGoalEdit.mockReset();
    mockHandleGoalAnswer.mockReset();
    mockHandleGoalFeedback.mockReset();

    const messageHandlers = new Map<string, (ctx: Record<string, unknown>) => Promise<void>>();
    const bot = {
      on: vi.fn((event: string, handler: (ctx: Record<string, unknown>) => Promise<void>) => {
        messageHandlers.set(event, handler);
      }),
      api: {
        sendMessage: vi.fn(async () => ({ message_id: 999 })),
        sendChatAction: vi.fn(async () => undefined),
      },
    };

    registerTelegramHandlers({
      cfg: { goal: { claudeCodeAuth: "api_key" } },
      accountId: "telegram-account",
      bot: bot as never,
      opts: { token: "token" },
      runtime: {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
      mediaMaxBytes: 8 * 1024 * 1024,
      telegramCfg: {
        repoChatBackend: null,
        dmPolicy: "open",
        chatMode: "chat",
      } as never,
      allowFrom: [],
      groupAllowFrom: [],
      resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }),
      resolveTelegramGroupConfig: () => ({ groupConfig: undefined, topicConfig: undefined }),
      shouldSkipUpdate: () => false,
      processMessage: vi.fn(async () => undefined),
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      } as never,
      commandFragmentBuffer: undefined,
    });

    const messageHandler = messageHandlers.get("message");
    expect(messageHandler).toBeTypeOf("function");
    if (!messageHandler) throw new Error("Expected message handler");
    return { bot, messageHandler };
  }

  async function routeText(params: {
    text: string;
    messageId: number;
    replyToMessageId?: number;
    runs?: SerializedRun[];
  }) {
    mockRuns.length = 0;
    mockRuns.push(...(params.runs ?? []));
    const harness = makeBotHarness();
    await harness.messageHandler({
      message: {
        chat: { id: 42, type: "private" },
        from: { id: 99, username: "tester" },
        text: params.text,
        message_id: params.messageId,
        reply_to_message:
          params.replyToMessageId != null ? { message_id: params.replyToMessageId } : undefined,
        date: 1,
      },
      me: { username: "moltbot_bot" },
      getFile: async () => ({}),
    });
    return harness;
  }

  function expectSendReplyToCurrentMessage(
    sendMessage: ReturnType<typeof vi.fn>,
    messageId: number,
  ) {
    expect(sendMessage).toHaveBeenCalledWith(
      42,
      expect.any(String),
      expect.objectContaining({
        reply_parameters: { message_id: messageId },
      }),
    );
  }

  it("threads natural-language status replies to the current message", async () => {
    const { bot } = await routeText({ text: "status abcdef12", messageId: 701 });

    expectSendReplyToCurrentMessage(bot.api.sendMessage, 701);
  });

  it("threads generic natural-language goal-router replies to the current message", async () => {
    const { bot } = await routeText({ text: "list goals", messageId: 702 });

    expectSendReplyToCurrentMessage(bot.api.sendMessage, 702);
  });

  it("threads goal-router edit preface and result sends to the current message", async () => {
    const run = makeRun({
      runId: "run-edit",
      state: "awaiting_approval",
      telegramPlanMessage: { chatId: 42, messageId: 400 },
    });
    mockHandleGoalEdit.mockResolvedValue({ text: "Router edit result" });

    const { bot } = await routeText({
      text: "tighten the plan",
      messageId: 703,
      replyToMessageId: 400,
      runs: [run],
    });

    await vi.waitFor(() => expect(mockHandleGoalEdit).toHaveBeenCalled());
    expectSendReplyToCurrentMessage(bot.api.sendMessage, 703);
    expect(bot.api.sendMessage).not.toHaveBeenCalledWith(
      42,
      expect.any(String),
      expect.objectContaining({
        reply_parameters: { message_id: 400 },
      }),
    );
  });

  it("threads lock-failed edit, answer, and feedback replies to the current message", async () => {
    for (const scenario of [
      {
        text: "edit while locked",
        messageId: 704,
        replyToMessageId: 410,
        run: makeRun({
          runId: "locked-edit",
          state: "awaiting_approval",
          telegramPlanMessage: { chatId: 42, messageId: 410 },
        }),
      },
      {
        text: "answer while locked",
        messageId: 705,
        replyToMessageId: 420,
        run: makeRun({
          runId: "locked-answer",
          state: "blocked",
          blocked: {
            blockedAt: "execution",
            prompt: "Need input",
            requiredInputKey: "input_key",
          },
          telegramQuestionMessages: [{ chatId: 42, messageId: 420, requiredInputKey: "input_key" }],
        }),
      },
      {
        text: "feedback while locked",
        messageId: 706,
        replyToMessageId: 430,
        run: makeRun({
          runId: "locked-feedback",
          state: "done",
          telegramFeedbackPromptMessages: [{ chatId: 42, messageId: 430 }],
        }),
      },
    ]) {
      const lock = acquireGoalOpLock(scenario.run.runId, "test");
      expect(lock.acquired).toBe(true);
      try {
        const { bot } = await routeText({
          text: scenario.text,
          messageId: scenario.messageId,
          replyToMessageId: scenario.replyToMessageId,
          runs: [scenario.run],
        });

        expectSendReplyToCurrentMessage(bot.api.sendMessage, scenario.messageId);
      } finally {
        if (lock.acquired) lock.release();
      }
    }
  });
});
