import { resolveTelegramForumThreadId } from "./bot/helpers.js";
import type { TelegramMessage } from "./bot/types.js";

// Wait up to 15s for the next chunk. Long Telegram pastes may be split and
// delivered with human-scale pauses between chunks.
export const COMMAND_FRAGMENT_MAX_GAP_MS = 15000;
export const COMMAND_FRAGMENT_MIN_GAP_MS = 3000;
export const COMMAND_FRAGMENT_MAX_CONFIGURED_GAP_MS = 60000;
// Allow up to 4 intervening messages (bot replies, service messages) between user-sent chunks.
// The time gap is the primary guard against false matches.
export const COMMAND_FRAGMENT_MAX_ID_GAP = 5;
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

type CommandFragmentDebugLogger = {
  debug?: (...args: unknown[]) => void;
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
  private readonly gapMs: number;

  constructor(
    private readonly logger?: CommandFragmentDebugLogger,
    gapMs: number = COMMAND_FRAGMENT_MAX_GAP_MS,
  ) {
    this.gapMs = clampCommandFragmentGapMs(gapMs);
    this.logDebug("telegram command fragment buffer initialized", {
      gapMs: this.gapMs,
    });
  }

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
      timer: setTimeout(() => {}, this.gapMs),
      flushCallback: entry.flushCallback,
    };

    this.entries.set(key, state);
    this.logDebug("telegram command fragment buffer created", {
      key,
      commandName: entry.commandName,
      messageId: entry.firstMessageId,
      textLength: entry.text.length,
      replacedExisting: Boolean(existing),
    });
    this.scheduleFlush(key, state);
  }

  tryAppend(key: string, messageId: number, text: string, receivedAtMs: number): boolean {
    const entry = this.entries.get(key);
    if (!entry) {
      this.logDebug("telegram command fragment append failed", {
        key,
        messageId,
        reason: "no entry",
      });
      return false;
    }

    if (text.trimStart().startsWith("/")) {
      this.logDebug("telegram command fragment append failed", {
        key,
        messageId,
        reason: "starts with /",
      });
      return false;
    }

    const idGap = messageId - entry.lastMessageId;
    const timeGapMs = receivedAtMs - entry.lastReceivedAtMs;
    if (idGap <= 0 || idGap > COMMAND_FRAGMENT_MAX_ID_GAP) {
      this.logDebug("telegram command fragment append failed", {
        key,
        messageId,
        reason: "id gap exceeded",
        idGap,
        maxIdGap: COMMAND_FRAGMENT_MAX_ID_GAP,
      });
      return false;
    }
    if (timeGapMs < 0 || timeGapMs > this.gapMs) {
      this.logDebug("telegram command fragment append failed", {
        key,
        messageId,
        reason: "time gap exceeded",
        timeGapMs,
        maxGapMs: this.gapMs,
      });
      return false;
    }

    const nextPartCount = entry.textParts.length + 1;
    const nextTotalChars = entry.totalChars + text.length;
    if (
      nextPartCount > COMMAND_FRAGMENT_MAX_PARTS ||
      nextTotalChars > COMMAND_FRAGMENT_MAX_TOTAL_CHARS
    ) {
      this.logDebug("telegram command fragment append failed", {
        key,
        messageId,
        reason: "limits exceeded",
        nextPartCount,
        maxParts: COMMAND_FRAGMENT_MAX_PARTS,
        nextTotalChars,
        maxTotalChars: COMMAND_FRAGMENT_MAX_TOTAL_CHARS,
      });
      return false;
    }

    entry.textParts.push(text);
    entry.totalChars = nextTotalChars;
    entry.lastMessageId = messageId;
    entry.lastReceivedAtMs = receivedAtMs;
    this.logDebug("telegram command fragment append succeeded", {
      key,
      messageId,
      idGap,
      timeGapMs,
    });
    this.scheduleFlush(key, entry);
    return true;
  }

  async flush(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.entries.delete(key);
    this.logDebug("telegram command fragment flushing", {
      key,
      parts: entry.textParts.length,
      totalChars: entry.totalChars,
    });

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
    }, this.gapMs);
  }

  private logDebug(message: string, fields: Record<string, unknown>): void {
    this.logger?.debug?.(fields, message);
  }
}

export function clampCommandFragmentGapMs(gapMs: number): number {
  return Math.min(
    COMMAND_FRAGMENT_MAX_CONFIGURED_GAP_MS,
    Math.max(COMMAND_FRAGMENT_MIN_GAP_MS, Math.floor(gapMs)),
  );
}
