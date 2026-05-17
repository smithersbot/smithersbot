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

  it("prompts for an explicit choice when a live command anchor blocks repo-chat routing", async () => {
    const commandFragmentBuffer = new CommandFragmentBuffer();
    const commandKey = buildCommandFragmentKey({
      accountId: "telegram-account",
      chatId: 42,
      resolvedThreadId: undefined,
      senderId: "99",
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

  it("passes cfg to handleGoalAnswer for GOAL_ANSWER routes", async () => {
    const goalCommands = await import("./goal-commands.js");
    const handleGoalAnswerSpy = vi
      .spyOn(goalCommands, "handleGoalAnswer")
      .mockResolvedValue("Resuming: run-1234...");
    const runGoalInBackgroundSpy = vi
      .spyOn(goalCommands, "runGoalInBackground")
      .mockImplementation((params) => {
        void params.fn();
      });

    routeTelegramTextMock.mockReturnValue({ kind: "GOAL_ANSWER", runId: "run-1234" });

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
        date: 1,
      },
      me: { username: "moltbot_bot" },
      getFile: async () => ({}),
    });
    await Promise.resolve();

    expect(runGoalInBackgroundSpy).toHaveBeenCalledTimes(1);
    expect(handleGoalAnswerSpy).toHaveBeenCalledWith(
      "run-1234",
      "details from telegram",
      expect.any(Function),
      cfg,
    );
  });
});
