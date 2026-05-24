import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { canRunGit, isGitRepo } from "./git-checkpoint.js";
import { resolveRunDir } from "./run-store.js";
import type { RalphDetail } from "./types.js";
import { redactSecretValues } from "../security/secret-paths.js";
import type { AgentBackendUsage } from "./agent-history-events.js";

export type AttemptOutcome =
  | "complete"
  | "blocked"
  | "failed"
  | "ralph"
  | "timeout"
  | "crash"
  | "process_lost"
  | "rate_limit";

export type AttemptBundle = {
  attemptNumber: number;
  backend: string;
  outcome: AttemptOutcome;
  errorClassification?: string;
  resultFile?: string | null;
  logExcerpt?: string;
  diffstat?: string;
  changedFiles?: string[];
  durationMs: number;
  tokenUsage?: AgentBackendUsage;
  toolCalls?: string[];
  ralphDetail?: RalphDetail;
  buildGateFailure?: {
    failedCommand: string;
    output: string;
  };
};

const ATTEMPT_SUMMARY_TEXT_LIMIT = 1200;

export function resolveWorkerDir(runId: string, stepId: string): string {
  return path.join(resolveRunDir(runId), "workers", stepId);
}

export function resolveAttemptPath(dir: string, attemptNumber: number): string {
  return path.join(dir, `attempt-${attemptNumber}.json`);
}

export function writeAttemptBundle(dir: string, bundle: AttemptBundle): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const attemptPath = resolveAttemptPath(dir, bundle.attemptNumber);
    fs.writeFileSync(attemptPath, redactSecretValues(JSON.stringify(bundle, null, 2)), "utf8");
  } catch {
    // Best-effort; don't mask task execution errors.
  }
}

export function loadAttemptBundleText(
  dir: string,
  attemptNumber: number,
  maxChars = 4000,
): string | null {
  try {
    const attemptPath = resolveAttemptPath(dir, attemptNumber);
    const raw = fs.readFileSync(attemptPath, "utf8").trim();
    if (!raw) return null;
    if (raw.length <= maxChars) return raw;
    return `${raw.slice(-maxChars)}\n...(truncated, showing most recent content)`;
  } catch {
    return null;
  }
}

export function loadAttemptBundles(dir: string): AttemptBundle[] {
  try {
    if (!fs.existsSync(dir)) return [];
    const entries = fs.readdirSync(dir);
    const bundles: AttemptBundle[] = [];
    for (const entry of entries) {
      const match = /^attempt-(\d+)\.json$/.exec(entry);
      if (!match) continue;
      const raw = fs.readFileSync(path.join(dir, entry), "utf8");
      const parsed = JSON.parse(raw) as AttemptBundle;
      bundles.push(parsed);
    }
    bundles.sort((a, b) => a.attemptNumber - b.attemptNumber);
    return bundles;
  } catch {
    return [];
  }
}

export function formatAttemptBundleSummary(bundle: AttemptBundle): string {
  const lines: string[] = [];
  lines.push(`Attempt: ${bundle.attemptNumber}`);
  lines.push(`Backend: ${bundle.backend}`);
  lines.push(`Outcome: ${bundle.outcome}`);
  lines.push(`Duration: ${formatDuration(bundle.durationMs)}`);
  if (bundle.changedFiles && bundle.changedFiles.length > 0) {
    lines.push(`Changed files: ${bundle.changedFiles.join(", ")}`);
  }
  if (bundle.diffstat) {
    lines.push(`Diffstat: ${bundle.diffstat.replace(/\n/g, "; ")}`);
  }
  if (bundle.errorClassification) {
    lines.push(`Error classification: ${bundle.errorClassification}`);
  }
  if (bundle.ralphDetail) {
    lines.push("Ralph details:");
    lines.push(`Approach tried: ${bundle.ralphDetail.approachTried}`);
    lines.push(`Specific errors: ${compactAttemptText(bundle.ralphDetail.specificErrors)}`);
    lines.push(`Key insight: ${bundle.ralphDetail.keyInsight}`);
    lines.push(`Suggested approach: ${bundle.ralphDetail.suggestedApproach}`);
  }
  if (bundle.buildGateFailure) {
    lines.push("Build gate failure:");
    lines.push(`Failed command: ${bundle.buildGateFailure.failedCommand}`);
    lines.push("Build gate output:");
    lines.push(compactAttemptText(bundle.buildGateFailure.output));
  }
  if (bundle.logExcerpt) {
    lines.push("Log excerpt:");
    lines.push(compactAttemptText(bundle.logExcerpt));
  }
  if (bundle.toolCalls && bundle.toolCalls.length > 0) {
    lines.push(`Tool calls: ${bundle.toolCalls.join(", ")}`);
  }
  return lines.join("\n");
}

function compactAttemptText(text: string): string {
  const normalized = text.trim();
  if (normalized.length <= ATTEMPT_SUMMARY_TEXT_LIMIT) return normalized;
  const headLength = Math.floor(ATTEMPT_SUMMARY_TEXT_LIMIT * 0.35);
  const tailLength = ATTEMPT_SUMMARY_TEXT_LIMIT - headLength;
  return [
    normalized.slice(0, headLength),
    `...(${normalized.length - ATTEMPT_SUMMARY_TEXT_LIMIT} chars omitted; showing start and end)...`,
    normalized.slice(-tailLength),
  ].join("\n");
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "0s";
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}

export function tailText(text: string, maxChars: number): string {
  if (!text) return "";
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

export function collectGitDiffSummary(cwd: string): {
  diffstat?: string;
  changedFiles?: string[];
} {
  if (!canRunGit() || !isGitRepo(cwd)) return {};
  try {
    const diffstat = execFileSync("git", ["-C", cwd, "diff", "--stat"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    const changedRaw = execFileSync("git", ["-C", cwd, "diff", "--name-only"], {
      encoding: "utf8",
      timeout: 5000,
    })
      .trim()
      .split("\n")
      .filter(Boolean);
    const result: { diffstat?: string; changedFiles?: string[] } = {};
    if (diffstat) result.diffstat = diffstat;
    if (changedRaw.length > 0) result.changedFiles = changedRaw;
    return result;
  } catch {
    return {};
  }
}
