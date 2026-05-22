import type { PlanStep } from "../goal/types.js";
import { buildInlineKeyboard } from "./send.js";

export function buildGoalBlockedInlineKeyboard(runIdPrefix: string) {
  return buildInlineKeyboard([
    [{ text: "✏️ Add Details", callback_data: `gAD:${runIdPrefix}` }],
    [
      { text: "\u25B6\uFE0F Resume Goal", callback_data: `gResume:${runIdPrefix}` },
      { text: "\u23F9\uFE0F Stop Goal", callback_data: `gStop:${runIdPrefix}` },
    ],
  ]);
}

export function buildTaskBlockedInlineKeyboard(runIdPrefix: string) {
  return buildInlineKeyboard([
    [{ text: "✏️ Add Details", callback_data: `gAD:${runIdPrefix}` }],
    [{ text: "\u23F9\uFE0F Stop Goal", callback_data: `gStop:${runIdPrefix}` }],
  ]);
}

export function buildBlockedCaption(steps: PlanStep[]): string {
  const blocked = steps.filter((step) => step.status === "blocked");
  if (blocked.length === 0) return "";

  const lines: string[] = [];
  for (const step of blocked.slice(0, 3)) {
    lines.push(`• Step ${step.id}: ${describeBlockedStep(step)}`);
  }
  if (blocked.length > 3) lines.push(`  \u2026and ${blocked.length - 3} more`);
  return lines.join("\n");
}

export function describeBlockedStep(step: PlanStep): string {
  if (step.blockedQuestion?.trim()) return step.blockedQuestion;
  switch (step.blockedReason) {
    case "user_input":
    case undefined:
      return "needs input";
    case "process_lost":
      return "worker process lost/interrupted; resume needed";
    case "timeout":
      return "worker timed out; resume needed";
    case "rate_limit":
    case "usage_limit":
      return "worker hit a provider limit; resume needed";
    case "network":
      return "worker hit a network error; resume needed";
    case "auth":
      return "worker authentication failed";
    case "out_of_credits":
      return "worker is out of credits";
    case "task_failed":
      return "worker failed";
    default:
      return "worker failed/interrupted; resume needed";
  }
}
