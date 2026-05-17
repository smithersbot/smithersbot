import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TelegramAccountConfig } from "../config/types.js";
import {
  findRepoChatSessionByMessageId,
  resetRepoChatStoreIndexForTests,
} from "../repo-chat/repo-chat-store.js";
import type { RuntimeEnv } from "../runtime.js";
import { buildCommandFragmentKey, CommandFragmentBuffer } from "./command-fragments.js";
import {
  dispatchTelegramRepoChatForInboundText,
  registerTelegramRepoChatCommands,
} from "./repo-chat-commands.js";

const runRepoChatWorkerMock = vi.hoisted(() => vi.fn());
const withChatActionMock = vi.hoisted(() => vi.fn());
const withTelegramApiErrorLoggingMock = vi.hoisted(() => vi.fn());
const markdownToTelegramChunksMock = vi.hoisted(() => vi.fn());

vi.mock("../repo-chat/repo-chat-worker.js", () => ({
  runRepoChatWorker: (...args: unknown[]) => runRepoChatWorkerMock(...args),
}));

vi.mock("./goal-commands.js", () => ({
  withChatAction: (...args: unknown[]) => withChatActionMock(...args),
}));

vi.mock("./api-logging.js", () => ({
  withTelegramApiErrorLogging: (...args: unknown[]) => withTelegramApiErrorLoggingMock(...args),
}));

vi.mock("./format.js", () => ({
  markdownToTelegramChunks: (...args: unknown[]) => markdownToTelegramChunksMock(...args),
}));

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

function buildTelegramCfg(): TelegramAccountConfig {
  return { repoChatBackend: "claude_code" };
}

function buildRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv;
}

function makeRepoChatCommandHarness(
  options: {
    commandFragmentBuffer?: CommandFragmentBuffer;
  } = {},
): {
  handlers: Record<string, (ctx: unknown) => Promise<void>>;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 99 });
  const bot = {
    api: {
      sendMessage,
    },
    command: (name: string | string[], handler: (ctx: unknown) => Promise<void>) => {
      if (Array.isArray(name)) {
        for (const entry of name) handlers[entry] = handler;
        return;
      }
      handlers[name] = handler;
    },
  };

  registerTelegramRepoChatCommands({
    bot: bot as never,
    cfg: { goal: { claudeCodeAuth: "subscription" } } as never,
    runtime: buildRuntime(),
    accountId: "default",
    telegramCfg: buildTelegramCfg(),
    allowFrom: ["42"],
    groupAllowFrom: [],
    useAccessGroups: false,
    resolveGroupPolicy: () =>
      ({
        allowlistEnabled: false,
        allowed: true,
      }) as never,
    resolveTelegramGroupConfig: () => ({
      groupConfig: undefined,
      topicConfig: undefined,
    }),
    shouldSkipUpdate: () => false,
    commandFragmentBuffer: options.commandFragmentBuffer,
  });

  return { handlers, sendMessage };
}

function makeRepoChatCommandCtx(match: string, messageId: number): Record<string, unknown> {
  return {
    match,
    message: {
      chat: { id: 42, type: "private" },
      from: { id: 42, username: "tester" },
      message_id: messageId,
      date: 123_456,
    },
  };
}

describe("repo-chat-commands", () => {
  let tmpHomeDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-chat-commands-"));
    process.env.HOME = tmpHomeDir;
    resetRepoChatStoreIndexForTests();

    vi.clearAllMocks();
    withChatActionMock.mockImplementation(async ({ fn }: { fn: () => Promise<unknown> }) => fn());
    withTelegramApiErrorLoggingMock.mockImplementation(
      async ({ fn }: { fn: () => Promise<unknown> }) => fn(),
    );
    markdownToTelegramChunksMock.mockReturnValue([
      { html: "<b>chunk 1</b>", text: "chunk 1" },
      { html: "<b>chunk 2</b>", text: "chunk 2" },
    ]);
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpHomeDir, { recursive: true, force: true });
    resetRepoChatStoreIndexForTests();
  });

  it("stores all repo-chat response chunk ids so any chunk id resolves the session", async () => {
    runRepoChatWorkerMock.mockResolvedValue({
      text: "first worker output",
      cliSessionId: "session-1",
    });

    const sendMessageMock = vi
      .fn()
      .mockResolvedValueOnce({ message_id: 701 })
      .mockResolvedValueOnce({ message_id: 702 });
    const bot = { api: { sendMessage: sendMessageMock } };

    const started = dispatchTelegramRepoChatForInboundText({
      bot: bot as never,
      runtime: buildRuntime(),
      telegramCfg: buildTelegramCfg(),
      chatId: 101,
      prompt: "What changed?",
      sourceMessageId: 700,
      replyToMessageId: undefined,
      claudeCodeAuth: "subscription",
    });

    expect(started).toBe(true);

    await waitForAssertion(() => {
      const fromFirstChunk = findRepoChatSessionByMessageId({ chatId: 101, messageId: 701 });
      const fromSecondChunk = findRepoChatSessionByMessageId({ chatId: 101, messageId: 702 });
      const fromSourceMessage = findRepoChatSessionByMessageId({ chatId: 101, messageId: 700 });

      expect(fromFirstChunk).toBeDefined();
      expect(fromSecondChunk?.id).toBe(fromFirstChunk?.id);
      expect(fromSourceMessage?.id).toBe(fromFirstChunk?.id);
      expect(fromFirstChunk?.messageRefs).toEqual(
        expect.arrayContaining([
          { chatId: 101, messageId: 700 },
          { chatId: 101, messageId: 701 },
          { chatId: 101, messageId: 702 },
        ]),
      );
    });
  });

  it("replying to a non-last bot chunk id stays on repo-chat routing and resumes the session", async () => {
    runRepoChatWorkerMock
      .mockResolvedValueOnce({
        text: "initial output",
        cliSessionId: "session-1",
      })
      .mockResolvedValueOnce({
        text: "follow-up output",
        cliSessionId: "session-2",
      });

    const sendMessageMock = vi
      .fn()
      .mockResolvedValueOnce({ message_id: 801 })
      .mockResolvedValueOnce({ message_id: 802 })
      .mockResolvedValueOnce({ message_id: 901 })
      .mockResolvedValueOnce({ message_id: 902 });
    const bot = { api: { sendMessage: sendMessageMock } };
    const runtime = buildRuntime();
    const telegramCfg = buildTelegramCfg();

    const firstStarted = dispatchTelegramRepoChatForInboundText({
      bot: bot as never,
      runtime,
      telegramCfg,
      chatId: 202,
      prompt: "Initial question",
      sourceMessageId: 800,
      replyToMessageId: undefined,
      claudeCodeAuth: "subscription",
    });
    expect(firstStarted).toBe(true);

    await waitForAssertion(() => {
      expect(findRepoChatSessionByMessageId({ chatId: 202, messageId: 801 })).toBeDefined();
      expect(findRepoChatSessionByMessageId({ chatId: 202, messageId: 802 })).toBeDefined();
    });

    const secondStarted = dispatchTelegramRepoChatForInboundText({
      bot: bot as never,
      runtime,
      telegramCfg,
      chatId: 202,
      prompt: "Follow-up on first chunk reply",
      sourceMessageId: 900,
      replyToMessageId: 801,
      claudeCodeAuth: "subscription",
    });
    expect(secondStarted).toBe(true);

    await waitForAssertion(() => {
      expect(runRepoChatWorkerMock).toHaveBeenCalledTimes(2);
      const secondCallArg = runRepoChatWorkerMock.mock.calls[1]?.[0] as
        | { cliSessionId?: string }
        | undefined;
      expect(secondCallArg?.cliSessionId).toBe("session-1");

      const resumedSession = findRepoChatSessionByMessageId({ chatId: 202, messageId: 901 });
      const nonLastChunkSession = findRepoChatSessionByMessageId({ chatId: 202, messageId: 801 });
      expect(resumedSession).toBeDefined();
      expect(nonLastChunkSession?.id).toBe(resumedSession?.id);
      expect(resumedSession?.cliSessionId).toBe("session-2");
    });
  });

  it("caps repo-chat replies to 8 chunks and appends a truncation notice", async () => {
    runRepoChatWorkerMock.mockResolvedValue({
      text: "very long worker output",
      cliSessionId: "session-cap",
    });

    markdownToTelegramChunksMock.mockReturnValue(
      Array.from({ length: 12 }, (_, index) => ({
        html: `<b>chunk ${index + 1}</b>`,
        text: `chunk ${index + 1}`,
      })),
    );

    let nextMessageId = 1000;
    const sendMessageMock = vi.fn().mockImplementation(async () => ({
      message_id: ++nextMessageId,
    }));
    const bot = { api: { sendMessage: sendMessageMock } };

    const started = dispatchTelegramRepoChatForInboundText({
      bot: bot as never,
      runtime: buildRuntime(),
      telegramCfg: buildTelegramCfg(),
      chatId: 303,
      prompt: "Return long output",
      sourceMessageId: 999,
      replyToMessageId: undefined,
      claudeCodeAuth: "subscription",
    });

    expect(started).toBe(true);

    await waitForAssertion(() => {
      expect(sendMessageMock).toHaveBeenCalledTimes(8);
      const lastCall = sendMessageMock.mock.calls.at(-1);
      expect(lastCall?.[1]).toBe("[Response truncated]");

      const session = findRepoChatSessionByMessageId({ chatId: 303, messageId: 1008 });
      expect(session).toBeDefined();
      expect(session?.messageRefs).toEqual(
        expect.arrayContaining([
          { chatId: 303, messageId: 999 },
          { chatId: 303, messageId: 1001 },
          { chatId: 303, messageId: 1008 },
        ]),
      );
      expect(session?.messageRefs).toHaveLength(9);
    });
  });

  it("sets a repo_chat anchor after a buffered command flush", async () => {
    runRepoChatWorkerMock.mockResolvedValue({
      text: "worker output",
      cliSessionId: "session-anchor",
    });
    const commandFragmentBuffer = new CommandFragmentBuffer(undefined, 3000, 60000);
    const setAnchor = vi.spyOn(commandFragmentBuffer, "setAnchor");
    const harness = makeRepoChatCommandHarness({ commandFragmentBuffer });

    await harness.handlers.repo_chat!(makeRepoChatCommandCtx("first part", 1201));
    const key = buildCommandFragmentKey({
      accountId: "default",
      chatId: 42,
      resolvedThreadId: undefined,
      senderId: "42",
    });
    await commandFragmentBuffer.cancelAndFlush(key);

    expect(setAnchor).toHaveBeenCalledTimes(1);
    expect(setAnchor.mock.calls[0]?.[0]).toBe(key);
    expect(setAnchor.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        commandName: "repo_chat",
        sourceMessageId: 1201,
      }),
    );
    expect(commandFragmentBuffer.getAnchor(key)?.commandName).toBe("repo_chat");
  });

  it("routes appended repo_chat anchor text through inbound repo-chat dispatch", async () => {
    runRepoChatWorkerMock
      .mockResolvedValueOnce({
        text: "initial output",
        cliSessionId: "session-anchor-1",
      })
      .mockResolvedValueOnce({
        text: "follow-up output",
        cliSessionId: "session-anchor-2",
      });
    const commandFragmentBuffer = new CommandFragmentBuffer(undefined, 3000, 60000);
    const harness = makeRepoChatCommandHarness({ commandFragmentBuffer });

    await harness.handlers.repo_chat!(makeRepoChatCommandCtx("first part", 1301));
    const key = buildCommandFragmentKey({
      accountId: "default",
      chatId: 42,
      resolvedThreadId: undefined,
      senderId: "42",
    });
    await commandFragmentBuffer.cancelAndFlush(key);

    await waitForAssertion(() => {
      expect(findRepoChatSessionByMessageId({ chatId: 42, messageId: 1301 })).toBeDefined();
    });

    const anchor = commandFragmentBuffer.getAnchor(key);
    expect(anchor).toBeDefined();
    await anchor!.appendHandler("appended part");

    await waitForAssertion(() => {
      expect(runRepoChatWorkerMock).toHaveBeenCalledTimes(2);
    });
    expect(runRepoChatWorkerMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        prompt: "appended part",
        cliSessionId: "session-anchor-1",
      }),
    );
  });
});
