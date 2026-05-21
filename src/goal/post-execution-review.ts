import type { ClaudeCodeAuthMode } from "../config/types.goal.js";
import { buildPostExecutionReviewPrompt as buildPostExecutionReviewPromptFromPrompts } from "../prompts/post-execution-review/build-prompt.js";
import { redactSecretValues } from "../security/secret-paths.js";
import { formatExecError } from "./build-gate.js";
import { buildClaudeCodeEnv, buildCredentialStrippedEnv } from "./claude-code-env.js";
import {
  detectBackendAvailability,
  getCodexAskForApprovalPlacement,
} from "./backend-availability.js";
import {
  CLAUDE_ALLOWED_TOOLS_READ_ONLY,
  CLAUDE_READ_ONLY_PROMPT,
} from "./claude-code-constants.js";
import { collectText, isRecord } from "./cli-output-parsing.js";
import { runCliProcess, type RunCliProcessResult } from "./cli-process.js";
import { truncateSingleLine as truncateCompactSingleLine } from "./compact-output.js";
import { extractJsonObjectCandidates, repairJsonText } from "./json-repair.js";
import { resolveClaudeBinary } from "./scout.js";
import type { GoalSession, PlanStep } from "./types.js";

export const POST_EXECUTION_REVIEW_TIMEOUT_MS = 300_000;
export const POST_EXECUTION_REVIEW_MAX_ISSUES = 8;
export const POST_EXECUTION_REVIEW_ERROR_MAX_CHARS = 400;
// Rough ~45K-token budget; leaves headroom for the prompt scaffold and the
// model's reply within ~200K input context.
export const POST_EXECUTION_REVIEW_DIFF_MAX_CHARS = 180_000;
const NO_WORKER_BACKEND_REASON = "no worker backend available — install Codex or Claude Code";

export type PostExecutionReviewDecision = {
  approved: boolean;
  issues: string[];
};

export type PostExecutionReviewResult =
  | { status: "approved"; issues: string[] }
  | { status: "rejected"; issues: string[] }
  | { status: "error"; reason: string };

export function normalizeReviewIssues(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const normalized = raw
    .map((issue) => (typeof issue === "string" ? issue.trim() : ""))
    .filter((issue) => issue.length > 0);
  return normalized.slice(0, POST_EXECUTION_REVIEW_MAX_ISSUES);
}

export function parsePostExecutionReviewDecisionRecord(
  raw: unknown,
): PostExecutionReviewDecision | undefined {
  if (!isRecord(raw) || typeof raw.approved !== "boolean") return undefined;
  return { approved: raw.approved, issues: normalizeReviewIssues(raw.issues) };
}

export function parsePostExecutionReviewDecisionFromText(
  text: string,
): PostExecutionReviewDecision | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const decision = parsePostExecutionReviewDecisionRecord(parsed);
    if (decision) return decision;
  } catch {
    try {
      const parsed = JSON.parse(repairJsonText(trimmed)) as unknown;
      const decision = parsePostExecutionReviewDecisionRecord(parsed);
      if (decision) return decision;
    } catch {
      // Fall through to lenient extraction.
    }
  }

  for (const line of trimmed.split(/\r?\n/g)) {
    const candidate = line.trim();
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const decision = parsePostExecutionReviewDecisionRecord(parsed);
      if (decision) return decision;
    } catch {
      try {
        const parsed = JSON.parse(repairJsonText(candidate)) as unknown;
        const decision = parsePostExecutionReviewDecisionRecord(parsed);
        if (decision) return decision;
      } catch {
        continue;
      }
    }
  }

  for (const candidate of extractJsonObjectCandidates(trimmed)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const decision = parsePostExecutionReviewDecisionRecord(parsed);
      if (decision) return decision;
    } catch {
      try {
        const parsed = JSON.parse(repairJsonText(candidate)) as unknown;
        const decision = parsePostExecutionReviewDecisionRecord(parsed);
        if (decision) return decision;
      } catch {
        continue;
      }
    }
  }

  return undefined;
}

export function parsePostExecutionReviewDecision(
  stdout: string,
): PostExecutionReviewDecision | undefined {
  const fromText = parsePostExecutionReviewDecisionFromText(stdout);
  if (fromText) return fromText;

  const parseStreamRecord = (raw: unknown): PostExecutionReviewDecision | undefined => {
    const direct = parsePostExecutionReviewDecisionRecord(raw);
    if (direct) return direct;
    const viaResult = isRecord(raw)
      ? parsePostExecutionReviewDecisionRecord(raw.result)
      : undefined;
    if (viaResult) return viaResult;
    const text = collectText(raw).trim();
    if (!text) return undefined;
    return parsePostExecutionReviewDecisionFromText(text);
  };

  for (const line of stdout.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const fromLine = parseStreamRecord(parsed);
      if (fromLine) return fromLine;
    } catch {
      try {
        const parsed = JSON.parse(repairJsonText(trimmed)) as unknown;
        const fromLine = parseStreamRecord(parsed);
        if (fromLine) return fromLine;
      } catch {
        continue;
      }
    }
  }

  return undefined;
}

export function truncateSingleLine(text: string): string {
  return truncateCompactSingleLine(text, POST_EXECUTION_REVIEW_ERROR_MAX_CHARS);
}

/**
 * Parse the first balanced top-level JSON object from a Claude CLI stdout. If
 * it looks like the structured api-error envelope (`is_error === true` and a
 * numeric `api_error_status`), return a short human-readable reason. Otherwise
 * return undefined so callers fall through to other failure heuristics.
 */
export function describeApiErrorEnvelope(stdout: string): string | undefined {
  const [first] = extractJsonObjectCandidates(stdout);
  if (!first) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(first);
  } catch {
    try {
      parsed = JSON.parse(repairJsonText(first));
    } catch {
      return undefined;
    }
  }

  if (!isRecord(parsed)) return undefined;
  if (parsed.is_error !== true) return undefined;
  if (typeof parsed.api_error_status !== "number") return undefined;

  const resultText = typeof parsed.result === "string" ? parsed.result : undefined;
  const stopReason = typeof parsed.stop_reason === "string" ? parsed.stop_reason : undefined;
  const detail =
    resultText && resultText.length > 0
      ? resultText
      : stopReason && stopReason.length > 0
        ? stopReason
        : "no detail";

  let message = `API ${parsed.api_error_status}: ${detail}`;
  if (
    resultText &&
    (resultText.includes("Prompt is too long") || resultText.includes("context length"))
  ) {
    message +=
      " (diff likely too large — consider raising POST_EXECUTION_REVIEW_DIFF_MAX_CHARS or splitting the goal)";
  }
  return message;
}

export function describeCliFailure(result: RunCliProcessResult): string {
  const envelope = describeApiErrorEnvelope(result.stdout);
  if (envelope) return envelope;
  const detail = truncateSingleLine(result.stderr) || truncateSingleLine(result.stdout);
  if (detail) return detail;
  if (result.signal) return `terminated by ${result.signal}`;
  return `exit=${result.exitCode ?? "unknown"}`;
}

/**
 * True when a reason string is shaped like the structured API error envelope
 * reason produced by `describeApiErrorEnvelope` (e.g. `"API 400: Prompt is too long"`).
 * Callers use this to choose a "failed:" vs "skipped:" footer prefix.
 */
export function isApiErrorEnvelopeReason(reason: string): boolean {
  return /^API \d+:/.test(reason);
}

/**
 * Split a unified diff on `diff --git a/<path> b/<path>` boundaries. Each
 * returned chunk starts with its own header line so it remains a valid
 * standalone diff when fed to a reviewer in isolation.
 */
export function splitDiffByFile(diff: string): Array<{ path: string; chunk: string }> {
  if (!diff) return [];
  const headerRegex = /^diff --git a\/(\S+) b\/\S+/gm;
  const positions: Array<{ index: number; path: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = headerRegex.exec(diff)) !== null) {
    positions.push({ index: match.index, path: match[1] ?? "<unknown>" });
  }
  if (positions.length === 0) return [];

  const result: Array<{ path: string; chunk: string }> = [];
  for (let i = 0; i < positions.length; i += 1) {
    const start = positions[i]!.index;
    const end = i + 1 < positions.length ? positions[i + 1]!.index : diff.length;
    result.push({ path: positions[i]!.path, chunk: diff.slice(start, end) });
  }
  return result;
}

export type BoundedDiff =
  | { kind: "single"; diff: string }
  | {
      kind: "chunks";
      chunks: Array<{ path: string; diff: string }>;
      truncatedFiles: string[];
    };

/**
 * Return `{ kind: "single", diff }` when the diff fits the budget, otherwise
 * return per-file chunks. Any single per-file chunk larger than `maxChars` is
 * truncated to `maxChars` with a sentinel appended and its path recorded.
 */
export function buildBoundedDiffOrChunks(diff: string, maxChars: number): BoundedDiff {
  if (diff.length <= maxChars) return { kind: "single", diff };

  const parts = splitDiffByFile(diff);
  if (parts.length === 0) {
    // Diff doesn't match the standard `diff --git` shape — treat the whole
    // thing as a single oversized chunk so callers still get a bounded review.
    const overflow = diff.length - maxChars;
    const truncated = `${diff.slice(0, maxChars)}\n... [diff truncated: ${overflow} more bytes in this file]`;
    return {
      kind: "chunks",
      chunks: [{ path: "<diff>", diff: truncated }],
      truncatedFiles: ["<diff>"],
    };
  }

  const truncatedFiles: string[] = [];
  const chunks: Array<{ path: string; diff: string }> = [];
  for (const part of parts) {
    if (part.chunk.length <= maxChars) {
      chunks.push({ path: part.path, diff: part.chunk });
      continue;
    }
    const overflow = part.chunk.length - maxChars;
    const truncated = `${part.chunk.slice(0, maxChars)}\n... [diff truncated: ${overflow} more bytes in this file]`;
    chunks.push({ path: part.path, diff: truncated });
    truncatedFiles.push(part.path);
  }
  return { kind: "chunks", chunks, truncatedFiles };
}

export function resolvePostExecutionReviewBaseSha(
  steps: PlanStep[],
  checkpoints?: GoalSession["taskCheckpoints"],
): string | undefined {
  if (!checkpoints) return undefined;
  const firstStepId = steps[0]?.id;
  const firstSha = firstStepId ? checkpoints[firstStepId]?.baseSha : undefined;
  if (firstSha) return firstSha;

  for (const step of steps) {
    const candidate = checkpoints[step.id]?.baseSha;
    if (candidate) return candidate;
  }

  return undefined;
}

/**
 * Re-export of the canonical post-execution review prompt builder from
 * `src/prompts/post-execution-review/build-prompt.ts`. Keeps the function
 * name available on this module so existing imports keep resolving.
 */
export const buildPostExecutionReviewPrompt = buildPostExecutionReviewPromptFromPrompts;

async function runSingleReviewPass(params: {
  prompt: string;
  workingDir: string;
  claudeCodeAuth: ClaudeCodeAuthMode;
  abortSignal: AbortSignal;
  backend: { id: "claude_code"; command: string } | { id: "codex"; command: "codex" };
}): Promise<PostExecutionReviewResult> {
  let result: RunCliProcessResult;
  const codexAskForApproval =
    params.backend.id === "codex" ? getCodexAskForApprovalPlacement() : "unsupported";
  try {
    result = await runCliProcess({
      command: params.backend.command,
      args:
        params.backend.id === "claude_code"
          ? [
              "-p",
              "--output-format",
              "json",
              "--max-turns",
              "1",
              "--allowedTools",
              CLAUDE_ALLOWED_TOOLS_READ_ONLY,
              "--append-system-prompt",
              CLAUDE_READ_ONLY_PROMPT,
            ]
          : [
              ...(codexAskForApproval === "before_exec" ? ["--ask-for-approval", "never"] : []),
              "exec",
              "--json",
              ...(codexAskForApproval === "after_exec" ? ["--ask-for-approval", "never"] : []),
              "--sandbox",
              "workspace-write",
              "--cd",
              params.workingDir,
              "-c",
              "net.allowed=true",
              params.prompt,
            ],
      cwd: params.workingDir,
      timeoutMs: POST_EXECUTION_REVIEW_TIMEOUT_MS,
      ...(params.backend.id === "claude_code" ? { stdin: params.prompt } : {}),
      abortSignal: params.abortSignal,
      env:
        params.backend.id === "claude_code"
          ? buildClaudeCodeEnv(params.claudeCodeAuth)
          : buildCredentialStrippedEnv(process.env, { stripAuthKeys: true }),
    });
  } catch (error) {
    return {
      status: "error",
      reason: `review process failed: ${truncateSingleLine(formatExecError(error)) || "unknown error"}`,
    };
  }

  if (result.timedOut) {
    return {
      status: "error",
      reason: `review timed out after ${(POST_EXECUTION_REVIEW_TIMEOUT_MS / 1000).toFixed(0)}s`,
    };
  }
  const redactedResult: RunCliProcessResult = {
    ...result,
    stdout: redactSecretValues(result.stdout),
    stderr: redactSecretValues(result.stderr),
  };

  if ((redactedResult.exitCode && redactedResult.exitCode !== 0) || redactedResult.signal) {
    return { status: "error", reason: describeCliFailure(redactedResult) };
  }

  const decision = parsePostExecutionReviewDecision(redactedResult.stdout);
  if (!decision) {
    return { status: "error", reason: "review response was not valid JSON decision output" };
  }

  const issues = decision.issues.map((issue) => redactSecretValues(issue));
  return decision.approved ? { status: "approved", issues } : { status: "rejected", issues };
}

export async function runPostExecutionReview(params: {
  goal: string;
  steps: PlanStep[];
  diff: string;
  workingDir: string;
  claudeCodeAuth: ClaudeCodeAuthMode;
  abortSignal: AbortSignal;
}): Promise<PostExecutionReviewResult> {
  const claudeBinary = resolveClaudeBinary();
  const availability = detectBackendAvailability();
  const codexAvailable = availability.find((entry) => entry.id === "codex")?.available === true;
  const backend:
    | { id: "claude_code"; command: string }
    | { id: "codex"; command: "codex" }
    | undefined = claudeBinary
    ? { id: "claude_code", command: claudeBinary }
    : codexAvailable
      ? { id: "codex", command: "codex" }
      : undefined;
  if (!backend) {
    return { status: "error", reason: NO_WORKER_BACKEND_REASON };
  }

  const bounded = buildBoundedDiffOrChunks(params.diff, POST_EXECUTION_REVIEW_DIFF_MAX_CHARS);

  if (bounded.kind === "single") {
    const prompt = buildPostExecutionReviewPrompt({
      goal: params.goal,
      steps: params.steps,
      diff: bounded.diff,
    });
    return runSingleReviewPass({
      prompt,
      workingDir: params.workingDir,
      claudeCodeAuth: params.claudeCodeAuth,
      abortSignal: params.abortSignal,
      backend,
    });
  }

  const totalChunks = bounded.chunks.length;
  const mergedIssues: string[] = [];
  const seenIssues = new Set<string>();
  let anyRejected = false;

  for (let i = 0; i < totalChunks; i += 1) {
    if (params.abortSignal.aborted) {
      return { status: "error", reason: "review aborted" };
    }
    const chunk = bounded.chunks[i]!;
    const basePrompt = buildPostExecutionReviewPrompt({
      goal: params.goal,
      steps: params.steps,
      diff: chunk.diff,
    });
    const chunkPrompt = [
      `You are reviewing one file out of ${totalChunks}. Focus on issues local to this file. Other files may add context you cannot see.`,
      "",
      basePrompt,
    ].join("\n");

    const chunkResult = await runSingleReviewPass({
      prompt: chunkPrompt,
      workingDir: params.workingDir,
      claudeCodeAuth: params.claudeCodeAuth,
      abortSignal: params.abortSignal,
      backend,
    });

    if (chunkResult.status === "error") {
      return { status: "error", reason: `${chunk.path}: ${chunkResult.reason}` };
    }

    if (chunkResult.status === "rejected") {
      anyRejected = true;
    }
    for (const issue of chunkResult.issues) {
      if (seenIssues.has(issue)) continue;
      seenIssues.add(issue);
      mergedIssues.push(issue);
      if (mergedIssues.length >= POST_EXECUTION_REVIEW_MAX_ISSUES) break;
    }
    if (mergedIssues.length >= POST_EXECUTION_REVIEW_MAX_ISSUES) break;
  }

  if (bounded.truncatedFiles.length > 0 && mergedIssues.length < POST_EXECUTION_REVIEW_MAX_ISSUES) {
    const truncationIssue = `Diff for these files was truncated and not fully reviewed: ${bounded.truncatedFiles.join(", ")}`;
    if (!seenIssues.has(truncationIssue)) {
      seenIssues.add(truncationIssue);
      mergedIssues.push(truncationIssue);
    }
  }

  return anyRejected
    ? { status: "rejected", issues: mergedIssues }
    : { status: "approved", issues: mergedIssues };
}
