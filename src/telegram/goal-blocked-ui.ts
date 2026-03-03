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
    lines.push(`• Step ${step.id}: ${step.blockedQuestion ?? step.blockedReason ?? "needs input"}`);
  }
  if (blocked.length > 3) lines.push(`  \u2026and ${blocked.length - 3} more`);
  return lines.join("\n");
}
