import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TelegramMessage } from "./bot/types.js";
import {
  buildCommandFragmentKey,
  clampCommandFragmentGapMs,
  COMMAND_FRAGMENT_MAX_CONFIGURED_GAP_MS,
  COMMAND_FRAGMENT_MAX_GAP_MS,
  COMMAND_FRAGMENT_MIN_GAP_MS,
  COMMAND_FRAGMENT_MAX_PARTS,
  COMMAND_FRAGMENT_MAX_TOTAL_CHARS,
  COMMAND_ANCHOR_TTL_MS,
  CommandFragmentBuffer,
  normalizeCommandFragmentParams,
} from "./command-fragments.js";

const resolveTelegramCommandAuthMock = vi.hoisted(() => vi.fn());
const goalCommandMock = vi.hoisted(() => vi.fn());
const runRepoChatWorkerMock = vi.hoisted(() => vi.fn());
const findRepoChatSessionByMessageIdMock = vi.hoisted(() => vi.fn());
const saveRepoChatSessionMock = vi.hoisted(() => vi.fn());

const useSpy = vi.hoisted(() => vi.fn());
const middlewareUseSpy = vi.hoisted(() => vi.fn());
const onSpy = vi.hoisted(() => vi.fn());
const commandSpy = vi.hoisted(() => vi.fn());
const stopSpy = vi.hoisted(() => vi.fn());

const sendMessageSpy = vi.hoisted(() => vi.fn(async () => ({ message_id: 500 })));
const sendPhotoSpy = vi.hoisted(() => vi.fn(async () => ({ message_id: 501 })));
const sendChatActionSpy = vi.hoisted(() => vi.fn(async () => true));
const answerCallbackQuerySpy = vi.hoisted(() => vi.fn(async () => undefined));
const setMessageReactionSpy = vi.hoisted(() => vi.fn(async () => undefined));
const editMessageTextSpy = vi.hoisted(() => vi.fn(async () => ({ message_id: 600 })));
const setMyCommandsSpy = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("grammy", () => ({
  Bot: class {
    api = {
      config: { use: useSpy },
      sendMessage: sendMessageSpy,
      sendPhoto: sendPhotoSpy,
      sendChatAction: sendChatActionSpy,
      answerCallbackQuery: answerCallbackQuerySpy,
      setMessageReaction: setMessageReactionSpy,
      editMessageText: editMessageTextSpy,
      setMyCommands: setMyCommandsSpy,
    };
    use = middlewareUseSpy;
    on = onSpy;
    command = commandSpy;
    stop = stopSpy;
    catch = vi.fn();
    constructor(public token: string) {}
  },
  InputFile: class {},
  webhookCallback: vi.fn(),
}));

vi.mock("@grammyjs/runner", () => ({
  sequentialize: () => vi.fn(),
}));

vi.mock("@grammyjs/transformer-throttler", () => ({
  apiThrottler: () => "throttler",
}));

vi.mock("./telegram-auth.js", () => ({
  resolveTelegramCommandAuth: (...args: unknown[]) => resolveTelegramCommandAuthMock(...args),
}));

vi.mock("../commands/goal.js", () => ({
  goalCommand: (...args: unknown[]) => goalCommandMock(...args),
}));

vi.mock("../repo-chat/repo-chat-worker.js", () => ({
  runRepoChatWorker: (...args: unknown[]) => runRepoChatWorkerMock(...args),
}));

vi.mock("../repo-chat/repo-chat-store.js", () => ({
  findRepoChatSessionByMessageId: (...args: unknown[]) =>
    findRepoChatSessionByMessageIdMock(...args),
  saveRepoChatSession: (...args: unknown[]) => saveRepoChatSessionMock(...args),
}));

vi.mock("./pairing-store.js", () => ({
  readTelegramAllowFromStore: vi.fn(async () => [] as string[]),
  upsertTelegramPairingRequest: vi.fn(async () => ({
    code: "PAIRCODE",
    created: true,
  })),
}));

vi.mock("../auto-reply/reply.js", () => ({
  getReplyFromConfig: vi.fn(async () => undefined),
}));

vi.mock("../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions.js")>();
  return {
    ...actual,
    updateLastRoute: vi.fn(async () => undefined),
  };
});

function makeTelegramMessage(params: {
  messageId: number;
  text?: string;
  chatId?: number;
  chatType?: "private" | "group" | "supergroup";
  messageThreadId?: number;
  isForum?: boolean;
  fromId?: number;
}): TelegramMessage {
  return {
    message_id: params.messageId,
    date: 1_736_380_800,
    text: params.text,
    chat: {
      id: params.chatId ?? 42,
      type: params.chatType ?? "private",
      is_forum: params.isForum,
    },
    from: { id: params.fromId ?? 7, username: "tester" },
    message_thread_id: params.messageThreadId,
  } as unknown as TelegramMessage;
}

function buildConfig(repoChatBackend: "codex" | "claude_code" | null = "codex") {
  return {
    channels: {
      telegram: {
        dmPolicy: "open",
        allowFrom: ["*"],
        repoChatBackend,
        goalRouter: true,
      },
    },
  };
}

function getOnHandler(event: string): (ctx: Record<string, unknown>) => Promise<void> {
  const call = onSpy.mock.calls.findLast((entry) => entry[0] === event);
  if (!call) throw new Error(`Missing on handler: ${event}`);
  return call[1] as (ctx: Record<string, unknown>) => Promise<void>;
}

function getCommandHandler(name: string): (ctx: Record<string, unknown>) => Promise<void> {
  for (const [registered, handler] of commandSpy.mock.calls) {
    if (Array.isArray(registered) && registered.includes(name)) {
      return handler as (ctx: Record<string, unknown>) => Promise<void>;
    }
    if (registered === name) {
      return handler as (ctx: Record<string, unknown>) => Promise<void>;
    }
  }
  throw new Error(`Missing command handler: ${name}`);
}

async function waitForAssertion(assertion: () => void, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

describe("command-fragments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveTelegramCommandAuthMock.mockImplementation(
      async ({ msg }: { msg: TelegramMessage }) => ({
        chatId: msg.chat.id,
        isGroup: msg.chat.type !== "private",
        isForum: (msg.chat as { is_forum?: boolean }).is_forum === true,
        resolvedThreadId:
          (msg.chat as { is_forum?: boolean }).is_forum === true
            ? ((msg as { message_thread_id?: number }).message_thread_id ?? 1)
            : undefined,
        senderId: String(msg.from?.id ?? "unknown"),
        senderUsername: msg.from?.username ?? "",
        commandAuthorized: true,
      }),
    );
    goalCommandMock.mockImplementation(
      async (opts: { goal: string }, runtime: { log: (...args: unknown[]) => void }) => {
        runtime.log(`goal:${opts.goal}`);
      },
    );
    runRepoChatWorkerMock.mockResolvedValue({ text: "repo response", cliSessionId: "session-1" });
    findRepoChatSessionByMessageIdMock.mockReturnValue(undefined);
    saveRepoChatSessionMock.mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("helpers", () => {
    it("builds deterministic keys", () => {
      const key1 = buildCommandFragmentKey({
        accountId: "default",
        chatId: 42,
        resolvedThreadId: undefined,
        senderId: "7",
      });
      const key2 = buildCommandFragmentKey({
        accountId: "default",
        chatId: 42,
        resolvedThreadId: undefined,
        senderId: "7",
      });
      expect(key1).toBe("cmd:42:main:7");
      expect(key1).toBe(key2);
    });

    it("derives distinct keys for DM and forum messages", () => {
      const dmMessage = makeTelegramMessage({
        messageId: 1,
        chatId: 777,
        chatType: "private",
        messageThreadId: 12,
        text: "hello",
      });
      const forumMessage = makeTelegramMessage({
        messageId: 2,
        chatId: 777,
        chatType: "supergroup",
        isForum: true,
        messageThreadId: 12,
        text: "hello",
      });

      const dmKey = buildCommandFragmentKey(normalizeCommandFragmentParams(dmMessage, "default"));
      const forumKey = buildCommandFragmentKey(
        normalizeCommandFragmentParams(forumMessage, "default"),
      );

      expect(dmKey).toBe("cmd:777:main:7");
      expect(forumKey).toBe("cmd:777:12:7");
      expect(dmKey).not.toBe(forumKey);
    });
  });

  describe("CommandFragmentBuffer", () => {
    function makeAnchor(nowMs: number, commandName: "new_goal" | "repo_chat" = "new_goal") {
      return {
        commandName,
        anchoredAtMs: nowMs,
        expiresAtMs: nowMs + COMMAND_ANCHOR_TTL_MS,
        sourceMessageId: 123,
        appendHandler: vi.fn(async () => undefined),
      };
    }

    it("clamps configured gaps to the supported range", () => {
      expect(clampCommandFragmentGapMs(1000)).toBe(COMMAND_FRAGMENT_MIN_GAP_MS);
      expect(clampCommandFragmentGapMs(15000)).toBe(COMMAND_FRAGMENT_MAX_GAP_MS);
      expect(clampCommandFragmentGapMs(120000)).toBe(COMMAND_FRAGMENT_MAX_CONFIGURED_GAP_MS);
    });

    it("sets and retrieves a command anchor within its TTL", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const buffer = new CommandFragmentBuffer();
      const key = "cmd:42:main:7";
      const anchor = makeAnchor(Date.now());

      buffer.setAnchor(key, anchor);
      vi.advanceTimersByTime(COMMAND_ANCHOR_TTL_MS - 1);

      expect(buffer.getAnchor(key)).toBe(anchor);
    });

    it("returns undefined for expired command anchors", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const buffer = new CommandFragmentBuffer();
      const key = "cmd:42:main:7";

      buffer.setAnchor(key, makeAnchor(Date.now()));
      vi.advanceTimersByTime(COMMAND_ANCHOR_TTL_MS);

      expect(buffer.getAnchor(key)).toBeUndefined();
      expect(buffer.getAnchor(key)).toBeUndefined();
    });

    it("clears an existing anchor when buffering a different canonical command", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const buffer = new CommandFragmentBuffer();
      const key = "cmd:42:main:7";
      const anchor = makeAnchor(Date.now(), "new_goal");

      buffer.setAnchor(key, anchor);
      buffer.bufferCommand(key, {
        commandName: "repo_chat",
        text: "first",
        firstMessageId: 100,
        receivedAtMs: 10,
        dispatch: {
          chatId: 42,
          senderId: "7",
          sourceMessageId: 100,
          accountId: "default",
        },
        flushCallback: vi.fn(),
      });

      expect(buffer.getAnchor(key)).toBeUndefined();
    });

    it("retains an existing anchor when rebuffering the same canonical command", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const buffer = new CommandFragmentBuffer();
      const key = "cmd:42:main:7";
      const anchor = makeAnchor(Date.now(), "repo_chat");

      buffer.setAnchor(key, anchor);
      buffer.bufferCommand(key, {
        commandName: "repo_chat",
        text: "first",
        firstMessageId: 100,
        receivedAtMs: 10,
        dispatch: {
          chatId: 42,
          senderId: "7",
          sourceMessageId: 100,
          accountId: "default",
        },
        flushCallback: vi.fn(),
      });

      expect(buffer.getAnchor(key)).toBe(anchor);
    });

    it("logs command anchor set, hit, and clear decisions", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const logger = { debug: vi.fn() };
      const buffer = new CommandFragmentBuffer(logger);
      const key = "cmd:42:main:7";
      const anchor = makeAnchor(Date.now(), "new_goal");

      buffer.setAnchor(key, anchor);
      expect(buffer.getAnchor(key)).toBe(anchor);
      buffer.clearAnchor(key);

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          key,
          commandName: "new_goal",
          anchoredAtMs: anchor.anchoredAtMs,
          expiresAtMs: anchor.expiresAtMs,
          sourceMessageId: anchor.sourceMessageId,
        }),
        "telegram command anchor set",
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          key,
          commandName: "new_goal",
          expiresAtMs: anchor.expiresAtMs,
        }),
        "telegram command anchor hit",
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          key,
          commandName: "new_goal",
        }),
        "telegram command anchor cleared",
      );
    });

    it("buffers, appends, and flushes combined text", async () => {
      vi.useFakeTimers();
      const buffer = new CommandFragmentBuffer();
      const flushCallback = vi.fn(async () => undefined);
      const key = "cmd:42:main:7";

      buffer.bufferCommand(key, {
        commandName: "new_goal",
        text: "first",
        firstMessageId: 100,
        receivedAtMs: 10,
        dispatch: {
          chatId: 42,
          senderId: "7",
          sourceMessageId: 100,
          accountId: "default",
        },
        flushCallback,
      });
      const appended = buffer.tryAppend(key, 101, "second", 20);
      expect(appended).toBe(true);

      await buffer.flush(key);

      expect(flushCallback).toHaveBeenCalledTimes(1);
      expect(flushCallback).toHaveBeenCalledWith("firstsecond");
      expect(buffer.hasPending(key)).toBe(false);
    });

    it("sends the buffering ack once on bufferCommand and never on tryAppend", async () => {
      vi.useFakeTimers();
      const buffer = new CommandFragmentBuffer();
      const flushCallback = vi.fn(async () => undefined);
      const newGoalAck = vi.fn(async () => undefined);
      const repoChatAck = vi.fn(async () => undefined);

      buffer.bufferCommand("cmd:42:main:7", {
        commandName: "new_goal",
        text: "first",
        firstMessageId: 100,
        receivedAtMs: 10,
        dispatch: {
          chatId: 42,
          senderId: "7",
          sourceMessageId: 100,
          accountId: "default",
        },
        flushCallback,
        ackReply: newGoalAck,
      });
      await Promise.resolve();
      expect(buffer.tryAppend("cmd:42:main:7", 101, "second", 20)).toBe(true);
      await Promise.resolve();

      expect(newGoalAck).toHaveBeenCalledTimes(1);
      expect(newGoalAck).toHaveBeenCalledWith(
        "Buffering /new_goal — keep pasting, I will combine for up to 15s.",
      );

      buffer.bufferCommand("cmd:42:main:8", {
        commandName: "repo_chat",
        text: "first",
        firstMessageId: 200,
        receivedAtMs: 10,
        dispatch: {
          chatId: 42,
          senderId: "8",
          sourceMessageId: 200,
          accountId: "default",
        },
        flushCallback,
        ackReply: repoChatAck,
      });
      await Promise.resolve();
      expect(buffer.tryAppend("cmd:42:main:8", 201, "second", 20)).toBe(true);
      await Promise.resolve();

      expect(repoChatAck).toHaveBeenCalledTimes(1);
      expect(repoChatAck).toHaveBeenCalledWith(
        "Buffering /repo_chat — keep pasting, I will combine for up to 15s.",
      );
    });

    it("auto-flushes after timeout", async () => {
      vi.useFakeTimers();
      const buffer = new CommandFragmentBuffer();
      const flushCallback = vi.fn(async () => undefined);
      const key = "cmd:42:main:7";

      buffer.bufferCommand(key, {
        commandName: "new_goal",
        text: "first",
        firstMessageId: 100,
        receivedAtMs: 10,
        dispatch: {
          chatId: 42,
          senderId: "7",
          sourceMessageId: 100,
          accountId: "default",
        },
        flushCallback,
      });

      await vi.advanceTimersByTimeAsync(COMMAND_FRAGMENT_MAX_GAP_MS + 50);

      expect(flushCallback).toHaveBeenCalledTimes(1);
      expect(flushCallback).toHaveBeenCalledWith("first");
      expect(buffer.hasPending(key)).toBe(false);
    });

    it("allows append when message IDs have an intervening gap of 3", () => {
      vi.useFakeTimers();
      const buffer = new CommandFragmentBuffer();
      const key = "cmd:42:main:7";

      buffer.bufferCommand(key, {
        commandName: "new_goal",
        text: "first",
        firstMessageId: 100,
        receivedAtMs: 10,
        dispatch: {
          chatId: 42,
          senderId: "7",
          sourceMessageId: 100,
          accountId: "default",
        },
        flushCallback: vi.fn(),
      });

      expect(buffer.tryAppend(key, 103, "second", 20)).toBe(true);
    });

    it("rejects message IDs when gap exceeds 5", () => {
      vi.useFakeTimers();
      const buffer = new CommandFragmentBuffer();
      const key = "cmd:42:main:7";

      buffer.bufferCommand(key, {
        commandName: "new_goal",
        text: "first",
        firstMessageId: 100,
        receivedAtMs: 10,
        dispatch: {
          chatId: 42,
          senderId: "7",
          sourceMessageId: 100,
          accountId: "default",
        },
        flushCallback: vi.fn(),
      });

      expect(buffer.tryAppend(key, 106, "second", 20)).toBe(false);
    });

    it("rejects append when time gap is too large", () => {
      vi.useFakeTimers();
      const buffer = new CommandFragmentBuffer();
      const key = "cmd:42:main:7";

      buffer.bufferCommand(key, {
        commandName: "new_goal",
        text: "first",
        firstMessageId: 100,
        receivedAtMs: 10,
        dispatch: {
          chatId: 42,
          senderId: "7",
          sourceMessageId: 100,
          accountId: "default",
        },
        flushCallback: vi.fn(),
      });

      expect(buffer.tryAppend(key, 101, "second", 10 + COMMAND_FRAGMENT_MAX_GAP_MS + 1)).toBe(
        false,
      );
    });

    it("allows append within the default 15s window", () => {
      vi.useFakeTimers();
      expect(COMMAND_FRAGMENT_MAX_GAP_MS).toBe(15000);
      const buffer = new CommandFragmentBuffer();
      const key = "cmd:42:main:7";

      buffer.bufferCommand(key, {
        commandName: "new_goal",
        text: "first",
        firstMessageId: 100,
        receivedAtMs: 10,
        dispatch: {
          chatId: 42,
          senderId: "7",
          sourceMessageId: 100,
          accountId: "default",
        },
        flushCallback: vi.fn(),
      });

      expect(buffer.tryAppend(key, 101, "second", 10 + COMMAND_FRAGMENT_MAX_GAP_MS)).toBe(true);
    });

    it("honors a per-instance gap override", () => {
      vi.useFakeTimers();
      const buffer = new CommandFragmentBuffer(undefined, 5000);
      const key = "cmd:42:main:7";

      buffer.bufferCommand(key, {
        commandName: "new_goal",
        text: "first",
        firstMessageId: 100,
        receivedAtMs: 10,
        dispatch: {
          chatId: 42,
          senderId: "7",
          sourceMessageId: 100,
          accountId: "default",
        },
        flushCallback: vi.fn(),
      });

      expect(buffer.tryAppend(key, 101, "second", 5010)).toBe(true);
      expect(buffer.tryAppend(key, 102, "third", 10011)).toBe(false);
    });

    it("rejects slash-prefixed continuation text", () => {
      vi.useFakeTimers();
      const buffer = new CommandFragmentBuffer();
      const key = "cmd:42:main:7";

      buffer.bufferCommand(key, {
        commandName: "new_goal",
        text: "first",
        firstMessageId: 100,
        receivedAtMs: 10,
        dispatch: {
          chatId: 42,
          senderId: "7",
          sourceMessageId: 100,
          accountId: "default",
        },
        flushCallback: vi.fn(),
      });

      expect(buffer.tryAppend(key, 101, "/repo_chat hi", 20)).toBe(false);
    });

    it("flushes an existing entry on collision via cancelAndFlush", async () => {
      vi.useFakeTimers();
      const buffer = new CommandFragmentBuffer();
      const key = "cmd:42:main:7";
      const flushCallback = vi.fn(async () => undefined);

      buffer.bufferCommand(key, {
        commandName: "new_goal",
        text: "first",
        firstMessageId: 100,
        receivedAtMs: 10,
        dispatch: {
          chatId: 42,
          senderId: "7",
          sourceMessageId: 100,
          accountId: "default",
        },
        flushCallback,
      });

      await buffer.cancelAndFlush(key);

      expect(flushCallback).toHaveBeenCalledTimes(1);
      expect(flushCallback).toHaveBeenCalledWith("first");
      expect(buffer.hasPending(key)).toBe(false);
    });

    it("enforces max parts limit", () => {
      vi.useFakeTimers();
      const buffer = new CommandFragmentBuffer();
      const key = "cmd:42:main:7";

      buffer.bufferCommand(key, {
        commandName: "new_goal",
        text: "a",
        firstMessageId: 100,
        receivedAtMs: 10,
        dispatch: {
          chatId: 42,
          senderId: "7",
          sourceMessageId: 100,
          accountId: "default",
        },
        flushCallback: vi.fn(),
      });

      for (let i = 0; i < COMMAND_FRAGMENT_MAX_PARTS - 1; i += 1) {
        const appended = buffer.tryAppend(key, 101 + i, "a", 20 + i);
        expect(appended).toBe(true);
      }

      const reject = buffer.tryAppend(
        key,
        101 + COMMAND_FRAGMENT_MAX_PARTS,
        "overflow",
        20 + COMMAND_FRAGMENT_MAX_PARTS,
      );
      expect(reject).toBe(false);
    });

    it("enforces max total chars limit", () => {
      vi.useFakeTimers();
      const buffer = new CommandFragmentBuffer();
      const key = "cmd:42:main:7";

      buffer.bufferCommand(key, {
        commandName: "new_goal",
        text: "x".repeat(COMMAND_FRAGMENT_MAX_TOTAL_CHARS),
        firstMessageId: 100,
        receivedAtMs: 10,
        dispatch: {
          chatId: 42,
          senderId: "7",
          sourceMessageId: 100,
          accountId: "default",
        },
        flushCallback: vi.fn(),
      });

      expect(buffer.tryAppend(key, 101, "y", 20)).toBe(false);
    });
  });

  describe("integration", () => {
    it("buffers short /new_goal and appends immediate continuation fragments", async () => {
      vi.useFakeTimers();
      const { createTelegramBot } = await import("./bot.js");
      createTelegramBot({ token: "tok", config: buildConfig("codex") as never });

      const messageHandler = getOnHandler("message");
      const newGoalHandler = getCommandHandler("new_goal");

      const shortPrompt = "s".repeat(490);
      expect(`/new_goal ${shortPrompt}`.length).toBe(500);
      await newGoalHandler({
        match: shortPrompt,
        message: makeTelegramMessage({
          messageId: 50,
          text: `/new_goal ${shortPrompt}`,
        }),
      });

      expect(goalCommandMock).not.toHaveBeenCalled();

      await messageHandler({
        message: makeTelegramMessage({
          messageId: 51,
          text: "continuation text",
        }),
        me: { username: "moltbot_bot" },
        getFile: async () => ({}),
      });

      expect(runRepoChatWorkerMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(COMMAND_FRAGMENT_MAX_GAP_MS + 50);

      await waitForAssertion(() => {
        expect(goalCommandMock).toHaveBeenCalledTimes(1);
      });
      expect(goalCommandMock.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          goal: `${shortPrompt}continuation text`,
        }),
      );
      expect(runRepoChatWorkerMock).not.toHaveBeenCalled();
    });

    it("buffers /new_goal when the first chunk is around 2k chars", async () => {
      vi.useFakeTimers();
      const { createTelegramBot } = await import("./bot.js");
      createTelegramBot({ token: "tok", config: buildConfig("codex") as never });

      const messageHandler = getOnHandler("message");
      const newGoalHandler = getCommandHandler("new_goal");

      const part1 = "A".repeat(2117);
      const part2 = "B".repeat(2200);
      expect(`/new_goal ${part1}`.length).toBe(2127);

      await newGoalHandler({
        match: part1,
        message: makeTelegramMessage({
          messageId: 70,
          text: `/new_goal ${part1}`,
        }),
      });

      expect(goalCommandMock).not.toHaveBeenCalled();

      await messageHandler({
        message: makeTelegramMessage({
          messageId: 71,
          text: part2,
        }),
        me: { username: "moltbot_bot" },
        getFile: async () => ({}),
      });

      expect(runRepoChatWorkerMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(COMMAND_FRAGMENT_MAX_GAP_MS + 50);

      await waitForAssertion(() => {
        expect(goalCommandMock).toHaveBeenCalledTimes(1);
      });
      expect(goalCommandMock.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          goal: part1 + part2,
        }),
      );
      expect(runRepoChatWorkerMock).not.toHaveBeenCalled();
    });

    it("buffers /new_goal when prompt is 3894 chars but full message is 3904", async () => {
      vi.useFakeTimers();
      const { createTelegramBot } = await import("./bot.js");
      createTelegramBot({ token: "tok", config: buildConfig("codex") as never });

      const messageHandler = getOnHandler("message");
      const newGoalHandler = getCommandHandler("new_goal");

      const part1 = "A".repeat(3894);
      const part2 = "B".repeat(2752);
      expect(`/new_goal ${part1}`.length).toBe(3904);

      await newGoalHandler({
        match: part1,
        message: makeTelegramMessage({
          messageId: 100,
          text: `/new_goal ${part1}`,
        }),
      });

      expect(goalCommandMock).not.toHaveBeenCalled();

      await messageHandler({
        message: makeTelegramMessage({
          messageId: 101,
          text: part2,
        }),
        me: { username: "moltbot_bot" },
        getFile: async () => ({}),
      });

      expect(runRepoChatWorkerMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(COMMAND_FRAGMENT_MAX_GAP_MS + 50);

      await waitForAssertion(() => {
        expect(goalCommandMock).toHaveBeenCalledTimes(1);
      });
      expect(goalCommandMock.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          goal: part1 + part2,
        }),
      );
      expect(runRepoChatWorkerMock).not.toHaveBeenCalled();
    });
  });

  describe("createTelegramBot end-to-end split command flow", () => {
    it("combines split /new_goal into one planner request", async () => {
      vi.useFakeTimers();
      const { createTelegramBot } = await import("./bot.js");
      createTelegramBot({ token: "tok", config: buildConfig("codex") as never });

      const messageHandler = getOnHandler("message");
      const newGoalHandler = getCommandHandler("new_goal");

      const part1 = "P".repeat(4050);
      const part2 = "Q".repeat(80);

      await newGoalHandler({
        match: part1,
        message: makeTelegramMessage({
          messageId: 100,
          text: `/new_goal ${part1}`,
        }),
      });

      await messageHandler({
        message: makeTelegramMessage({
          messageId: 101,
          text: part2,
        }),
        me: { username: "moltbot_bot" },
        getFile: async () => ({}),
      });

      await vi.advanceTimersByTimeAsync(COMMAND_FRAGMENT_MAX_GAP_MS + 50);

      await waitForAssertion(() => {
        expect(goalCommandMock).toHaveBeenCalledTimes(1);
      });
      expect(goalCommandMock.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          goal: part1 + part2,
        }),
      );
      expect(runRepoChatWorkerMock).not.toHaveBeenCalled();
    });

    it("combines split /repo_chat into one request and preserves disabled-backend reply", async () => {
      vi.useFakeTimers();

      const { createTelegramBot } = await import("./bot.js");
      createTelegramBot({ token: "tok", config: buildConfig("codex") as never });

      const messageHandler = getOnHandler("message");
      const repoChatHandler = getCommandHandler("repo_chat");

      const part1 = "R".repeat(3890);
      const part2 = "S".repeat(2752);
      expect(`/repo_chat ${part1}`.length).toBe(3901);

      await repoChatHandler({
        match: part1,
        message: makeTelegramMessage({
          messageId: 200,
          text: `/repo_chat ${part1}`,
        }),
      });

      expect(runRepoChatWorkerMock).not.toHaveBeenCalled();

      await messageHandler({
        message: makeTelegramMessage({
          messageId: 201,
          text: part2,
        }),
        me: { username: "moltbot_bot" },
        getFile: async () => ({}),
      });

      expect(runRepoChatWorkerMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(COMMAND_FRAGMENT_MAX_GAP_MS + 50);

      await waitForAssertion(() => {
        expect(runRepoChatWorkerMock).toHaveBeenCalledTimes(1);
      });
      expect(runRepoChatWorkerMock.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          prompt: part1 + part2,
        }),
      );

      vi.clearAllMocks();
      resolveTelegramCommandAuthMock.mockImplementation(
        async ({ msg }: { msg: TelegramMessage }) => ({
          chatId: msg.chat.id,
          isGroup: false,
          isForum: false,
          resolvedThreadId: undefined,
          senderId: String(msg.from?.id ?? "unknown"),
          senderUsername: msg.from?.username ?? "",
          commandAuthorized: true,
        }),
      );
      runRepoChatWorkerMock.mockResolvedValue({ text: "repo response", cliSessionId: "session-1" });

      createTelegramBot({ token: "tok", config: buildConfig(null) as never });
      const disabledMessageHandler = getOnHandler("message");
      const disabledRepoChatHandler = getCommandHandler("repo_chat");

      const disabledPart1 = "D".repeat(4050);
      const disabledPart2 = "E".repeat(60);

      await disabledRepoChatHandler({
        match: disabledPart1,
        message: makeTelegramMessage({
          messageId: 300,
          text: `/repo_chat ${disabledPart1}`,
        }),
      });

      await disabledMessageHandler({
        message: makeTelegramMessage({
          messageId: 301,
          text: disabledPart2,
        }),
        me: { username: "moltbot_bot" },
        getFile: async () => ({}),
      });

      await vi.advanceTimersByTimeAsync(COMMAND_FRAGMENT_MAX_GAP_MS + 50);

      expect(runRepoChatWorkerMock).not.toHaveBeenCalled();
      expect(
        sendMessageSpy.mock.calls.some((call) =>
          String(call[1]).includes("Repo chat is disabled. Enable it with /chat_backend codex"),
        ),
      ).toBe(true);
    });

    it("combines split /repo_chat when the first chunk is short", async () => {
      vi.useFakeTimers();
      const { createTelegramBot } = await import("./bot.js");
      createTelegramBot({ token: "tok", config: buildConfig("codex") as never });

      const messageHandler = getOnHandler("message");
      const repoChatHandler = getCommandHandler("repo_chat");

      const part1 = "T".repeat(300);
      const part2 = "U".repeat(2500);
      expect(`/repo_chat ${part1}`.length).toBe(311);

      await repoChatHandler({
        match: part1,
        message: makeTelegramMessage({
          messageId: 400,
          text: `/repo_chat ${part1}`,
        }),
      });

      expect(runRepoChatWorkerMock).not.toHaveBeenCalled();

      await messageHandler({
        message: makeTelegramMessage({
          messageId: 401,
          text: part2,
        }),
        me: { username: "moltbot_bot" },
        getFile: async () => ({}),
      });

      expect(runRepoChatWorkerMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(COMMAND_FRAGMENT_MAX_GAP_MS + 50);

      await waitForAssertion(() => {
        expect(runRepoChatWorkerMock).toHaveBeenCalledTimes(1);
      });
      expect(runRepoChatWorkerMock.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          prompt: part1 + part2,
        }),
      );
    });
  });
});
