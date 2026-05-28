import { beforeEach, describe, expect, it, vi } from "vitest";

const buildTelegramMessageContext = vi.hoisted(() => vi.fn());
const dispatchTelegramMessage = vi.hoisted(() => vi.fn());
const mockStop = vi.hoisted(() => vi.fn());
const mockStartTypingLoop = vi.hoisted(() => vi.fn(() => ({ stop: mockStop })));

vi.mock("./bot-message-context.js", () => ({
  buildTelegramMessageContext,
}));

vi.mock("./bot-message-dispatch.js", () => ({
  dispatchTelegramMessage,
}));

vi.mock("./typing-loop.js", () => ({
  startTypingLoop: mockStartTypingLoop,
}));

import { createTelegramMessageProcessor } from "./bot-message.js";

describe("telegram bot message processor", () => {
  beforeEach(() => {
    buildTelegramMessageContext.mockReset();
    dispatchTelegramMessage.mockReset();
    mockStartTypingLoop.mockClear().mockReturnValue({ stop: mockStop });
    mockStop.mockClear();
  });

  const baseDeps = {
    bot: { the: "bot" },
    cfg: {},
    account: {},
    telegramCfg: {},
    historyLimit: 0,
    groupHistories: {},
    dmPolicy: {},
    allowFrom: [],
    groupAllowFrom: [],
    ackReactionScope: "none",
    logger: {},
    resolveGroupActivation: () => true,
    resolveGroupRequireMention: () => false,
    resolveTelegramGroupConfig: () => ({}),
    runtime: {},
    replyToMode: "auto",
    streamMode: "auto",
    textLimit: 4096,
    opts: {},
    resolveBotTopicsEnabled: () => false,
  };

  it("dispatches when context is available", async () => {
    buildTelegramMessageContext.mockResolvedValue({ route: { sessionKey: "agent:main:main" } });

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processMessage({ message: { chat: { id: 123 }, message_id: 456 } }, [], [], {});

    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("skips dispatch when no context is produced", async () => {
    buildTelegramMessageContext.mockResolvedValue(null);
    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processMessage({ message: { chat: { id: 123 }, message_id: 456 } }, [], [], {});
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
  });

  it("starts typing loop before dispatch and stops after", async () => {
    buildTelegramMessageContext.mockResolvedValue({
      chatId: 42,
      resolvedThreadId: 7,
      route: { sessionKey: "agent:main:main" },
    });

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processMessage({ message: { chat: { id: 42 }, message_id: 1 } }, [], [], {});

    expect(mockStartTypingLoop).toHaveBeenCalledWith({
      bot: baseDeps.bot,
      chatId: 42,
      threadId: 7,
      label: "chat",
    });
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("does not start typing loop when context is null", async () => {
    buildTelegramMessageContext.mockResolvedValue(null);

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processMessage({ message: { chat: { id: 42 }, message_id: 1 } }, [], [], {});

    expect(mockStartTypingLoop).not.toHaveBeenCalled();
    expect(mockStop).not.toHaveBeenCalled();
  });

  it("stops typing loop even if dispatch throws", async () => {
    buildTelegramMessageContext.mockResolvedValue({
      chatId: 42,
      resolvedThreadId: undefined,
      route: { sessionKey: "agent:main:main" },
    });
    dispatchTelegramMessage.mockRejectedValue(new Error("dispatch failed"));

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(
      processMessage({ message: { chat: { id: 42 }, message_id: 1 } }, [], [], {}),
    ).rejects.toThrow("dispatch failed");

    expect(mockStartTypingLoop).toHaveBeenCalledTimes(1);
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it("does not send planning preface in chat mode", async () => {
    const sendMessage = vi.fn();
    const botWithApi = { ...baseDeps.bot, api: { sendMessage } };
    buildTelegramMessageContext.mockResolvedValue({
      chatId: 42,
      resolvedThreadId: undefined,
      route: { sessionKey: "agent:main:main" },
    });

    const processMessage = createTelegramMessageProcessor({ ...baseDeps, bot: botWithApi });
    await processMessage({ message: { chat: { id: 42 }, message_id: 1 } }, [], [], {});

    // No "Right away, sir." preface in chat mode
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
