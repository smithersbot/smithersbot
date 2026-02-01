import type { Bot } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import type { MarkdownTableMode } from "../config/types.base.js";
import { formatErrorMessage } from "../infra/errors.js";
import { markdownToTelegramChunks, renderTelegramHtmlText } from "./format.js";

const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;
const DEFAULT_PLACEHOLDER = "…";
const DEFAULT_FRAMES = ["…", "..", ".", "…"];
const DEFAULT_INTERVAL_MS = 4000;

export type ProofOfLifeFinishOptions = {
  textMode?: "markdown" | "html";
  plainText?: string;
  tableMode?: MarkdownTableMode;
  replyMarkup?: InlineKeyboardMarkup;
  chunkLimit?: number;
};

export type ProofOfLifeHandle = {
  messageId?: number;
  update: (text: string) => Promise<boolean>;
  finish: (text: string, options?: ProofOfLifeFinishOptions) => Promise<boolean>;
  stop: () => void;
  failed: () => boolean;
};

const activeProofs = new Map<string, { stop: () => void }>();

function proofKey(chatId: number, threadId?: number): string {
  return threadId != null ? `${chatId}:${threadId}` : String(chatId);
}

function resolveThreadParams(threadId?: number): Record<string, number> | undefined {
  if (threadId == null) return undefined;
  return { message_thread_id: threadId };
}

async function editMessageTextSafely(params: {
  bot: Bot;
  chatId: number;
  messageId: number;
  htmlText: string;
  plainText: string;
  replyMarkup?: InlineKeyboardMarkup;
}): Promise<boolean> {
  const { bot, chatId, messageId, htmlText, plainText, replyMarkup } = params;
  const editMessageText = bot.api?.editMessageText?.bind(bot.api);
  if (typeof editMessageText !== "function") return false;
  try {
    const htmlParams = replyMarkup
      ? { parse_mode: "HTML" as const, reply_markup: replyMarkup }
      : { parse_mode: "HTML" as const };
    await editMessageText(chatId, messageId, htmlText, htmlParams);
    return true;
  } catch (err) {
    const errText = formatErrorMessage(err);
    if (!PARSE_ERR_RE.test(errText)) return false;
  }
  try {
    const plainParams = replyMarkup ? { reply_markup: replyMarkup } : {};
    await editMessageText(chatId, messageId, plainText, plainParams);
    return true;
  } catch {
    return false;
  }
}

async function editPlainTextSafely(params: {
  bot: Bot;
  chatId: number;
  messageId: number;
  text: string;
}): Promise<boolean> {
  const { bot, chatId, messageId, text } = params;
  const editMessageText = bot.api?.editMessageText?.bind(bot.api);
  if (typeof editMessageText !== "function") return false;
  try {
    await editMessageText(chatId, messageId, text);
    return true;
  } catch {
    return false;
  }
}

export function beginProofOfLife(params: {
  bot: Bot;
  chatId: number;
  threadId?: number;
  label?: string;
  preface?: string;
  placeholder?: string;
}): ProofOfLifeHandle {
  const { bot, chatId, threadId, preface, placeholder, label: _label } = params;
  const key = proofKey(chatId, threadId);

  const existing = activeProofs.get(key);
  if (existing) existing.stop();

  let stopped = false;
  let failed = false;
  let messageId: number | undefined;

  const threadParams = resolveThreadParams(threadId);
  const sendMessage = bot.api?.sendMessage?.bind(bot.api);
  if (typeof sendMessage !== "function") {
    failed = true;
  }

  if (preface && typeof sendMessage === "function") {
    Promise.resolve(sendMessage(chatId, preface, threadParams ?? {})).catch(() => {
      failed = true;
    });
  }

  const placeholderText = placeholder ?? DEFAULT_PLACEHOLDER;
  const messageIdPromise =
    typeof sendMessage === "function"
      ? Promise.resolve(sendMessage(chatId, placeholderText, threadParams ?? {}))
          .then((res) => {
            if (res && typeof res === "object" && "message_id" in res) {
              messageId = (res as { message_id?: number }).message_id;
              handle.messageId = messageId;
            }
            return messageId;
          })
          .catch(() => {
            failed = true;
            return undefined;
          })
      : Promise.resolve(undefined);

  const update = async (text: string): Promise<boolean> => {
    if (stopped || failed) return false;
    const resolved = await messageIdPromise;
    if (!resolved) {
      failed = true;
      return false;
    }
    const ok = await editPlainTextSafely({ bot, chatId, messageId: resolved, text });
    if (!ok) failed = true;
    return ok;
  };

  const finish = async (text: string, options?: ProofOfLifeFinishOptions): Promise<boolean> => {
    if (stopped || failed) return false;
    const resolved = await messageIdPromise;
    if (!resolved) {
      failed = true;
      return false;
    }
    const textMode = options?.textMode ?? "markdown";
    const chunkLimit = options?.chunkLimit ?? 4000;
    const chunks =
      textMode === "html"
        ? [
            {
              html: renderTelegramHtmlText(text, {
                textMode: "html",
                tableMode: options?.tableMode,
              }),
              text: options?.plainText ?? text,
            },
          ]
        : markdownToTelegramChunks(text, chunkLimit, { tableMode: options?.tableMode });

    if (chunks.length !== 1) return false;
    const chunk = chunks[0]!;
    const ok = await editMessageTextSafely({
      bot,
      chatId,
      messageId: resolved,
      htmlText: chunk.html,
      plainText: chunk.text,
      replyMarkup: options?.replyMarkup,
    });
    if (!ok) failed = true;
    return ok;
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    activeProofs.delete(key);
  };

  const handle: ProofOfLifeHandle = {
    messageId,
    update,
    finish,
    stop,
    failed: () => failed,
  };

  activeProofs.set(key, { stop });
  return handle;
}

export function startProofOfLifePulse(
  handle: ProofOfLifeHandle,
  options?: { intervalMs?: number; frames?: string[] },
): { stop: () => void } {
  const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const frames = options?.frames ?? DEFAULT_FRAMES;
  let index = 0;
  let stopped = false;

  const interval = setInterval(() => {
    if (stopped) return;
    void handle.update(frames[index % frames.length] ?? frames[0] ?? DEFAULT_PLACEHOLDER);
    index += 1;
  }, intervalMs);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
    },
  };
}
