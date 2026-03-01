import { beforeEach, describe, expect, it, vi } from "vitest";

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

beforeEach(() => {
  vi.clearAllMocks();
  dispatchTelegramRepoChatForInboundTextMock.mockReturnValue(true);
  findRepoChatSessionByMessageIdMock.mockReturnValue(undefined);
  routeTelegramTextMock.mockReturnValue({ kind: "CHAT" });
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
});
