import type { SerializedRun } from "../goal/types.js";

// Routing contract: Telegram chats feel conversational, but all side effects must flow
// through goal runs. CHAT is read-only. Only GOAL_* routes are allowed to plan/execute.
export type RouteKind =
  | "GOAL_CREATE"
  | "GOAL_EDIT"
  | "GOAL_ANSWER"
  | "GOAL_APPROVE"
  | "GOAL_REJECT"
  | "CHAT"
  | "CHAT_HELP"
  | "DISAMBIGUATE";

export type RouterDecision = "GOAL_CREATE" | "GOAL_EDIT" | "GOAL_APPROVE" | "GOAL_ANSWER" | "CHAT";

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

const APPROVAL_INTENTS = ["approve", "yes", "go ahead", "run it", "ship it", "do it"];
const REJECTION_INTENTS = ["reject", "no", "stop", "cancel"];
const APPROVAL_EMOJIS = ["✅", "👍", "❤️"];
const REJECTION_EMOJIS = ["👎"];

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

const MULTIPLE_BLOCKED_MESSAGE =
  "Multiple blocked runs. Use /goal_list and /goal_answer <runId> <answer>.";
const OLDER_REVISION_MESSAGE =
  "That's an older revision. Reply to the latest plan message to request changes.";

function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function containsIntent(text: string, intents: string[]): boolean {
  return intents.some((intent) => text === intent || text.includes(intent));
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

function containsEmoji(rawText: string, emojis: string[]): boolean {
  return emojis.some((emoji) => rawText.includes(emoji));
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

function hasApprovalIntent(rawText: string): boolean {
  const normalized = normalizeText(rawText);
  if (containsEmoji(rawText, APPROVAL_EMOJIS)) return true;
  if (!normalized) return false;
  return containsIntent(normalized, APPROVAL_INTENTS);
}

function hasRejectionIntent(rawText: string): boolean {
  const normalized = normalizeText(rawText);
  if (containsEmoji(rawText, REJECTION_EMOJIS)) return true;
  if (!normalized) return false;
  return containsIntent(normalized, REJECTION_INTENTS);
}

function filterRunsForChatThread(params: {
  runs: SerializedRun[];
  chatId: number;
  threadId?: number;
}): SerializedRun[] {
  const { runs, chatId, threadId } = params;
  return runs.filter((run) => {
    const plan = run.telegramPlanMessage;
    if (!plan) return false;
    if (plan.chatId !== chatId) return false;
    if (typeof threadId === "number") {
      return plan.threadId === threadId;
    }
    return typeof plan.threadId !== "number";
  });
}

function isBlockedRun(run: SerializedRun): boolean {
  return (
    (run.state === "blocked" || run.state === "needs_clarification") &&
    Boolean(run.blocked?.prompt?.trim()) &&
    Boolean(run.blocked?.requiredInputKey?.trim())
  );
}

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

  if (replyToMessageId != null) {
    const latestMatch = scopedRuns.find(
      (run) => run.telegramPlanMessage?.messageId === replyToMessageId,
    );
    // GOAL_EDIT: reply to the latest plan message.
    if (latestMatch) {
      return { kind: "GOAL_EDIT", runId: latestMatch.runId };
    }
    const olderMatch = scopedRuns.find((run) =>
      run.telegramPlanMessage?.messageHistory?.includes(replyToMessageId),
    );
    // CHAT (disambiguate): reply to an older plan revision.
    if (olderMatch) {
      return { kind: "DISAMBIGUATE", replyText: OLDER_REVISION_MESSAGE };
    }
  }

  // CHAT: meta/help queries should not invoke goals or tools.
  if (isHelpIntent(messageText)) {
    return { kind: "CHAT_HELP" };
  }

  const blockedRuns = scopedRuns.filter(isBlockedRun);
  // GOAL_ANSWER: exactly one blocked run is awaiting a required input.
  if (blockedRuns.length === 1) {
    return { kind: "GOAL_ANSWER", runId: blockedRuns[0]!.runId };
  }
  // CHAT (disambiguate): multiple blocked runs need explicit selection.
  if (blockedRuns.length > 1) {
    return { kind: "DISAMBIGUATE", replyText: MULTIPLE_BLOCKED_MESSAGE };
  }

  const awaitingRuns = scopedRuns.filter((run) => run.state === "awaiting_approval");
  // GOAL_APPROVE: exactly one awaiting-approval run and approval intent detected.
  if (awaitingRuns.length === 1 && hasApprovalIntent(messageText)) {
    return { kind: "GOAL_APPROVE", runId: awaitingRuns[0]!.runId };
  }
  // GOAL_REJECT: exactly one awaiting-approval run and rejection intent detected.
  if (awaitingRuns.length === 1 && hasRejectionIntent(messageText)) {
    return { kind: "GOAL_REJECT", runId: awaitingRuns[0]!.runId };
  }

  // Default: treat as regular conversation — only explicit /commands create goal runs.
  return { kind: "CHAT" };
}

export const TELEGRAM_GOAL_ROUTER_MESSAGES = {
  MULTIPLE_BLOCKED_MESSAGE,
  OLDER_REVISION_MESSAGE,
};
