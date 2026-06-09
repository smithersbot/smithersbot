import { afterEach, describe, expect, it, vi } from "vitest";

const mockRuns = vi.hoisted(() => [] as SerializedRun[]);
const mockHandleGoalEdit = vi.hoisted(() => vi.fn());
const mockHandleGoalAnswer = vi.hoisted(() => vi.fn());
const mockHandleGoalFeedback = vi.hoisted(() => vi.fn());
const mockHandleGoalApprove = vi.hoisted(() => vi.fn());
const mockApplyGoalResumeNoteById = vi.hoisted(() => vi.fn());
const mockApplyContinuationEditReply = vi.hoisted(() => vi.fn());

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
    handleGoalApprove: (...args: unknown[]) => mockHandleGoalApprove(...args),
  };
});

vi.mock("../commands/goal-resume-note.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/goal-resume-note.js")>();
  return {
    ...actual,
    applyGoalResumeNoteById: (...args: unknown[]) => mockApplyGoalResumeNoteById(...args),
  };
});

vi.mock("./continuation-core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./continuation-core.js")>();
  return {
    ...actual,
    applyContinuationEditReply: (...args: unknown[]) => mockApplyContinuationEditReply(...args),
  };
});

import { handleTelegramGoalRouting, registerTelegramHandlers } from "./bot-handlers.js";
import { acquireGoalOpLock } from "../goal/goal-lock.js";
import type { SerializedRun } from "../goal/types.js";
import { COMMAND_FRAGMENT_MAX_GAP_MS, CommandFragmentBuffer } from "./command-fragments.js";
import {
  clearAllPendingContinuationEditInteractionsForTest,
  recordPendingContinuationEditInteraction,
} from "./continuation-edit-interactions.js";

const now = new Date().toISOString();

function makeRun(partial: Partial<SerializedRun>): SerializedRun {
  return {
    runId: partial.runId ?? "run-1",
    goal: "Test goal",
    state: partial.state ?? "awaiting_approval",
    plan: partial.plan ?? null,
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
    pendingContinuation: partial.pendingContinuation,
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
    expect(answer).toHaveBeenCalledWith("r1", "postgres", "direct_reply");
    // Result delivery is now fire-and-forget inside the handler
  });

  it("reply to a Paused (resume_execution) message routes to the unified resume-note path", async () => {
    const runs = [
      makeRun({
        runId: "paused1",
        state: "blocked",
        blocked: {
          blockedAt: "execution",
          prompt: "worker hit a provider limit; resume needed",
          requiredInputKey: "resume_execution",
        },
        telegramQuestionMessages: [
          { chatId: 9, messageId: 25, requiredInputKey: "resume_execution" },
        ],
      }),
    ];

    const sendReply = vi.fn(async () => {});
    const answer = vi.fn();

    const handled = await handleTelegramGoalRouting({
      chatId: 9,
      threadId: undefined,
      messageText: "please continue",
      replyToMessageId: 25,
      runs,
      chatMode: "chat",
      sendReply,
      sendPlanResult: vi.fn(async () => {}),
      runHandlers: { edit: vi.fn(), answer },
    });

    expect(handled).toBe(true);
    expect(answer).toHaveBeenCalledWith("paused1", "please continue", "direct_reply");
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("reply to a tracked but unusable goal message is handled (never falls through)", async () => {
    const runs = [
      makeRun({
        runId: "done1",
        state: "done",
        telegramQuestionMessages: [{ chatId: 9, messageId: 26 }],
      }),
    ];

    const sendReply = vi.fn(async () => {});
    const answer = vi.fn();

    const handled = await handleTelegramGoalRouting({
      chatId: 9,
      threadId: undefined,
      messageText: "foo",
      replyToMessageId: 26,
      runs,
      chatMode: "chat",
      sendReply,
      sendPlanResult: vi.fn(async () => {}),
      runHandlers: { edit: vi.fn(), answer },
    });

    expect(handled).toBe(true);
    expect(answer).not.toHaveBeenCalled();
    expect(sendReply).toHaveBeenCalledWith(expect.stringContaining("currently done"));
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
  function makeBotHarness(
    options: { commandFragmentBuffer?: CommandFragmentBuffer; operatorHonorific?: string } = {},
  ) {
    mockHandleGoalEdit.mockReset();
    mockHandleGoalAnswer.mockReset();
    mockHandleGoalFeedback.mockReset();
    mockHandleGoalApprove.mockReset();
    mockApplyGoalResumeNoteById.mockReset();
    mockApplyContinuationEditReply.mockReset();
    mockApplyGoalResumeNoteById.mockReturnValue({
      status: "applied",
      message: "Got it. Added those details and am resuming the goal now.",
      rescheduledStepIds: ["task-a"],
    });
    mockHandleGoalApprove.mockResolvedValue(
      "Executing: add-detai (0/1). I'll notify you if input is needed.",
    );

    const messageHandlers = new Map<string, (ctx: Record<string, unknown>) => Promise<void>>();
    const processMessage = vi.fn(async () => undefined);
    const bot = {
      on: vi.fn((event: string, handler: (ctx: Record<string, unknown>) => Promise<void>) => {
        messageHandlers.set(event, handler);
      }),
      api: {
        sendMessage: vi.fn(async () => ({ message_id: 999 })),
        sendChatAction: vi.fn(async () => undefined),
        setMessageReaction: vi.fn(async () => true),
      },
    };

    registerTelegramHandlers({
      cfg: {
        goal: { claudeCodeAuth: "api_key" },
        agents: options.operatorHonorific
          ? { defaults: { identity: { operatorHonorific: options.operatorHonorific } } }
          : undefined,
      },
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
      processMessage,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      } as never,
      commandFragmentBuffer: options.commandFragmentBuffer,
    });

    const messageHandler = messageHandlers.get("message");
    expect(messageHandler).toBeTypeOf("function");
    if (!messageHandler) throw new Error("Expected message handler");
    return { bot, messageHandler, processMessage };
  }

  afterEach(() => {
    clearAllPendingContinuationEditInteractionsForTest();
    vi.useRealTimers();
  });

  async function routeText(params: {
    text: string;
    messageId: number;
    replyToMessageId?: number;
    runs?: SerializedRun[];
    operatorHonorific?: string;
    commandFragmentBuffer?: CommandFragmentBuffer;
  }) {
    mockRuns.length = 0;
    mockRuns.push(...(params.runs ?? []));
    const harness = makeBotHarness({
      operatorHonorific: params.operatorHonorific,
      commandFragmentBuffer: params.commandFragmentBuffer,
    });
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

  it("records direct replies as goal-level resume notes and resumes without using handleGoalAnswer", async () => {
    const run = makeRun({
      runId: "direct-reply-run",
      state: "blocked",
      blocked: {
        blockedAt: "execution",
        prompt: "Need input",
        requiredInputKey: "task-b:input",
      },
      telegramQuestionMessages: [{ chatId: 42, messageId: 420, requiredInputKey: "task-a:input" }],
    });

    const { bot } = await routeText({
      text: "use postgres for both",
      messageId: 704,
      replyToMessageId: 420,
      runs: [run],
    });

    expect(mockApplyGoalResumeNoteById).toHaveBeenCalledWith({
      runId: "direct-reply-run",
      source: "direct_reply",
      userText: "use postgres for both",
    });
    await vi.waitFor(() => expect(mockHandleGoalApprove).toHaveBeenCalledTimes(1));
    expect(mockHandleGoalApprove).toHaveBeenCalledWith(
      "direct-reply-run",
      expect.any(Function),
      expect.any(Object),
    );
    expect(mockHandleGoalAnswer).not.toHaveBeenCalled();
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      42,
      "Right away, sir. Resuming the goal now.",
      expect.objectContaining({
        reply_parameters: { message_id: 704 },
      }),
    );
  });

  it("records Add Details prompt replies with the add_details source and resumes", async () => {
    const run = makeRun({
      runId: "add-details-run",
      state: "blocked",
      blocked: {
        blockedAt: "execution",
        prompt: "Need input",
        requiredInputKey: "tasks:task-a,task-b:input",
      },
      telegramQuestionMessages: [{ chatId: 42, messageId: 421, requiredInputKey: "add_details" }],
    });

    const { bot } = await routeText({
      text: "the fix is ready",
      messageId: 705,
      replyToMessageId: 421,
      runs: [run],
    });

    expect(mockApplyGoalResumeNoteById).toHaveBeenCalledWith({
      runId: "add-details-run",
      source: "add_details",
      userText: "the fix is ready",
    });
    await vi.waitFor(() => expect(mockHandleGoalApprove).toHaveBeenCalledTimes(1));
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      42,
      "Right away, sir. Resuming the goal now.",
      expect.objectContaining({
        reply_parameters: { message_id: 705 },
      }),
    );
  });

  it("routes Add Details prompt replies for planning Needs Decision blocks through handleGoalAnswer", async () => {
    const run = makeRun({
      runId: "planning-decision-run",
      state: "blocked",
      plan: null,
      blocked: {
        blockedAt: "planning",
        prompt: "Decision(s) needed",
        requiredInputKey: "step:planning:input",
      },
      telegramQuestionMessages: [{ chatId: 42, messageId: 424, requiredInputKey: "add_details" }],
    });
    mockHandleGoalAnswer.mockResolvedValue("Planning resumed.");

    const { bot } = await routeText({
      text: "A",
      messageId: 706,
      replyToMessageId: 424,
      runs: [run],
    });

    await vi.waitFor(() => expect(mockHandleGoalAnswer).toHaveBeenCalledTimes(1));
    expect(mockHandleGoalAnswer).toHaveBeenCalledWith(
      "planning-decision-run",
      "A",
      expect.any(Function),
      expect.any(Object),
    );
    expect(mockApplyGoalResumeNoteById).not.toHaveBeenCalled();
    const sentText = bot.api.sendMessage.mock.calls.map((call) => String(call[1])).join("\n");
    expect(sentText).not.toContain(
      "No blocked, paused, or failed steps need input/resume right now.",
    );
  });

  it("Add Details on a run-level resume_execution marker records the note and resumes", async () => {
    const run = makeRun({
      runId: "add-details-run-level",
      state: "blocked",
      blocked: {
        blockedAt: "execution",
        prompt: "worker interrupted - resume needed",
        requiredInputKey: "resume_execution",
      },
      plan: {
        goal: "Resume interrupted goal",
        workingDir: "/tmp",
        summary: "Resume interrupted goal",
        steps: [
          {
            id: "resume-work",
            description: "Resume work",
            dependsOn: [],
            status: "pending",
          },
        ],
      },
      telegramQuestionMessages: [{ chatId: 42, messageId: 423, requiredInputKey: "add_details" }],
    });
    mockApplyGoalResumeNoteById.mockReturnValueOnce({
      status: "applied",
      message: "Got it. Added those details and am resuming the goal now.",
      rescheduledStepIds: [],
    });

    const { bot } = await routeText({
      text: "the external issue is fixed",
      messageId: 707,
      replyToMessageId: 423,
      runs: [run],
    });

    await vi.waitFor(() => expect(mockHandleGoalApprove).toHaveBeenCalledTimes(1));
    expect(mockApplyGoalResumeNoteById).toHaveBeenCalledWith({
      runId: "add-details-run-level",
      source: "add_details",
      userText: "the external issue is fixed",
    });
    expect(mockHandleGoalApprove).toHaveBeenCalledWith(
      "add-details-run-level",
      expect.any(Function),
      expect.any(Object),
    );
    const sentText = bot.api.sendMessage.mock.calls.map((call) => String(call[1])).join("\n");
    expect(sentText).toContain("Right away, sir. Resuming the goal now.");
    expect(sentText).not.toContain("rescheduled");
  });

  it("acknowledges Request Edit replies, reacts, types, and preserves continuation buttons", async () => {
    const replyMarkup = {
      inline_keyboard: [
        [{ text: "✅ Continue Goal", callback_data: "gca:continue:proposal" }],
        [{ text: "📝 Request Edit", callback_data: "gce:continue:proposal" }],
      ],
    };
    const run = makeRun({
      runId: "continuation-edit-run",
      state: "done",
      pendingContinuation: {
        proposalId: "proposal-1",
        fromPlanNumber: 1,
        goalAchieved: false,
        briefSummary: "Continue from the last plan.",
        proposedPrompt: "Draft the next plan.",
        runAt: "now",
        status: "pending",
        createdAt: now,
        notify: { chatId: 42, messageId: 500 },
      },
    });
    mockRuns.length = 0;
    mockRuns.push(run);
    const harness = makeBotHarness({ operatorHonorific: "Matthew" });
    mockApplyContinuationEditReply.mockResolvedValue({
      runId: "continuation-edit-run",
      state: "done",
      messages: [{ text: "Revised continuation surface", replyMarkup }],
    });

    await harness.messageHandler({
      message: {
        chat: { id: 42, type: "private" },
        from: { id: 99, username: "tester" },
        text: "Aim the continuation at paid customer discovery.",
        message_id: 708,
        reply_to_message: { message_id: 500 },
        date: 1,
      },
      me: { username: "moltbot_bot" },
      getFile: async () => ({}),
    });

    await vi.waitFor(() => expect(mockApplyContinuationEditReply).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(harness.bot.api.sendMessage).toHaveBeenCalledWith(
        42,
        "Revised continuation surface",
        expect.objectContaining({ reply_markup: replyMarkup }),
      ),
    );

    expect(mockApplyContinuationEditReply).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "continuation-edit-run",
        text: "Aim the continuation at paid customer discovery.",
      }),
    );
    expect(harness.bot.api.setMessageReaction).toHaveBeenCalledWith(42, 708, [
      { type: "emoji", emoji: "\u270D" },
    ]);
    expect(harness.bot.api.sendChatAction).toHaveBeenCalledWith(42, "typing");

    const sentTexts = harness.bot.api.sendMessage.mock.calls.map((call) => String(call[1]));
    expect(sentTexts.indexOf("Right away, Matthew.")).toBeGreaterThanOrEqual(0);
    expect(sentTexts.indexOf("Right away, Matthew.")).toBeLessThan(
      sentTexts.indexOf("Revised continuation surface"),
    );
    expect(harness.bot.api.sendMessage).toHaveBeenCalledWith(
      42,
      "Right away, Matthew.",
      expect.objectContaining({
        reply_parameters: { message_id: 708 },
      }),
    );
    expect(harness.bot.api.sendMessage).toHaveBeenCalledWith(
      42,
      "Revised continuation surface",
      expect.objectContaining({
        reply_markup: replyMarkup,
        reply_parameters: { message_id: 708 },
      }),
    );
  });

  it("does not route direct replies to tracked blocked messages into repo-chat", async () => {
    const run = makeRun({
      runId: "repo-chat-guard",
      state: "blocked",
      blocked: {
        blockedAt: "execution",
        prompt: "Need input",
        requiredInputKey: "input_key",
      },
      telegramQuestionMessages: [{ chatId: 42, messageId: 422, requiredInputKey: "input_key" }],
    });
    mockRuns.length = 0;
    mockRuns.push(run);
    const harness = makeBotHarness();
    harness.bot.api.sendMessage.mockClear();

    await harness.messageHandler({
      message: {
        chat: { id: 42, type: "private" },
        from: { id: 99, username: "tester" },
        text: "answer from reply",
        message_id: 706,
        reply_to_message: { message_id: 422 },
        date: 1,
      },
      me: { username: "moltbot_bot" },
      getFile: async () => ({}),
    });

    expect(mockApplyGoalResumeNoteById).toHaveBeenCalled();
    expect(mockHandleGoalAnswer).not.toHaveBeenCalled();
  });

  it("preserves answer notes without an extra message when the resume lock is already held", async () => {
    const run = makeRun({
      runId: "locked-answer",
      state: "blocked",
      blocked: {
        blockedAt: "execution",
        prompt: "Need input",
        requiredInputKey: "input_key",
      },
      telegramQuestionMessages: [{ chatId: 42, messageId: 420, requiredInputKey: "input_key" }],
    });
    const lock = acquireGoalOpLock(run.runId, "test");
    expect(lock.acquired).toBe(true);
    try {
      const { bot } = await routeText({
        text: "answer while locked",
        messageId: 705,
        replyToMessageId: 420,
        runs: [run],
      });

      expect(mockApplyGoalResumeNoteById).toHaveBeenCalledWith({
        runId: "locked-answer",
        source: "direct_reply",
        userText: "answer while locked",
      });
      expect(mockHandleGoalApprove).not.toHaveBeenCalled();
      const sentText = bot.api.sendMessage.mock.calls.map((call) => String(call[1])).join("\n");
      expect(sentText).not.toContain("locked");
      expect(sentText).not.toContain("did not start");
      expect(sentText).not.toContain("Use /goal_resume");
    } finally {
      if (lock.acquired) lock.release();
    }
  });

  it("threads lock-failed edit and feedback replies to the current message", async () => {
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

  it("buffers split feedback replies before acquiring the feedback lock", async () => {
    vi.useFakeTimers();
    mockHandleGoalFeedback.mockResolvedValue("Feedback incorporated");
    const run = makeRun({
      runId: "feedback-run",
      state: "done",
      telegramFeedbackPromptMessages: [{ chatId: 42, messageId: 430 }],
    });
    mockRuns.length = 0;
    mockRuns.push(run);
    const commandFragmentBuffer = new CommandFragmentBuffer(undefined, 3000, 60000);
    const harness = makeBotHarness({ commandFragmentBuffer });

    await harness.messageHandler({
      message: {
        chat: { id: 42, type: "private" },
        from: { id: 99, username: "tester" },
        text: "Fix G9 and ",
        message_id: 801,
        reply_to_message: { message_id: 430 },
        date: 1,
      },
      me: { username: "moltbot_bot" },
      getFile: async () => ({}),
    });
    expect(mockHandleGoalFeedback).not.toHaveBeenCalled();

    await harness.messageHandler({
      message: {
        chat: { id: 42, type: "private" },
        from: { id: 99, username: "tester" },
        text: "FULL_MULTIMESSAGE_FEEDBACK_SENTINEL_20260524_G9_G10_REPO_CHAT_GOAL_ANSWER_ADD_DETAILS",
        message_id: 802,
        reply_to_message: { message_id: 430 },
        date: 1,
      },
      me: { username: "moltbot_bot" },
      getFile: async () => ({}),
    });

    expect(
      harness.bot.api.sendMessage.mock.calls.some((call) =>
        String(call[1]).includes("Already being processed"),
      ),
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(COMMAND_FRAGMENT_MAX_GAP_MS + 1050);

    await vi.waitFor(() => {
      expect(mockHandleGoalFeedback).toHaveBeenCalledTimes(1);
    });
    expect(mockHandleGoalFeedback.mock.calls[0]?.[1]).toContain(
      "FULL_MULTIMESSAGE_FEEDBACK_SENTINEL_20260524_G9_G10_REPO_CHAT_GOAL_ANSWER_ADD_DETAILS",
    );
  });

  it("buffers split Request changes (GOAL_EDIT) replies before acquiring the edit lock", async () => {
    vi.useFakeTimers();
    mockHandleGoalEdit.mockResolvedValue("Plan updated");
    const run = makeRun({
      runId: "edit-buffer-run",
      state: "awaiting_approval",
      telegramPlanMessage: { chatId: 42, messageId: 410 },
    });
    mockRuns.length = 0;
    mockRuns.push(run);
    const commandFragmentBuffer = new CommandFragmentBuffer(undefined, 3000, 60000);
    const harness = makeBotHarness({ commandFragmentBuffer });

    await harness.messageHandler({
      message: {
        chat: { id: 42, type: "private" },
        from: { id: 99, username: "tester" },
        text: "Please change step 1 and ",
        message_id: 811,
        reply_to_message: { message_id: 410 },
        date: 1,
      },
      me: { username: "moltbot_bot" },
      getFile: async () => ({}),
    });
    expect(mockHandleGoalEdit).not.toHaveBeenCalled();

    await harness.messageHandler({
      message: {
        chat: { id: 42, type: "private" },
        from: { id: 99, username: "tester" },
        text: "SPLIT_EDIT_SENTINEL_combine_both_fragments_into_one_edit",
        message_id: 812,
        reply_to_message: { message_id: 410 },
        date: 1,
      },
      me: { username: "moltbot_bot" },
      getFile: async () => ({}),
    });

    // The edit lock must not be contended by the split fragment.
    expect(
      harness.bot.api.sendMessage.mock.calls.some((call) =>
        String(call[1]).toLowerCase().includes("already being processed"),
      ),
    ).toBe(false);

    await vi.advanceTimersByTimeAsync(COMMAND_FRAGMENT_MAX_GAP_MS + 1050);

    await vi.waitFor(() => {
      expect(mockHandleGoalEdit).toHaveBeenCalledTimes(1);
    });
    // Lock acquired exactly once, after buffering, with the combined edit text.
    expect(mockHandleGoalEdit.mock.calls[0]?.[1]).toBe(
      "Please change step 1 and SPLIT_EDIT_SENTINEL_combine_both_fragments_into_one_edit",
    );
  });

  it("appends a second Request changes fragment that lost its reply_to", async () => {
    vi.useFakeTimers();
    mockHandleGoalEdit.mockResolvedValue("Plan updated");
    const run = makeRun({
      runId: "edit-late-fragment-run",
      state: "awaiting_approval",
      telegramPlanMessage: { chatId: 42, messageId: 415 },
    });
    mockRuns.length = 0;
    mockRuns.push(run);
    const commandFragmentBuffer = new CommandFragmentBuffer(undefined, 3000, 60000);
    const harness = makeBotHarness({ commandFragmentBuffer });

    await harness.messageHandler({
      message: {
        chat: { id: 42, type: "private" },
        from: { id: 99, username: "tester" },
        text: "First edit chunk ",
        message_id: 820,
        reply_to_message: { message_id: 415 },
        date: 1,
      },
      me: { username: "moltbot_bot" },
      getFile: async () => ({}),
    });

    // Second fragment arrives WITHOUT reply_to (Telegram dropped reply threading on the tail).
    await harness.messageHandler({
      message: {
        chat: { id: 42, type: "private" },
        from: { id: 99, username: "tester" },
        text: "second chunk via global append",
        message_id: 821,
        date: 1,
      },
      me: { username: "moltbot_bot" },
      getFile: async () => ({}),
    });

    expect(mockHandleGoalEdit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(COMMAND_FRAGMENT_MAX_GAP_MS + 1050);
    await vi.waitFor(() => {
      expect(mockHandleGoalEdit).toHaveBeenCalledTimes(1);
    });
    expect(mockHandleGoalEdit.mock.calls[0]?.[1]).toBe(
      "First edit chunk second chunk via global append",
    );
  });

  it("joins split continuation Request Edit replies into one revision call", async () => {
    vi.useFakeTimers();
    const run = makeRun({
      runId: "continuation-edit-run",
      state: "done",
      pendingContinuation: {
        proposalId: "proposal-1",
        fromPlanNumber: 1,
        goalAchieved: false,
        briefSummary: "Continue from the last plan.",
        proposedPrompt: "Draft the next plan.",
        runAt: "now",
        status: "pending",
        createdAt: now,
        notify: { chatId: 42, messageId: 500 },
      },
    });
    mockRuns.length = 0;
    mockRuns.push(run);
    const commandFragmentBuffer = new CommandFragmentBuffer(undefined, COMMAND_FRAGMENT_MAX_GAP_MS);
    const harness = makeBotHarness({ commandFragmentBuffer });
    mockApplyContinuationEditReply.mockResolvedValue({
      runId: "continuation-edit-run",
      state: "done",
      messages: [{ text: "Revised continuation surface" }],
    });

    await harness.messageHandler({
      message: {
        chat: { id: 42, type: "private" },
        from: { id: 99, username: "tester" },
        text: "Aim the continuation at customer discovery ",
        message_id: 801,
        reply_to_message: { message_id: 500 },
        date: 1,
      },
      me: { username: "moltbot_bot" },
      getFile: async () => ({}),
    });
    await harness.messageHandler({
      message: {
        chat: { id: 42, type: "private" },
        from: { id: 99, username: "tester" },
        text: "and include pricing interviews.",
        message_id: 802,
        date: 1,
      },
      me: { username: "moltbot_bot" },
      getFile: async () => ({}),
    });

    expect(mockApplyContinuationEditReply).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(COMMAND_FRAGMENT_MAX_GAP_MS + 50);

    await vi.waitFor(() => expect(mockApplyContinuationEditReply).toHaveBeenCalledTimes(1));
    expect(mockApplyContinuationEditReply).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "continuation-edit-run",
        text: "Aim the continuation at customer discovery and include pricing interviews.",
      }),
    );
  });

  it("joins split active continuation Request Edit text when later chunks lose reply metadata", async () => {
    vi.useFakeTimers();
    const run = makeRun({
      runId: "continuation-edit-run",
      state: "done",
      pendingContinuation: {
        proposalId: "proposal-1",
        fromPlanNumber: 1,
        goalAchieved: false,
        briefSummary: "Continue from the last plan.",
        proposedPrompt: "Draft the next plan.",
        runAt: "now",
        status: "pending",
        createdAt: now,
        notify: { chatId: 42, messageId: 500 },
      },
    });
    mockRuns.length = 0;
    mockRuns.push(run);
    recordPendingContinuationEditInteraction({
      chatId: 42,
      senderId: "99",
      runId: "continuation-edit-run",
      originalMessageId: 499,
      promptMessageId: 500,
    });
    const commandFragmentBuffer = new CommandFragmentBuffer(undefined, COMMAND_FRAGMENT_MAX_GAP_MS);
    const harness = makeBotHarness({ commandFragmentBuffer });
    mockApplyContinuationEditReply.mockResolvedValue({
      runId: "continuation-edit-run",
      state: "done",
      messages: [{ text: "Revised continuation surface" }],
    });

    await harness.messageHandler({
      message: {
        chat: { id: 42, type: "private" },
        from: { id: 99, username: "tester" },
        text: "Part A: remove dev gateway prompts. ",
        message_id: 811,
        date: 1,
      },
      me: { username: "moltbot_bot" },
      getFile: async () => ({}),
    });
    await harness.messageHandler({
      message: {
        chat: { id: 42, type: "private" },
        from: { id: 99, username: "tester" },
        text: "Part B: update README without gateway mention.",
        message_id: 812,
        date: 1,
      },
      me: { username: "moltbot_bot" },
      getFile: async () => ({}),
    });

    expect(mockApplyContinuationEditReply).not.toHaveBeenCalled();
    expect(harness.processMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(COMMAND_FRAGMENT_MAX_GAP_MS + 50);

    await vi.waitFor(() => expect(mockApplyContinuationEditReply).toHaveBeenCalledTimes(1));
    expect(mockApplyContinuationEditReply).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "continuation-edit-run",
        text: "Part A: remove dev gateway prompts. Part B: update README without gateway mention.",
      }),
    );
    expect(harness.processMessage).not.toHaveBeenCalled();
  });
});
