import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatchTelegramRepoChatForInboundTextMock = vi.hoisted(() => vi.fn());
const findRepoChatSessionByMessageIdMock = vi.hoisted(() => vi.fn());
const routeTelegramTextMock = vi.hoisted(() => vi.fn());

vi.mock("./repo-chat-commands.js", () => ({
  dispatchTelegramRepoChatForInboundText: (...args: unknown[]) =>
    dispatchTelegramRepoChatForInboundTextMock(...args),
}));

vi.mock("../repo-chat/repo-chat-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repo-chat/repo-chat-store.js")>();
  return {
    ...actual,
    findRepoChatSessionByMessageId: (...args: unknown[]) =>
      findRepoChatSessionByMessageIdMock(...args),
  };
});

vi.mock("./goal-router.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./goal-router.js")>();
  return {
    ...actual,
    routeTelegramText: (...args: unknown[]) => routeTelegramTextMock(...args),
  };
});

import { registerTelegramHandlers, shouldRouteTelegramTextToRepoChat } from "./bot-handlers.js";
import { buildCommandFragmentKey, CommandFragmentBuffer } from "./command-fragments.js";

beforeEach(() => {
  vi.clearAllMocks();
  dispatchTelegramRepoChatForInboundTextMock.mockReturnValue(true);
  findRepoChatSessionByMessageIdMock.mockReturnValue(undefined);
  routeTelegramTextMock.mockReturnValue({ kind: "CHAT" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("shouldRouteTelegramTextToRepoChat", () => {
  it("routes non-reply text to repo chat when backend is codex", () => {
    expect(
      shouldRouteTelegramTextToRepoChat({
        repoChatBackend: "codex",
        replyToMessageId: undefined,
      }),
    ).toBe(true);
  });

  it("routes non-reply text to repo chat when backend is claude_code", () => {
    expect(
      shouldRouteTelegramTextToRepoChat({
        repoChatBackend: "claude_code",
        replyToMessageId: undefined,
      }),
    ).toBe(true);
  });

  it("helper does not route replies to repo chat", () => {
    expect(
      shouldRouteTelegramTextToRepoChat({
        repoChatBackend: "codex",
        replyToMessageId: 123,
      }),
    ).toBe(false);
  });

  it("does not route to repo chat when backend is disabled", () => {
    expect(
      shouldRouteTelegramTextToRepoChat({
        repoChatBackend: null,
        replyToMessageId: undefined,
      }),
    ).toBe(false);
  });

  it("does not route non-reply text to repo chat when a live command anchor exists", () => {
    const commandFragmentBuffer = new CommandFragmentBuffer();
    const commandKey = buildCommandFragmentKey({
      accountId: "telegram-account",
      chatId: 42,
      resolvedThreadId: 7,
      senderId: "99",
      commandName: "new_goal",
    });
    commandFragmentBuffer.setAnchor(commandKey, {
      commandName: "new_goal",
      anchoredAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      appendHandler: vi.fn(async () => undefined),
    });

    expect(
      shouldRouteTelegramTextToRepoChat({
        repoChatBackend: "codex",
        replyToMessageId: undefined,
        commandFragmentBuffer,
        accountId: "telegram-account",
        chatId: 42,
        threadId: 7,
        senderId: "99",
      }),
    ).toBe(false);
  });

  it("keeps existing non-reply repo-chat routing when no command anchor exists", () => {
    const commandFragmentBuffer = new CommandFragmentBuffer();

    expect(
      shouldRouteTelegramTextToRepoChat({
        repoChatBackend: "codex",
        replyToMessageId: undefined,
        commandFragmentBuffer,
        accountId: "telegram-account",
        chatId: 42,
        threadId: 7,
        senderId: "99",
      }),
    ).toBe(true);
  });
});

describe("registerTelegramHandlers repo-chat routing", () => {
  function makeRouteHarness(
    options: {
      commandFragmentBuffer?: CommandFragmentBuffer;
      repoChatBackend?: "codex" | "claude_code" | null;
    } = {},
  ) {
    const messageHandlers = new Map<string, (ctx: Record<string, unknown>) => Promise<void>>();
    const bot = {
      on: vi.fn((event: string, handler: (ctx: Record<string, unknown>) => Promise<void>) => {
        messageHandlers.set(event, handler);
      }),
      api: {
        answerCallbackQuery: vi.fn(async () => undefined),
        editMessageText: vi.fn(async () => ({ message_id: 1 })),
        sendMessage: vi.fn(async () => ({ message_id: 2 })),
        setMessageReaction: vi.fn(async () => undefined),
      },
    };

    registerTelegramHandlers({
      cfg: { goal: { claudeCodeAuth: "subscription" } },
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
        repoChatBackend: options.repoChatBackend ?? "claude_code",
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
      commandFragmentBuffer: options.commandFragmentBuffer,
    });

    const messageHandler = messageHandlers.get("message");
    expect(messageHandler).toBeTypeOf("function");
    if (!messageHandler) {
      throw new Error("Expected Telegram handlers to be registered");
    }
    return { bot, messageHandler };
  }

  function makeTextMessage(text: string, messageId: number, replyToMessageId?: number) {
    return {
      message: {
        chat: { id: 42, type: "private" },
        from: { id: 99, username: "tester" },
        text,
        message_id: messageId,
        date: 1,
        ...(replyToMessageId != null ? { reply_to_message: { message_id: replyToMessageId } } : {}),
      },
      me: { username: "moltbot_bot" },
      getFile: async () => ({}),
    };
  }

  async function setupCommandAnchorCallbackTest(params?: {
    expiresAtMs?: number;
    appendHandler?: (text: string) => Promise<void>;
  }) {
    const appendHandler = params?.appendHandler ?? vi.fn(async () => undefined);
    const commandFragmentBuffer = new CommandFragmentBuffer();
    const commandKey = buildCommandFragmentKey({
      accountId: "telegram-account",
      chatId: 42,
      resolvedThreadId: undefined,
      senderId: "99",
      commandName: "new_goal",
    });
    commandFragmentBuffer.setAnchor(commandKey, {
      commandName: "new_goal",
      anchoredAtMs: Date.now(),
      expiresAtMs: params?.expiresAtMs ?? Date.now() + 60_000,
      appendHandler,
    });

    const handlers = new Map<string, (ctx: Record<string, unknown>) => Promise<void>>();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const bot = {
      on: vi.fn((event: string, handler: (ctx: Record<string, unknown>) => Promise<void>) => {
        handlers.set(event, handler);
      }),
      api: {
        answerCallbackQuery: vi.fn(async () => undefined),
        editMessageText: vi.fn(async () => ({ message_id: 1 })),
        sendMessage: vi.fn(async () => ({ message_id: 2 })),
        setMessageReaction: vi.fn(async () => undefined),
      },
    };

    registerTelegramHandlers({
      cfg: { goal: { claudeCodeAuth: "subscription" } },
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
        repoChatBackend: "claude_code",
        dmPolicy: "open",
        chatMode: "chat",
      } as never,
      allowFrom: [],
      groupAllowFrom: [],
      resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }),
      resolveTelegramGroupConfig: () => ({ groupConfig: undefined, topicConfig: undefined }),
      shouldSkipUpdate: () => false,
      processMessage: vi.fn(async () => undefined),
      logger: logger as never,
      commandFragmentBuffer,
    });

    const messageHandler = handlers.get("message");
    const callbackHandler = handlers.get("callback_query");
    expect(messageHandler).toBeTypeOf("function");
    expect(callbackHandler).toBeTypeOf("function");
    if (!messageHandler || !callbackHandler) {
      throw new Error("Expected Telegram handlers to be registered");
    }

    const pendingText = "follow-up text from the paste tail";
    await messageHandler({
      message: {
        chat: { id: 42, type: "private" },
        from: { id: 99, username: "tester" },
        text: pendingText,
        message_id: 501,
        date: 1,
      },
      me: { username: "moltbot_bot" },
      getFile: async () => ({}),
    });

    const sendCall = bot.api.sendMessage.mock.calls[0];
    const sendOptions = sendCall?.[2] as {
      reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    };
    const callbackData =
      sendOptions.reply_markup?.inline_keyboard
        ?.flat()
        .map((button) => button.callback_data)
        .filter((value): value is string => typeof value === "string") ?? [];
    expect(callbackData).toHaveLength(3);

    const invokeCallback = async (data: string, callbackId = `callback-${data}`) => {
      await callbackHandler({
        callbackQuery: {
          id: callbackId,
          data,
          from: { id: 99, username: "tester" },
          message: {
            chat: { id: 42, type: "private" },
            message_id: 777,
            date: 1,
          },
        },
      });
    };

    return {
      appendHandler,
      bot,
      callbackData,
      commandFragmentBuffer,
      commandKey,
      invokeCallback,
      pendingText,
    };
  }

  it("combines split free-text repo chat into one inbound dispatch", async () => {
    const commandFragmentBuffer = new CommandFragmentBuffer(undefined, 3000, 60000);
    const { messageHandler } = makeRouteHarness({ commandFragmentBuffer });

    await messageHandler(makeTextMessage("How does the repo-chat ", 900));
    await messageHandler(makeTextMessage("worker resume sessions?", 901));

    expect(dispatchTelegramRepoChatForInboundTextMock).not.toHaveBeenCalled();
    const key = buildCommandFragmentKey({
      accountId: "telegram-account",
      chatId: 42,
      resolvedThreadId: undefined,
      senderId: "99",
      commandName: "repo_chat",
    });
    await commandFragmentBuffer.cancelAndFlush(key);

    expect(dispatchTelegramRepoChatForInboundTextMock).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramRepoChatForInboundTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 42,
        prompt: "How does the repo-chat worker resume sessions?",
        sourceMessageId: 900,
        replyToMessageId: undefined,
      }),
    );
  });

  it("combines split replies to known repo-chat sessions before dispatch", async () => {
    findRepoChatSessionByMessageIdMock.mockReturnValue({ id: "repo-chat-session" });
    const commandFragmentBuffer = new CommandFragmentBuffer(undefined, 3000, 60000);
    const { messageHandler } = makeRouteHarness({ commandFragmentBuffer });

    await messageHandler(makeTextMessage("Follow up with first ", 910, 400));
    await messageHandler(makeTextMessage("and second chunk", 911, 400));

    expect(dispatchTelegramRepoChatForInboundTextMock).not.toHaveBeenCalled();
    const key = buildCommandFragmentKey({
      accountId: "telegram-account",
      chatId: 42,
      resolvedThreadId: undefined,
      senderId: "99",
      commandName: "repo_chat",
      replyToMessageId: 400,
    });
    await commandFragmentBuffer.cancelAndFlush(key);

    expect(dispatchTelegramRepoChatForInboundTextMock).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramRepoChatForInboundTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 42,
        prompt: "Follow up with first and second chunk",
        sourceMessageId: 910,
        replyToMessageId: 400,
      }),
    );
  });

  it("buffers split Add Details replies and answers with the combined text once", async () => {
    const goalCommands = await import("./goal-commands.js");
    const handlerSpy = vi
      .spyOn(goalCommands, "handleGoalAnswer")
      .mockResolvedValue("Resuming: run-1234..." as never);
    const runGoalInBackgroundSpy = vi
      .spyOn(goalCommands, "runGoalInBackground")
      .mockImplementation((params) => {
        void (async () => {
          try {
            await params.fn();
          } finally {
            params.releaseGoalLock?.();
          }
        })();
      });
    routeTelegramTextMock.mockReturnValue({ kind: "GOAL_ANSWER", runId: "run-1234" });
    const commandFragmentBuffer = new CommandFragmentBuffer(undefined, 3000, 60000);
    const { messageHandler } = makeRouteHarness({
      commandFragmentBuffer,
      repoChatBackend: null,
    });

    await messageHandler(makeTextMessage("The decisive ", 920, 400));
    await messageHandler(makeTextMessage("unblock token is postgres", 921, 400));

    expect(runGoalInBackgroundSpy).not.toHaveBeenCalled();
    const key = buildCommandFragmentKey({
      accountId: "telegram-account",
      chatId: 42,
      resolvedThreadId: undefined,
      senderId: "99",
      commandName: "goal_answer",
      runId: "run-1234",
      replyToMessageId: 400,
    });
    await commandFragmentBuffer.cancelAndFlush(key);

    await vi.waitFor(() => expect(handlerSpy).toHaveBeenCalledTimes(1));
    expect(handlerSpy).toHaveBeenCalledWith(
      "run-1234",
      "The decisive unblock token is postgres",
      expect.any(Function),
      expect.anything(),
    );
  });

  it("routes replies to known repo-chat sessions directly without goal routing", async () => {
    findRepoChatSessionByMessageIdMock.mockReturnValue({ id: "repo-chat-session" });

    const messageHandlers = new Map<string, (ctx: Record<string, unknown>) => Promise<void>>();
    const bot = {
      on: vi.fn((event: string, handler: (ctx: Record<string, unknown>) => Promise<void>) => {
        messageHandlers.set(event, handler);
      }),
      api: {
        answerCallbackQuery: vi.fn(async () => undefined),
        editMessageText: vi.fn(async () => ({ message_id: 1 })),
        sendMessage: vi.fn(async () => ({ message_id: 2 })),
        setMessageReaction: vi.fn(async () => undefined),
      },
    };

    registerTelegramHandlers({
      cfg: { goal: { claudeCodeAuth: "subscription" } },
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
        repoChatBackend: "claude_code",
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
    if (!messageHandler) {
      throw new Error("Expected Telegram message handler to be registered");
    }

    await messageHandler({
      message: {
        chat: { id: 42, type: "private" },
        from: { id: 99, username: "tester" },
        text: "follow up question",
        message_id: 500,
        date: 1,
        reply_to_message: { message_id: 400 },
      },
      me: { username: "moltbot_bot" },
      getFile: async () => ({}),
    });

    expect(findRepoChatSessionByMessageIdMock).toHaveBeenCalledWith({
      chatId: 42,
      messageId: 400,
    });
    expect(dispatchTelegramRepoChatForInboundTextMock).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramRepoChatForInboundTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 42,
        prompt: "follow up question",
        sourceMessageId: 500,
        replyToMessageId: 400,
        claudeCodeAuth: "subscription",
      }),
    );
    expect(routeTelegramTextMock).not.toHaveBeenCalled();
  });

  it("routes replies to known repo-chat sessions before pending command-fragment append", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    findRepoChatSessionByMessageIdMock.mockReturnValue({ id: "repo-chat-session" });
    const commandFragmentBuffer = new CommandFragmentBuffer();
    const commandKey = buildCommandFragmentKey({
      accountId: "telegram-account",
      chatId: 42,
      resolvedThreadId: undefined,
      senderId: "99",
      commandName: "repo_chat",
    });
    const pendingFlush = vi.fn(async () => undefined);
    commandFragmentBuffer.bufferCommand(commandKey, {
      commandName: "repo_chat",
      text: "pending split command",
      firstMessageId: 499,
      receivedAtMs: Date.now(),
      dispatch: {
        chatId: 42,
        senderId: "99",
        sourceMessageId: 499,
        accountId: "telegram-account",
      },
      flushCallback: pendingFlush,
    });

    const messageHandlers = new Map<string, (ctx: Record<string, unknown>) => Promise<void>>();
    const bot = {
      on: vi.fn((event: string, handler: (ctx: Record<string, unknown>) => Promise<void>) => {
        messageHandlers.set(event, handler);
      }),
      api: {
        answerCallbackQuery: vi.fn(async () => undefined),
        editMessageText: vi.fn(async () => ({ message_id: 1 })),
        sendMessage: vi.fn(async () => ({ message_id: 2 })),
        setMessageReaction: vi.fn(async () => undefined),
      },
    };

    registerTelegramHandlers({
      cfg: { goal: { claudeCodeAuth: "subscription" } },
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
        repoChatBackend: "claude_code",
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
      commandFragmentBuffer,
    });

    const messageHandler = messageHandlers.get("message");
    expect(messageHandler).toBeTypeOf("function");
    if (!messageHandler) {
      throw new Error("Expected Telegram message handler to be registered");
    }

    await messageHandler({
      message: {
        chat: { id: 42, type: "private" },
        from: { id: 99, username: "tester" },
        text: "reply should continue the repo-chat session",
        message_id: 500,
        date: 1,
        reply_to_message: { message_id: 400 },
      },
      me: { username: "moltbot_bot" },
      getFile: async () => ({}),
    });

    expect(dispatchTelegramRepoChatForInboundTextMock).not.toHaveBeenCalled();
    const replyKey = buildCommandFragmentKey({
      accountId: "telegram-account",
      chatId: 42,
      resolvedThreadId: undefined,
      senderId: "99",
      commandName: "repo_chat",
      replyToMessageId: 400,
    });
    await commandFragmentBuffer.cancelAndFlush(replyKey);
    expect(dispatchTelegramRepoChatForInboundTextMock).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramRepoChatForInboundTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 42,
        prompt: "reply should continue the repo-chat session",
        sourceMessageId: 500,
        replyToMessageId: 400,
      }),
    );
    expect(pendingFlush).not.toHaveBeenCalled();
    expect(commandFragmentBuffer.hasPending(commandKey)).toBe(true);
    vi.useRealTimers();
  });

  it("prompts for an explicit choice when a live command anchor blocks repo-chat routing", async () => {
    const commandFragmentBuffer = new CommandFragmentBuffer();
    const commandKey = buildCommandFragmentKey({
      accountId: "telegram-account",
      chatId: 42,
      resolvedThreadId: undefined,
      senderId: "99",
      commandName: "new_goal",
    });
    commandFragmentBuffer.setAnchor(commandKey, {
      commandName: "new_goal",
      anchoredAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      appendHandler: vi.fn(async () => undefined),
    });

    const messageHandlers = new Map<string, (ctx: Record<string, unknown>) => Promise<void>>();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const bot = {
      on: vi.fn((event: string, handler: (ctx: Record<string, unknown>) => Promise<void>) => {
        messageHandlers.set(event, handler);
      }),
      api: {
        answerCallbackQuery: vi.fn(async () => undefined),
        editMessageText: vi.fn(async () => ({ message_id: 1 })),
        sendMessage: vi.fn(async () => ({ message_id: 2 })),
        setMessageReaction: vi.fn(async () => undefined),
      },
    };

    registerTelegramHandlers({
      cfg: { goal: { claudeCodeAuth: "subscription" } },
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
        repoChatBackend: "claude_code",
        dmPolicy: "open",
        chatMode: "chat",
      } as never,
      allowFrom: [],
      groupAllowFrom: [],
      resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }),
      resolveTelegramGroupConfig: () => ({ groupConfig: undefined, topicConfig: undefined }),
      shouldSkipUpdate: () => false,
      processMessage: vi.fn(async () => undefined),
      logger: logger as never,
      commandFragmentBuffer,
    });

    const messageHandler = messageHandlers.get("message");
    expect(messageHandler).toBeTypeOf("function");
    if (!messageHandler) {
      throw new Error("Expected Telegram message handler to be registered");
    }

    await messageHandler({
      message: {
        chat: { id: 42, type: "private" },
        from: { id: 99, username: "tester" },
        text: "At minimum:\nmore goal details",
        message_id: 501,
        date: 1,
      },
      me: { username: "moltbot_bot" },
      getFile: async () => ({}),
    });

    expect(dispatchTelegramRepoChatForInboundTextMock).not.toHaveBeenCalled();
    expect(routeTelegramTextMock).not.toHaveBeenCalled();
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    const sendCall = bot.api.sendMessage.mock.calls[0];
    expect(sendCall?.[0]).toBe(42);
    expect(sendCall?.[1]).toContain("/new_goal");
    const sendOptions = sendCall?.[2] as {
      reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    };
    const callbackData =
      sendOptions.reply_markup?.inline_keyboard
        ?.flat()
        .map((button) => button.callback_data)
        .filter((value): value is string => typeof value === "string") ?? [];
    expect(callbackData).toHaveLength(3);
    expect(callbackData[0]).toMatch(/^cmd_anchor:append:[a-z0-9]{1,8}$/);
    expect(callbackData[1]).toMatch(/^cmd_anchor:new:[a-z0-9]{1,8}$/);
    expect(callbackData[2]).toMatch(/^cmd_anchor:ignore:[a-z0-9]{1,8}$/);
    const ids = callbackData.map((value) => value.split(":").at(-1));
    expect(new Set(ids).size).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(
      { key: commandKey, commandName: "new_goal", choice: "prompted" },
      "telegram command anchor surfaced follow-up",
    );
  });

  it.each([
    {
      routeKind: "GOAL_EDIT",
      label: "goal-router:edit",
      handlerName: "handleGoalEdit",
    },
    {
      routeKind: "GOAL_ANSWER",
      label: "goal-router:answer",
      handlerName: "handleGoalAnswer",
    },
    {
      routeKind: "GOAL_FEEDBACK",
      label: "goal-router:feedback",
      handlerName: "handleGoalFeedback",
    },
  ] as const)(
    "threads reply-to context through $routeKind router runs and result replies",
    async ({ routeKind, label, handlerName }) => {
      const goalCommands = await import("./goal-commands.js");
      const handlerSpy = vi
        .spyOn(goalCommands, handlerName)
        .mockResolvedValue("Resuming: run-1234..." as never);
      const runGoalInBackgroundSpy = vi
        .spyOn(goalCommands, "runGoalInBackground")
        .mockImplementation((params) => {
          void (async () => {
            try {
              await params.fn();
              await params.onResult?.("Router result");
            } finally {
              params.releaseGoalLock?.();
            }
          })();
        });

      routeTelegramTextMock.mockReturnValue({ kind: routeKind, runId: "run-1234" });

      const messageHandlers = new Map<string, (ctx: Record<string, unknown>) => Promise<void>>();
      const bot = {
        on: vi.fn((event: string, handler: (ctx: Record<string, unknown>) => Promise<void>) => {
          messageHandlers.set(event, handler);
        }),
        api: {
          answerCallbackQuery: vi.fn(async () => undefined),
          editMessageText: vi.fn(async () => ({ message_id: 1 })),
          sendMessage: vi.fn(async () => ({ message_id: 2 })),
          setMessageReaction: vi.fn(async () => undefined),
        },
      };

      const cfg = { goal: { claudeCodeAuth: "api_key" as const } };
      registerTelegramHandlers({
        cfg,
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
      if (!messageHandler) {
        throw new Error("Expected Telegram message handler to be registered");
      }

      await messageHandler({
        message: {
          chat: { id: 42, type: "private" },
          from: { id: 99, username: "tester" },
          text: "details from telegram",
          message_id: 501,
          reply_to_message: { message_id: 400 },
          date: 1,
        },
        me: { username: "moltbot_bot" },
        getFile: async () => ({}),
      });
      await vi.waitFor(() => expect(bot.api.sendMessage).toHaveBeenCalled());

      expect(runGoalInBackgroundSpy).toHaveBeenCalledTimes(1);
      expect(runGoalInBackgroundSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          label,
          replyToMessageId: 501,
        }),
      );
      expect(handlerSpy).toHaveBeenCalledWith(
        "run-1234",
        "details from telegram",
        ...(handlerName === "handleGoalEdit"
          ? [cfg]
          : handlerName === "handleGoalAnswer"
            ? [expect.any(Function), cfg]
            : [cfg, expect.any(Function)]),
      );
      expect(bot.api.sendMessage).toHaveBeenCalledWith(
        42,
        "Router result",
        expect.objectContaining({
          reply_parameters: { message_id: 501 },
        }),
      );
    },
  );

  it("appends command-anchor pending text and clears the pending callback", async () => {
    const appendHandler = vi.fn(async () => undefined);
    const { bot, callbackData, invokeCallback, pendingText } = await setupCommandAnchorCallbackTest(
      {
        appendHandler,
      },
    );
    const appendData = callbackData.find((data) => data.startsWith("cmd_anchor:append:"));
    expect(appendData).toBeTypeOf("string");
    if (!appendData) throw new Error("Expected append callback data");

    await invokeCallback(appendData);

    expect(bot.api.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(appendHandler).toHaveBeenCalledTimes(1);
    expect(appendHandler).toHaveBeenCalledWith(pendingText);
    expect(dispatchTelegramRepoChatForInboundTextMock).not.toHaveBeenCalled();

    await invokeCallback(appendData, "callback-repeat");
    expect(bot.api.answerCallbackQuery).toHaveBeenCalledTimes(2);
    expect(appendHandler).toHaveBeenCalledTimes(1);
    expect(bot.api.sendMessage).toHaveBeenLastCalledWith(
      42,
      "That follow-up expired. Send it again if you still want me to use it.",
      undefined,
    );
  });

  it("starts a new repo chat from command-anchor pending text and clears the anchor", async () => {
    const { bot, callbackData, commandFragmentBuffer, commandKey, invokeCallback, pendingText } =
      await setupCommandAnchorCallbackTest();
    const newData = callbackData.find((data) => data.startsWith("cmd_anchor:new:"));
    expect(newData).toBeTypeOf("string");
    if (!newData) throw new Error("Expected new-chat callback data");

    await invokeCallback(newData);

    expect(bot.api.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(commandFragmentBuffer.getAnchor(commandKey)).toBeUndefined();
    expect(dispatchTelegramRepoChatForInboundTextMock).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramRepoChatForInboundTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 42,
        prompt: pendingText,
        sourceMessageId: 777,
        replyToMessageId: undefined,
        claudeCodeAuth: "subscription",
      }),
    );

    await invokeCallback(newData, "callback-repeat");
    expect(bot.api.answerCallbackQuery).toHaveBeenCalledTimes(2);
    expect(dispatchTelegramRepoChatForInboundTextMock).toHaveBeenCalledTimes(1);
    expect(bot.api.sendMessage).toHaveBeenLastCalledWith(
      42,
      "That follow-up expired. Send it again if you still want me to use it.",
      undefined,
    );
  });

  it("ignores command-anchor pending text and clears it without dispatching", async () => {
    const { bot, callbackData, commandFragmentBuffer, commandKey, invokeCallback } =
      await setupCommandAnchorCallbackTest();
    const ignoreData = callbackData.find((data) => data.startsWith("cmd_anchor:ignore:"));
    expect(ignoreData).toBeTypeOf("string");
    if (!ignoreData) throw new Error("Expected ignore callback data");

    await invokeCallback(ignoreData);

    expect(bot.api.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(commandFragmentBuffer.getAnchor(commandKey)).toBeUndefined();
    expect(dispatchTelegramRepoChatForInboundTextMock).not.toHaveBeenCalled();

    await invokeCallback(ignoreData, "callback-repeat");
    expect(bot.api.answerCallbackQuery).toHaveBeenCalledTimes(2);
    expect(dispatchTelegramRepoChatForInboundTextMock).not.toHaveBeenCalled();
    expect(bot.api.sendMessage).toHaveBeenLastCalledWith(
      42,
      "That follow-up expired. Send it again if you still want me to use it.",
      undefined,
    );
  });

  it("dismisses expired command-anchor pending text without dispatching", async () => {
    vi.useFakeTimers();
    try {
      const { bot, callbackData, invokeCallback } = await setupCommandAnchorCallbackTest({
        expiresAtMs: Date.now() + 1_000,
      });
      const appendData = callbackData.find((data) => data.startsWith("cmd_anchor:append:"));
      expect(appendData).toBeTypeOf("string");
      if (!appendData) throw new Error("Expected append callback data");

      vi.setSystemTime(Date.now() + 2_000);
      await invokeCallback(appendData);

      expect(bot.api.answerCallbackQuery).toHaveBeenCalledTimes(1);
      expect(dispatchTelegramRepoChatForInboundTextMock).not.toHaveBeenCalled();
      expect(bot.api.sendMessage).toHaveBeenLastCalledWith(
        42,
        "That follow-up expired. Send it again if you still want me to use it.",
        undefined,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
