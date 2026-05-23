import type { GoalBackendId } from "../goal/backend-types.js";
import { splitAttemptHistory } from "../goal/blocked.js";
import { classifyUsageLimit, type UsageLimitBackend } from "../goal/error-patterns.js";
import type { PlanStep } from "../goal/types.js";
import { describeUsageLimitEvent, type UsageLimitEvent } from "../goal/usage-limit-message.js";
import { buildInlineKeyboard } from "./send.js";

export function buildGoalBlockedInlineKeyboard(runIdPrefix: string) {
  return buildInlineKeyboard([
    [{ text: "✏️ Add Details", callback_data: `gAD:${runIdPrefix}` }],
    [
      { text: "▶️ Resume Goal", callback_data: `gResume:${runIdPrefix}` },
      { text: "⏹️ Stop Goal", callback_data: `gStop:${runIdPrefix}` },
    ],
  ]);
}

export function buildTaskBlockedInlineKeyboard(runIdPrefix: string) {
  return buildInlineKeyboard([
    [{ text: "✏️ Add Details", callback_data: `gAD:${runIdPrefix}` }],
    [{ text: "⏹️ Stop Goal", callback_data: `gStop:${runIdPrefix}` }],
  ]);
}

export function buildBlockedCaption(steps: PlanStep[]): string {
  const blocked = steps.filter((step) => step.status === "blocked");
  if (blocked.length === 0) return "";

  const lines: string[] = [];
  // Technical blockers carry the same attempt history on every cascaded step;
  // collect unique histories and render them once at the end of the caption.
  const histories: string[] = [];
  for (const step of blocked.slice(0, 3)) {
    const { attemptHistory } = splitAttemptHistory(step.blockedQuestion);
    if (attemptHistory && !histories.includes(attemptHistory)) histories.push(attemptHistory);
    lines.push(`• Step ${step.id}: ${describeBlockedStep(step)}`);
  }
  if (blocked.length > 3) lines.push(`  …and ${blocked.length - 3} more`);
  let caption = lines.join("\n");
  if (histories.length > 0) caption += `\n\n${histories.join("\n\n")}`;
  return caption;
}

function toUsageLimitBackend(backend: GoalBackendId | undefined): UsageLimitBackend | undefined {
  return backend === "claude_code" || backend === "codex" ? backend : undefined;
}

/**
 * Render a usage/rate-limit blocker with the backend name and reset time when
 * available. Reuses the shared classifier — never re-implements detection here.
 */
function describeUsageLimitBlocked(step: PlanStep): string {
  const { message } = splitAttemptHistory(step.blockedQuestion);
  const text = message.trim();
  // The worker path already formats a backend-attributed message; surface it.
  if (text && (text.includes("Claude Code") || text.includes("Codex"))) return text;

  const backend = toUsageLimitBackend(step.executedBackend ?? step.backend);
  if (!backend) return text || "worker hit a provider limit; resume needed";

  const classification = classifyUsageLimit({ backend, text });
  const event: UsageLimitEvent = {
    backend,
    kind: step.blockedReason === "usage_limit" ? "usage_limit" : "rate_limit",
    limitType: classification.limitType,
    ...(classification.resetHint ? { resetHint: classification.resetHint } : {}),
  };
  return `${describeUsageLimitEvent(event)}; resume needed`;
}

export function describeBlockedStep(step: PlanStep): string {
  // Usage/rate limits get backend + reset-time attribution from the classifier.
  if (step.blockedReason === "usage_limit" || step.blockedReason === "rate_limit") {
    return describeUsageLimitBlocked(step);
  }

  // Only true user-input blockers may say "needs input".
  if (step.blockedReason === "user_input" || step.blockedReason === undefined) {
    return step.blockedQuestion?.trim() || "needs input";
  }

  // Technical blockers: categorized phrase, with attempt history stripped (it is
  // deduplicated once per report by buildBlockedCaption).
  const message = splitAttemptHistory(step.blockedQuestion).message;
  switch (step.blockedReason) {
    case "process_lost":
      return "worker process lost/interrupted; resume needed";
    case "timeout":
      return "worker timed out; resume needed";
    case "turn_limit":
      return "worker hit its turn limit; resume needed";
    case "network":
      return "worker hit a network error; resume needed";
    case "auth":
      return "worker authentication failed";
    case "out_of_credits":
      return "worker is out of credits";
    case "task_failed":
      return message || "worker failed";
    case "error":
      return message || "worker failed/interrupted; resume needed";
    default:
      return message || "worker failed/interrupted; resume needed";
  }
}
