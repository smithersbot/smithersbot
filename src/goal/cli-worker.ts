// CLI worker execution for /goal — runs steps via Codex CLI or Claude Code.

import fs from "node:fs";
import path from "node:path";
import type { GoalBackendId, GoalWorkerOutput, BackendTaskResult } from "./backend-types.js";
import type { HardDeny } from "./capability-types.js";
import { GoalWorkerOutputSchema } from "./goal-schemas.js";
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
import { classifyProviderError } from "./error-patterns.js";
import { runCliProcess } from "./cli-process.js";
import {
  buildClaudeCodeEnv,
  buildCredentialStrippedEnv,
  writeAuthModeArtifact,
} from "./claude-code-env.js";
import { WORKER_CONTEXT } from "./worker-context.js";
import { getCodexAskForApprovalPlacement } from "./backend-availability.js";

// --- Constants ---

const WORKER_RESULT_FILENAME = "worker_result.json";
const LOG_EXCERPT_CHARS = 2048;
const WORKER_RESULT_WORKSPACE_DIR = ".moltbot-goal-worker-results";
const RESULT_POLL_INTERVAL_MS = 4_000;
const RESULT_GRACE_PERIOD_MS = 10_000;
export const REPAIR_TIMEOUT_MS = 60_000;
const PROMPT_SECTION_DIVIDER = "\n\n----------------------------------------\n\n";

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
  lessons?: Array<{ pattern: string; lesson: string }>;
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
  /** Optional project conventions from CLAUDE.md for Codex worker prompts. */
  projectConventions?: string;
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

function writeTextArtifact(filePath: string, value: string): void {
  fs.writeFileSync(filePath, value, "utf8");
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
  const base =
    backend === "claude_code" ? buildClaudeCodeEnv(claudeCodeAuth) : buildCredentialStrippedEnv();
  return { ...base, MOLTBOT_GOAL_TEST_SCOPE: "1" };
}

/**
 * Re-run a CLI worker for one turn to repair an invalid worker_result.json.
 * Returns validated output after repair, or null if still invalid.
 */
export async function repairResultFile(params: {
  backend: GoalBackendId;
  resultFilePath: string;
  workerDir: string;
  attemptNumber: number;
  model?: string;
  onProgress?: (text: string) => void;
  abortSignal?: AbortSignal;
  workingDir: string;
  hardDenies: HardDeny[];
}): Promise<GoalWorkerOutput | null> {
  const {
    backend,
    resultFilePath,
    workerDir,
    attemptNumber,
    model,
    onProgress,
    abortSignal,
    workingDir,
    hardDenies,
  } = params;

  const initialRead = readWorkerResultFile({ primaryPath: resultFilePath });
  const initialErrorKind = initialRead.error?.kind;
  const resultIssue =
    initialErrorKind === "invalid_schema"
      ? "does not match the expected schema"
      : "contains invalid JSON";

  const repairPrompt = [
    `The file at ${resultFilePath} ${resultIssue}.`,
    "Read the file, fix it, and write it back to the same path.",
    "Do not change the meaning of the result. Only fix JSON syntax/schema shape issues.",
    "",
    "Expected valid schema shapes:",
    '1. {"status":"complete","summary":"<brief summary of what was done>"}',
    '2. {"status":"blocked","question":"<what you need from the user>"}',
    '3. {"status":"ralph","approachTried":"...","specificErrors":"...","keyInsight":"...","suggestedApproach":"..."}',
    '4. {"status":"failed","reason":"...","whatTried":"...","errorType":"...","suggestedNext":"...","needsRevert":false}',
  ].join("\n");

  const denyFilePath = writeDenyFile(hardDenies, workerDir);
  const args = buildCliArgs({
    backend,
    prompt: repairPrompt,
    workingDir,
    denyFilePath,
    model,
  });

  const command = backend === "codex" ? "codex" : "claude";
  const stdoutPath = path.join(workerDir, `attempt-${attemptNumber}.repair.stdout.txt`);
  const stderrPath = path.join(workerDir, `attempt-${attemptNumber}.repair.stderr.txt`);

  onProgress?.(`  [cli-worker:${backend}] repairing invalid worker_result.json`);

  await runCliProcess({
    command,
    args,
    cwd: workingDir,
    timeoutMs: REPAIR_TIMEOUT_MS,
    abortSignal,
    stdoutPath,
    stderrPath,
  });

  const repairedRead = readWorkerResultFile({ primaryPath: resultFilePath });
  return repairedRead.output;
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
    lessons,
    onProgress,
    resumeAnswer,
    resumeQuestion,
    attemptNumber = 1,
    previousAttempt,
    claudeCodeAuth = "subscription",
    projectConventions,
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
    lessons,
    resumeAnswer,
    resumeQuestion,
    resultPath: workspaceResultPath,
    previousAttempt,
  });

  // Write artifacts
  const denyFilePath = writeDenyFile(hardDenies, workerDir);
  const promptPayload = buildCliPromptPayload({
    backend,
    prompt,
    denyFilePath,
    projectConventions,
  });
  writeTextArtifact(
    path.join(workerDir, `worker-prompt-${attemptNumber}.txt`),
    promptPayload.persistedPrompt,
  );

  const args = buildCliArgs({
    backend,
    prompt,
    workingDir,
    denyFilePath,
    model,
    projectConventions,
    promptPayload,
  });

  const command = backend === "codex" ? "codex" : "claude";

  onProgress?.(
    `  [cli-worker:${backend}] attempt ${attemptNumber} (timeout ${(timeoutMs / 60_000).toFixed(0)}m)`,
  );

  const stdoutPath = path.join(workerDir, `attempt-${attemptNumber}.stdout.txt`);
  const stderrPath = path.join(workerDir, `attempt-${attemptNumber}.stderr.txt`);

  const localAbortController = new AbortController();
  const forwardAbort = () => localAbortController.abort();
  let removeAbortForwarding: (() => void) | undefined;

  if (abortSignal) {
    if (abortSignal.aborted) {
      localAbortController.abort();
    } else {
      abortSignal.addEventListener("abort", forwardAbort, { once: true });
      removeAbortForwarding = () => abortSignal.removeEventListener("abort", forwardAbort);
    }
  }

  let processSettled = false;
  let earlyResult: GoalWorkerOutput | null = null;
  let earlyResultSourcePath: string | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let graceTimer: NodeJS.Timeout | undefined;

  const clearPollTimer = () => {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = undefined;
  };
  const clearGraceTimer = () => {
    if (!graceTimer) return;
    clearTimeout(graceTimer);
    graceTimer = undefined;
  };

  const processPromise = runCliProcess({
    command,
    args,
    cwd: workingDir,
    timeoutMs,
    abortSignal: localAbortController.signal,
    stdoutPath,
    stderrPath,
    env: workerEnv,
  })
    .then((result) => {
      processSettled = true;
      return result;
    })
    .catch((error) => {
      processSettled = true;
      throw error;
    });

  const pollForEarlyResult = () => {
    if (processSettled || earlyResult) return;
    const polled = readWorkerResultFile({
      primaryPath: workspaceResultPath,
      fallbackPath: canonicalResultPath,
    });
    if (!polled.output || !polled.sourcePath) return;

    earlyResult = polled.output;
    earlyResultSourcePath = polled.sourcePath;
    clearPollTimer();
    onProgress?.("  [cli-worker] result file detected — waiting grace period for process exit");

    graceTimer = setTimeout(() => {
      if (processSettled || localAbortController.signal.aborted) return;
      localAbortController.abort();
    }, RESULT_GRACE_PERIOD_MS);
    graceTimer.unref();
  };

  pollTimer = setInterval(pollForEarlyResult, RESULT_POLL_INTERVAL_MS);
  pollTimer.unref();

  const { stdout, stderr, timedOut, exitCode, signal, durationMs } = await processPromise.finally(
    () => {
      processSettled = true;
      clearPollTimer();
      clearGraceTimer();
      removeAbortForwarding?.();
    },
  );

  const resultRead: ReturnType<typeof readWorkerResultFile> =
    earlyResult && earlyResultSourcePath
      ? { output: earlyResult, sourcePath: earlyResultSourcePath }
      : readWorkerResultFile({
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

  let output = fileValidated;
  let errorType: string | undefined;
  let blockedClassification: string | undefined;

  // Check stdout JSONL stream for structured error info (billing, auth, rate limit)
  const streamError = parseClaudeCodeStreamError(stdout, stderr);

  if (
    !output &&
    !timedOut &&
    !streamError &&
    resultRead.error &&
    (resultRead.error.kind === "invalid_json" || resultRead.error.kind === "invalid_schema")
  ) {
    const repairTargetPath = fs.existsSync(workspaceResultPath)
      ? workspaceResultPath
      : canonicalResultPath;
    onProgress?.(`  [cli-worker] attempting result-file repair (${resultRead.error.kind})`);
    const repaired = await repairResultFile({
      backend,
      resultFilePath: repairTargetPath,
      workerDir,
      attemptNumber,
      model,
      onProgress,
      abortSignal: localAbortController.signal,
      workingDir,
      hardDenies,
    });
    if (repaired) {
      output = repaired;
      persistCanonicalWorkerResult({
        sourcePath: repairTargetPath,
        canonicalResultPath,
      });
      onProgress?.("  [cli-worker] repaired worker_result.json");
    } else {
      onProgress?.("  [cli-worker] worker_result.json repair failed");
    }
  }

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
    ralphDetail:
      output.status === "ralph"
        ? {
            approachTried: output.approachTried,
            specificErrors: output.specificErrors,
            keyInsight: output.keyInsight,
            suggestedApproach: output.suggestedApproach,
          }
        : undefined,
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
  lessons?: Array<{ pattern: string; lesson: string }>;
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
    lessons,
    resumeAnswer,
    resumeQuestion,
    resultPath,
    previousAttempt,
  } = params;
  const lines: string[] = [];

  lines.push(
    "You are a goal worker: an autonomous coding agent executing one task from a multi-step plan. Complete your assigned task independently, verify your work, then report the result.",
  );
  lines.push("");
  lines.push(`GOAL: ${goal}`);
  lines.push("");
  lines.push("PLAN CONTEXT:");
  lines.push(formatPlanAsContext(plan));
  lines.push("");

  if (lessons && lessons.length > 0) {
    lines.push("LESSONS FROM PRIOR RUNS (knowledge from previous work in this project):");
    for (const entry of lessons) {
      lines.push(`- [${entry.pattern}]: ${entry.lesson}`);
    }
    lines.push("");
  }

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

  const estMinutes = step.durationMinutes || 30;
  const timeoutMinutes = Math.min(120, 3 * estMinutes);
  lines.push("");
  lines.push(
    `TIME BUDGET: You have an estimated ${estMinutes} minutes for this task (max timeout: ${timeoutMinutes}m). Plan your work accordingly.`,
  );

  if (step.successCriteria) {
    lines.push("");
    lines.push("SUCCESS CRITERIA:");
    lines.push(step.successCriteria);
  }
  if (step.constraints && step.constraints.length > 0) {
    lines.push("");
    lines.push("CONSTRAINTS (do NOT violate these):");
    for (const constraint of step.constraints) {
      lines.push(`- ${constraint}`);
    }
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

  lines.push(
    "VERIFICATION: Before reporting completion, run the project's build and test commands to verify your changes work. Do not mark complete without verification.",
  );
  lines.push("");

  lines.push("RESULT PROTOCOL:");
  lines.push("When you are done, write your result to this exact file path:");
  lines.push(resultPath);
  lines.push("");
  lines.push("In worker_result.json, write a concise outcome summary.");
  lines.push("");
  lines.push("The file must contain valid JSON with one of these shapes:");
  lines.push(
    '  Complete (task done): { "status": "complete", "summary": "<brief summary of what was done>" }',
  );
  lines.push("");
  lines.push(
    "  Ralph (stuck after genuine attempt — use only when continuing is slower than reverting and retrying with a different strategy):",
  );
  lines.push(
    '  { "status": "ralph", "approachTried": "...", "specificErrors": "...", "keyInsight": "...", "suggestedApproach": "..." }',
  );
  lines.push("");
  lines.push(
    '  Blocked (need user input): { "status": "blocked", "question": "<what you need from the user>" }',
  );
  lines.push("");
  lines.push(
    '  Failed (impossible/out of scope): { "status": "failed", "reason": "...", "whatTried": "...", "errorType": "...", "suggestedNext": "...", "needsRevert": false }',
  );
  lines.push(
    "Write the file using your file-writing tool. This is how the orchestrator knows you are done.",
  );
  lines.push("Do NOT rely on printing JSON to stdout as your result mechanism.");

  return lines.join("\n");
}

function buildPromptSection(title: string, content: string): string {
  return `${title}\n\n${content.trim()}`;
}

function buildCliPromptPayload(params: {
  backend: GoalBackendId;
  prompt: string;
  denyFilePath: string;
  projectConventions?: string;
}): {
  promptArg: string;
  persistedPrompt: string;
  appendedSystemPrompt?: string;
} {
  const { backend, prompt, denyFilePath, projectConventions } = params;

  if (backend === "codex") {
    const sections: string[] = [];
    const trimmedProjectConventions = projectConventions?.trim();
    if (trimmedProjectConventions) {
      sections.push(buildPromptSection("## PROJECT CONVENTIONS", trimmedProjectConventions));
    }
    if (WORKER_CONTEXT) {
      sections.push(buildPromptSection("## WORKER GUIDELINES", WORKER_CONTEXT));
    }
    sections.push(prompt);
    const promptArg = sections.join(PROMPT_SECTION_DIVIDER);
    return { promptArg, persistedPrompt: promptArg };
  }

  const denyContent = fs.readFileSync(denyFilePath, "utf8");
  const appendedSystemPrompt = WORKER_CONTEXT ? `${denyContent}\n\n${WORKER_CONTEXT}` : denyContent;
  return {
    promptArg: prompt,
    appendedSystemPrompt,
    persistedPrompt: [
      buildPromptSection("## APPENDED SYSTEM PROMPT", appendedSystemPrompt),
      buildPromptSection("## USER PROMPT", prompt),
    ].join(PROMPT_SECTION_DIVIDER),
  };
}

// --- Allowed tools list generation (for Claude Code --allowedTools) ---

/** Convert default tools into Claude Code --allowedTools patterns. */
export function buildAllowedToolsList(): string[] {
  return ["Read", "Edit", "Write", "Glob", "Grep", "Bash(*)"];
}

// --- Capability bounds file writing ---

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
 * Validate parsed JSON against GoalWorkerOutput type.
 * Returns the validated output or null if validation fails.
 */
export function validateWorkerOutput(parsed: Record<string, unknown>): GoalWorkerOutput | null {
  const parsedResult = GoalWorkerOutputSchema.safeParse(parsed);
  if (!parsedResult.success) return null;
  return parsedResult.data;
}

// --- CLI process execution ---

export function buildCliArgs(params: {
  backend: GoalBackendId;
  prompt: string;
  workingDir: string;
  denyFilePath: string;
  model?: string;
  projectConventions?: string;
  promptPayload?: {
    promptArg: string;
    persistedPrompt: string;
    appendedSystemPrompt?: string;
  };
}): string[] {
  const { backend, prompt, workingDir, denyFilePath, model, projectConventions, promptPayload } =
    params;
  const assembledPrompt =
    promptPayload ??
    buildCliPromptPayload({
      backend,
      prompt,
      denyFilePath,
      projectConventions,
    });

  if (backend === "codex") {
    const codexAskForApproval = getCodexAskForApprovalPlacement();
    const args = [
      ...(codexAskForApproval === "before_exec" ? ["--ask-for-approval", "never"] : []),
      "exec",
      "--json",
      ...(codexAskForApproval === "after_exec" ? ["--ask-for-approval", "never"] : []),
      "--sandbox",
      "workspace-write",
      "--cd",
      workingDir,
    ];

    args.push("-c", "net.allowed=true");
    // codex's workspace-write sandbox protects `.git` as read-only by default
    // (via PROTECTED_METADATA_PATH_NAMES + bubblewrap `--ro-bind`). Adding an
    // explicit writable_roots entry for the working dir's `.git` overrides that
    // default and lets scripts/committer succeed from inside the worker. The
    // hallucinated `sandbox_workspace_write.allow_git_writes` key is a silent
    // no-op; codex 0.125.0 has no such option.
    const gitWritablePath = path.join(workingDir, ".git");
    const escapedGitPath = gitWritablePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    args.push("-c", `sandbox_workspace_write.writable_roots=["${escapedGitPath}"]`);

    if (model) args.push("--model", model);
    args.push(assembledPrompt.promptArg);
    return args;
  }

  // Claude Code
  const allowedTools = buildAllowedToolsList();
  const args = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--allowedTools",
    allowedTools.join(","),
    "--append-system-prompt",
    assembledPrompt.appendedSystemPrompt ?? "",
  ];
  if (model) args.push("--model", model);
  args.push(assembledPrompt.promptArg);
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
  const classification = classifyProviderError({
    text: resultText,
    assistantError,
    preferCredits: true,
  });

  switch (classification) {
    case "out_of_credits":
      return {
        message: resultText,
        errorType: "out_of_credits",
        suggestedNext: "Add credits to your account or switch to subscription auth mode.",
      };
    case "auth":
      return {
        message: resultText,
        errorType: "auth",
        suggestedNext: "Check API key or auth configuration.",
      };
    case "rate_limit":
      return {
        message: resultText,
        errorType: "rate_limit",
        suggestedNext: "Wait and retry, or reduce concurrency.",
      };
    case "network":
      return {
        message: resultText,
        errorType: "network",
        suggestedNext: "Check network connectivity and retry.",
      };
    default:
      return {
        message: resultText,
        errorType: "process_error",
        suggestedNext: "Check CLI logs and retry the task.",
      };
  }
}

function classifyAttemptOutcome(
  output: GoalWorkerOutput,
  timedOut: boolean,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): AttemptOutcome {
  if (output.status === "complete") return "complete";
  if (output.status === "blocked") return "blocked";
  if (output.status === "ralph") return "ralph";
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
