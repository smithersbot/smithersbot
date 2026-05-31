// @ts-nocheck
import { hasControlCommand, isControlCommandMessage } from "../auto-reply/command-detection.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../auto-reply/inbound-debounce.js";
import { buildCommandsPaginationKeyboard } from "../auto-reply/reply/commands-info.js";
import { buildCommandsMessagePaginated } from "../auto-reply/status.js";
import { listSkillCommandsForAgents } from "../auto-reply/skill-commands.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { formatCliCommand } from "../cli/command-format.js";
import { loadConfig } from "../config/config.js";
import { writeConfigFile } from "../config/io.js";
import { danger, logVerbose, warn } from "../globals.js";
import type { SerializedRun } from "../goal/types.js";
import { resolveMedia } from "./bot/delivery.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { resolveTelegramForumThreadId } from "./bot/helpers.js";
import type { TelegramMessage } from "./bot/types.js";
import {
  firstDefined,
  isSenderAllowed,
  normalizeAllowFromWithStore,
  resolveSenderAllowMatch,
} from "./bot-access.js";
import { MEDIA_GROUP_TIMEOUT_MS, type MediaGroupEntry } from "./bot-updates.js";
import { acquireGoalOpLock } from "../goal/goal-lock.js";
import { applyGoalResumeNoteById } from "../commands/goal-resume-note.js";
import {
  formatGoalLockedMessage,
  buildOnStatusChange,
  handleGoalEdit,
  handleGoalFeedback,
  handleGoalList,
  handleGoalStatus,
  runGoalInBackground,
  sendGoalPlanResult,
  sendGoalReply,
  sendGoalStatusResponse,
} from "./goal-commands.js";
import type { GoalPlanResult } from "./goal-commands.js";
import { routeTelegramText } from "./goal-router.js";
import { migrateTelegramGroupConfig } from "./group-migration.js";
import { resolveTelegramInlineButtonsScope } from "./inline-buttons.js";
import { readTelegramAllowFromStore, upsertTelegramPairingRequest } from "./pairing-store.js";
import { dispatchTelegramRepoChatForInboundText } from "./repo-chat-commands.js";
import { findRepoChatSessionByMessageId } from "../repo-chat/repo-chat-store.js";
import { resolveChannelConfigWrites } from "../channels/plugins/config-writes.js";
import { buildInlineKeyboard } from "./send.js";
import { listRuns, loadRun } from "../goal/run-store.js";
import {
  buildCommandFragmentKey,
  clampCommandFragmentGapMs,
  COMMAND_FRAGMENT_MAX_GAP_MS,
  type CommandAnchor,
  normalizeCommandFragmentParams,
} from "./command-fragments.js";

const GOAL_HELP_MESSAGE = [
  "SmithersBot goal mode:",
  "",
  "• /new_goal <description> — create a plan",
  "• Approve: use buttons on the plan, react ❤️/👍, or /goal_approve <id>",
  "• Reject: use 👎 button, react 👎, or /goal_reject <id>",
  "• Edit: reply to the plan message with instructions",
  "• Answer: reply to a question message, or /goal_answer <id> <answer>",
  "• Feedback: reply to the feedback prompt, or /goal_feedback <id> <feedback>",
  "",
  'Ask about goals: "list goals", "status", /goal_list, /goal_status <id>',
].join("\n");

// ---------------------------------------------------------------------------
// Deterministic local intent handlers (no LLM)
// ---------------------------------------------------------------------------

export type TelegramChatMode = "help" | "chat";

const RUN_ID_PREFIX_RE = /^[a-f0-9]{8}$/;

// A) GOAL_LIST: exact phrases or "list" + "goal"/"run" within 30 chars
const GOAL_LIST_EXACT = new Set(["list goals", "goals", "goal list", "runs", "list runs"]);

function isGoalListIntent(text: string): boolean {
  const stripped = text.trim().toLowerCase();
  if (GOAL_LIST_EXACT.has(stripped)) return true;
  return /\blist\b/i.test(text) && /\b(goal|run)s?\b/i.test(text) && text.trim().length <= 60;
}

// B) GOAL_STATUS: bare 8-hex-char run ID, or optional-leading-slash command aliases.
function matchGoalStatusIntent(text: string): string | undefined {
  const trimmed = text.trim();
  if (RUN_ID_PREFIX_RE.test(trimmed)) return trimmed;
  const m = /^\/?(?:status|goal_status|run)\s+([a-f0-9]{8})$/i.exec(trimmed);
  return m ? m[1]! : undefined;
}

// C) APPROVAL_GUIDANCE: deterministic regex, never actually approves
const APPROVAL_LIKE_RE =
  /^(approve|approved|approve\s*it|go\s*ahead|lgtm|ship\s*it|yes\s*,?\s*approve|approve\s+(?:that\s+)?(?:the\s+)?(?:last\s+one|latest|most\s+recent))$/i;

function isApprovalLikeText(text: string): boolean {
  return APPROVAL_LIKE_RE.test(text.trim().replace(/[!.]+$/, ""));
}

/**
 * Try all deterministic local intents. Returns reply text if matched, undefined otherwise.
 * Intents A-C never call the LLM.
 */
async function tryLocalIntentHandlers(
  messageText: string,
  runs: SerializedRun[],
): Promise<string | undefined> {
  // A) GOAL_LIST
  if (isGoalListIntent(messageText)) {
    return await handleGoalList();
  }

  // B) GOAL_STATUS
  const statusId = matchGoalStatusIntent(messageText);
  if (statusId) {
    return await handleGoalStatus(statusId);
  }

  // C) APPROVAL_GUIDANCE (never approves)
  if (isApprovalLikeText(messageText)) {
    const awaitingRuns = runs.filter((r) => r.state === "awaiting_approval");
    if (awaitingRuns.length === 1) {
      const shortId = awaitingRuns[0]!.runId.slice(0, 8);
      return `To approve run \`${shortId}\`, use the Approve button on the plan, react 👍 or ❤️ to the plan message, or run /goal_approve ${shortId}`;
    }
    if (awaitingRuns.length > 1) {
      const ids = awaitingRuns
        .slice(0, 5)
        .map((r) => `\`${r.runId.slice(0, 8)}\``)
        .join(", ");
      return `${awaitingRuns.length} runs awaiting approval: ${ids}\nUse /goal_list to see all, then /goal_approve <id> to approve.`;
    }
    return "Nothing is awaiting approval right now. Use /goal_list to see runs.";
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Goal routing handler
// ---------------------------------------------------------------------------

export async function handleTelegramGoalRouting(params: {
  chatId: number;
  threadId?: number;
  messageText: string;
  replyToMessageId?: number;
  runs: SerializedRun[];
  chatMode: TelegramChatMode;
  suppressChatHelpFallback?: boolean;
  suppressBlockedHintReply?: boolean;
  sendReply: (text: string) => Promise<void>;
  sendPlanResult: (result: GoalPlanResult) => Promise<void>;
  runHandlers: {
    edit: (runId: string, text: string) => void;
    answer: (runId: string, text: string, source?: "add_details" | "direct_reply") => void;
    feedback?: (runId: string, text: string) => void;
  };
}): Promise<boolean> {
  const suppressChatHelpFallback = params.suppressChatHelpFallback === true;
  const suppressBlockedHintReply = params.suppressBlockedHintReply === true;
  const route = routeTelegramText({
    chatId: params.chatId,
    threadId: params.threadId,
    messageText: params.messageText,
    replyToMessageId: params.replyToMessageId,
    runs: params.runs,
  });

  if (route.kind === "CHAT_HELP") {
    if (suppressChatHelpFallback) return false;
    await params.sendReply(GOAL_HELP_MESSAGE);
    return true;
  }

  if (route.kind === "DISAMBIGUATE") {
    await params.sendReply(route.replyText ?? "Reply to the latest plan or question message.");
    return true;
  }

  // GOAL_NOTICE: a reply to a tracked goal/task message that can't be used as an
  // answer (paused run, or a done/stale notification). Always handled by the goal
  // path — returning true here prevents any fall-through to repo-chat or the
  // embedded agent.
  if (route.kind === "GOAL_NOTICE") {
    await params.sendReply(
      route.replyText ?? "That goal message isn't waiting on a reply right now.",
    );
    return true;
  }

  if (route.kind === "CHAT") {
    // Try deterministic local intent handlers (A-C). Never calls LLM.
    const localReply = await tryLocalIntentHandlers(params.messageText, params.runs);
    if (localReply) {
      await params.sendReply(localReply);
      return true;
    }

    // Blocked-run hint (from router)
    if (route.replyText && !suppressBlockedHintReply) {
      await params.sendReply(route.replyText);
    }

    // E) FALLBACK: in "help" mode, always reply with help message (never fall through to LLM)
    if (params.chatMode === "help") {
      if (suppressChatHelpFallback) return false;
      await params.sendReply(GOAL_HELP_MESSAGE);
      return true;
    }

    // "chat" mode: fall through to LLM for non-goal text
    return false;
  }

  if (route.kind === "GOAL_EDIT" && route.runId) {
    params.runHandlers.edit(route.runId, params.messageText);
    return true;
  }

  if (route.kind === "GOAL_ANSWER" && route.runId) {
    params.runHandlers.answer(route.runId, params.messageText, route.resumeSource);
    return true;
  }

  if (route.kind === "GOAL_FEEDBACK" && route.runId) {
    params.runHandlers.feedback?.(route.runId, params.messageText);
    return true;
  }

  return false;
}

function isRepoChatBackendEnabled(
  backend: "codex" | "claude_code" | null | undefined,
): backend is "codex" | "claude_code" {
  return backend === "codex" || backend === "claude_code";
}

export function shouldRouteTelegramTextToRepoChat(params: {
  repoChatBackend: "codex" | "claude_code" | null | undefined;
  replyToMessageId?: number;
  commandFragmentBuffer?: {
    getAnchor: (key: string) => unknown;
  };
  accountId?: string;
  chatId?: number;
  threadId?: number;
  senderId?: string;
}): boolean {
  if (!isRepoChatBackendEnabled(params.repoChatBackend) || params.replyToMessageId != null) {
    return false;
  }

  if (
    params.commandFragmentBuffer &&
    params.accountId &&
    params.chatId != null &&
    params.senderId
  ) {
    for (const commandName of ["new_goal", "repo_chat"] as const) {
      const commandKey = buildCommandFragmentKey({
        accountId: params.accountId,
        chatId: params.chatId,
        resolvedThreadId: params.threadId,
        senderId: params.senderId,
        commandName,
      });
      if (params.commandFragmentBuffer.getAnchor(commandKey)) {
        return false;
      }
    }
  }

  return true;
}

export const registerTelegramHandlers = ({
  cfg,
  accountId,
  bot,
  opts,
  runtime,
  mediaMaxBytes,
  telegramCfg,
  allowFrom,
  groupAllowFrom,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
  processMessage,
  logger,
  commandFragmentBuffer,
}) => {
  const TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS = 4000;
  // Mirror command-fragment buffering so long Telegram pastes have one timeout policy.
  const TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS = clampCommandFragmentGapMs(
    telegramCfg.commandFragmentMaxGapMs ?? COMMAND_FRAGMENT_MAX_GAP_MS,
  );
  // Allow up to 4 intervening messages (bot replies, service messages) between user-sent chunks.
  // The configured time gap is the primary guard against false matches.
  const TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP = 5;
  const TELEGRAM_TEXT_FRAGMENT_MAX_PARTS = 12;
  const TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS = 50_000;

  const mediaGroupBuffer = new Map<string, MediaGroupEntry>();
  let mediaGroupProcessing: Promise<void> = Promise.resolve();

  type TextFragmentEntry = {
    key: string;
    messages: Array<{ msg: TelegramMessage; ctx: unknown; receivedAtMs: number }>;
    timer: ReturnType<typeof setTimeout>;
  };
  const textFragmentBuffer = new Map<string, TextFragmentEntry>();
  let textFragmentProcessing: Promise<void> = Promise.resolve();
  type PendingCommandAnchorText = {
    text: string;
    key: string;
    expiresAtMs: number;
  };
  const pendingCommandAnchorTexts = new Map<string, PendingCommandAnchorText>();
  const goalRouterEnabled = telegramCfg.goalRouter !== false;
  const logTextFragmentDebug = (message: string, fields: Record<string, unknown>) => {
    logger.debug?.(fields, message);
  };

  function pruneExpiredCommandAnchorTexts(nowMs: number = Date.now()): void {
    for (const [id, pending] of pendingCommandAnchorTexts) {
      if (nowMs >= pending.expiresAtMs) {
        pendingCommandAnchorTexts.delete(id);
      }
    }
  }

  function createCommandAnchorPendingId(): string {
    pruneExpiredCommandAnchorTexts();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = Math.random().toString(36).slice(2, 10);
      if (id.length > 0 && !pendingCommandAnchorTexts.has(id)) return id;
    }
    return Date.now().toString(36).slice(-8);
  }

  function resolveLiveCommandAnchor(params: {
    chatId: number;
    threadId?: number;
    senderId: string;
  }): { key: string; anchor: CommandAnchor } | undefined {
    if (!commandFragmentBuffer) return undefined;
    // Mirror /new_goal: resolve live anchors for both /new_goal and /repo_chat so a late
    // paste tail (after the buffer flushed) routes to append/new/ignore instead of falling
    // through to a brand-new repo-chat launch.
    for (const commandName of ["new_goal", "repo_chat"] as const) {
      const key = buildCommandFragmentKey({
        accountId,
        chatId: params.chatId,
        resolvedThreadId: params.threadId,
        senderId: params.senderId,
        commandName,
      });
      const anchor = commandFragmentBuffer.getAnchor(key) as CommandAnchor | undefined;
      if (anchor) return { key, anchor };
    }
    return undefined;
  }

  async function promptForCommandAnchorFollowUp(params: {
    chatId: number;
    threadId?: number;
    text: string;
    key: string;
    anchor: CommandAnchor;
  }): Promise<void> {
    const shortId = createCommandAnchorPendingId();
    pendingCommandAnchorTexts.set(shortId, {
      text: params.text,
      key: params.key,
      expiresAtMs: params.anchor.expiresAtMs,
    });
    logger.info?.(
      { key: params.key, commandName: params.anchor.commandName, choice: "prompted" },
      "telegram command anchor surfaced follow-up",
    );
    const commandLabel = `/${params.anchor.commandName}`;
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime,
      fn: () =>
        bot.api.sendMessage(
          params.chatId,
          `This looks like more text for ${commandLabel}. What should I do with it?`,
          {
            ...(params.threadId != null ? { message_thread_id: params.threadId } : {}),
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: `append to ${commandLabel}`,
                    callback_data: `cmd_anchor:append:${shortId}`,
                  },
                ],
                [
                  {
                    text: "start new chat",
                    callback_data: `cmd_anchor:new:${shortId}`,
                  },
                  {
                    text: "ignore",
                    callback_data: `cmd_anchor:ignore:${shortId}`,
                  },
                ],
              ],
            },
          },
        ),
    });
  }

  async function replyToCommandAnchorCallback(params: {
    chatId: number;
    threadId?: number;
    text: string;
  }): Promise<void> {
    const options = params.threadId != null ? { message_thread_id: params.threadId } : undefined;
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime,
      fn: () => bot.api.sendMessage(params.chatId, params.text, options),
    });
  }

  async function handleCommandAnchorCallback(params: {
    data: string;
    callbackMessage: TelegramMessage;
    threadId?: number;
  }): Promise<boolean> {
    const match = params.data.match(/^cmd_anchor:(append|new|ignore):([a-z0-9]{1,8})$/);
    if (!match) return false;

    const choice = match[1] as "append" | "new" | "ignore";
    const shortId = match[2];
    pruneExpiredCommandAnchorTexts();
    const pending = pendingCommandAnchorTexts.get(shortId);
    const chatId = params.callbackMessage.chat.id;

    if (!pending) {
      await replyToCommandAnchorCallback({
        chatId,
        threadId: params.threadId,
        text: "That follow-up expired. Send it again if you still want me to use it.",
      });
      return true;
    }

    const anchor = commandFragmentBuffer?.getAnchor(pending.key);
    if (!anchor) {
      pendingCommandAnchorTexts.delete(shortId);
      await replyToCommandAnchorCallback({
        chatId,
        threadId: params.threadId,
        text: "That command window expired. Send it again if you still want me to use it.",
      });
      return true;
    }

    if (choice === "append") {
      await anchor.appendHandler(pending.text);
      pendingCommandAnchorTexts.delete(shortId);
      logger.info?.(
        { key: pending.key, commandName: anchor.commandName, choice },
        "telegram command anchor follow-up selected",
      );
      return true;
    }

    pendingCommandAnchorTexts.delete(shortId);
    commandFragmentBuffer?.clearAnchor(pending.key);
    logger.info?.(
      { key: pending.key, commandName: anchor.commandName, choice },
      "telegram command anchor follow-up selected",
    );

    if (choice === "new") {
      dispatchTelegramRepoChatForInboundText({
        bot,
        runtime,
        telegramCfg,
        claudeCodeAuth: cfg.goal?.claudeCodeAuth,
        chatId,
        threadId: params.threadId,
        prompt: pending.text,
        sourceMessageId: params.callbackMessage.message_id,
        replyToMessageId: undefined,
      });
    }

    return true;
  }

  const debounceMs = resolveInboundDebounceMs({ cfg, channel: "telegram" });
  type TelegramDebounceEntry = {
    ctx: unknown;
    msg: TelegramMessage;
    allMedia: Array<{ path: string; contentType?: string }>;
    storeAllowFrom: string[];
    debounceKey: string | null;
    botUsername?: string;
  };
  const inboundDebouncer = createInboundDebouncer<TelegramDebounceEntry>({
    debounceMs,
    buildKey: (entry) => entry.debounceKey,
    shouldDebounce: (entry) => {
      if (entry.allMedia.length > 0) return false;
      const text = entry.msg.text ?? entry.msg.caption ?? "";
      if (!text.trim()) return false;
      return !hasControlCommand(text, cfg, { botUsername: entry.botUsername });
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) return;
      if (entries.length === 1) {
        await processMessage(last.ctx, last.allMedia, last.storeAllowFrom);
        return;
      }
      const combinedText = entries
        .map((entry) => entry.msg.text ?? entry.msg.caption ?? "")
        .filter(Boolean)
        .join("\n");
      if (!combinedText.trim()) return;
      const first = entries[0];
      const baseCtx = first.ctx as { me?: unknown; getFile?: unknown } & Record<string, unknown>;
      const getFile =
        typeof baseCtx.getFile === "function" ? baseCtx.getFile.bind(baseCtx) : async () => ({});
      const syntheticMessage: TelegramMessage = {
        ...first.msg,
        text: combinedText,
        caption: undefined,
        caption_entities: undefined,
        entities: undefined,
        date: last.msg.date ?? first.msg.date,
      };
      const messageIdOverride = last.msg.message_id ? String(last.msg.message_id) : undefined;
      await processMessage(
        { message: syntheticMessage, me: baseCtx.me, getFile },
        [],
        first.storeAllowFrom,
        messageIdOverride ? { messageIdOverride } : undefined,
      );
    },
    onError: (err) => {
      runtime.error?.(danger(`telegram debounce flush failed: ${String(err)}`));
    },
  });

  function resolveThreadIdForRouting(params: {
    isGroup: boolean;
    messageThreadId?: number;
    isForum: boolean;
  }): number | undefined {
    if (params.isGroup) {
      return resolveTelegramForumThreadId({
        isForum: params.isForum,
        messageThreadId: params.messageThreadId,
      });
    }
    return params.messageThreadId;
  }

  function matchesChatThread(
    msg: { chatId: number; threadId?: number } | undefined,
    targetChatId: number,
    targetThreadId?: number,
  ): boolean {
    if (!msg) return false;
    if (msg.chatId !== targetChatId) return false;
    if (typeof targetThreadId === "number") return msg.threadId === targetThreadId;
    return typeof msg.threadId !== "number";
  }

  function loadRunsForChatThread(chatId: number, threadId?: number): SerializedRun[] {
    return listRuns()
      .map((summary) => loadRun(summary.runId))
      .filter((run): run is SerializedRun => Boolean(run))
      .filter((run) => {
        if (matchesChatThread(run.telegramPlanMessage, chatId, threadId)) return true;
        if (run.telegramQuestionMessages?.some((qm) => matchesChatThread(qm, chatId, threadId))) {
          return true;
        }
        if (run.telegramEditPromptMessages?.some((ep) => matchesChatThread(ep, chatId, threadId))) {
          return true;
        }
        if (matchesChatThread(run.telegramDoneMessage, chatId, threadId)) return true;
        if (
          run.telegramFeedbackPromptMessages?.some((fp) => matchesChatThread(fp, chatId, threadId))
        ) {
          return true;
        }
        return false;
      });
  }

  async function ensureTelegramDmPolicy(params: {
    msg: TelegramMessage;
    chatId: number;
    storeAllowFrom: string[];
  }): Promise<boolean> {
    const dmPolicy = telegramCfg.dmPolicy ?? "pairing";
    if (dmPolicy === "disabled") return false;
    if (dmPolicy === "open") return true;
    const candidate = String(params.chatId);
    const senderUsername = params.msg.from?.username ?? "";
    const effectiveDmAllow = normalizeAllowFromWithStore({
      allowFrom,
      storeAllowFrom: params.storeAllowFrom,
    });
    const allowMatch = resolveSenderAllowMatch({
      allow: effectiveDmAllow,
      senderId: candidate,
      senderUsername,
    });
    const allowed =
      effectiveDmAllow.hasWildcard || (effectiveDmAllow.hasEntries && allowMatch.allowed);
    if (allowed) return true;
    if (dmPolicy === "pairing") {
      try {
        const from = params.msg.from as
          | {
              first_name?: string;
              last_name?: string;
              username?: string;
              id?: number;
            }
          | undefined;
        const telegramUserId = from?.id ? String(from.id) : candidate;
        const { code, created } = await upsertTelegramPairingRequest({
          chatId: candidate,
          username: from?.username,
          firstName: from?.first_name,
          lastName: from?.last_name,
        });
        if (created) {
          await withTelegramApiErrorLogging({
            operation: "sendMessage",
            fn: () =>
              bot.api.sendMessage(
                params.chatId,
                [
                  "SmithersBot: access not configured.",
                  "",
                  `Your Telegram user id: ${telegramUserId}`,
                  "",
                  `Pairing code: ${code}`,
                  "",
                  "Ask the bot owner to approve with:",
                  formatCliCommand("moltbot pairing approve telegram <code>"),
                ].join("\n"),
              ),
          });
        }
      } catch (err) {
        logVerbose(`telegram pairing reply failed for chat ${params.chatId}: ${String(err)}`);
      }
      return false;
    }
    logVerbose(
      `Blocked unauthorized telegram sender ${candidate} (dmPolicy=${dmPolicy}, matchKey=${allowMatch.matchKey ?? "none"})`,
    );
    return false;
  }

  async function routeTelegramTextMessage(params: {
    msg: TelegramMessage;
    text: string;
    threadId?: number;
  }): Promise<boolean> {
    const chatId = params.msg.chat.id;
    const sourceMessageId = params.msg.message_id;
    const replyToMessageId = (params.msg as { reply_to_message?: { message_id?: number } })
      .reply_to_message?.message_id;
    const repoChatEnabled = isRepoChatBackendEnabled(telegramCfg.repoChatBackend);

    const bufferLongFreeformRoute = async (bufferParams: {
      commandName: "repo_chat" | "goal_answer" | "goal_feedback" | "goal_edit";
      runId?: string;
      replyToMessageId?: number;
      text: string;
      flushCallback: (combinedText: string) => void | Promise<void>;
    }): Promise<boolean> => {
      if (!commandFragmentBuffer) return false;
      const normalized = normalizeCommandFragmentParams(params.msg, accountId);
      const key = buildCommandFragmentKey({
        ...normalized,
        commandName: bufferParams.commandName,
        runId: bufferParams.runId,
        replyToMessageId: bufferParams.replyToMessageId,
      });
      const nowMs = Date.now();
      if (commandFragmentBuffer.getPendingCommandName(key) === bufferParams.commandName) {
        const appended = commandFragmentBuffer.tryAppend(
          key,
          sourceMessageId,
          bufferParams.text,
          nowMs,
        );
        if (appended) return true;
      }
      if (commandFragmentBuffer.hasPending(key)) {
        await commandFragmentBuffer.cancelAndFlush(key);
      }
      if (bufferParams.text.trimStart().startsWith("/")) return false;
      commandFragmentBuffer.bufferCommand(key, {
        commandName: bufferParams.commandName,
        text: bufferParams.text,
        firstMessageId: sourceMessageId,
        receivedAtMs: nowMs,
        dispatch: {
          chatId,
          threadIdForSend: params.threadId,
          senderId: normalized.senderId,
          replyToMessageId: bufferParams.replyToMessageId,
          sourceMessageId,
          accountId,
        },
        flushCallback: bufferParams.flushCallback,
      });
      return true;
    };

    if (replyToMessageId != null && repoChatEnabled) {
      const repoChatSession = findRepoChatSessionByMessageId({
        chatId,
        messageId: replyToMessageId,
      });
      if (repoChatSession) {
        const buffered = await bufferLongFreeformRoute({
          commandName: "repo_chat",
          replyToMessageId,
          text: params.text,
          flushCallback: (combinedText) =>
            dispatchTelegramRepoChatForInboundText({
              bot,
              runtime,
              telegramCfg,
              claudeCodeAuth: cfg.goal?.claudeCodeAuth,
              chatId,
              threadId: params.threadId,
              prompt: combinedText,
              sourceMessageId,
              replyToMessageId,
            }),
        });
        if (buffered) return true;
        return dispatchTelegramRepoChatForInboundText({
          bot,
          runtime,
          telegramCfg,
          claudeCodeAuth: cfg.goal?.claudeCodeAuth,
          chatId,
          threadId: params.threadId,
          prompt: params.text,
          sourceMessageId: params.msg.message_id,
          replyToMessageId,
        });
      }
    }

    // Deterministic routing for free-text chat mode:
    // non-command + non-reply text goes directly to repo chat when backend is enabled.
    if (
      shouldRouteTelegramTextToRepoChat({
        repoChatBackend: telegramCfg.repoChatBackend,
        replyToMessageId,
        commandFragmentBuffer,
        accountId,
        chatId,
        threadId: params.threadId,
        senderId: String(params.msg.from?.id ?? "unknown"),
      })
    ) {
      const buffered = await bufferLongFreeformRoute({
        commandName: "repo_chat",
        replyToMessageId,
        text: params.text,
        flushCallback: (combinedText) =>
          dispatchTelegramRepoChatForInboundText({
            bot,
            runtime,
            telegramCfg,
            claudeCodeAuth: cfg.goal?.claudeCodeAuth,
            chatId,
            threadId: params.threadId,
            prompt: combinedText,
            sourceMessageId,
            replyToMessageId,
          }),
      });
      if (buffered) return true;
      return dispatchTelegramRepoChatForInboundText({
        bot,
        runtime,
        telegramCfg,
        claudeCodeAuth: cfg.goal?.claudeCodeAuth,
        chatId,
        threadId: params.threadId,
        prompt: params.text,
        sourceMessageId: params.msg.message_id,
        replyToMessageId,
      });
    }

    const liveCommandAnchor =
      repoChatEnabled && replyToMessageId == null
        ? resolveLiveCommandAnchor({
            chatId,
            threadId: params.threadId,
            senderId: String(params.msg.from?.id ?? "unknown"),
          })
        : undefined;
    if (liveCommandAnchor) {
      await promptForCommandAnchorFollowUp({
        chatId,
        threadId: params.threadId,
        text: params.text,
        key: liveCommandAnchor.key,
        anchor: liveCommandAnchor.anchor,
      });
      return true;
    }

    const statusId = matchGoalStatusIntent(params.text);
    if (statusId) {
      await sendGoalStatusResponse({
        bot,
        chatId,
        threadId: params.threadId,
        runtime,
        rawId: statusId,
        replyToMessageId: sourceMessageId,
      });
      return true;
    }
    const runs = loadRunsForChatThread(chatId, params.threadId);

    const handledByGoalRouting = await handleTelegramGoalRouting({
      chatId,
      threadId: params.threadId,
      messageText: params.text,
      replyToMessageId,
      runs,
      chatMode: telegramCfg.chatMode ?? "help",
      suppressChatHelpFallback: repoChatEnabled,
      suppressBlockedHintReply: repoChatEnabled,
      sendReply: async (text) => {
        await sendGoalReply(bot, chatId, text, runtime, params.threadId, sourceMessageId);
      },
      sendPlanResult: async (result) => {
        await sendGoalPlanResult({
          bot,
          chatId,
          runtime,
          result,
          threadId: params.threadId,
          replyToMessageId: sourceMessageId,
        });
      },
      runHandlers: {
        edit: (runId, text) => {
          // Buffer split "Request changes" / GOAL_EDIT fragments BEFORE taking the edit
          // lock, mirroring goal_answer. Acquiring the lock per-fragment would make the
          // second split chunk surface "already being processed (edit)". The lock is only
          // taken once, after the combined edit text flushes.
          const dispatchEdit = (editText: string) => {
            const editLock = acquireGoalOpLock(runId, "edit");
            if (!editLock.acquired) {
              void sendGoalReply(
                bot,
                chatId,
                formatGoalLockedMessage(runId, editLock.existingLabel),
                runtime,
                params.threadId,
                sourceMessageId,
              );
              return;
            }
            runGoalInBackground({
              bot,
              chatId,
              threadId: params.threadId,
              runtime,
              label: "goal-router:edit",
              replyToMessageId: sourceMessageId,
              releaseGoalLock: editLock.release,
              fn: () => handleGoalEdit(runId, editText, cfg),
              onResult: async (result) => {
                if (result == null) return;
                if (typeof result === "string") {
                  await sendGoalReply(
                    bot,
                    chatId,
                    result,
                    runtime,
                    params.threadId,
                    sourceMessageId,
                  );
                } else {
                  await sendGoalPlanResult({
                    bot,
                    chatId,
                    runtime,
                    result,
                    threadId: params.threadId,
                    replyToMessageId: sourceMessageId,
                  });
                }
              },
            });
          };

          if (replyToMessageId != null) {
            void bufferLongFreeformRoute({
              commandName: "goal_edit",
              runId,
              replyToMessageId,
              text,
              flushCallback: (combinedText) => dispatchEdit(combinedText),
            }).then((buffered) => {
              if (!buffered) dispatchEdit(text);
            });
            return;
          }

          dispatchEdit(text);
        },
        answer: (runId, text, source = "direct_reply") => {
          const dispatchAnswer = (answerText: string) => {
            const result = applyGoalResumeNoteById({
              runId,
              source,
              userText: answerText,
            });
            void sendGoalReply(
              bot,
              chatId,
              result.message,
              runtime,
              params.threadId,
              sourceMessageId,
            );
          };

          if (replyToMessageId != null) {
            void bufferLongFreeformRoute({
              commandName: "goal_answer",
              runId,
              replyToMessageId,
              text,
              flushCallback: (combinedText) => dispatchAnswer(combinedText),
            }).then((buffered) => {
              if (!buffered) dispatchAnswer(text);
            });
            return;
          }

          dispatchAnswer(text);
        },
        feedback: (runId, text) => {
          const dispatchFeedback = (feedbackText: string) => {
            const feedbackLock = acquireGoalOpLock(runId, "feedback");
            if (!feedbackLock.acquired) {
              void sendGoalReply(
                bot,
                chatId,
                formatGoalLockedMessage(runId, feedbackLock.existingLabel),
                runtime,
                params.threadId,
                sourceMessageId,
              );
              return;
            }
            runGoalInBackground({
              bot,
              chatId,
              threadId: params.threadId,
              runtime,
              label: "goal-router:feedback",
              replyToMessageId: sourceMessageId,
              releaseGoalLock: feedbackLock.release,
              fn: () => {
                const statusCb = buildOnStatusChange({
                  bot,
                  chatId,
                  threadId: params.threadId,
                  runtime,
                  runId,
                });
                return handleGoalFeedback(runId, feedbackText, cfg, statusCb);
              },
              onResult: async (result) => {
                if (result == null) return;
                if (typeof result === "string") {
                  await sendGoalReply(
                    bot,
                    chatId,
                    result,
                    runtime,
                    params.threadId,
                    sourceMessageId,
                  );
                } else {
                  await sendGoalPlanResult({
                    bot,
                    chatId,
                    runtime,
                    result,
                    threadId: params.threadId,
                    replyToMessageId: sourceMessageId,
                  });
                }
              },
            });
          };

          if (commandFragmentBuffer && replyToMessageId != null) {
            const normalized = normalizeCommandFragmentParams(params.msg, accountId);
            const key = buildCommandFragmentKey({
              ...normalized,
              commandName: "goal_feedback",
              runId,
              replyToMessageId,
            });
            const nowMs = Date.now();
            if (commandFragmentBuffer.getPendingCommandName(key) === "goal_feedback") {
              const appended = commandFragmentBuffer.tryAppend(key, sourceMessageId, text, nowMs);
              if (appended) return;
            }
            if (commandFragmentBuffer.hasPending(key)) {
              void commandFragmentBuffer.cancelAndFlush(key);
              return;
            }
            commandFragmentBuffer.bufferCommand(key, {
              commandName: "goal_feedback",
              text,
              firstMessageId: sourceMessageId,
              receivedAtMs: nowMs,
              dispatch: {
                chatId,
                threadIdForSend: params.threadId,
                senderId: normalized.senderId,
                replyToMessageId,
                sourceMessageId,
                accountId,
              },
              flushCallback: (combinedText) => dispatchFeedback(combinedText),
            });
            return;
          }

          dispatchFeedback(text);
        },
      },
    });
    if (handledByGoalRouting) return true;

    return dispatchTelegramRepoChatForInboundText({
      bot,
      runtime,
      telegramCfg,
      claudeCodeAuth: cfg.goal?.claudeCodeAuth,
      chatId,
      threadId: params.threadId,
      prompt: params.text,
      sourceMessageId: params.msg.message_id,
      replyToMessageId,
    });
  }

  const processMediaGroup = async (entry: MediaGroupEntry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);

      const captionMsg = entry.messages.find((m) => m.msg.caption || m.msg.text);
      const primaryEntry = captionMsg ?? entry.messages[0];

      const allMedia: Array<{
        path: string;
        contentType?: string;
        stickerMetadata?: { emoji?: string; setName?: string; fileId?: string };
      }> = [];
      for (const { ctx } of entry.messages) {
        const media = await resolveMedia(ctx, mediaMaxBytes, opts.token, opts.proxyFetch);
        if (media) {
          allMedia.push({
            path: media.path,
            contentType: media.contentType,
            stickerMetadata: media.stickerMetadata,
          });
        }
      }

      const storeAllowFrom = await readTelegramAllowFromStore().catch(() => []);
      await processMessage(primaryEntry.ctx, allMedia, storeAllowFrom);
    } catch (err) {
      runtime.error?.(danger(`media group handler failed: ${String(err)}`));
    }
  };

  const flushTextFragments = async (entry: TextFragmentEntry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);

      const first = entry.messages[0];
      const last = entry.messages.at(-1);
      if (!first || !last) return;

      const combinedText = entry.messages.map((m) => m.msg.text ?? "").join("");
      logTextFragmentDebug("telegram text fragment flushing", {
        key: entry.key,
        parts: entry.messages.length,
        totalChars: combinedText.length,
      });
      if (!combinedText.trim()) return;

      const syntheticMessage: TelegramMessage = {
        ...first.msg,
        text: combinedText,
        caption: undefined,
        caption_entities: undefined,
        entities: undefined,
        date: last.msg.date ?? first.msg.date,
      };

      if (goalRouterEnabled) {
        const isGroup =
          syntheticMessage.chat.type === "group" || syntheticMessage.chat.type === "supergroup";
        const messageThreadId = (syntheticMessage as { message_thread_id?: number })
          .message_thread_id;
        const isForum = (syntheticMessage.chat as { is_forum?: boolean }).is_forum === true;
        const threadId = resolveThreadIdForRouting({ isGroup, messageThreadId, isForum });
        await routeTelegramTextMessage({
          msg: syntheticMessage,
          text: combinedText,
          threadId,
        });
      } else {
        const storeAllowFrom = await readTelegramAllowFromStore().catch(() => []);
        const baseCtx = first.ctx as { me?: unknown; getFile?: unknown } & Record<string, unknown>;
        const getFile =
          typeof baseCtx.getFile === "function" ? baseCtx.getFile.bind(baseCtx) : async () => ({});

        await processMessage(
          { message: syntheticMessage, me: baseCtx.me, getFile },
          [],
          storeAllowFrom,
          { messageIdOverride: String(last.msg.message_id) },
        );
      }
    } catch (err) {
      runtime.error?.(danger(`text fragment handler failed: ${String(err)}`));
    }
  };

  const scheduleTextFragmentFlush = (entry: TextFragmentEntry) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      textFragmentBuffer.delete(entry.key);
      textFragmentProcessing = textFragmentProcessing
        .then(async () => {
          await flushTextFragments(entry);
        })
        .catch(() => undefined);
      await textFragmentProcessing;
    }, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS);
  };

  bot.on("callback_query", async (ctx) => {
    const callback = ctx.callbackQuery;
    if (!callback) return;
    if (shouldSkipUpdate(ctx)) return;
    // Answer immediately to prevent Telegram from retrying while we process
    await withTelegramApiErrorLogging({
      operation: "answerCallbackQuery",
      runtime,
      fn: () => bot.api.answerCallbackQuery(callback.id),
    }).catch(() => {});
    try {
      const data = (callback.data ?? "").trim();
      const callbackMessage = callback.message;
      if (!data || !callbackMessage) return;

      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        cfg,
        accountId,
      });
      if (inlineButtonsScope === "off") return;

      const chatId = callbackMessage.chat.id;
      const isGroup =
        callbackMessage.chat.type === "group" || callbackMessage.chat.type === "supergroup";
      if (inlineButtonsScope === "dm" && isGroup) return;
      if (inlineButtonsScope === "group" && !isGroup) return;

      const messageThreadId = (callbackMessage as { message_thread_id?: number }).message_thread_id;
      const isForum = (callbackMessage.chat as { is_forum?: boolean }).is_forum === true;
      const resolvedThreadId = resolveTelegramForumThreadId({
        isForum,
        messageThreadId,
      });
      const { groupConfig, topicConfig } = resolveTelegramGroupConfig(chatId, resolvedThreadId);
      const storeAllowFrom = await readTelegramAllowFromStore().catch(() => []);
      const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
      const effectiveGroupAllow = normalizeAllowFromWithStore({
        allowFrom: groupAllowOverride ?? groupAllowFrom,
        storeAllowFrom,
      });
      const effectiveDmAllow = normalizeAllowFromWithStore({
        allowFrom: telegramCfg.allowFrom,
        storeAllowFrom,
      });
      const dmPolicy = telegramCfg.dmPolicy ?? "pairing";
      const senderId = callback.from?.id ? String(callback.from.id) : "";
      const senderUsername = callback.from?.username ?? "";

      if (isGroup) {
        if (groupConfig?.enabled === false) {
          logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
          return;
        }
        if (topicConfig?.enabled === false) {
          logVerbose(
            `Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
          );
          return;
        }
        if (typeof groupAllowOverride !== "undefined") {
          const allowed =
            senderId &&
            isSenderAllowed({
              allow: effectiveGroupAllow,
              senderId,
              senderUsername,
            });
          if (!allowed) {
            logVerbose(
              `Blocked telegram group sender ${senderId || "unknown"} (group allowFrom override)`,
            );
            return;
          }
        }
        const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
        const groupPolicy = telegramCfg.groupPolicy ?? defaultGroupPolicy ?? "open";
        if (groupPolicy === "disabled") {
          logVerbose(`Blocked telegram group message (groupPolicy: disabled)`);
          return;
        }
        if (groupPolicy === "allowlist") {
          if (!senderId) {
            logVerbose(`Blocked telegram group message (no sender ID, groupPolicy: allowlist)`);
            return;
          }
          if (!effectiveGroupAllow.hasEntries) {
            logVerbose(
              "Blocked telegram group message (groupPolicy: allowlist, no group allowlist entries)",
            );
            return;
          }
          if (
            !isSenderAllowed({
              allow: effectiveGroupAllow,
              senderId,
              senderUsername,
            })
          ) {
            logVerbose(`Blocked telegram group message from ${senderId} (groupPolicy: allowlist)`);
            return;
          }
        }
        const groupAllowlist = resolveGroupPolicy(chatId);
        if (groupAllowlist.allowlistEnabled && !groupAllowlist.allowed) {
          logger.info(
            { chatId, title: callbackMessage.chat.title, reason: "not-allowed" },
            "skipping group message",
          );
          return;
        }
      }

      if (inlineButtonsScope === "allowlist") {
        if (!isGroup) {
          if (dmPolicy === "disabled") return;
          if (dmPolicy !== "open") {
            const allowed =
              effectiveDmAllow.hasWildcard ||
              (effectiveDmAllow.hasEntries &&
                isSenderAllowed({
                  allow: effectiveDmAllow,
                  senderId,
                  senderUsername,
                }));
            if (!allowed) return;
          }
        } else {
          const allowed =
            effectiveGroupAllow.hasWildcard ||
            (effectiveGroupAllow.hasEntries &&
              isSenderAllowed({
                allow: effectiveGroupAllow,
                senderId,
                senderUsername,
              }));
          if (!allowed) return;
        }
      }

      const handledCommandAnchorCallback = await handleCommandAnchorCallback({
        data,
        callbackMessage,
        threadId: resolvedThreadId,
      });
      if (handledCommandAnchorCallback) return;

      const paginationMatch = data.match(/^commands_page_(\d+|noop)(?::(.+))?$/);
      if (paginationMatch) {
        const pageValue = paginationMatch[1];
        if (pageValue === "noop") return;

        const page = Number.parseInt(pageValue, 10);
        if (Number.isNaN(page) || page < 1) return;

        const agentId = paginationMatch[2]?.trim() || resolveDefaultAgentId(cfg) || undefined;
        const skillCommands = listSkillCommandsForAgents({
          cfg,
          agentIds: agentId ? [agentId] : undefined,
        });
        const result = buildCommandsMessagePaginated(cfg, skillCommands, {
          page,
          surface: "telegram",
        });

        const keyboard =
          result.totalPages > 1
            ? buildInlineKeyboard(
                buildCommandsPaginationKeyboard(result.currentPage, result.totalPages, agentId),
              )
            : undefined;

        try {
          await bot.api.editMessageText(
            callbackMessage.chat.id,
            callbackMessage.message_id,
            result.text,
            keyboard ? { reply_markup: keyboard } : undefined,
          );
        } catch (editErr) {
          const errStr = String(editErr);
          if (!errStr.includes("message is not modified")) {
            throw editErr;
          }
        }
        return;
      }

      const syntheticMessage: TelegramMessage = {
        ...callbackMessage,
        from: callback.from,
        text: data,
        caption: undefined,
        caption_entities: undefined,
        entities: undefined,
      };
      const getFile = typeof ctx.getFile === "function" ? ctx.getFile.bind(ctx) : async () => ({});
      await processMessage({ message: syntheticMessage, me: ctx.me, getFile }, [], storeAllowFrom, {
        forceWasMentioned: true,
        messageIdOverride: callback.id,
      });
    } catch (err) {
      runtime.error?.(danger(`callback handler failed: ${String(err)}`));
    }
  });

  // Handle group migration to supergroup (chat ID changes)
  bot.on("message:migrate_to_chat_id", async (ctx) => {
    try {
      const msg = ctx.message;
      if (!msg?.migrate_to_chat_id) return;
      if (shouldSkipUpdate(ctx)) return;

      const oldChatId = String(msg.chat.id);
      const newChatId = String(msg.migrate_to_chat_id);
      const chatTitle = (msg.chat as { title?: string }).title ?? "Unknown";

      runtime.log?.(warn(`[telegram] Group migrated: "${chatTitle}" ${oldChatId} → ${newChatId}`));

      if (!resolveChannelConfigWrites({ cfg, channelId: "telegram", accountId })) {
        runtime.log?.(warn("[telegram] Config writes disabled; skipping group config migration."));
        return;
      }

      // Check if old chat ID has config and migrate it
      const currentConfig = loadConfig();
      const migration = migrateTelegramGroupConfig({
        cfg: currentConfig,
        accountId,
        oldChatId,
        newChatId,
      });

      if (migration.migrated) {
        runtime.log?.(warn(`[telegram] Migrating group config from ${oldChatId} to ${newChatId}`));
        migrateTelegramGroupConfig({ cfg, accountId, oldChatId, newChatId });
        await writeConfigFile(currentConfig);
        runtime.log?.(warn(`[telegram] Group config migrated and saved successfully`));
      } else if (migration.skippedExisting) {
        runtime.log?.(
          warn(
            `[telegram] Group config already exists for ${newChatId}; leaving ${oldChatId} unchanged`,
          ),
        );
      } else {
        runtime.log?.(
          warn(`[telegram] No config found for old group ID ${oldChatId}, migration logged only`),
        );
      }
    } catch (err) {
      runtime.error?.(danger(`[telegram] Group migration handler failed: ${String(err)}`));
    }
  });

  bot.on("message", async (ctx) => {
    try {
      const msg = ctx.message;
      if (!msg) return;
      if (shouldSkipUpdate(ctx)) return;

      // Never process bot commands here — they are handled by bot.command() handlers.
      // This prevents /goal (and any other slash command) from falling through to
      // the generic chat agent.
      const rawText = typeof msg.text === "string" ? msg.text : undefined;
      const botUsername = ctx.me?.username;
      if (
        rawText &&
        rawText.trimStart().startsWith("/") &&
        !isControlCommandMessage(rawText, cfg, botUsername ? { botUsername } : undefined)
      ) {
        return;
      }
      const entities = (msg as { entities?: Array<{ type: string; offset: number }> }).entities;
      if (entities?.some((e) => e.type === "bot_command" && e.offset === 0)) return;

      const chatId = msg.chat.id;
      const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
      const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
      const isForum = (msg.chat as { is_forum?: boolean }).is_forum === true;
      const resolvedThreadId = resolveTelegramForumThreadId({
        isForum,
        messageThreadId,
      });
      const storeAllowFrom = await readTelegramAllowFromStore().catch(() => []);
      const { groupConfig, topicConfig } = resolveTelegramGroupConfig(chatId, resolvedThreadId);
      const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
      const effectiveGroupAllow = normalizeAllowFromWithStore({
        allowFrom: groupAllowOverride ?? groupAllowFrom,
        storeAllowFrom,
      });
      const hasGroupAllowOverride = typeof groupAllowOverride !== "undefined";

      if (isGroup) {
        if (groupConfig?.enabled === false) {
          logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
          return;
        }
        if (topicConfig?.enabled === false) {
          logVerbose(
            `Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
          );
          return;
        }
        if (hasGroupAllowOverride) {
          const senderId = msg.from?.id;
          const senderUsername = msg.from?.username ?? "";
          const allowed =
            senderId != null &&
            isSenderAllowed({
              allow: effectiveGroupAllow,
              senderId: String(senderId),
              senderUsername,
            });
          if (!allowed) {
            logVerbose(
              `Blocked telegram group sender ${senderId ?? "unknown"} (group allowFrom override)`,
            );
            return;
          }
        }
        // Group policy filtering: controls how group messages are handled
        // - "open": groups bypass allowFrom, only mention-gating applies
        // - "disabled": block all group messages entirely
        // - "allowlist": only allow group messages from senders in groupAllowFrom/allowFrom
        const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
        const groupPolicy = telegramCfg.groupPolicy ?? defaultGroupPolicy ?? "open";
        if (groupPolicy === "disabled") {
          logVerbose(`Blocked telegram group message (groupPolicy: disabled)`);
          return;
        }
        if (groupPolicy === "allowlist") {
          // For allowlist mode, the sender (msg.from.id) must be in allowFrom
          const senderId = msg.from?.id;
          if (senderId == null) {
            logVerbose(`Blocked telegram group message (no sender ID, groupPolicy: allowlist)`);
            return;
          }
          if (!effectiveGroupAllow.hasEntries) {
            logVerbose(
              "Blocked telegram group message (groupPolicy: allowlist, no group allowlist entries)",
            );
            return;
          }
          const senderUsername = msg.from?.username ?? "";
          if (
            !isSenderAllowed({
              allow: effectiveGroupAllow,
              senderId: String(senderId),
              senderUsername,
            })
          ) {
            logVerbose(`Blocked telegram group message from ${senderId} (groupPolicy: allowlist)`);
            return;
          }
        }

        // Group allowlist based on configured group IDs.
        const groupAllowlist = resolveGroupPolicy(chatId);
        if (groupAllowlist.allowlistEnabled && !groupAllowlist.allowed) {
          logger.info(
            { chatId, title: msg.chat.title, reason: "not-allowed" },
            "skipping group message",
          );
          return;
        }
      }

      if (!isGroup) {
        const allowed = await ensureTelegramDmPolicy({
          msg,
          chatId,
          storeAllowFrom,
        });
        if (!allowed) return;
      }

      const text = typeof msg.text === "string" ? msg.text : undefined;
      const caption = typeof msg.caption === "string" ? msg.caption : undefined;
      const textForRouting = text ?? caption;
      const isCommandLike = (textForRouting ?? "").trim().startsWith("/");

      const replyToMessageId = (msg as { reply_to_message?: { message_id?: number } })
        .reply_to_message?.message_id;
      if (!isCommandLike && text && commandFragmentBuffer && replyToMessageId == null) {
        const normalized = normalizeCommandFragmentParams(msg, accountId);
        const consumed = commandFragmentBuffer.tryAppendMatching(
          {
            ...normalized,
            commandNames: [
              "new_goal",
              "repo_chat",
              "goal_feedback",
              "goal_answer",
              "goal_edit",
              "goal_resume",
            ],
          },
          msg.message_id,
          text,
          Date.now(),
        );
        if (consumed) return;
      }

      // Text fragment handling - Telegram splits long pastes into multiple inbound messages (~4096 chars).
      // We buffer “near-limit” messages and append immediately-following parts.
      if (text && !isCommandLike) {
        const nowMs = Date.now();
        const senderId = msg.from?.id != null ? String(msg.from.id) : "unknown";
        const key = `text:${chatId}:${resolvedThreadId ?? "main"}:${senderId}`;
        const existing = textFragmentBuffer.get(key);

        if (existing) {
          const last = existing.messages.at(-1);
          const lastMsgId = last?.msg.message_id;
          const lastReceivedAtMs = last?.receivedAtMs ?? nowMs;
          const idGap = typeof lastMsgId === "number" ? msg.message_id - lastMsgId : Infinity;
          const timeGapMs = nowMs - lastReceivedAtMs;
          const canAppend =
            idGap > 0 &&
            idGap <= TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP &&
            timeGapMs >= 0 &&
            timeGapMs <= TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS;

          if (canAppend) {
            const currentTotalChars = existing.messages.reduce(
              (sum, m) => sum + (m.msg.text?.length ?? 0),
              0,
            );
            const nextTotalChars = currentTotalChars + text.length;
            if (
              existing.messages.length + 1 <= TELEGRAM_TEXT_FRAGMENT_MAX_PARTS &&
              nextTotalChars <= TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS
            ) {
              existing.messages.push({ msg, ctx, receivedAtMs: nowMs });
              logTextFragmentDebug("telegram text fragment append succeeded", {
                key,
                messageId: msg.message_id,
                idGap,
                timeGapMs,
              });
              scheduleTextFragmentFlush(existing);
              return;
            }
            logTextFragmentDebug("telegram text fragment append failed", {
              key,
              messageId: msg.message_id,
              reason: "limits exceeded",
              nextPartCount: existing.messages.length + 1,
              maxParts: TELEGRAM_TEXT_FRAGMENT_MAX_PARTS,
              nextTotalChars,
              maxTotalChars: TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS,
            });
          } else {
            logTextFragmentDebug("telegram text fragment append failed", {
              key,
              messageId: msg.message_id,
              reason:
                idGap <= 0 || idGap > TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP
                  ? "id gap exceeded"
                  : "time gap exceeded",
              idGap,
              maxIdGap: TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP,
              timeGapMs,
              maxGapMs: TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS,
            });
          }

          // Not appendable (or limits exceeded): flush buffered entry first, then continue normally.
          clearTimeout(existing.timer);
          textFragmentBuffer.delete(key);
          textFragmentProcessing = textFragmentProcessing
            .then(async () => {
              await flushTextFragments(existing);
            })
            .catch(() => undefined);
          await textFragmentProcessing;
        }

        const shouldStart = text.length >= TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS;
        if (shouldStart) {
          const entry: TextFragmentEntry = {
            key,
            messages: [{ msg, ctx, receivedAtMs: nowMs }],
            timer: setTimeout(() => {}, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS),
          };
          textFragmentBuffer.set(key, entry);
          logTextFragmentDebug("telegram text fragment buffer created", {
            key,
            messageId: msg.message_id,
            textLength: text.length,
          });
          scheduleTextFragmentFlush(entry);
          return;
        }
      }

      // Generic auto-reply chat must never execute tools; all execution is gated by goal routing.
      if (goalRouterEnabled && textForRouting && !isCommandLike) {
        const threadId = resolveThreadIdForRouting({
          isGroup,
          messageThreadId,
          isForum,
        });
        const handled = await routeTelegramTextMessage({
          msg,
          text: textForRouting,
          threadId,
        });
        if (handled) return;
      }

      if (goalRouterEnabled && !isCommandLike && !textForRouting) {
        return;
      }

      // Media group handling - buffer multi-image messages
      const mediaGroupId = (msg as { media_group_id?: string }).media_group_id;
      if (mediaGroupId) {
        const existing = mediaGroupBuffer.get(mediaGroupId);
        if (existing) {
          clearTimeout(existing.timer);
          existing.messages.push({ msg, ctx });
          existing.timer = setTimeout(async () => {
            mediaGroupBuffer.delete(mediaGroupId);
            mediaGroupProcessing = mediaGroupProcessing
              .then(async () => {
                await processMediaGroup(existing);
              })
              .catch(() => undefined);
            await mediaGroupProcessing;
          }, MEDIA_GROUP_TIMEOUT_MS);
        } else {
          const entry: MediaGroupEntry = {
            messages: [{ msg, ctx }],
            timer: setTimeout(async () => {
              mediaGroupBuffer.delete(mediaGroupId);
              mediaGroupProcessing = mediaGroupProcessing
                .then(async () => {
                  await processMediaGroup(entry);
                })
                .catch(() => undefined);
              await mediaGroupProcessing;
            }, MEDIA_GROUP_TIMEOUT_MS),
          };
          mediaGroupBuffer.set(mediaGroupId, entry);
        }
        return;
      }

      let media: Awaited<ReturnType<typeof resolveMedia>> = null;
      try {
        media = await resolveMedia(ctx, mediaMaxBytes, opts.token, opts.proxyFetch);
      } catch (mediaErr) {
        const errMsg = String(mediaErr);
        if (errMsg.includes("exceeds") && errMsg.includes("MB limit")) {
          const limitMb = Math.round(mediaMaxBytes / (1024 * 1024));
          await withTelegramApiErrorLogging({
            operation: "sendMessage",
            runtime,
            fn: () =>
              bot.api.sendMessage(chatId, `⚠️ File too large. Maximum size is ${limitMb}MB.`, {
                reply_to_message_id: msg.message_id,
              }),
          }).catch(() => {});
          logger.warn({ chatId, error: errMsg }, "media exceeds size limit");
          return;
        }
        throw mediaErr;
      }

      // Skip sticker-only messages where the sticker was skipped (animated/video)
      // These have no media and no text content to process.
      const hasText = Boolean((msg.text ?? msg.caption ?? "").trim());
      if (msg.sticker && !media && !hasText) {
        logVerbose("telegram: skipping sticker-only message (unsupported sticker type)");
        return;
      }

      const allMedia = media
        ? [
            {
              path: media.path,
              contentType: media.contentType,
              stickerMetadata: media.stickerMetadata,
            },
          ]
        : [];
      const senderId = msg.from?.id ? String(msg.from.id) : "";
      const conversationKey =
        resolvedThreadId != null ? `${chatId}:topic:${resolvedThreadId}` : String(chatId);
      const debounceKey = senderId
        ? `telegram:${accountId ?? "default"}:${conversationKey}:${senderId}`
        : null;
      await inboundDebouncer.enqueue({
        ctx,
        msg,
        allMedia,
        storeAllowFrom,
        debounceKey,
        botUsername: ctx.me?.username,
      });
    } catch (err) {
      runtime.error?.(danger(`handler failed: ${String(err)}`));
    }
  });
};
