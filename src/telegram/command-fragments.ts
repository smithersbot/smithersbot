import { resolveTelegramForumThreadId } from "./bot/helpers.js";
import type { TelegramMessage } from "./bot/types.js";

// Telegram splits at 4096 chars, but command prefixes reduce ctx.match length.
// Start buffering earlier so split command chunks are still combined reliably.
export const COMMAND_FRAGMENT_START_THRESHOLD = 3800;
export const COMMAND_FRAGMENT_MAX_GAP_MS = 1500;
export const COMMAND_FRAGMENT_MAX_ID_GAP = 1;
export const COMMAND_FRAGMENT_MAX_PARTS = 12;
export const COMMAND_FRAGMENT_MAX_TOTAL_CHARS = 50_000;

export type CommandFragmentKeyParams = {
  accountId: string;
  chatId: string | number;
  resolvedThreadId: number | undefined;
  senderId: string;
};

export type CommandFragmentDispatchMetadata = {
  chatId: number;
  threadIdForSend?: number;
  senderId: string;
  replyToMessageId?: number;
  sourceMessageId: number;
  accountId: string;
};

export type CommandFragmentBufferEntry = {
  commandName: string;
  firstMessageId: number;
  receivedAtMs: number;
  text: string;
  dispatch: CommandFragmentDispatchMetadata;
  flushCallback: (combinedText: string) => void | Promise<void>;
};

type CommandFragmentState = {
  commandName: string;
  textParts: string[];
  totalChars: number;
  dispatch: CommandFragmentDispatchMetadata;
  firstMessageId: number;
  lastMessageId: number;
  receivedAtMs: number;
  lastReceivedAtMs: number;
  timer: ReturnType<typeof setTimeout>;
  flushCallback: (combinedText: string) => void | Promise<void>;
};

export function buildCommandFragmentKey(params: CommandFragmentKeyParams): string {
  return `cmd:${params.chatId}:${params.resolvedThreadId ?? "main"}:${params.senderId}`;
}

export function normalizeCommandFragmentParams(
  msg: TelegramMessage,
  accountId: string,
): CommandFragmentKeyParams {
  const chatId = msg.chat.id;
  const isForum = (msg.chat as { is_forum?: boolean }).is_forum === true;
  const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
  const resolvedThreadId = resolveTelegramForumThreadId({
    isForum,
    messageThreadId,
  });
  const senderId = String(msg.from?.id ?? "unknown");
  return {
    accountId,
    chatId,
    resolvedThreadId,
    senderId,
  };
}

export class CommandFragmentBuffer {
  private readonly entries = new Map<string, CommandFragmentState>();

  hasPending(key: string): boolean {
    return this.entries.has(key);
  }

  bufferCommand(key: string, entry: CommandFragmentBufferEntry): void {
    const existing = this.entries.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      this.entries.delete(key);
    }

    const state: CommandFragmentState = {
      commandName: entry.commandName,
      textParts: [entry.text],
      totalChars: entry.text.length,
      dispatch: entry.dispatch,
      firstMessageId: entry.firstMessageId,
      lastMessageId: entry.firstMessageId,
      receivedAtMs: entry.receivedAtMs,
      lastReceivedAtMs: entry.receivedAtMs,
      timer: setTimeout(() => {}, COMMAND_FRAGMENT_MAX_GAP_MS),
      flushCallback: entry.flushCallback,
    };

    this.entries.set(key, state);
    this.scheduleFlush(key, state);
  }

  tryAppend(key: string, messageId: number, text: string, receivedAtMs: number): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;

    if (text.trimStart().startsWith("/")) {
      return false;
    }

    const idGap = messageId - entry.lastMessageId;
    const timeGapMs = receivedAtMs - entry.lastReceivedAtMs;
    if (
      idGap <= 0 ||
      idGap > COMMAND_FRAGMENT_MAX_ID_GAP ||
      timeGapMs < 0 ||
      timeGapMs > COMMAND_FRAGMENT_MAX_GAP_MS
    ) {
      return false;
    }

    const nextPartCount = entry.textParts.length + 1;
    const nextTotalChars = entry.totalChars + text.length;
    if (
      nextPartCount > COMMAND_FRAGMENT_MAX_PARTS ||
      nextTotalChars > COMMAND_FRAGMENT_MAX_TOTAL_CHARS
    ) {
      return false;
    }

    entry.textParts.push(text);
    entry.totalChars = nextTotalChars;
    entry.lastMessageId = messageId;
    entry.lastReceivedAtMs = receivedAtMs;
    this.scheduleFlush(key, entry);
    return true;
  }

  async flush(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.entries.delete(key);

    const combinedText = entry.textParts.join("");
    await entry.flushCallback(combinedText);
  }

  async cancelAndFlush(key: string): Promise<void> {
    await this.flush(key);
  }

  private scheduleFlush(key: string, entry: CommandFragmentState): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      void this.flush(key).catch(() => undefined);
    }, COMMAND_FRAGMENT_MAX_GAP_MS);
  }
}
