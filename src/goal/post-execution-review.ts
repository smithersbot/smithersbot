import type { ClaudeCodeAuthMode } from "../config/types.goal.js";
import { buildClaudeCodeEnv } from "./claude-code-env.js";
import { runCliProcess, type RunCliProcessResult } from "./cli-process.js";
import { extractJsonObjectCandidates, repairJsonText } from "./json-repair.js";
import { resolveClaudeBinary } from "./scout.js";
import type { GoalSession, PlanStep } from "./types.js";

export { extractJsonObjectCandidates } from "./json-repair.js";

export const POST_EXECUTION_REVIEW_TIMEOUT_MS = 300_000;
export const POST_EXECUTION_REVIEW_MAX_ISSUES = 8;
export const POST_EXECUTION_REVIEW_ERROR_MAX_CHARS = 400;
export const CLAUDE_REVIEW_ALLOWED_TOOLS = "Read,Glob,Grep,Bash";
export const CLAUDE_REVIEW_READ_ONLY_PROMPT =
  "This is READ-ONLY. Do NOT create, modify, or delete any files.";

export type PostExecutionReviewDecision = {
  approved: boolean;
  issues: string[];
};

export type PostExecutionReviewResult =
  | { status: "approved"; issues: string[] }
  | { status: "rejected"; issues: string[] }
  | { status: "error"; reason: string };

function formatExecError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const maybeStdout = (error as { stdout?: Buffer | string }).stdout;
  const maybeStderr = (error as { stderr?: Buffer | string }).stderr;
  const stdout =
    typeof maybeStdout === "string"
      ? maybeStdout
      : maybeStdout instanceof Buffer
        ? maybeStdout.toString("utf8")
        : "";
  const stderr =
    typeof maybeStderr === "string"
      ? maybeStderr
      : maybeStderr instanceof Buffer
        ? maybeStderr.toString("utf8")
        : "";
  return [error.message, stdout, stderr]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function collectText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((entry) => collectText(entry)).join("");
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content))
    return value.content.map((entry) => collectText(entry)).join("");
  if (isRecord(value.message)) return collectText(value.message);
  if (isRecord(value.delta)) return collectText(value.delta);
  if (isRecord(value.item)) return collectText(value.item);
  if (typeof value.result === "string") return value.result;
  if (isRecord(value.result)) return collectText(value.result);
  return "";
}

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
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= POST_EXECUTION_REVIEW_ERROR_MAX_CHARS) return normalized;
  return `${normalized.slice(0, POST_EXECUTION_REVIEW_ERROR_MAX_CHARS).trimEnd()}...`;
}

export function describeCliFailure(result: RunCliProcessResult): string {
  const detail = truncateSingleLine(result.stderr) || truncateSingleLine(result.stdout);
  if (detail) return detail;
  if (result.signal) return `terminated by ${result.signal}`;
  return `exit=${result.exitCode ?? "unknown"}`;
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

export function buildPostExecutionReviewPrompt(params: {
  goal: string;
  steps: PlanStep[];
  diff: string;
}): string {
  const stepLines = params.steps.map((step, index) => {
    const headline = step.shortSummary?.trim() || step.description.trim();
    const successCriteria = step.successCriteria?.trim();
    const summary = step.taskSummary?.trim();
    return [
      `${index + 1}. ${step.id} — ${headline}`,
      successCriteria ? `   Success criteria: ${successCriteria}` : "",
      summary ? `   Result: ${summary}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  return [
    "Review this diff for: verify that per-step success criteria were met, code quality issues, missed edge cases, unnecessary complexity, security concerns, leftover debug code, incomplete error handling.",
    "",
    "Goal description:",
    params.goal,
    "",
    "Plan step summaries:",
    ...(stepLines.length > 0 ? stepLines : ["(no steps)"]),
    "",
    "Full diff:",
    "```diff",
    params.diff || "(no diff output)",
    "```",
    "",
    'Return ONLY JSON with shape: {"approved": boolean, "issues": string[]}.',
    "When approved is true, issues may be empty.",
    "When approved is false, include concrete actionable issues.",
  ].join("\n");
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
  if (!claudeBinary) {
    return { status: "error", reason: "claude binary not found on PATH" };
  }

  const reviewPrompt = buildPostExecutionReviewPrompt({
    goal: params.goal,
    steps: params.steps,
    diff: params.diff,
  });

  let result: RunCliProcessResult;
  try {
    result = await runCliProcess({
      command: claudeBinary,
      args: [
        "-p",
        "--output-format",
        "json",
        "--max-turns",
        "1",
        "--allowedTools",
        CLAUDE_REVIEW_ALLOWED_TOOLS,
        "--append-system-prompt",
        CLAUDE_REVIEW_READ_ONLY_PROMPT,
      ],
      cwd: params.workingDir,
      timeoutMs: POST_EXECUTION_REVIEW_TIMEOUT_MS,
      stdin: reviewPrompt,
      abortSignal: params.abortSignal,
      env: buildClaudeCodeEnv(params.claudeCodeAuth),
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
  if ((result.exitCode && result.exitCode !== 0) || result.signal) {
    return { status: "error", reason: describeCliFailure(result) };
  }

  const decision = parsePostExecutionReviewDecision(result.stdout);
  if (!decision) {
    return { status: "error", reason: "review response was not valid JSON decision output" };
  }

  return decision.approved
    ? { status: "approved", issues: decision.issues }
    : { status: "rejected", issues: decision.issues };
}
