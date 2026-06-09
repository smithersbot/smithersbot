import crypto from "node:crypto";
import path from "node:path";
import type { Bot, Context } from "grammy";

import { resolveChannelConfigWrites } from "../channels/plugins/config-writes.js";
import type { MoltbotConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { writeConfigFile } from "../config/io.js";
import type { ChannelGroupPolicy } from "../config/group-policy.js";
import type {
  TelegramAccountConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "../config/types.js";
import type { ClaudeCodeAuthMode } from "../config/types.goal.js";
import { danger } from "../globals.js";
import { runRepoChatWorker } from "../repo-chat/repo-chat-worker.js";
import {
  findRepoChatSessionByMessageId,
  loadRepoChatSession,
  saveRepoChatSession,
} from "../repo-chat/repo-chat-store.js";
import type { RepoChatBackend, RepoChatSession } from "../repo-chat/types.js";
import { normalizeAccountId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { redactSecretValues } from "../security/secret-paths.js";
import { sanitizeUserFacingText } from "../agents/pi-embedded-helpers.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  buildCommandFragmentKey,
  type CommandFragmentBuffer,
  normalizeCommandFragmentParams,
} from "./command-fragments.js";
import { markdownToTelegramChunks } from "./format.js";
import { withChatAction } from "./goal-commands.js";
import { buildInlineKeyboard } from "./send.js";
import { resolveTelegramCommandAuth } from "./telegram-auth.js";

// Telegram command menu entries for repo chat controls.
export const REPO_CHAT_COMMAND_SPECS: Array<{ command: string; description: string }> = [
  { command: "repo_chat", description: "Ask a repository question (read-only)." },
  {
    command: "chat_backend",
    description: "Set repo chat backend: codex, claude_code, or off.",
  },
];

const REPO_CHAT_USAGE = "Usage: /repo_chat <question>";
const CHAT_BACKEND_USAGE = "Usage: /chat_backend <codex|claude_code|off>";
const REPO_CHAT_DISABLED_MESSAGE =
  "Repo chat is disabled. Enable it with /chat_backend codex or /chat_backend claude_code.";
const MAX_SESSION_MESSAGE_REFS = 200;
const MAX_REPLY_CHUNKS = 8;
const REPO_CHAT_MORE_CALLBACK_PREFIX = "rcm";
const CODEX_REPO_CHAT_SANDBOX_PREFIX = "repo-chat-session-";

type TelegramRepoChatCommandContext = Context & { match?: string };

type RegisterRepoChatCommandsParams = {
  bot: Bot;
  cfg: MoltbotConfig;
  runtime: RuntimeEnv;
  accountId: string;
  telegramCfg: TelegramAccountConfig;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  useAccessGroups: boolean;
  resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId?: number,
  ) => { groupConfig?: TelegramGroupConfig; topicConfig?: TelegramTopicConfig };
  shouldSkipUpdate: (ctx: unknown) => boolean;
  commandFragmentBuffer?: CommandFragmentBuffer;
};

type StartRepoChatResult =
  | {
      started: true;
    }
  | {
      started: false;
      reason: "disabled" | "reply-session-not-found";
    };

function parseRepoChatBackend(raw: string): RepoChatBackend | null | undefined {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "off") return null;
  if (normalized === "codex" || normalized === "claude_code") {
    return normalized;
  }
  return undefined;
}

function isRepoChatBackend(value: unknown): value is RepoChatBackend {
  return value === "codex" || value === "claude_code";
}

function resolveAccountKey(
  accounts: Record<string, TelegramAccountConfig> | undefined,
  accountId: string,
): string | undefined {
  if (!accounts || typeof accounts !== "object") return undefined;
  if (Object.hasOwn(accounts, accountId)) return accountId;
  const normalized = normalizeAccountId(accountId);
  return Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
}

function setRepoChatBackendOnConfig(params: {
  cfg: MoltbotConfig;
  accountId: string;
  backend: RepoChatBackend | null;
}): void {
  params.cfg.channels ??= {};
  const telegramConfig = (params.cfg.channels.telegram ??= {});
  const telegramWithAccounts = telegramConfig as TelegramAccountConfig & {
    accounts?: Record<string, TelegramAccountConfig>;
  };
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const accountKey = resolveAccountKey(telegramWithAccounts.accounts, params.accountId);
  const writeToAccount = normalizedAccountId !== "default" || Boolean(accountKey);

  if (writeToAccount) {
    telegramWithAccounts.accounts ??= {};
    const key = accountKey ?? normalizedAccountId;
    const accountCfg = telegramWithAccounts.accounts[key] ?? {};
    telegramWithAccounts.accounts[key] = {
      ...accountCfg,
      repoChatBackend: params.backend,
    };
    return;
  }

  telegramConfig.repoChatBackend = params.backend;
}

function appendMessageRef(
  refs: RepoChatSession["messageRefs"],
  next: { chatId: number; messageId: number },
): RepoChatSession["messageRefs"] {
  if (refs.some((entry) => entry.chatId === next.chatId && entry.messageId === next.messageId)) {
    return refs.slice(-MAX_SESSION_MESSAGE_REFS);
  }
  return [...refs, next].slice(-MAX_SESSION_MESSAGE_REFS);
}

function appendMessageRefs(
  refs: RepoChatSession["messageRefs"],
  nextRefs: RepoChatSession["messageRefs"],
): RepoChatSession["messageRefs"] {
  return nextRefs.reduce((acc, entry) => appendMessageRef(acc, entry), refs);
}

function buildNextRepoChatSession(params: {
  sessionId: string;
  existingSession?: RepoChatSession;
  backend: RepoChatBackend;
  workingDir: string;
  cliSessionId?: string;
  codexSandboxRunId?: string;
  messageRefs: RepoChatSession["messageRefs"];
  overflowReplies?: NonNullable<RepoChatSession["overflowReplies"]>;
}): RepoChatSession {
  const now = new Date().toISOString();
  const existing = params.existingSession;
  return {
    id: params.sessionId,
    backend: existing?.backend ?? params.backend,
    workingDir: existing?.workingDir ?? params.workingDir,
    cliSessionId: params.cliSessionId ?? existing?.cliSessionId,
    codexSandboxRunId: params.codexSandboxRunId ?? existing?.codexSandboxRunId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    messageRefs: appendMessageRefs(existing?.messageRefs ?? [], params.messageRefs),
    overflowReplies: [
      ...(existing?.overflowReplies ?? []),
      ...(params.overflowReplies ?? []),
    ].slice(-MAX_SESSION_MESSAGE_REFS),
  };
}

async function sendRepoChatReply(params: {
  bot: Bot;
  runtime: RuntimeEnv;
  chatId: number;
  sessionId?: string;
  text: string;
  threadId?: number;
  replyToMessageId: number;
}): Promise<{
  messageIds: number[];
  overflowReplies?: NonNullable<RepoChatSession["overflowReplies"]>;
}> {
  const redactedText = redactSecretValues(params.text);
  const markdown = redactedText.trim() ? redactedText : "No output.";
  const chunks = markdownToTelegramChunks(markdown, 4000);
  const replyChunks = params.sessionId != null ? chunks.slice(0, MAX_REPLY_CHUNKS) : chunks;
  const overflowChunks = params.sessionId != null ? chunks.slice(MAX_REPLY_CHUNKS) : [];
  const overflowId =
    params.sessionId != null && overflowChunks.length > 0
      ? crypto.randomBytes(4).toString("hex")
      : undefined;
  const overflowReplies =
    overflowId != null
      ? [
          {
            id: overflowId,
            chunks: overflowChunks,
            createdAt: new Date().toISOString(),
          },
        ]
      : undefined;
  const messageIds: number[] = [];
  for (const [index, chunk] of replyChunks.entries()) {
    const threadParams = params.threadId != null ? { message_thread_id: params.threadId } : {};
    const isLastInitialChunk = index === replyChunks.length - 1;
    const replyMarkup =
      overflowId != null && isLastInitialChunk
        ? buildInlineKeyboard([
            [
              {
                text: "Show More",
                callback_data: `${REPO_CHAT_MORE_CALLBACK_PREFIX}:${params.sessionId ?? ""}:${overflowId}:0`,
              },
            ],
          ])
        : undefined;
    const sendParams = {
      parse_mode: "HTML" as const,
      link_preview_options: { is_disabled: true },
      reply_to_message_id: params.replyToMessageId,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      ...threadParams,
    };
    const fallbackParams = {
      link_preview_options: { is_disabled: true },
      reply_to_message_id: params.replyToMessageId,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      ...threadParams,
    };
    const sent = await withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime: params.runtime,
      fn: () =>
        params.bot.api
          .sendMessage(params.chatId, chunk.html, sendParams)
          .catch(() => params.bot.api.sendMessage(params.chatId, chunk.text, fallbackParams)),
    }).catch(() => undefined);
    if (sent?.message_id != null) {
      messageIds.push(sent.message_id);
    }
  }
  return { messageIds, overflowReplies };
}

function parseRepoChatMoreCallback(data: string):
  | {
      sessionId: string;
      overflowId: string;
      offset: number;
    }
  | undefined {
  const [prefix, sessionId, overflowId, offsetRaw] = data.split(":");
  if (prefix !== REPO_CHAT_MORE_CALLBACK_PREFIX) return undefined;
  if (!sessionId || !overflowId || !offsetRaw) return undefined;
  const offset = Number.parseInt(offsetRaw, 10);
  if (!Number.isInteger(offset) || offset < 0) return undefined;
  return { sessionId, overflowId, offset };
}

export function isRepoChatShowMoreCallback(data: string): boolean {
  return parseRepoChatMoreCallback(data) != null;
}

export async function handleRepoChatShowMoreCallback(params: {
  bot: Bot;
  runtime: RuntimeEnv;
  chatId: number;
  data: string;
  threadId?: number;
  replyToMessageId: number;
}): Promise<boolean> {
  const parsed = parseRepoChatMoreCallback(params.data);
  if (!parsed) return false;

  const session = loadRepoChatSession(parsed.sessionId);
  const overflow = session?.overflowReplies?.find((entry) => entry.id === parsed.overflowId);
  if (!session || !overflow) {
    await params.bot.api.sendMessage(params.chatId, "That repo-chat page is no longer available.", {
      reply_to_message_id: params.replyToMessageId,
      ...(params.threadId != null ? { message_thread_id: params.threadId } : {}),
    });
    return true;
  }

  const pageChunks = overflow.chunks.slice(parsed.offset, parsed.offset + MAX_REPLY_CHUNKS);
  if (pageChunks.length === 0) {
    await params.bot.api.sendMessage(params.chatId, "There is no more repo-chat output to show.", {
      reply_to_message_id: params.replyToMessageId,
      ...(params.threadId != null ? { message_thread_id: params.threadId } : {}),
    });
    return true;
  }

  const nextOffset = parsed.offset + pageChunks.length;
  const hasMore = nextOffset < overflow.chunks.length;
  const messageIds: number[] = [];
  for (const [index, chunk] of pageChunks.entries()) {
    const isLastPageChunk = index === pageChunks.length - 1;
    const replyMarkup =
      hasMore && isLastPageChunk
        ? buildInlineKeyboard([
            [
              {
                text: "Show More",
                callback_data: `${REPO_CHAT_MORE_CALLBACK_PREFIX}:${session.id}:${overflow.id}:${nextOffset}`,
              },
            ],
          ])
        : undefined;
    const baseParams = {
      link_preview_options: { is_disabled: true },
      reply_to_message_id: params.replyToMessageId,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      ...(params.threadId != null ? { message_thread_id: params.threadId } : {}),
    };
    const sent = await withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime: params.runtime,
      fn: () =>
        params.bot.api
          .sendMessage(params.chatId, chunk.html, {
            ...baseParams,
            parse_mode: "HTML" as const,
          })
          .catch(() => params.bot.api.sendMessage(params.chatId, chunk.text, baseParams)),
    }).catch(() => undefined);
    if (sent?.message_id != null) {
      messageIds.push(sent.message_id);
    }
  }

  if (messageIds.length > 0) {
    saveRepoChatSession({
      ...session,
      updatedAt: new Date().toISOString(),
      messageRefs: appendMessageRefs(
        session.messageRefs,
        messageIds.map((messageId) => ({ chatId: params.chatId, messageId })),
      ),
    });
  }
  return true;
}

function runRepoChatInBackground(params: {
  bot: Bot;
  runtime: RuntimeEnv;
  chatId: number;
  threadId?: number;
  prompt: string;
  sourceMessageId: number;
  backend: RepoChatBackend;
  claudeCodeAuth?: ClaudeCodeAuthMode;
  existingSession?: RepoChatSession;
  workingDir: string;
}): void {
  const workingDir = params.existingSession?.workingDir ?? params.workingDir;
  const sessionId = params.existingSession?.id ?? crypto.randomUUID();
  const codexSandboxRunId =
    params.backend === "codex"
      ? (params.existingSession?.codexSandboxRunId ??
        `${CODEX_REPO_CHAT_SANDBOX_PREFIX}${sessionId}`)
      : undefined;
  void (async () => {
    try {
      const workerResult = await withChatAction({
        bot: params.bot,
        chatId: params.chatId,
        threadId: params.threadId,
        action: "typing",
        label: "repo-chat",
        fn: async () =>
          runRepoChatWorker({
            backend: params.backend,
            sessionId,
            prompt: params.prompt,
            workingDir,
            cliSessionId: params.existingSession?.cliSessionId,
            codexSandboxRunId,
            claudeCodeAuth: params.claudeCodeAuth,
          }),
      });
      const sentReply = await sendRepoChatReply({
        bot: params.bot,
        runtime: params.runtime,
        chatId: params.chatId,
        sessionId,
        text: workerResult.text,
        threadId: params.threadId,
        replyToMessageId: params.sourceMessageId,
      });
      const sessionMessageRefs: RepoChatSession["messageRefs"] = [
        { chatId: params.chatId, messageId: params.sourceMessageId },
        ...sentReply.messageIds.map((messageId) => ({
          chatId: params.chatId,
          messageId,
        })),
      ];
      const nextSession = buildNextRepoChatSession({
        sessionId,
        existingSession: params.existingSession,
        backend: params.backend,
        workingDir,
        cliSessionId: workerResult.cliSessionId,
        codexSandboxRunId,
        messageRefs: sessionMessageRefs,
        overflowReplies: sentReply.overflowReplies,
      });
      saveRepoChatSession(nextSession);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      params.runtime.error?.(danger(`telegram repo chat worker failed: ${message}`));
      const userMessage = sanitizeUserFacingText(message);
      await sendRepoChatReply({
        bot: params.bot,
        runtime: params.runtime,
        chatId: params.chatId,
        text: `Repo chat failed: ${userMessage}`,
        threadId: params.threadId,
        replyToMessageId: params.sourceMessageId,
      }).catch(() => undefined);
    }
  })();
}

function startRepoChat(params: {
  bot: Bot;
  runtime: RuntimeEnv;
  telegramCfg: TelegramAccountConfig;
  chatId: number;
  threadId?: number;
  sourceMessageId: number;
  prompt: string;
  replyToMessageId?: number;
  allowNewSessionWhenReplyMissing: boolean;
  claudeCodeAuth?: ClaudeCodeAuthMode;
}): StartRepoChatResult {
  const configuredBackend = params.telegramCfg.repoChatBackend;
  if (!isRepoChatBackend(configuredBackend)) {
    return { started: false, reason: "disabled" };
  }

  const existingSession =
    params.replyToMessageId != null
      ? findRepoChatSessionByMessageId({
          chatId: params.chatId,
          messageId: params.replyToMessageId,
        })
      : undefined;

  if (
    params.replyToMessageId != null &&
    !existingSession &&
    !params.allowNewSessionWhenReplyMissing
  ) {
    return { started: false, reason: "reply-session-not-found" };
  }

  const backend = existingSession?.backend ?? configuredBackend;
  runRepoChatInBackground({
    bot: params.bot,
    runtime: params.runtime,
    chatId: params.chatId,
    threadId: params.threadId,
    sourceMessageId: params.sourceMessageId,
    prompt: params.prompt,
    backend,
    claudeCodeAuth: params.claudeCodeAuth,
    existingSession,
    workingDir: path.resolve(process.cwd()),
  });
  return { started: true };
}

export function dispatchTelegramRepoChatForInboundText(params: {
  bot: Bot;
  runtime: RuntimeEnv;
  telegramCfg: TelegramAccountConfig;
  chatId: number;
  threadId?: number;
  prompt: string;
  sourceMessageId: number;
  replyToMessageId?: number;
  claudeCodeAuth?: ClaudeCodeAuthMode;
}): boolean {
  const result = startRepoChat({
    bot: params.bot,
    runtime: params.runtime,
    telegramCfg: params.telegramCfg,
    chatId: params.chatId,
    threadId: params.threadId,
    sourceMessageId: params.sourceMessageId,
    prompt: params.prompt,
    replyToMessageId: params.replyToMessageId,
    allowNewSessionWhenReplyMissing: false,
    claudeCodeAuth: params.claudeCodeAuth,
  });
  return result.started;
}

export function registerTelegramRepoChatCommands({
  bot,
  cfg,
  runtime,
  accountId,
  telegramCfg,
  allowFrom,
  groupAllowFrom,
  useAccessGroups,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
  commandFragmentBuffer,
}: RegisterRepoChatCommandsParams): void {
  async function authAndResolve(ctx: TelegramRepoChatCommandContext) {
    const msg = ctx.message;
    if (!msg) return null;
    if (shouldSkipUpdate(ctx)) return null;
    const auth = await resolveTelegramCommandAuth({
      msg,
      bot,
      cfg,
      telegramCfg,
      allowFrom,
      groupAllowFrom,
      useAccessGroups,
      resolveGroupPolicy,
      resolveTelegramGroupConfig,
      requireAuth: true,
    });
    if (!auth) return null;
    const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
    const threadIdForSend = auth.isGroup ? auth.resolvedThreadId : messageThreadId;
    const replyToMessageId = (msg as { reply_to_message?: { message_id?: number } })
      .reply_to_message?.message_id;
    return {
      chatId: auth.chatId,
      threadIdForSend,
      sourceMessageId: msg.message_id,
      replyToMessageId,
    };
  }

  bot.command(["repo_chat", "rc"], async (ctx: TelegramRepoChatCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;
    const prompt = ctx.match?.trim() ?? "";
    if (!prompt) {
      await sendRepoChatReply({
        bot,
        runtime,
        chatId: resolved.chatId,
        threadId: resolved.threadIdForSend,
        text: REPO_CHAT_USAGE,
        replyToMessageId: resolved.sourceMessageId,
      });
      return;
    }

    const runRepoChat = (textPrompt: string): boolean | Promise<boolean> => {
      const result = startRepoChat({
        bot,
        runtime,
        telegramCfg,
        chatId: resolved.chatId,
        threadId: resolved.threadIdForSend,
        sourceMessageId: resolved.sourceMessageId,
        prompt: textPrompt,
        replyToMessageId: resolved.replyToMessageId,
        allowNewSessionWhenReplyMissing: true,
        claudeCodeAuth: cfg.goal?.claudeCodeAuth,
      });
      if (!result.started && result.reason === "disabled") {
        return sendRepoChatReply({
          bot,
          runtime,
          chatId: resolved.chatId,
          threadId: resolved.threadIdForSend,
          text: REPO_CHAT_DISABLED_MESSAGE,
          replyToMessageId: resolved.sourceMessageId,
        }).then(() => false);
      }
      return result.started;
    };

    const msg = ctx.message;
    if (msg && commandFragmentBuffer && prompt) {
      const normalized = normalizeCommandFragmentParams(msg, accountId);
      const key = buildCommandFragmentKey({
        ...normalized,
        commandName: "repo_chat",
        replyToMessageId: resolved.replyToMessageId,
      });
      const nowMs = Date.now();
      if (commandFragmentBuffer.getPendingCommandName(key) === "repo_chat") {
        const appended = commandFragmentBuffer.tryAppend(key, msg.message_id, prompt, nowMs);
        if (appended) return;
      }
      if (commandFragmentBuffer.hasPending(key)) {
        await commandFragmentBuffer.cancelAndFlush(key);
      }
      commandFragmentBuffer.bufferCommand(key, {
        commandName: "repo_chat",
        text: prompt,
        firstMessageId: msg.message_id,
        receivedAtMs: nowMs,
        dispatch: {
          chatId: resolved.chatId,
          threadIdForSend: resolved.threadIdForSend,
          senderId: normalized.senderId,
          replyToMessageId: resolved.replyToMessageId,
          sourceMessageId: resolved.sourceMessageId,
          accountId,
        },
        flushCallback: async (combinedText) => {
          const started = await runRepoChat(combinedText);
          if (!started) return;
          const anchoredAtMs = Date.now();
          commandFragmentBuffer.setAnchor(key, {
            commandName: "repo_chat",
            anchoredAtMs,
            expiresAtMs: anchoredAtMs + commandFragmentBuffer.getAnchorTtlMs(),
            sourceMessageId: msg.message_id,
            appendHandler: async (appendedText) => {
              dispatchTelegramRepoChatForInboundText({
                bot,
                runtime,
                telegramCfg,
                chatId: resolved.chatId,
                threadId: resolved.threadIdForSend,
                prompt: appendedText,
                sourceMessageId: resolved.sourceMessageId,
                replyToMessageId: resolved.sourceMessageId,
                claudeCodeAuth: cfg.goal?.claudeCodeAuth,
              });
            },
          });
        },
      });
      return;
    }

    await runRepoChat(prompt);
  });

  bot.command("chat_backend", async (ctx: TelegramRepoChatCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;

    const parsedBackend = parseRepoChatBackend(ctx.match?.trim() ?? "");
    if (typeof parsedBackend === "undefined") {
      await sendRepoChatReply({
        bot,
        runtime,
        chatId: resolved.chatId,
        threadId: resolved.threadIdForSend,
        text: CHAT_BACKEND_USAGE,
        replyToMessageId: resolved.sourceMessageId,
      });
      return;
    }

    if (!resolveChannelConfigWrites({ cfg, channelId: "telegram", accountId })) {
      await sendRepoChatReply({
        bot,
        runtime,
        chatId: resolved.chatId,
        threadId: resolved.threadIdForSend,
        text: "Config writes are disabled for this Telegram account.",
        replyToMessageId: resolved.sourceMessageId,
      });
      return;
    }

    const nextConfig = loadConfig();
    setRepoChatBackendOnConfig({
      cfg: nextConfig,
      accountId,
      backend: parsedBackend,
    });
    await writeConfigFile(nextConfig);
    telegramCfg.repoChatBackend = parsedBackend;

    const confirmationText =
      parsedBackend == null
        ? "Repo chat backend disabled."
        : `Repo chat backend set to \`${parsedBackend}\`.`;

    await sendRepoChatReply({
      bot,
      runtime,
      chatId: resolved.chatId,
      threadId: resolved.threadIdForSend,
      text: confirmationText,
      replyToMessageId: resolved.sourceMessageId,
    });
  });
}
