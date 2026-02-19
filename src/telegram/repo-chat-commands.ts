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
  saveRepoChatSession,
} from "../repo-chat/repo-chat-store.js";
import type { RepoChatBackend, RepoChatSession } from "../repo-chat/types.js";
import { normalizeAccountId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  buildCommandFragmentKey,
  COMMAND_FRAGMENT_START_THRESHOLD,
  type CommandFragmentBuffer,
  normalizeCommandFragmentParams,
} from "./command-fragments.js";
import { markdownToTelegramChunks } from "./format.js";
import { withChatAction } from "./goal-commands.js";
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
  existingSession?: RepoChatSession;
  backend: RepoChatBackend;
  workingDir: string;
  cliSessionId?: string;
  messageRefs: RepoChatSession["messageRefs"];
}): RepoChatSession {
  const now = new Date().toISOString();
  const existing = params.existingSession;
  return {
    id: existing?.id ?? crypto.randomUUID(),
    backend: existing?.backend ?? params.backend,
    workingDir: existing?.workingDir ?? params.workingDir,
    cliSessionId: params.cliSessionId ?? existing?.cliSessionId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    messageRefs: appendMessageRefs(existing?.messageRefs ?? [], params.messageRefs),
  };
}

async function sendRepoChatReply(params: {
  bot: Bot;
  runtime: RuntimeEnv;
  chatId: number;
  text: string;
  threadId?: number;
  replyToMessageId: number;
}): Promise<number[]> {
  const markdown = params.text.trim() ? params.text : "No output.";
  const chunks = markdownToTelegramChunks(markdown, 4000);
  const messageIds: number[] = [];
  for (const chunk of chunks) {
    const threadParams = params.threadId != null ? { message_thread_id: params.threadId } : {};
    const sendParams = {
      parse_mode: "HTML" as const,
      link_preview_options: { is_disabled: true },
      reply_to_message_id: params.replyToMessageId,
      ...threadParams,
    };
    const fallbackParams = {
      link_preview_options: { is_disabled: true },
      reply_to_message_id: params.replyToMessageId,
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
  return messageIds;
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
            prompt: params.prompt,
            workingDir,
            cliSessionId: params.existingSession?.cliSessionId,
            claudeCodeAuth: params.claudeCodeAuth,
          }),
      });
      const sentMessageIds = await sendRepoChatReply({
        bot: params.bot,
        runtime: params.runtime,
        chatId: params.chatId,
        text: workerResult.text,
        threadId: params.threadId,
        replyToMessageId: params.sourceMessageId,
      });
      const sessionMessageRefs: RepoChatSession["messageRefs"] = [
        { chatId: params.chatId, messageId: params.sourceMessageId },
        ...sentMessageIds.map((messageId) => ({
          chatId: params.chatId,
          messageId,
        })),
      ];
      const nextSession = buildNextRepoChatSession({
        existingSession: params.existingSession,
        backend: params.backend,
        workingDir,
        cliSessionId: workerResult.cliSessionId,
        messageRefs: sessionMessageRefs,
      });
      saveRepoChatSession(nextSession);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      params.runtime.error?.(danger(`telegram repo chat worker failed: ${message}`));
      await sendRepoChatReply({
        bot: params.bot,
        runtime: params.runtime,
        chatId: params.chatId,
        text: `Repo chat failed: ${message}`,
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

    const runRepoChat = (textPrompt: string) => {
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
        });
      }
      return undefined;
    };

    const msg = ctx.message;
    if (
      msg &&
      commandFragmentBuffer &&
      (msg.text ?? "").length >= COMMAND_FRAGMENT_START_THRESHOLD
    ) {
      const normalized = normalizeCommandFragmentParams(msg, accountId);
      const key = buildCommandFragmentKey(normalized);
      if (commandFragmentBuffer.hasPending(key)) {
        await commandFragmentBuffer.cancelAndFlush(key);
      }
      const rawCommand = (msg.text ?? "").trim().slice(1).split(/\s+/, 1)[0] ?? "";
      const commandName = rawCommand.split("@")[0] || "repo_chat";
      commandFragmentBuffer.bufferCommand(key, {
        commandName,
        text: prompt,
        firstMessageId: msg.message_id,
        receivedAtMs: Date.now(),
        dispatch: {
          chatId: resolved.chatId,
          threadIdForSend: resolved.threadIdForSend,
          senderId: normalized.senderId,
          replyToMessageId: resolved.replyToMessageId,
          sourceMessageId: resolved.sourceMessageId,
          accountId,
        },
        flushCallback: async (combinedText) => {
          await runRepoChat(combinedText);
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
