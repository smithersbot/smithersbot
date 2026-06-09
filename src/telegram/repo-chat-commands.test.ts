import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TelegramAccountConfig } from "../config/types.js";
import {
  findRepoChatSessionByMessageId,
  loadRepoChatSession,
  resetRepoChatStoreIndexForTests,
} from "../repo-chat/repo-chat-store.js";
import type { RuntimeEnv } from "../runtime.js";
import { buildCommandFragmentKey, CommandFragmentBuffer } from "./command-fragments.js";
import {
  dispatchTelegramRepoChatForInboundText,
  handleRepoChatShowMoreCallback,
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

  it("sanitizes provider auth/config errors before sending repo-chat failures to Telegram", async () => {
    runRepoChatWorkerMock.mockRejectedValue(
      new Error(
        'No API key found for provider "anthropic". Auth store: /tmp/agent/auth-profiles.json (agentDir: /tmp/agent).',
      ),
    );
    markdownToTelegramChunksMock.mockImplementation((markdown: string) => [
      { html: markdown, text: markdown },
    ]);
    const sendMessageMock = vi.fn().mockResolvedValue({ message_id: 803 });
    const bot = { api: { sendMessage: sendMessageMock } };

    const started = dispatchTelegramRepoChatForInboundText({
      bot: bot as never,
      runtime: buildRuntime(),
      telegramCfg: buildTelegramCfg(),
      chatId: 101,
      prompt: "What changed?",
      sourceMessageId: 800,
      replyToMessageId: undefined,
      claudeCodeAuth: "subscription",
    });

    expect(started).toBe(true);

    await waitForAssertion(() => {
      const text = String(sendMessageMock.mock.calls[0]?.[1] ?? "");
      expect(text).toContain("Repo chat failed: AI authentication is unavailable.");
      expect(text).not.toContain('No API key found for provider "anthropic"');
      expect(text).not.toContain("auth-profiles.json");
      expect(text).not.toContain("auth-store");
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

  it("reuses stable Codex sandbox state when resuming a repo-chat thread", async () => {
    runRepoChatWorkerMock
      .mockResolvedValueOnce({
        text: "initial output",
        cliSessionId: "codex-thread-A",
      })
      .mockResolvedValueOnce({
        text: "follow-up output",
        cliSessionId: "codex-thread-A",
      });

    const sendMessageMock = vi
      .fn()
      .mockResolvedValueOnce({ message_id: 1101 })
      .mockResolvedValueOnce({ message_id: 1102 })
      .mockResolvedValueOnce({ message_id: 1201 })
      .mockResolvedValueOnce({ message_id: 1202 });
    const bot = { api: { sendMessage: sendMessageMock } };
    const runtime = buildRuntime();
    const telegramCfg: TelegramAccountConfig = { repoChatBackend: "codex" };

    expect(
      dispatchTelegramRepoChatForInboundText({
        bot: bot as never,
        runtime,
        telegramCfg,
        chatId: 404,
        prompt: "Initial Codex question",
        sourceMessageId: 1100,
        replyToMessageId: undefined,
      }),
    ).toBe(true);

    await waitForAssertion(() => {
      expect(findRepoChatSessionByMessageId({ chatId: 404, messageId: 1101 })).toBeDefined();
    });

    expect(
      dispatchTelegramRepoChatForInboundText({
        bot: bot as never,
        runtime,
        telegramCfg,
        chatId: 404,
        prompt: "Follow-up Codex question",
        sourceMessageId: 1200,
        replyToMessageId: 1101,
      }),
    ).toBe(true);

    await waitForAssertion(() => {
      expect(runRepoChatWorkerMock).toHaveBeenCalledTimes(2);
    });

    const firstCall = runRepoChatWorkerMock.mock.calls[0]?.[0] as
      | { cliSessionId?: string; codexSandboxRunId?: string }
      | undefined;
    const secondCall = runRepoChatWorkerMock.mock.calls[1]?.[0] as
      | { cliSessionId?: string; codexSandboxRunId?: string }
      | undefined;
    expect(firstCall?.cliSessionId).toBeUndefined();
    expect(firstCall?.codexSandboxRunId).toMatch(/^repo-chat-session-/);
    expect(secondCall?.cliSessionId).toBe("codex-thread-A");
    expect(secondCall?.codexSandboxRunId).toBe(firstCall?.codexSandboxRunId);

    let resumedSession = findRepoChatSessionByMessageId({ chatId: 404, messageId: 1201 });
    await waitForAssertion(() => {
      resumedSession = findRepoChatSessionByMessageId({ chatId: 404, messageId: 1201 });
      expect(resumedSession).toBeDefined();
    });
    expect(resumedSession?.cliSessionId).toBe("codex-thread-A");
    expect(resumedSession?.codexSandboxRunId).toBe(firstCall?.codexSandboxRunId);
  });

  it("does not leak raw Codex no-rollout errors to Telegram replies", async () => {
    runRepoChatWorkerMock.mockRejectedValueOnce(
      new Error("Codex resume state missing; start a fresh repo-chat session."),
    );
    const sendMessageMock = vi.fn().mockResolvedValue({ message_id: 1301 });
    const bot = { api: { sendMessage: sendMessageMock } };

    const started = dispatchTelegramRepoChatForInboundText({
      bot: bot as never,
      runtime: buildRuntime(),
      telegramCfg: { repoChatBackend: "codex" },
      chatId: 505,
      prompt: "Follow-up Codex question",
      sourceMessageId: 1300,
      replyToMessageId: undefined,
    });

    expect(started).toBe(true);

    await waitForAssertion(() => {
      expect(markdownToTelegramChunksMock).toHaveBeenCalled();
      const renderedText = String(markdownToTelegramChunksMock.mock.calls.at(-1)?.[0] ?? "");
      expect(renderedText).toContain(
        "Repo chat failed: Codex resume state missing; start a fresh repo-chat session.",
      );
      expect(renderedText).not.toContain("no rollout found");
      expect(renderedText).not.toContain("RPC error");
    });
  });

  it("sends long repo-chat replies as a first page with recoverable Show More overflow", async () => {
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
      expect(lastCall?.[1]).toBe("<b>chunk 8</b>");
      expect(lastCall?.[2]).toEqual(
        expect.objectContaining({
          parse_mode: "HTML",
          reply_markup: expect.objectContaining({
            inline_keyboard: [
              [
                expect.objectContaining({
                  text: "Show More",
                  callback_data: expect.stringMatching(/^rcm:[^:]+:[a-f0-9]{8}:0$/),
                }),
              ],
            ],
          }),
        }),
      );
      expect(sendMessageMock.mock.calls.map((call) => call[1])).not.toContain(
        "[Response truncated]",
      );

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
      expect(session?.overflowReplies).toHaveLength(1);
      expect(session?.overflowReplies?.[0]?.chunks.map((chunk) => chunk.text)).toEqual([
        "chunk 9",
        "chunk 10",
        "chunk 11",
        "chunk 12",
      ]);
    });
  });

  it("sends stored repo-chat overflow chunks from the Show More callback and indexes them", async () => {
    runRepoChatWorkerMock.mockResolvedValue({
      text: "very long worker output",
      cliSessionId: "session-more",
    });

    markdownToTelegramChunksMock.mockReturnValue(
      Array.from({ length: 10 }, (_, index) => ({
        html: `<b>chunk ${index + 1}</b>`,
        text: `chunk ${index + 1}`,
      })),
    );

    let nextMessageId = 2000;
    const sendMessageMock = vi.fn().mockImplementation(async () => ({
      message_id: ++nextMessageId,
    }));
    const bot = { api: { sendMessage: sendMessageMock } };

    expect(
      dispatchTelegramRepoChatForInboundText({
        bot: bot as never,
        runtime: buildRuntime(),
        telegramCfg: buildTelegramCfg(),
        chatId: 606,
        prompt: "Return long output",
        sourceMessageId: 1999,
        replyToMessageId: undefined,
        claudeCodeAuth: "subscription",
      }),
    ).toBe(true);

    let callbackData = "";
    await waitForAssertion(() => {
      const lastOptions = sendMessageMock.mock.calls.at(-1)?.[2] as {
        reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
      };
      callbackData = lastOptions.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data ?? "";
      expect(callbackData).toMatch(/^rcm:[^:]+:[a-f0-9]{8}:0$/);
    });

    sendMessageMock.mockClear();
    await handleRepoChatShowMoreCallback({
      bot: bot as never,
      runtime: buildRuntime(),
      chatId: 606,
      data: callbackData,
      replyToMessageId: 2008,
    });

    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMock.mock.calls.map((call) => call[1])).toEqual([
      "<b>chunk 9</b>",
      "<b>chunk 10</b>",
    ]);
    expect(sendMessageMock.mock.calls.at(-1)?.[2]).not.toHaveProperty("reply_markup");
    const stored = loadRepoChatSession(callbackData.split(":")[1] ?? "");
    expect(stored?.messageRefs).toEqual(
      expect.arrayContaining([
        { chatId: 606, messageId: 2009 },
        { chatId: 606, messageId: 2010 },
      ]),
    );
    expect(findRepoChatSessionByMessageId({ chatId: 606, messageId: 2010 })?.id).toBe(stored?.id);
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
      commandName: "repo_chat",
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
      commandName: "repo_chat",
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
