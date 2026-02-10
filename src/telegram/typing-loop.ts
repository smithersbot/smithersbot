import type { Bot } from "grammy";

// ---------------------------------------------------------------------------
// Typing indicator loop — shared by goal commands and chat message dispatch
// ---------------------------------------------------------------------------

export type ChatAction =
  | "typing"
  | "upload_photo"
  | "record_video"
  | "upload_video"
  | "record_voice"
  | "upload_voice"
  | "upload_document"
  | "choose_sticker"
  | "find_location"
  | "record_video_note"
  | "upload_video_note";

const debugTyping = process.env.MOLTBOT_TELEGRAM_DEBUG_TYPING === "1";

export function logTyping(msg: string): void {
  if (debugTyping) console.debug(`[typing] ${msg}`);
}

const TYPING_INTERVAL_MS = 4000;

/** Active typing loops keyed by "chatId" or "chatId:threadId" for overlap prevention. */
const activeTypingLoops = new Map<string, { stop: () => void }>();

function typingKey(chatId: number, threadId?: number): string {
  return threadId != null ? `${chatId}:${threadId}` : String(chatId);
}

/**
 * Start a repeating chat action (default "typing") for a chat.
 * Returns `{ stop() }` — call it to cancel the loop.
 *
 * - Per-chat overlap prevention: if a loop is already running for the same
 *   chatId+threadId, the previous one is stopped before starting the new one.
 * - Every `sendChatAction` promise is caught internally — no unhandled rejections.
 * - Errors are logged at most once per loop invocation, at debug level,
 *   including err.cause when available.
 * - Best-effort: never blocks the caller, never throws.
 */
export function startTypingLoop(params: {
  bot: Bot;
  chatId: number;
  action?: ChatAction;
  threadId?: number;
  label?: string;
  /** Auto-stop after this many ms (default: 10 min). Prevents zombie loops. */
  maxDurationMs?: number;
}): { stop: () => void } {
  const { bot, chatId, action = "typing", threadId, label } = params;
  const tag = label ? `${label} ` : "";
  const key = typingKey(chatId, threadId);

  // Overlap prevention: stop any existing loop for this chat+thread
  const existing = activeTypingLoops.get(key);
  if (existing) existing.stop();

  let stopped = false;
  let errorLogged = false;

  const sendAction = () => {
    if (stopped) return;
    const p =
      threadId != null
        ? bot.api.raw.sendChatAction({ chat_id: chatId, action, message_thread_id: threadId })
        : bot.api.sendChatAction(chatId, action);
    p.catch((err: unknown) => {
      if (!errorLogged) {
        errorLogged = true;
        const errMsg = err instanceof Error ? err.message : String(err);
        let cause = "";
        if (err instanceof Error && err.cause != null) {
          let causeValue = "[non-string]";
          if (typeof err.cause === "string") {
            causeValue = err.cause;
          } else if (err.cause instanceof Error) {
            causeValue = err.cause.message;
          }
          cause = ` cause=${causeValue}`;
        }
        logTyping(`${tag}sendChatAction error chatId=${chatId}: ${errMsg}${cause}`);
      }
    });
  };

  logTyping(`${tag}start chatId=${chatId}${threadId != null ? ` threadId=${threadId}` : ""}`);
  sendAction();
  const interval = setInterval(sendAction, TYPING_INTERVAL_MS);
  const maxTimer = setTimeout(() => handle.stop(), params.maxDurationMs ?? 10 * 60 * 1000);

  const handle = {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      clearTimeout(maxTimer);
      activeTypingLoops.delete(key);
      logTyping(`${tag}stop chatId=${chatId}`);
    },
  };

  activeTypingLoops.set(key, handle);
  return handle;
}
