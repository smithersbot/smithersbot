import type { SerializedRun } from "../goal/types.js";

// Routing contract: Telegram chats feel conversational, but all side effects must flow
// through goal runs. CHAT is read-only. Only GOAL_* routes are allowed to plan/execute.
//
// Callback queries (inline buttons) and emoji reactions never enter routeTelegramText.
// They are handled by dedicated Grammy middleware registered in registerTelegramGoalCommands()
// (called from registerTelegramNativeCommands, bot.ts:348) which runs before registerTelegramHandlers
// (bot.ts:454) where the text router lives.
export type RouteKind = "GOAL_EDIT" | "GOAL_ANSWER" | "CHAT" | "CHAT_HELP" | "DISAMBIGUATE";

export type RouterDecision = "GOAL_EDIT" | "GOAL_ANSWER" | "CHAT";

export type RouteResult = {
  kind: RouteKind;
  runId?: string;
  replyText?: string;
};

type RouteInput = {
  chatId: number;
  threadId?: number;
  messageText: string;
  replyToMessageId?: number;
  runs: SerializedRun[];
};

const HELP_INTENTS = [
  "who are you",
  "help",
  "help me",
  "capabilities",
  "what can you do",
  "how do i use this",
  "how do i use it",
  "what is this",
  "what are you",
];

const GREETING_INTENTS = [
  "hello",
  "hi",
  "hey",
  "yo",
  "sup",
  "morning",
  "good morning",
  "hello there",
  "hi there",
  "hey there",
  "thanks",
  "thank you",
  "thx",
  "ok",
  "k",
  "lol",
  "nice",
  "cool",
  "great",
  "awesome",
];

const MAX_GREETING_WORDS = 4;
const MAX_HELP_WORDS = 8;

const OLDER_REVISION_MESSAGE =
  "That's an older revision. Reply to the latest plan message to request changes.";

function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function stripPunctuation(text: string): string {
  return text.replace(/[^\w\s]/g, "").trim();
}

// Exact match after normalizing + stripping punctuation. No substring matching.
function matchesIntentExact(normalized: string, intents: string[]): boolean {
  const stripped = stripPunctuation(normalized);
  return intents.some((intent) => stripped === intent);
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function isHelpIntent(rawText: string): boolean {
  const normalized = normalizeText(rawText);
  if (!normalized) return false;
  if (wordCount(normalized) > MAX_HELP_WORDS) return false;
  return matchesIntentExact(normalized, HELP_INTENTS);
}

function isGreetingIntent(rawText: string): boolean {
  const normalized = normalizeText(rawText);
  if (!normalized) return false;
  if (wordCount(normalized) > MAX_GREETING_WORDS) return false;
  return matchesIntentExact(normalized, GREETING_INTENTS);
}

// ---------------------------------------------------------------------------
// Chat/thread scoping helpers
// ---------------------------------------------------------------------------

function matchesChatThread(
  msg: { chatId: number; threadId?: number } | undefined,
  chatId: number,
  threadId?: number,
): boolean {
  if (!msg) return false;
  if (msg.chatId !== chatId) return false;
  if (typeof threadId === "number") return msg.threadId === threadId;
  return typeof msg.threadId !== "number";
}

function filterRunsForChatThread(params: {
  runs: SerializedRun[];
  chatId: number;
  threadId?: number;
}): SerializedRun[] {
  const { runs, chatId, threadId } = params;
  return runs.filter((run) => {
    if (matchesChatThread(run.telegramPlanMessage, chatId, threadId)) return true;
    if (run.telegramQuestionMessages?.some((qm) => matchesChatThread(qm, chatId, threadId))) {
      return true;
    }
    if (run.telegramEditPromptMessages?.some((ep) => matchesChatThread(ep, chatId, threadId))) {
      return true;
    }
    return false;
  });
}

function isBlockedRun(run: SerializedRun): boolean {
  return (
    run.state === "blocked" &&
    Boolean(run.blocked?.prompt?.trim()) &&
    Boolean(run.blocked?.requiredInputKey?.trim())
  );
}

// ---------------------------------------------------------------------------
// Reply-to lookup helpers
// ---------------------------------------------------------------------------

function findRunByQuestionMessageId(
  runs: SerializedRun[],
  chatId: number,
  threadId: number | undefined,
  messageId: number,
): SerializedRun | undefined {
  return runs.find(
    (run) =>
      isBlockedRun(run) &&
      run.telegramQuestionMessages?.some(
        (qm) => qm.messageId === messageId && matchesChatThread(qm, chatId, threadId),
      ),
  );
}

// ---------------------------------------------------------------------------
// Main routing function
// ---------------------------------------------------------------------------

/**
 * Route a Telegram text message to the appropriate handler.
 *
 * Routing precedence (callback queries and reactions bypass this function):
 *   1. Empty text → CHAT_HELP
 *   2. Non-reply greeting → CHAT
 *   3. Reply to latest plan message → GOAL_EDIT
 *   4. Reply to edit-prompt message (ForceReply from "Request changes" button) → GOAL_EDIT
 *   5. Reply to question message (blocked run) → GOAL_ANSWER
 *   6. Reply to older plan revision → DISAMBIGUATE
 *   7. Help intent → CHAT_HELP
 *   8. Default → CHAT (with replyText hint if blocked runs exist)
 */
export function routeTelegramText(input: RouteInput): RouteResult {
  const { chatId, threadId, messageText, replyToMessageId } = input;
  const scopedRuns = filterRunsForChatThread({
    runs: input.runs,
    chatId,
    threadId,
  });

  if (!messageText.trim()) {
    return { kind: "CHAT_HELP" };
  }

  // CHAT: greet/ack smalltalk should fall through to generic chat.
  if (replyToMessageId == null && isGreetingIntent(messageText)) {
    return { kind: "CHAT" };
  }

  // Reply-to-message routing
  if (replyToMessageId != null) {
    // GOAL_EDIT: reply to the latest plan message.
    const latestMatch = scopedRuns.find(
      (run) => run.telegramPlanMessage?.messageId === replyToMessageId,
    );
    if (latestMatch) {
      return { kind: "GOAL_EDIT", runId: latestMatch.runId };
    }

    // GOAL_EDIT: reply to an edit-prompt message (sent via the "Request changes" button).
    const editPromptMatch = scopedRuns.find((run) =>
      run.telegramEditPromptMessages?.some(
        (ep) => ep.messageId === replyToMessageId && matchesChatThread(ep, chatId, threadId),
      ),
    );
    if (editPromptMatch) {
      return { kind: "GOAL_EDIT", runId: editPromptMatch.runId };
    }

    // GOAL_ANSWER: reply to a question/clarification message from a blocked run.
    const questionMatch = findRunByQuestionMessageId(
      scopedRuns,
      chatId,
      threadId,
      replyToMessageId,
    );
    if (questionMatch) {
      return { kind: "GOAL_ANSWER", runId: questionMatch.runId };
    }

    // DISAMBIGUATE: reply to an older plan revision.
    const olderMatch = scopedRuns.find((run) =>
      run.telegramPlanMessage?.messageHistory?.includes(replyToMessageId),
    );
    if (olderMatch) {
      return { kind: "DISAMBIGUATE", replyText: OLDER_REVISION_MESSAGE };
    }
  }

  // CHAT: meta/help queries should not invoke goals or tools.
  if (isHelpIntent(messageText)) {
    return { kind: "CHAT_HELP" };
  }

  // Blocked-run hint: suggest reply-to or /goal_answer instead of silently attaching.
  const blockedRuns = scopedRuns.filter(isBlockedRun);
  if (blockedRuns.length > 0 && !isGreetingIntent(messageText)) {
    const hint =
      blockedRuns.length === 1
        ? `Tip: reply to the question above or use /goal_answer ${blockedRuns[0]!.runId.slice(0, 8)} <answer>`
        : "Tip: use /goal_list to see blocked runs, then /goal_answer <runId> <answer>";
    return { kind: "CHAT", replyText: hint };
  }

  // Default: treat as regular conversation — only explicit controls create/manage goal runs.
  return { kind: "CHAT" };
}

export const TELEGRAM_GOAL_ROUTER_MESSAGES = {
  OLDER_REVISION_MESSAGE,
};
