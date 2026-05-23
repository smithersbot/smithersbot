import type { BlockedDetail, PlanStep } from "./types.js";

/** Marker that {@link formatTechnicalBlockedQuestion} uses to append attempt history. */
const ATTEMPT_HISTORY_MARKER = "Attempt history:";

/**
 * Split a blocked-step message into its human-readable reason and any appended
 * attempt-history block. Technical blockers carry the same attempt history on
 * every cascaded step, so callers separate it out to deduplicate it and render
 * it once per report instead of under every step.
 */
export function splitAttemptHistory(text: string | undefined | null): {
  message: string;
  attemptHistory?: string;
} {
  if (!text) return { message: "" };
  const idx = text.indexOf(ATTEMPT_HISTORY_MARKER);
  if (idx === -1) return { message: text.trim() };
  const message = text.slice(0, idx).trim();
  const attemptHistory = text.slice(idx).trim();
  return attemptHistory ? { message, attemptHistory } : { message };
}

/** Append deduplicated attempt-history blocks once after the report body. */
function appendAttemptHistories(body: string, histories: string[]): string {
  if (histories.length === 0) return body;
  return `${body}\n\n${histories.join("\n\n")}`;
}

function buildStuckPrompt(step: PlanStep): string {
  return `Step ${step.id} stuck at in_progress — needs re-execution`;
}

function isUserInputBlocked(step: PlanStep): boolean {
  return step.blockedReason === "user_input" || step.blockedReason == null;
}

export function aggregateBlockedDetails(steps: PlanStep[]): BlockedDetail | null {
  const blocked = steps.filter((s) => s.status === "blocked");
  const stuckInProgress = steps.filter((s) => s.status === "in_progress");
  if (blocked.length === 0 && stuckInProgress.length === 0) return null;

  // Keep the legacy blocked-only contract untouched for existing callers.
  if (stuckInProgress.length === 0) {
    if (blocked.length === 1) {
      const task = blocked[0]!;
      const prompt =
        task.blockedQuestion ?? `Task ${task.id} is blocked (${task.blockedReason ?? "unknown"}).`;
      const requiredInputKey = isUserInputBlocked(task)
        ? `task:${task.id}:input`
        : "resume_execution";
      return {
        blockedAt: "execution",
        prompt,
        requiredInputKey,
        stepId: task.id,
      };
    }

    const histories: string[] = [];
    const lines = blocked.map((task) => {
      const { message, attemptHistory } = splitAttemptHistory(task.blockedQuestion);
      if (attemptHistory && !histories.includes(attemptHistory)) histories.push(attemptHistory);
      const reason = message || task.blockedReason || "unknown";
      return `- Task ${task.id} (${task.description}): ${reason}`;
    });
    return {
      blockedAt: "execution",
      prompt: appendAttemptHistories(
        `Multiple tasks need attention:\n${lines.join("\n")}`,
        histories,
      ),
      requiredInputKey: blocked.every(isUserInputBlocked)
        ? `tasks:${blocked.map((t) => t.id).join(",")}:input`
        : "resume_execution",
    };
  }

  if (blocked.length === 0 && stuckInProgress.length === 1) {
    return {
      blockedAt: "execution",
      prompt: buildStuckPrompt(stuckInProgress[0]!),
      requiredInputKey: "resume_execution",
    };
  }

  const histories: string[] = [];
  const blockedLines = blocked.map((task) => {
    const { message, attemptHistory } = splitAttemptHistory(task.blockedQuestion);
    if (attemptHistory && !histories.includes(attemptHistory)) histories.push(attemptHistory);
    const reason = message || task.blockedReason || "unknown";
    return `- Task ${task.id} (${task.description}): ${reason}`;
  });
  const stuckLines = stuckInProgress.map(
    (step) => `- Step ${step.id} (${step.description}): ${buildStuckPrompt(step)}`,
  );
  const lines = [...blockedLines, ...stuckLines];
  return {
    blockedAt: "execution",
    prompt: appendAttemptHistories(
      `Multiple tasks need attention:\n${lines.join("\n")}`,
      histories,
    ),
    requiredInputKey: "resume_execution",
  };
}
