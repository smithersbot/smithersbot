import type { SerializedRun } from "../goal/types.js";

export type RouteKind =
  | "GOAL_CREATE"
  | "GOAL_EDIT"
  | "GOAL_ANSWER"
  | "GOAL_APPROVE"
  | "GOAL_REJECT"
  | "CHAT_HELP"
  | "DISAMBIGUATE";

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
  "capabilities",
  "what can you do",
  "how do i use this",
  "how do i use it",
];

const MULTIPLE_BLOCKED_MESSAGE =
  "Multiple blocked runs. Use /goal_list and /goal_answer <runId> <answer>.";
const OLDER_REVISION_MESSAGE = "Older revision. Reply to the latest plan message.";

function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function containsIntent(text: string, intents: string[]): boolean {
  return intents.some((intent) => text === intent || text.includes(intent));
}

function containsEmoji(rawText: string, emojis: string[]): boolean {
  return emojis.some((emoji) => rawText.includes(emoji));
}

function isHelpIntent(rawText: string): boolean {
  const normalized = normalizeText(rawText);
  if (!normalized) return false;
  return containsIntent(normalized, HELP_INTENTS);
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
    run.state === "blocked" &&
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

  if (replyToMessageId != null) {
    const latestMatch = scopedRuns.find(
      (run) => run.telegramPlanMessage?.messageId === replyToMessageId,
    );
    if (latestMatch) {
      return { kind: "GOAL_EDIT", runId: latestMatch.runId };
    }
    const olderMatch = scopedRuns.find((run) =>
      run.telegramPlanMessage?.messageHistory?.includes(replyToMessageId),
    );
    if (olderMatch) {
      return { kind: "DISAMBIGUATE", replyText: OLDER_REVISION_MESSAGE };
    }
  }

  if (isHelpIntent(messageText)) {
    return { kind: "CHAT_HELP" };
  }

  const blockedRuns = scopedRuns.filter(isBlockedRun);
  if (blockedRuns.length === 1) {
    return { kind: "GOAL_ANSWER", runId: blockedRuns[0]!.runId };
  }
  if (blockedRuns.length > 1) {
    return { kind: "DISAMBIGUATE", replyText: MULTIPLE_BLOCKED_MESSAGE };
  }

  const awaitingRuns = scopedRuns.filter((run) => run.state === "awaiting_approval");
  if (awaitingRuns.length === 1 && hasApprovalIntent(messageText)) {
    return { kind: "GOAL_APPROVE", runId: awaitingRuns[0]!.runId };
  }
  if (awaitingRuns.length === 1 && hasRejectionIntent(messageText)) {
    return { kind: "GOAL_REJECT", runId: awaitingRuns[0]!.runId };
  }

  return { kind: "GOAL_CREATE" };
}

export const TELEGRAM_GOAL_ROUTER_MESSAGES = {
  MULTIPLE_BLOCKED_MESSAGE,
  OLDER_REVISION_MESSAGE,
};
