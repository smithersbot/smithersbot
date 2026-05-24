// CLI worker execution for /goal — runs steps via Codex CLI or Claude Code.
//
// Stage 2S defaults new work to SmithersBot-managed workspaces under
// <root>/agent/workspaces/<workspace>/repo. Legacy workingDir values outside
// the managed agent root remain supported by default with a warning; setting
// goal.allowLegacyWorkingDir=false fails closed. Real workspace env files under
// <root>/private/env are host-side only and are not passed to workers by default.

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
import type { GoalConfig } from "../config/types.goal.js";
import { classifyProviderError } from "./error-patterns.js";
import { runCliProcess } from "./cli-process.js";
import {
  buildClaudeCodeEnv,
  buildCredentialStrippedEnv,
  writeAuthModeArtifact,
} from "./claude-code-env.js";
import {
  WORKER_CONTEXT,
  WORKER_DYNAMIC_CONTEXT_HEADER,
  WORKER_PROMPT_STATIC_INSTRUCTION_PREFIX,
} from "./worker-context.js";
import { renderGroupedHardDenies } from "./hard-deny.js";
import { getCodexAskForApprovalPlacement } from "./backend-availability.js";
import { redactSecretValues } from "../security/secret-paths.js";
import { assertGoalWorkerWorkspace } from "./workspace-policy.js";
import {
  appendCodexNativeSandboxExecArgs,
  buildCodexNativeSandboxConfig,
  buildClaudeCodeSandboxLaunchConfig,
  claudeCodeNativeSandboxStatus,
  mergeCodexNativeSandboxEnv,
  writeCodexNativeSandboxConfig,
  type CodexNativeSandboxConfig,
} from "./backend-sandbox.js";
import {
  appendAgentHistoryEventBestEffort,
  parseBackendUsage,
  writeCriticalAgentLaunchEvent,
  type AgentBackendUsage,
} from "./agent-history-events.js";
import { workspaceNameFromWorkingDir } from "./agent-history.js";

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
  /** Goal config for Stage 2S managed-workspace compatibility policy. */
  goalConfig?: GoalConfig;
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
  try {
    const raw = fs.readFileSync(params.sourcePath, "utf8");
    const redacted = redactSecretValues(raw);
    fs.writeFileSync(params.sourcePath, redacted, "utf8");
    if (params.sourcePath === params.canonicalResultPath) return;
    fs.mkdirSync(path.dirname(params.canonicalResultPath), { recursive: true });
    fs.writeFileSync(params.canonicalResultPath, redacted, "utf8");
  } catch {
    // Best-effort artifact copy; execution result is already validated.
  }
}

function writeTextArtifact(filePath: string, value: string): void {
  fs.writeFileSync(filePath, redactSecretValues(value), "utf8");
}

function redactTextArtifactIfExists(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, "utf8");
    fs.writeFileSync(filePath, redactSecretValues(raw), "utf8");
  } catch {
    // Best-effort artifact redaction; don't mask task execution errors.
  }
}

function sanitizeWorkerArgvForHistory(args: readonly string[]): string[] {
  const sanitized = [...args];
  for (let index = 0; index < sanitized.length; index++) {
    const arg = sanitized[index];
    if (arg === "--append-system-prompt" && index + 1 < sanitized.length) {
      sanitized[index + 1] = "<append-system-prompt redacted; see prompt artifact>";
      index++;
      continue;
    }
  }
  if (sanitized.length > 0) {
    sanitized[sanitized.length - 1] = "<prompt redacted; see prompt artifact>";
  }
  return sanitized;
}

function appendWorkerHistoryBestEffort(params: {
  workingDir: string;
  runId: string;
  stepId: string;
  attemptNumber: number;
  backend: GoalBackendId;
  event: string;
  status?: string;
  tokenUsage?: AgentBackendUsage;
  errorClass?: string;
  outputSummary?: string;
  artifactPaths?: readonly string[];
  extra?: Record<string, unknown>;
  onProgress?: (text: string) => void;
}): void {
  const result = appendAgentHistoryEventBestEffort(
    {
      kind: "goal",
      workspaceName: workspaceNameFromWorkingDir(params.workingDir),
      goalId: params.runId,
    },
    {
      event: params.event,
      phase: "worker",
      backend: params.backend,
      runId: params.runId,
      goalId: params.runId,
      stepId: params.stepId,
      attemptNumber: params.attemptNumber,
      status: params.status,
      tokenUsage: params.tokenUsage,
      errorClass: params.errorClass,
      outputSummary: params.outputSummary,
      artifactPaths: params.artifactPaths,
      ...params.extra,
    },
  );
  if (!result.ok) {
    params.onProgress?.(`  [warn] ${result.warning}`);
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
  options: { trustedHostEnv?: Record<string, string> } = {},
): Record<string, string | undefined> {
  const base =
    backend === "claude_code" ? buildClaudeCodeEnv(claudeCodeAuth) : buildCredentialStrippedEnv();
  return { ...base, ...options.trustedHostEnv, MOLTBOT_GOAL_TEST_SCOPE: "1" };
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
  claudeCodeAuth?: ClaudeCodeAuthMode;
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
    claudeCodeAuth = "subscription",
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
  const codexNativeSandbox =
    backend === "codex"
      ? writeCodexNativeSandboxConfig({
          workingDir,
          runId: `repair-${attemptNumber}`,
          purpose: "goal-worker",
          sandboxRoot: process.env.SMITHERSBOT_CODEX_SANDBOX_ROOT,
        })
      : undefined;
  const args = buildCliArgs({
    backend,
    prompt: repairPrompt,
    workingDir,
    denyFilePath,
    model,
    codexNativeSandbox,
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
    env:
      backend === "codex"
        ? mergeCodexNativeSandboxEnv(buildCredentialStrippedEnv(), codexNativeSandbox!)
        : buildGoalWorkerEnv("claude_code", claudeCodeAuth),
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
    goalConfig,
  } = params;

  assertGoalWorkerWorkspace({ workingDir, config: goalConfig, onWarning: onProgress });

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

  const codexNativeSandbox =
    backend === "codex"
      ? writeCodexNativeSandboxConfig({
          workingDir,
          runId: `${runId}-${step.id}-attempt-${attemptNumber}`,
          purpose: "goal-worker",
          requiresNetwork: step.requiresNetwork === true,
          sandboxRoot: process.env.SMITHERSBOT_CODEX_SANDBOX_ROOT,
        })
      : undefined;

  // Build worker env based on auth mode
  const workerEnv =
    backend === "codex"
      ? mergeCodexNativeSandboxEnv(buildGoalWorkerEnv(backend, claudeCodeAuth), codexNativeSandbox!)
      : buildGoalWorkerEnv(backend, claudeCodeAuth);
  if (backend === "claude_code") writeAuthModeArtifact(workerDir, claudeCodeAuth);

  if (backend === "claude_code" && goalConfig?.requireNativeSandbox === true) {
    const sandboxStatus = claudeCodeNativeSandboxStatus({
      workingDir,
      runId,
      purpose: "goal-worker",
    });
    if (!sandboxStatus.supported) {
      throw new Error(
        `Claude Code native sandbox is required but unavailable: ${sandboxStatus.reason}`,
      );
    }
  }

  const prompt = buildCliWorkerPrompt({
    step,
    plan,
    goal,
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
    runId,
    requiresNetwork: step.requiresNetwork === true,
    projectConventions,
    promptPayload,
    codexNativeSandbox,
  });

  const command = backend === "codex" ? "codex" : "claude";
  const historyScope = {
    kind: "goal" as const,
    workspaceName: workspaceNameFromWorkingDir(workingDir),
    goalId: runId,
  };
  const launchHistory = writeCriticalAgentLaunchEvent({
    scope: historyScope,
    phase: "worker",
    backend,
    prompt: promptPayload.persistedPrompt,
    command,
    argv: sanitizeWorkerArgvForHistory(args),
    event: {
      runId,
      goalId: runId,
      stepId: step.id,
      attemptNumber,
      status: "launching",
    },
  });

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

  let processResult: Awaited<typeof processPromise>;
  try {
    processResult = await processPromise.finally(() => {
      processSettled = true;
      clearPollTimer();
      clearGraceTimer();
      removeAbortForwarding?.();
    });
  } catch (error) {
    const errorClass = error instanceof Error ? error.name : "process_error";
    appendWorkerHistoryBestEffort({
      workingDir,
      runId,
      stepId: step.id,
      attemptNumber,
      backend,
      event: "failure",
      status: "process_error",
      errorClass,
      outputSummary: error instanceof Error ? error.message : String(error),
      artifactPaths: [stdoutPath, stderrPath, launchHistory.promptArtifactPath],
      onProgress,
    });
    throw error;
  }
  const { stdout, stderr, timedOut, exitCode, signal, durationMs } = processResult;
  redactTextArtifactIfExists(stdoutPath);
  redactTextArtifactIfExists(stderrPath);
  const tokenUsage = parseBackendUsage(`${stdout}\n${stderr}`);

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
      claudeCodeAuth,
    });
    if (repaired) {
      output = repaired;
      redactTextArtifactIfExists(repairTargetPath);
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
      const missingResultMessage =
        exitCode == null && signal == null
          ? "Worker process was lost/interrupted before producing worker_result.json."
          : `Worker did not produce result artifact (process exited code ${exitCode ?? "unknown"}).`;
      output = makeFailureOutput(
        missingResultMessage,
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
  const errorClass =
    output.status === "failed"
      ? output.errorType
      : output.status === "blocked"
        ? blockedClassification
        : resultRead.error?.kind;
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
    tokenUsage,
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

  appendWorkerHistoryBestEffort({
    workingDir,
    runId,
    stepId: step.id,
    attemptNumber,
    backend,
    event: output.status === "complete" ? "result" : "failure",
    status: output.status,
    tokenUsage,
    errorClass,
    outputSummary:
      output.status === "complete"
        ? output.summary
        : output.status === "failed"
          ? output.reason
          : output.status === "blocked"
            ? output.question
            : output.approachTried,
    artifactPaths: [stdoutPath, stderrPath, launchHistory.promptArtifactPath].filter(Boolean),
    extra: {
      outcome,
      exitCode,
      signal,
      timedOut,
      durationMs,
      resultFile,
    },
    onProgress,
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
  hardDenies?: HardDeny[];
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
    completedSummaries,
    lessons,
    resumeAnswer,
    resumeQuestion,
    resultPath,
    previousAttempt,
  } = params;
  const lines: string[] = [];

  lines.push(WORKER_PROMPT_STATIC_INSTRUCTION_PREFIX);
  lines.push("");
  lines.push(WORKER_DYNAMIC_CONTEXT_HEADER);
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

  if (previousAttempt) {
    lines.push("PREVIOUS ATTEMPT FAILED:");
    lines.push(previousAttempt);
    lines.push("");
    lines.push("Try a different approach. Do not repeat what failed.");
    lines.push("");
  }

  lines.push("RESULT FILE PATH:");
  lines.push("Write worker_result.json to this exact file path:");
  lines.push(resultPath);

  return lines.join("\n");
}

function buildPromptSection(title: string, content: string): string {
  return `${title}\n\n${content.trim()}`;
}

function readDenyPromptContent(denyFilePath: string): string {
  try {
    return fs.readFileSync(denyFilePath, "utf8");
  } catch {
    return renderGroupedHardDenies();
  }
}

export function buildCliPromptPayload(params: {
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
  const denyContent = readDenyPromptContent(denyFilePath);

  if (backend === "codex") {
    const sections: string[] = [denyContent.trim()];
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
  const content = renderGroupedHardDenies(hardDenies);
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
  runId?: string;
  requiresNetwork?: boolean;
  projectConventions?: string;
  promptPayload?: {
    promptArg: string;
    persistedPrompt: string;
    appendedSystemPrompt?: string;
  };
  codexNativeSandbox?: CodexNativeSandboxConfig;
}): string[] {
  const {
    backend,
    prompt,
    workingDir,
    denyFilePath,
    model,
    runId = "cli-worker",
    requiresNetwork = false,
    projectConventions,
    promptPayload,
    codexNativeSandbox,
  } = params;
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
    const sandboxConfig =
      codexNativeSandbox ??
      buildCodexNativeSandboxConfig({
        workingDir,
        runId,
        purpose: "goal-worker",
        requiresNetwork,
        sandboxRoot: process.env.SMITHERSBOT_CODEX_SANDBOX_ROOT,
        codexPath: "codex",
      });
    const args = [
      ...(codexAskForApproval === "before_exec" ? ["--ask-for-approval", "never"] : []),
      "exec",
      "--json",
      ...(codexAskForApproval === "after_exec" ? ["--ask-for-approval", "never"] : []),
    ];

    appendCodexNativeSandboxExecArgs(args, sandboxConfig);

    if (model) args.push("--model", model);
    args.push(assembledPrompt.promptArg);
    return args;
  }

  // Claude Code
  const allowedTools = buildAllowedToolsList();
  const sandboxConfig = buildClaudeCodeSandboxLaunchConfig({
    workingDir,
    runId,
    purpose: "goal-worker",
  });
  const args = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    ...sandboxConfig.args,
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
  if (
    output.status === "failed" &&
    output.errorType === "missing_result" &&
    exitCode == null &&
    signal == null
  ) {
    return "process_lost";
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
