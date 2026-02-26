import fs from "node:fs";
import path from "node:path";

import type { AttemptBundle } from "./attempt-bundle.js";
import { resolveGoalWorkingFile, resolveWorkingFile } from "./run-store.js";

/** Append a summary line to the top-level WORKING.md for this goal run. */
export function appendGoalWorkingEntry(
  runId: string,
  stepId: string,
  status: string,
  detail: string,
): void {
  try {
    const filePath = resolveGoalWorkingFile(runId);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const entry = `\n## ${stepId} — ${status}\n${detail}\n`;
    fs.appendFileSync(filePath, entry, "utf8");
  } catch {
    // Best-effort; don't mask task execution errors.
  }
}

export function appendRetryContext(
  runId: string,
  stepId: string,
  summary: string,
  attemptNumber: number,
): void {
  try {
    const filePath = resolveWorkingFile(runId, stepId);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const entry = [
      `\n## Retry Context Attempt ${attemptNumber} (${new Date().toISOString()})`,
      summary,
      "",
    ].join("\n");
    fs.appendFileSync(filePath, entry, "utf8");
  } catch {
    // Best-effort
  }
}

export function appendRalphContext(
  runId: string,
  stepId: string,
  attemptNumber: number,
  detail: {
    approachTried: string;
    specificErrors: string;
    keyInsight: string;
    suggestedApproach: string;
  },
): void {
  try {
    const filePath = resolveWorkingFile(runId, stepId);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const timestamp = new Date().toISOString();
    const entry = [
      `\n## Ralph (attempt ${attemptNumber}) — ${timestamp}`,
      "### Approach tried",
      detail.approachTried,
      "### Errors encountered",
      detail.specificErrors,
      "### Key insight",
      detail.keyInsight,
      "### Suggested approach for next attempt",
      detail.suggestedApproach,
      "",
    ].join("\n");
    fs.appendFileSync(filePath, entry, "utf8");
  } catch {
    // Best-effort; don't mask task execution errors.
  }
}

export function buildRalphHistorySummary(stepId: string, bundles: AttemptBundle[]): string {
  const entries = bundles.filter((bundle) => bundle.ralphDetail);
  if (entries.length === 0) return `Task ${stepId} ralphed repeatedly but no detail was captured.`;

  const lines: string[] = [];
  for (const [index, bundle] of entries.entries()) {
    const detail = bundle.ralphDetail!;
    lines.push(`**Ralph ${index + 1} (attempt ${bundle.attemptNumber}):**`);
    lines.push(`• **Approach tried:** ${detail.approachTried}`);
    lines.push(`• **Errors:** ${detail.specificErrors}`);
    lines.push(`• **Key insight:** ${detail.keyInsight}`);
    lines.push(`• **Suggested approach:** ${detail.suggestedApproach}`);
    if (index < entries.length - 1) lines.push("");
  }
  return lines.join("\n");
}
