// CLI worker execution for /goal — runs steps via Codex CLI or Claude Code.

import fs from "node:fs";
import path from "node:path";
import type { GoalBackendId, GoalWorkerOutput, BackendTaskResult } from "./backend-types.js";
import { GOAL_WORKER_OUTPUT_SCHEMA as SCHEMA } from "./backend-types.js";
import type { HardDeny } from "./capability-types.js";
import type { PlanStep, Plan } from "./types.js";
import { formatPlanAsContext } from "./planner.js";
import {
  collectGitDiffSummary,
  resolveWorkerDir,
  tailText,
  writeAttemptBundle,
  type AttemptOutcome,
} from "./attempt-bundle.js";
import type { ClaudeCodeAuthMode } from "../config/types.goal.js";
import { RATE_LIMIT_RE, CREDITS_RE, AUTH_RE, NETWORK_RE } from "./error-patterns.js";
import { runCliProcess } from "./cli-process.js";
import { buildClaudeCodeEnv, writeAuthModeArtifact } from "./claude-code-env.js";
import { WORKER_CONTEXT } from "./worker-context.js";
import { getCodexAskForApprovalPlacement } from "./backend-availability.js";

// --- Constants ---

const WORKER_RESULT_FILENAME = "worker_result.json";
const LOG_EXCERPT_CHARS = 2048;
const WORKER_RESULT_WORKSPACE_DIR = ".moltbot-goal-worker-results";

// --- Public API ---

export type CliWorkerParams = {
  backend: GoalBackendId;
  step: PlanStep;
  plan: Plan;
  goal: string;
  workingDir: string;
  runId: string;
  hardDenies: HardDeny[];
  timeoutMs: number;
  abortSignal?: AbortSignal;
  model?: string;
  completedSummaries?: Array<{ id: string; summary: string }>;
  onProgress?: (text: string) => void;
  /** User's answer when resuming a previously-blocked step. */
  resumeAnswer?: string;
  /** The question the step asked before blocking. */
  resumeQuestion?: string;
  /** Attempt number for retries. */
  attemptNumber?: number;
  /** Prior attempt bundle for retry context. */
  previousAttempt?: string | null;
  /** How Claude Code workers authenticate: subscription (default) or api_key. */
  claudeCodeAuth?: ClaudeCodeAuthMode;
};

function resolveWorkspaceResultPath(params: {
  workingDir: string;
  runId: string;
  stepId: string;
  attemptNumber: number;
}): string {
  return path.join(
    params.workingDir,
    WORKER_RESULT_WORKSPACE_DIR,
    params.runId,
    params.stepId,
    `attempt-${params.attemptNumber}`,
    WORKER_RESULT_FILENAME,
  );
}

function prepareResultPaths(params: {
  workspaceResultPath: string;
  canonicalResultPath: string;
}): void {
  fs.mkdirSync(path.dirname(params.workspaceResultPath), { recursive: true });
  removeIfExists(params.workspaceResultPath);
  removeIfExists(params.canonicalResultPath);
}

function removeIfExists(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best-effort cleanup before each attempt.
  }
}

function persistCanonicalWorkerResult(params: {
  sourcePath: string;
  canonicalResultPath: string;
}): void {
  if (params.sourcePath === params.canonicalResultPath) return;
  try {
    fs.mkdirSync(path.dirname(params.canonicalResultPath), { recursive: true });
    fs.copyFileSync(params.sourcePath, params.canonicalResultPath);
  } catch {
    // Best-effort artifact copy; execution result is already validated.
  }
}

/**
 * Build env for goal worker subprocesses.
 *
 * Always sets MOLTBOT_GOAL_TEST_SCOPE=1 so any `pnpm test` invocation inside a
 * goal worker runs the scoped fast subset from scripts/test-parallel.mjs.
 */
export function buildGoalWorkerEnv(
  backend: GoalBackendId,
  claudeCodeAuth: ClaudeCodeAuthMode,
): Record<string, string | undefined> {
  const base = backend === "claude_code" ? buildClaudeCodeEnv(claudeCodeAuth) : { ...process.env };
  return { ...base, MOLTBOT_GOAL_TEST_SCOPE: "1" };
}

/**
 * Execute a goal step using a CLI worker (Codex or Claude Code).
 *
 * Single invocation per attempt. Returns structured output, or a synthetic
 * failure when no valid result artifact exists.
 */
export async function executeTaskWithCliWorker(
  params: CliWorkerParams,
): Promise<BackendTaskResult> {
  const {
    backend,
    step,
    plan,
    goal,
    workingDir,
    runId,
    hardDenies,
    timeoutMs,
    abortSignal,
    model,
    completedSummaries,
    onProgress,
    resumeAnswer,
    resumeQuestion,
    attemptNumber = 1,
    previousAttempt,
    claudeCodeAuth = "subscription",
  } = params;

  const workerDir = resolveWorkerDir(runId, step.id);
  fs.mkdirSync(workerDir, { recursive: true });
  const canonicalResultPath = path.join(workerDir, WORKER_RESULT_FILENAME);
  const workspaceResultPath = resolveWorkspaceResultPath({
    workingDir,
    runId,
    stepId: step.id,
    attemptNumber,
  });
  prepareResultPaths({
    workspaceResultPath,
    canonicalResultPath,
  });

  // Build worker env based on auth mode
  const workerEnv = buildGoalWorkerEnv(backend, claudeCodeAuth);
  if (backend === "claude_code") writeAuthModeArtifact(workerDir, claudeCodeAuth);

  const prompt = buildCliWorkerPrompt({
    step,
    plan,
    goal,
    hardDenies,
    completedSummaries,
    resumeAnswer,
    resumeQuestion,
    resultPath: workspaceResultPath,
    previousAttempt,
  });

  // Write artifacts
  const schemaPath = writeWorkerSchema(workerDir);
  const denyFilePath = writeDenyFile(hardDenies, workerDir);

  const args = buildCliArgs({
    backend,
    prompt,
    workingDir,
    schemaPath,
    denyFilePath,
    model,
  });

  const command = backend === "codex" ? "codex" : "claude";

  onProgress?.(
    `  [cli-worker:${backend}] attempt ${attemptNumber} (timeout ${(timeoutMs / 60_000).toFixed(0)}m)`,
  );

  const stdoutPath = path.join(workerDir, `attempt-${attemptNumber}.stdout.txt`);
  const stderrPath = path.join(workerDir, `attempt-${attemptNumber}.stderr.txt`);

  const { stdout, stderr, timedOut, exitCode, signal, durationMs } = await runCliProcess({
    command,
    args,
    cwd: workingDir,
    timeoutMs,
    abortSignal,
    stdoutPath,
    stderrPath,
    env: workerEnv,
  });

  const codexParsed = backend === "codex" ? parseCodexSchemaOutput(stdout) : null;
  const codexValidated = codexParsed ? validateWorkerOutput(codexParsed) : null;

  const resultRead = readWorkerResultFile({
    primaryPath: workspaceResultPath,
    fallbackPath: canonicalResultPath,
  });
  const fileValidated = resultRead.output;

  if (resultRead.output && resultRead.sourcePath) {
    persistCanonicalWorkerResult({
      sourcePath: resultRead.sourcePath,
      canonicalResultPath,
    });
  }

  let output = codexValidated ?? fileValidated;
  let errorType: string | undefined;
  let blockedClassification: string | undefined;

  // Check stdout JSONL stream for structured error info (billing, auth, rate limit)
  const streamError = parseClaudeCodeStreamError(stdout, stderr);

  if (!output) {
    if (timedOut) {
      output = makeFailureOutput(
        `CLI worker timed out after ${(timeoutMs / 60_000).toFixed(0)} minutes.`,
        "timeout",
        "Retry with more time or split the task into smaller steps.",
        "Ran worker until hard timeout.",
      );
    } else if (streamError) {
      output = makeFailureOutput(
        streamError.message,
        streamError.errorType,
        streamError.suggestedNext,
        "Parsed Claude Code JSONL stream output.",
      );
    } else if (resultRead.error?.kind === "missing") {
      output = makeFailureOutput(
        `Worker did not produce result artifact (process exited code ${exitCode ?? "unknown"}).`,
        "missing_result",
        "Retry the task and ensure the worker writes worker_result.json.",
        "Looked for worker_result.json after process exit.",
      );
    } else if (resultRead.error?.kind === "invalid_json") {
      output = makeFailureOutput(
        "Worker produced invalid result file.",
        "invalid_result",
        "Retry the task and ensure the result file contains valid JSON.",
        "Read worker_result.json and failed to parse JSON.",
      );
    } else if (resultRead.error?.kind === "invalid_schema") {
      output = makeFailureOutput(
        "Worker produced result file that does not match the expected schema.",
        "invalid_result",
        "Retry the task and ensure the result file matches the documented schema.",
        "Parsed worker_result.json but schema validation failed.",
      );
    } else if (signal) {
      output = makeFailureOutput(
        `CLI worker exited due to signal ${signal}.`,
        "process_error",
        "Check CLI logs and retry the task.",
        "Process was terminated by signal before producing a valid result.",
      );
    } else if (exitCode && exitCode !== 0) {
      output = makeFailureOutput(
        `CLI worker exited with code ${exitCode}.`,
        "process_error",
        "Check CLI logs and retry the task.",
        "Process exited non-zero before producing a valid result.",
      );
    } else {
      output = makeFailureOutput(
        "CLI worker failed without producing a valid result.",
        "unknown",
        "Check CLI logs and retry the task.",
        "Process exited without a valid worker_result.json.",
      );
    }
  }

  if (output.status === "failed") {
    errorType = output.errorType;
  }
  if (output.status === "blocked") {
    blockedClassification = "user_input";
  }

  const outcome = classifyAttemptOutcome(output, timedOut, exitCode, signal);
  const { diffstat, changedFiles } = collectGitDiffSummary(workingDir);
  const resultFile = fs.existsSync(canonicalResultPath) ? WORKER_RESULT_FILENAME : null;

  writeAttemptBundle(workerDir, {
    attemptNumber,
    backend,
    outcome,
    errorClassification:
      output.status === "complete"
        ? undefined
        : (errorType ?? blockedClassification ?? resultRead.error?.kind),
    resultFile,
    logExcerpt: tailText(stdout, LOG_EXCERPT_CHARS),
    diffstat,
    changedFiles,
    durationMs,
  });

  return {
    output,
    turnsUsed: 1,
    rawStdout: stdout,
    rawStderr: stderr,
  };
}

// --- Prompt building ---

export function buildCliWorkerPrompt(params: {
  step: PlanStep;
  plan: Plan;
  goal: string;
  hardDenies: HardDeny[];
  completedSummaries?: Array<{ id: string; summary: string }>;
  resumeAnswer?: string;
  resumeQuestion?: string;
  resultPath: string;
  previousAttempt?: string | null;
}): string {
  const {
    step,
    plan,
    goal,
    hardDenies,
    completedSummaries,
    resumeAnswer,
    resumeQuestion,
    resultPath,
    previousAttempt,
  } = params;
  const lines: string[] = [];

  lines.push(`GOAL: ${goal}`);
  lines.push("");
  lines.push("PLAN CONTEXT:");
  lines.push(formatPlanAsContext(plan));
  lines.push("");

  if (completedSummaries && completedSummaries.length > 0) {
    lines.push("COMPLETED TASKS:");
    for (const { id, summary } of completedSummaries) {
      lines.push(`- ${id}: ${summary}`);
    }
    lines.push("");
  }

  // Resume context: include user's answer from previous block
  if (resumeAnswer) {
    lines.push("RESUME CONTEXT:");
    lines.push(`You previously asked: ${resumeQuestion ?? "a question"}`);
    lines.push(`The user answered: ${resumeAnswer}`);
    lines.push("Use this information to continue and complete the task.");
    lines.push("");
  }

  lines.push(`YOUR TASK: ${step.description}`);
  lines.push(`Task ID: ${step.id}`);
  if (step.dependsOn.length > 0) {
    lines.push(`Dependencies completed: ${step.dependsOn.join(", ")}`);
  }
  lines.push("");

  lines.push("HARD DENIES (never do these):");
  for (const deny of hardDenies) {
    lines.push(`- ${deny.pattern}: ${deny.reason}`);
  }
  lines.push("");

  if (previousAttempt) {
    lines.push("PREVIOUS ATTEMPT FAILED:");
    lines.push(previousAttempt);
    lines.push("");
    lines.push("Try a different approach. Do not repeat what failed.");
    lines.push("");
  }

  lines.push("RESULT PROTOCOL:");
  lines.push("When you are done, write your result to this exact file path:");
  lines.push(resultPath);
  lines.push("");
  lines.push("The file must contain valid JSON with one of these shapes:");
  lines.push('  Complete: { "status": "complete", "summary": "<brief summary of what was done>" }');
  lines.push('  Blocked:  { "status": "blocked", "question": "<what you need from the user>" }');
  lines.push(
    '  Failed:   { "status": "failed", "reason": "...", "whatTried": "...", "errorType": "...", "suggestedNext": "...", "needsRevert": false }',
  );
  lines.push(
    "Write the file using your file-writing tool. This is how the orchestrator knows you are done.",
  );
  lines.push("Do NOT rely on printing JSON to stdout as your result mechanism.");

  return lines.join("\n");
}

// --- Allowed tools list generation (for Claude Code --allowedTools) ---

/** Convert default tools into Claude Code --allowedTools patterns. */
export function buildAllowedToolsList(): string[] {
  return ["Read", "Edit", "Write", "Glob", "Grep", "Bash(*)"];
}

// --- Schema / caps file writing ---

/** Write the GoalWorkerOutput JSON Schema to disk. Returns the file path. */
export function writeWorkerSchema(dir: string): string {
  const filePath = path.join(dir, "output-schema.json");
  fs.writeFileSync(filePath, JSON.stringify(SCHEMA, null, 2), "utf8");
  return filePath;
}

/** Build capability bounds text for --append-system-prompt, and write to disk for auditing. */
export function writeDenyFile(hardDenies: HardDeny[], dir: string): string {
  const lines: string[] = ["HARD DENIES (enforced):"];
  for (const deny of hardDenies) {
    lines.push(`- DENIED: ${deny.pattern} — ${deny.reason}`);
  }
  const content = lines.join("\n");
  // Write to disk for debugging/audit; the CLI gets the content inline.
  const filePath = path.join(dir, "capability-bounds.txt");
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

// --- Output parsing + validation ---

/**
 * Parse structured JSON output from Codex CLI stdout.
 *
 * Codex --json with --output-schema is expected to emit a single JSON object.
 */
export function parseCodexSchemaOutput(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Validate parsed JSON against GoalWorkerOutput type.
 * Returns the validated output or null if validation fails.
 */
export function validateWorkerOutput(parsed: Record<string, unknown>): GoalWorkerOutput | null {
  const status = parsed.status;
  if (typeof status !== "string") return null;

  if (status === "complete") {
    if (typeof parsed.summary !== "string") return null;
    return { status: "complete", summary: parsed.summary };
  }

  if (status === "blocked") {
    if (typeof parsed.question !== "string") return null;
    return { status: "blocked", question: parsed.question };
  }

  if (status === "failed") {
    if (typeof parsed.reason !== "string") return null;
    if (typeof parsed.whatTried !== "string") return null;
    if (typeof parsed.errorType !== "string") return null;
    if (typeof parsed.suggestedNext !== "string") return null;
    if (typeof parsed.needsRevert !== "boolean") return null;
    return {
      status: "failed",
      reason: parsed.reason,
      whatTried: parsed.whatTried,
      errorType: parsed.errorType,
      suggestedNext: parsed.suggestedNext,
      needsRevert: parsed.needsRevert,
    };
  }

  return null;
}

// --- CLI process execution ---

export function buildCliArgs(params: {
  backend: GoalBackendId;
  prompt: string;
  workingDir: string;
  schemaPath: string;
  denyFilePath: string;
  model?: string;
}): string[] {
  const { backend, prompt, workingDir, schemaPath, denyFilePath, model } = params;

  if (backend === "codex") {
    const codexAskForApproval = getCodexAskForApprovalPlacement();
    const args = [
      ...(codexAskForApproval === "before_exec" ? ["--ask-for-approval", "never"] : []),
      "exec",
      "--json",
      ...(codexAskForApproval === "after_exec" ? ["--ask-for-approval", "never"] : []),
      "--sandbox",
      "workspace-write",
      "--output-schema",
      schemaPath,
      "--cd",
      workingDir,
    ];

    args.push("-c", "net.allowed=true");

    if (model) args.push("--model", model);
    args.push(prompt);
    return args;
  }

  // Claude Code
  const allowedTools = buildAllowedToolsList();
  const denyContent = fs.readFileSync(denyFilePath, "utf8");
  const appendedPrompt = WORKER_CONTEXT ? `${denyContent}\n\n${WORKER_CONTEXT}` : denyContent;
  // TODO(goal): Claude Code has no workspace sandbox flag equivalent to Codex
  // `--sandbox workspace-write`; cwd is already set by runCliProcess() spawn options.
  const args = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--allowedTools",
    allowedTools.join(","),
    "--append-system-prompt",
    appendedPrompt,
  ];
  if (model) args.push("--model", model);
  args.push(prompt);
  return args;
}

export function readWorkerResultFile(params: { primaryPath: string; fallbackPath?: string }): {
  output: GoalWorkerOutput | null;
  sourcePath?: string;
  error?: { kind: "missing" | "invalid_json" | "invalid_schema"; message: string };
} {
  const primary = readResultPath(params.primaryPath);
  if (primary.exists) {
    if (primary.output) {
      return { output: primary.output, sourcePath: params.primaryPath };
    }
    return { output: null, error: primary.error };
  }

  if (params.fallbackPath) {
    const fallback = readResultPath(params.fallbackPath);
    if (fallback.exists) {
      if (fallback.output) {
        return { output: fallback.output, sourcePath: params.fallbackPath };
      }
      return { output: null, error: fallback.error };
    }
  }

  return {
    output: null,
    error: {
      kind: "missing",
      message: "worker_result.json not found",
    },
  };
}

function readResultPath(filePath: string): {
  exists: boolean;
  output: GoalWorkerOutput | null;
  error?: { kind: "invalid_json" | "invalid_schema"; message: string };
} {
  if (!fs.existsSync(filePath)) {
    return { exists: false, output: null };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return {
      exists: true,
      output: null,
      error: { kind: "invalid_json", message: "Unable to read result file" },
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {
      exists: true,
      output: null,
      error: { kind: "invalid_json", message: "Result file is invalid JSON" },
    };
  }

  const validated = validateWorkerOutput(parsed);
  if (!validated) {
    return {
      exists: true,
      output: null,
      error: { kind: "invalid_schema", message: "Result file does not match schema" },
    };
  }

  return { exists: true, output: validated };
}

function makeFailureOutput(
  reason: string,
  errorType: string,
  suggestedNext: string,
  whatTried: string,
): GoalWorkerOutput {
  return {
    status: "failed",
    reason,
    whatTried,
    errorType,
    suggestedNext,
    needsRevert: false,
  };
}

// --- JSONL stream error parsing ---

export type StreamError = {
  message: string;
  errorType: string;
  suggestedNext: string;
};

/**
 * Scan CLI JSONL stdout/stderr for structured error info.
 * Handles Claude Code `result` errors plus Codex `error` and
 * `turn.failed` events.
 */
export function parseClaudeCodeStreamError(stdout: string, stderr: string): StreamError | null {
  return parseStreamLines(stdout) ?? parseStreamLines(stderr);
}

function parseStreamLines(text: string): StreamError | null {
  if (!text) return null;
  const lines = text.split("\n");

  // Scan from end for result message
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (parsed.type === "result" && parsed.is_error === true && typeof parsed.result === "string") {
      const resultText = parsed.result;

      // Look backward for a preceding assistant error with billing_error etc.
      const assistantError = findPrecedingAssistantError(lines, i);

      return classifyStreamError(resultText, assistantError);
    }

    if (parsed.type === "error" && typeof parsed.message === "string") {
      return classifyStreamError(parsed.message, null);
    }

    if (
      parsed.type === "turn.failed" &&
      typeof parsed.error === "object" &&
      parsed.error !== null
    ) {
      const errorObject = parsed.error as Record<string, unknown>;
      if (typeof errorObject.message === "string") {
        return classifyStreamError(errorObject.message, null);
      }
    }
  }
  return null;
}

function findPrecedingAssistantError(lines: string[], fromIndex: number): string | null {
  for (let i = fromIndex - 1; i >= Math.max(0, fromIndex - 20); i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type === "assistant" && typeof parsed.error === "string") {
        return parsed.error;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function classifyStreamError(resultText: string, assistantError: string | null): StreamError {
  // Check assistant error field first (e.g. "billing_error")
  if (assistantError === "billing_error" || CREDITS_RE.test(resultText)) {
    return {
      message: resultText,
      errorType: "out_of_credits",
      suggestedNext: "Add credits to your account or switch to subscription auth mode.",
    };
  }
  if (AUTH_RE.test(resultText)) {
    return {
      message: resultText,
      errorType: "auth",
      suggestedNext: "Check API key or auth configuration.",
    };
  }
  if (RATE_LIMIT_RE.test(resultText)) {
    return {
      message: resultText,
      errorType: "rate_limit",
      suggestedNext: "Wait and retry, or reduce concurrency.",
    };
  }
  if (NETWORK_RE.test(resultText)) {
    return {
      message: resultText,
      errorType: "network",
      suggestedNext: "Check network connectivity and retry.",
    };
  }
  return {
    message: resultText,
    errorType: "process_error",
    suggestedNext: "Check CLI logs and retry the task.",
  };
}

function classifyAttemptOutcome(
  output: GoalWorkerOutput,
  timedOut: boolean,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): AttemptOutcome {
  if (output.status === "complete") return "complete";
  if (output.status === "blocked") return "blocked";
  if (output.status === "failed" && output.errorType === "timeout") {
    return "timeout";
  }
  if (output.status === "failed" && output.errorType === "rate_limit") {
    return "rate_limit";
  }
  if (timedOut) return "timeout";
  if (
    output.status === "failed" &&
    output.errorType === "process_error" &&
    (exitCode != null || signal)
  ) {
    return "crash";
  }
  return "failed";
}
