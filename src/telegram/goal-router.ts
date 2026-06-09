import type { SerializedRun } from "../goal/types.js";
import { findPendingContinuationEditInteraction } from "./continuation-edit-interactions.js";

// Routing contract: Telegram chats feel conversational, but all side effects must flow
// through goal runs. CHAT is read-only. Only GOAL_* routes are allowed to plan/execute.
//
// Callback queries (inline buttons) and emoji reactions never enter routeTelegramText.
// They are handled by dedicated Grammy middleware registered in registerTelegramGoalCommands()
// (called from registerTelegramNativeCommands, bot.ts:348) which runs before registerTelegramHandlers
// (bot.ts:454) where the text router lives.
export type RouteKind =
  | "GOAL_EDIT"
  | "GOAL_CONTINUATION_EDIT"
  | "GOAL_ANSWER"
  | "GOAL_FEEDBACK"
  | "GOAL_NOTICE"
  | "CHAT"
  | "CHAT_HELP"
  | "DISAMBIGUATE";

export type RouteResult = {
  kind: RouteKind;
  runId?: string;
  replyText?: string;
  resumeSource?: "add_details" | "direct_reply";
};

type RouteInput = {
  chatId: number;
  threadId?: number;
  senderId?: string;
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

const ADD_DETAILS_REPLY_KEY = "add_details";

function buildTrackedReplyNotice(runId: string): string {
  const shortId = runId.slice(0, 8);
  return `That goal message isn't waiting on a reply right now. Use /goal_detail ${shortId} to check its status, or /goal_resume ${shortId} if it's paused.`;
}

function buildCompletedTrackedReplyNotice(state: string): string {
  return `No blocked, paused, or failed steps need input/resume right now. The goal is currently ${state}.`;
}

function buildStaleContinuationEditNotice(): string {
  return "That continuation edit prompt was replaced. Reply to the latest continuation edit prompt.";
}

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

function matchesContinuationNotify(
  notify:
    | {
        chatId?: number;
        messageId?: number;
        threadId?: number;
      }
    | undefined,
  chatId: number,
  threadId: number | undefined,
  messageId?: number,
): boolean {
  if (notify?.chatId == null) return false;
  if (messageId != null && notify.messageId !== messageId) return false;
  return matchesChatThread({ chatId: notify.chatId, threadId: notify.threadId }, chatId, threadId);
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
    if (matchesChatThread(run.telegramDoneMessage, chatId, threadId)) return true;
    if (run.telegramFeedbackPromptMessages?.some((fp) => matchesChatThread(fp, chatId, threadId))) {
      return true;
    }
    if (matchesContinuationNotify(run.pendingContinuation?.notify, chatId, threadId)) return true;
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

type QuestionMessageHit = {
  run: SerializedRun;
  requiredInputKey: string | undefined;
};

function findQuestionHit(
  runs: SerializedRun[],
  chatId: number,
  threadId: number | undefined,
  messageId: number,
): QuestionMessageHit | undefined {
  for (const run of runs) {
    const qm = run.telegramQuestionMessages?.find(
      (q) => q.messageId === messageId && matchesChatThread(q, chatId, threadId),
    );
    if (qm) return { run, requiredInputKey: qm.requiredInputKey };
  }
  return undefined;
}

// True for a reply that targets ANY tracked goal/task message (plan, edit
// prompt, done, feedback prompt, or question/blocked-notification message),
// regardless of the run's current state. Used as a safety net so such replies
// are always handled by the goal path and never fall through to repo-chat or
// the embedded agent.
function findRunByAnyTrackedMessageId(
  runs: SerializedRun[],
  chatId: number,
  threadId: number | undefined,
  messageId: number,
): SerializedRun | undefined {
  return runs.find((run) => {
    if (
      run.telegramPlanMessage?.messageId === messageId &&
      matchesChatThread(run.telegramPlanMessage, chatId, threadId)
    ) {
      return true;
    }
    if (run.telegramPlanMessage?.messageHistory?.includes(messageId)) return true;
    if (
      run.telegramEditPromptMessages?.some(
        (ep) => ep.messageId === messageId && matchesChatThread(ep, chatId, threadId),
      )
    ) {
      return true;
    }
    if (
      run.telegramDoneMessage?.messageId === messageId &&
      matchesChatThread(run.telegramDoneMessage, chatId, threadId)
    ) {
      return true;
    }
    if (
      run.telegramFeedbackPromptMessages?.some(
        (fp) => fp.messageId === messageId && matchesChatThread(fp, chatId, threadId),
      )
    ) {
      return true;
    }
    if (matchesContinuationNotify(run.pendingContinuation?.notify, chatId, threadId, messageId)) {
      return true;
    }
    if (
      run.telegramQuestionMessages?.some(
        (qm) => qm.messageId === messageId && matchesChatThread(qm, chatId, threadId),
      )
    ) {
      return true;
    }
    return false;
  });
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
 *   5. Reply to done message (done buttons message) → GOAL_FEEDBACK
 *   6. Reply to feedback prompt message (ForceReply from "Incorporate Feedback") → GOAL_FEEDBACK
 *   7. Reply to continuation prompt edit message → GOAL_CONTINUATION_EDIT
 *   8. Reply to tracked blocked/paused/failed goal/task message → GOAL_ANSWER
 *   9. Reply to older plan revision → DISAMBIGUATE
 *   10. Reply to any other tracked goal/task message → GOAL_NOTICE (never repo-chat)
 *   11. Help intent → CHAT_HELP
 *   12. Default → CHAT (with replyText hint if blocked runs exist)
 */
export function routeTelegramText(input: RouteInput): RouteResult {
  const { chatId, threadId, senderId, messageText, replyToMessageId } = input;
  const scopedRuns = filterRunsForChatThread({
    runs: input.runs,
    chatId,
    threadId,
  });

  if (!messageText.trim()) {
    return { kind: "CHAT_HELP" };
  }

  const isSlashCommand = messageText.trimStart().startsWith("/");

  // CHAT: greet/ack smalltalk should fall through to generic chat.
  if (replyToMessageId == null && isGreetingIntent(messageText)) {
    return { kind: "CHAT" };
  }

  // Reply-to-message routing
  if (replyToMessageId != null) {
    const questionHit = findQuestionHit(scopedRuns, chatId, threadId, replyToMessageId);
    if (questionHit?.requiredInputKey === ADD_DETAILS_REPLY_KEY) {
      return {
        kind: "GOAL_ANSWER",
        runId: questionHit.run.runId,
        resumeSource: "add_details",
      };
    }

    const trackedMatch = findRunByAnyTrackedMessageId(
      scopedRuns,
      chatId,
      threadId,
      replyToMessageId,
    );
    if (trackedMatch?.state === "blocked") {
      return {
        kind: "GOAL_ANSWER",
        runId: trackedMatch.runId,
        resumeSource: "direct_reply",
      };
    }

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

    // GOAL_FEEDBACK: reply directly to the done message (button host message).
    const doneMessageMatch = scopedRuns.find(
      (run) =>
        run.telegramDoneMessage?.messageId === replyToMessageId &&
        matchesChatThread(run.telegramDoneMessage, chatId, threadId),
    );
    if (doneMessageMatch) {
      return { kind: "GOAL_FEEDBACK", runId: doneMessageMatch.runId };
    }

    // GOAL_FEEDBACK: reply to a feedback-prompt message (sent via the done message button).
    const feedbackPromptMatch = scopedRuns.find((run) =>
      run.telegramFeedbackPromptMessages?.some(
        (fp) => fp.messageId === replyToMessageId && matchesChatThread(fp, chatId, threadId),
      ),
    );
    if (feedbackPromptMatch) {
      return { kind: "GOAL_FEEDBACK", runId: feedbackPromptMatch.runId };
    }

    const continuationPromptMatch = scopedRuns.find((run) =>
      matchesContinuationNotify(
        run.pendingContinuation?.notify,
        chatId,
        threadId,
        replyToMessageId,
      ),
    );
    if (continuationPromptMatch) {
      return { kind: "GOAL_CONTINUATION_EDIT", runId: continuationPromptMatch.runId };
    }

    if (senderId && !isSlashCommand) {
      const pendingContinuationEdit = findPendingContinuationEditInteraction({
        chatId,
        threadId,
        senderId,
        runIds: scopedRuns.map((run) => run.runId),
      });
      if (
        pendingContinuationEdit &&
        (pendingContinuationEdit.originalMessageId === replyToMessageId ||
          pendingContinuationEdit.promptMessageId === replyToMessageId)
      ) {
        const run = scopedRuns.find(
          (candidate) => candidate.runId === pendingContinuationEdit.runId,
        );
        const status = run?.pendingContinuation?.status;
        if (status === "pending" || status === "edited") {
          return { kind: "GOAL_CONTINUATION_EDIT", runId: pendingContinuationEdit.runId };
        }
        return {
          kind: "GOAL_NOTICE",
          runId: pendingContinuationEdit.runId,
          replyText: "That continuation prompt is no longer waiting for edits.",
        };
      }
      if (pendingContinuationEdit?.supersededMessageIds?.includes(replyToMessageId)) {
        return {
          kind: "GOAL_NOTICE",
          runId: pendingContinuationEdit.runId,
          replyText: buildStaleContinuationEditNotice(),
        };
      }
    }

    // DISAMBIGUATE: reply to an older plan revision.
    const olderMatch = scopedRuns.find((run) =>
      run.telegramPlanMessage?.messageHistory?.includes(replyToMessageId),
    );
    if (olderMatch) {
      return { kind: "DISAMBIGUATE", replyText: OLDER_REVISION_MESSAGE };
    }

    // Safety net: a reply that targets a tracked goal/task message but matched no
    // actionable route (e.g. a reply to a paused/done run's notification) must be
    // handled by the goal path — never fall through to repo-chat or the embedded
    // agent. Return a clear instruction so the user knows the next action.
    if (trackedMatch) {
      if (trackedMatch.state === "done") {
        return {
          kind: "GOAL_NOTICE",
          runId: trackedMatch.runId,
          replyText: buildCompletedTrackedReplyNotice(trackedMatch.state),
        };
      }
      return {
        kind: "GOAL_NOTICE",
        runId: trackedMatch.runId,
        replyText: buildTrackedReplyNotice(trackedMatch.runId),
      };
    }
  }

  // CHAT: meta/help queries should not invoke goals or tools.
  if (isHelpIntent(messageText)) {
    return { kind: "CHAT_HELP" };
  }

  if (senderId && !isSlashCommand) {
    const pendingContinuationEdit = findPendingContinuationEditInteraction({
      chatId,
      threadId,
      senderId,
      runIds: scopedRuns.map((run) => run.runId),
    });
    if (pendingContinuationEdit) {
      const run = scopedRuns.find((candidate) => candidate.runId === pendingContinuationEdit.runId);
      const status = run?.pendingContinuation?.status;
      if (status === "pending" || status === "edited") {
        return { kind: "GOAL_CONTINUATION_EDIT", runId: pendingContinuationEdit.runId };
      }
      return {
        kind: "GOAL_NOTICE",
        runId: pendingContinuationEdit.runId,
        replyText: "That continuation prompt is no longer waiting for edits.",
      };
    }
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
  buildTrackedReplyNotice,
  buildCompletedTrackedReplyNotice,
  buildStaleContinuationEditNotice,
};
