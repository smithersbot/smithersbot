import { resolveTelegramForumThreadId } from "./bot/helpers.js";
import type { TelegramMessage } from "./bot/types.js";

// Wait up to 2s for the next chunk. Telegram client-side auto-splits a long
// paste into ~4096-char parts that arrive back-to-back through the Bot API
// (typically <500ms apart, ~1s worst-case on slow uplinks). Longer gaps risk
// stitching unrelated user messages.
export const COMMAND_FRAGMENT_MAX_GAP_MS = 2000;
export const COMMAND_FRAGMENT_MIN_GAP_MS = 500;
export const COMMAND_FRAGMENT_MAX_CONFIGURED_GAP_MS = 60000;
// Allow up to 4 intervening messages (bot replies, service messages) between user-sent chunks.
// The time gap is the primary guard against false matches.
export const COMMAND_FRAGMENT_MAX_ID_GAP = 5;
export const COMMAND_FRAGMENT_MAX_PARTS = 12;
export const COMMAND_FRAGMENT_MAX_TOTAL_CHARS = 50_000;
export const COMMAND_ANCHOR_TTL_MS = 60000;
export const COMMAND_ANCHOR_MIN_TTL_MS = 10000;
export const COMMAND_ANCHOR_MAX_TTL_MS = 60000;

export type CommandFragmentCommandName = "new_goal" | "repo_chat";

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
  commandName: CommandFragmentCommandName;
  firstMessageId: number;
  receivedAtMs: number;
  text: string;
  dispatch: CommandFragmentDispatchMetadata;
  flushCallback: (combinedText: string) => void | Promise<void>;
};

export type CommandAnchor = {
  commandName: CommandFragmentCommandName;
  anchoredAtMs: number;
  expiresAtMs: number;
  sourceMessageId?: number;
  appendHandler: (text: string) => Promise<void>;
};

type CommandFragmentState = {
  commandName: CommandFragmentCommandName;
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
  private readonly anchors = new Map<string, CommandAnchor>();
  private readonly gapMs: number;
  private readonly anchorTtlMs: number;

  constructor(
    private readonly logger?: CommandFragmentDebugLogger,
    gapMs: number = COMMAND_FRAGMENT_MAX_GAP_MS,
    anchorTtlMs: number = COMMAND_ANCHOR_TTL_MS,
  ) {
    this.gapMs = clampCommandFragmentGapMs(gapMs);
    this.anchorTtlMs = clampCommandAnchorTtlMs(anchorTtlMs);
    this.logDebug("telegram command fragment buffer initialized", {
      gapMs: this.gapMs,
      anchorTtlMs: this.anchorTtlMs,
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
    const existingAnchor = this.getAnchor(key);
    if (existingAnchor && existingAnchor.commandName !== entry.commandName) {
      this.clearAnchor(key);
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

  getAnchorTtlMs(): number {
    return this.anchorTtlMs;
  }

  getGapMs(): number {
    return this.gapMs;
  }

  setAnchor(key: string, anchor: CommandAnchor): void {
    this.anchors.set(key, anchor);
    this.logDebug("telegram command anchor set", {
      key,
      commandName: anchor.commandName,
      anchoredAtMs: anchor.anchoredAtMs,
      expiresAtMs: anchor.expiresAtMs,
      sourceMessageId: anchor.sourceMessageId,
    });
  }

  getAnchor(key: string): CommandAnchor | undefined {
    const anchor = this.anchors.get(key);
    if (!anchor) return undefined;

    if (Date.now() >= anchor.expiresAtMs) {
      this.clearAnchor(key);
      return undefined;
    }

    this.logDebug("telegram command anchor hit", {
      key,
      commandName: anchor.commandName,
      expiresAtMs: anchor.expiresAtMs,
    });
    return anchor;
  }

  clearAnchor(key: string): void {
    const anchor = this.anchors.get(key);
    if (!anchor) return;

    this.anchors.delete(key);
    this.logDebug("telegram command anchor cleared", {
      key,
      commandName: anchor.commandName,
    });
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

export function clampCommandAnchorTtlMs(ttlMs: number): number {
  return Math.min(
    COMMAND_ANCHOR_MAX_TTL_MS,
    Math.max(COMMAND_ANCHOR_MIN_TTL_MS, Math.floor(ttlMs)),
  );
}
