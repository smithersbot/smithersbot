import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import type { MoltbotConfig } from "../config/config.js";
import type { ClaudeCodeAuthMode } from "../config/types.goal.js";
import {
  loadAttemptBundles,
  resolveWorkerDir,
  formatAttemptBundleSummary,
  writeAttemptBundle,
  type AttemptBundle,
} from "./attempt-bundle.js";
import { aggregateBlockedDetails } from "./blocked.js";
import { detectBackendAvailability, isBackendAvailable } from "./backend-availability.js";
import type { GoalBackendId } from "./backend-types.js";
import { formatCompactGoalCompletionSummary, type GoalOutputChannel } from "./compact-output.js";
import { CliTaskRunner } from "./cli-runner.js";
import { HARD_DENIES } from "./hard-deny.js";
import {
  autosaveIfDirty,
  canRunGit,
  ensureRunBranch,
  finalizeTaskCheckpoint,
  isGitRepo,
  isWorkingTreeClean,
  startTaskCheckpoint,
} from "./git-checkpoint.js";
import {
  orderStepsCriticalPathFirst,
  computeCriticalPathScores,
  type CriticalPathScores,
} from "./plan-order.js";
import { generateManualTests } from "./manual-tests.js";
import { PiTaskRunner } from "./pi-runner.js";
import { loadRun, resolveGoalWorkingFile, resolveWorkingFile } from "./run-store.js";
import type {
  GitCheckpointConfig,
  GoalLlmClient,
  GoalOutcome,
  GoalSession,
  ManualTestSuggestion,
  PlanStep,
  RetryConfig,
  SerializedRun,
  TaskExecutionResult,
} from "./types.js";
import type { TaskRunner, TaskRunnerContext, TaskRunnerResult } from "./task-runner.js";

const DEFAULT_MAX_TURNS_PER_TASK = 5;
const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes per prompt
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_MAX_RALPH_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_BACKEND: GoalBackendId = "claude_code";
const DEFAULT_MAX_BUILD_GATE_FIX_CYCLES = 2;
const BUILD_GATE_COMMAND_TIMEOUT_MS = 5 * 60_000;
const BUILD_GATE_OUTPUT_MAX_CHARS = 16_000;

const MIN_TASK_TIMEOUT_MS = 10 * 60_000;
const MAX_TASK_TIMEOUT_MS = 2 * 60 * 60_000;

const PI_RETRYABLE: PlanStep["blockedReason"][] = ["timeout", "network", "rate_limit"];
const FATAL_ERRORS: PlanStep["blockedReason"][] = ["out_of_credits", "auth"];

function isAnthropicPlannerDegraded(
  reason: string | undefined,
): reason is "anthropic_rate_limit" | "anthropic_usage_limit" {
  return reason === "anthropic_rate_limit" || reason === "anthropic_usage_limit";
}

function rewriteStepBackendsForDegradedPlanner(step: PlanStep): void {
  if (!step.backend || step.backend === "claude_code") {
    step.backend = "codex";
  }
  if (step.executedBackend === "claude_code") {
    step.executedBackend = "codex";
  }
}

export type GoalStatusChangeEvent =
  | { type: "step_blocked"; stepId: string; question: string; steps: PlanStep[] }
  | { type: "fully_blocked"; steps: PlanStep[] }
  | { type: "plan_revised"; revision: number; summary: string; steps: PlanStep[] }
  | {
      type: "all_done";
      steps: PlanStep[];
      summary: string;
      manualTests?: ManualTestSuggestion[];
      manualTestsError?: string;
    };

export type ExecuteGoalParams = {
  session: GoalSession;
  runId: string;
  workingDir: string;
  config?: MoltbotConfig;
  provider?: string;
  model?: string;
  maxTurnsPerTask?: number;
  timeoutMs?: number;
  retryConfig?: Partial<RetryConfig>;
  gitCheckpointConfig?: Partial<GitCheckpointConfig>;
  onTaskUpdate?: (result: TaskExecutionResult) => void;
  /** Called when a task transitions to in_progress (before execution). */
  onTaskStart?: (taskId: string) => void;
  onProgress?: (text: string) => void;
  onStatusChange?: (event: GoalStatusChangeEvent) => void | Promise<void>;
  abortSignal?: AbortSignal;
  serializedRun?: SerializedRun;
  /** How Claude Code workers authenticate: subscription (default) or api_key. */
  claudeCodeAuth?: ClaudeCodeAuthMode;
  /** Optional LLM client for generating manual test suggestions on completion. */
  manualTestsClient?: GoalLlmClient;
  /** Output channel for formatting the completion summary. */
  channel?: GoalOutputChannel;
};

/** Append a summary line to the top-level WORKING.md for this goal run. */
function appendGoalWorkingEntry(
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

function appendRetryContext(
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

function appendRalphContext(
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

type BuildGateResult = { passed: true } | { passed: false; failedCommand: string; output: string };

function truncateForPrompt(text: string): string {
  if (!text) return "";
  const trimmed = text.trim();
  if (trimmed.length <= BUILD_GATE_OUTPUT_MAX_CHARS) return trimmed;
  return trimmed.slice(-BUILD_GATE_OUTPUT_MAX_CHARS);
}

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

function runBuildGateCommands(
  commands: string[],
  workingDir: string,
  onProgress?: (text: string) => void,
): BuildGateResult {
  for (const command of commands) {
    const trimmed = command.trim();
    if (!trimmed) continue;
    onProgress?.(`  [build-gate] Running: ${trimmed}`);

    const result = spawnSync("bash", ["-lc", trimmed], {
      cwd: workingDir,
      encoding: "utf8",
      timeout: BUILD_GATE_COMMAND_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    const output = truncateForPrompt([stdout, stderr].filter(Boolean).join("\n"));

    if (result.error) {
      const message = truncateForPrompt(
        [output, `Build gate command failed to execute: ${formatExecError(result.error)}`]
          .filter(Boolean)
          .join("\n"),
      );
      return {
        passed: false,
        failedCommand: trimmed,
        output: message || "Build gate command failed with an unknown process error.",
      };
    }

    if (result.status !== 0) {
      const statusBits = [
        result.status != null ? `exit code ${result.status}` : null,
        result.signal ? `signal ${result.signal}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      const message = truncateForPrompt(
        [output, statusBits ? `Build gate command failed with ${statusBits}.` : ""]
          .filter(Boolean)
          .join("\n"),
      );
      return {
        passed: false,
        failedCommand: trimmed,
        output: message || "Build gate command exited non-zero with no output.",
      };
    }
  }

  return { passed: true };
}

function resetToTaskBaseSha(
  workingDir: string,
  checkpointSha: string | undefined,
): { success: true } | { success: false; error: string } {
  if (!checkpointSha) {
    return { success: false, error: "No task checkpoint base SHA was recorded for this step." };
  }
  try {
    execFileSync("git", ["-C", workingDir, "reset", "--hard", checkpointSha], {
      encoding: "utf8",
      timeout: 15_000,
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: formatExecError(error) };
  }
}

function buildRalphHistorySummary(stepId: string, bundles: AttemptBundle[]): string {
  const entries = bundles.filter((bundle) => bundle.ralphDetail);
  if (entries.length === 0) return `Task ${stepId} ralphed repeatedly but no detail was captured.`;

  const lines: string[] = [];
  for (const [index, bundle] of entries.entries()) {
    const detail = bundle.ralphDetail!;
    lines.push(`Ralph ${index + 1} (attempt ${bundle.attemptNumber}):`);
    lines.push(`- Approach tried: ${detail.approachTried}`);
    lines.push(`- Errors: ${detail.specificErrors}`);
    lines.push(`- Key insight: ${detail.keyInsight}`);
    lines.push(`- Suggested approach: ${detail.suggestedApproach}`);
  }
  return lines.join("\n");
}

function makeBuildGateFailurePrompt(command: string, output: string): string {
  return [
    `The build gate (${command}) failed after you reported complete.`,
    "Fix the errors.",
    "Here is the output:",
    output,
  ].join("\n");
}

function resolveTaskTimeoutMs(durationMinutes: number | undefined, fallbackMs: number): number {
  if (!durationMinutes || durationMinutes <= 0) return Math.max(fallbackMs, MIN_TASK_TIMEOUT_MS);
  const estimateMs = durationMinutes * 2 * 60_000;
  return Math.max(MIN_TASK_TIMEOUT_MS, Math.min(estimateMs, MAX_TASK_TIMEOUT_MS));
}

export async function executeGoalWithAgent(params: ExecuteGoalParams): Promise<GoalOutcome> {
  const {
    session,
    runId,
    workingDir,
    config,
    maxTurnsPerTask = DEFAULT_MAX_TURNS_PER_TASK,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryConfig,
    gitCheckpointConfig,
    onTaskUpdate,
    onTaskStart,
    onProgress,
    onStatusChange,
    abortSignal,
  } = params;

  const plan = session.plan;
  if (!plan) throw new Error("No plan to execute");

  session.state = "executing";
  session.buildGateConfig = plan.buildGate;
  session.stepRalphCounts ??= {};
  session.buildGateResults ??= {};

  const effectiveAbort = abortSignal ?? new AbortController().signal;
  const maxRalphAttempts = retryConfig?.maxRalphAttempts ?? DEFAULT_MAX_RALPH_ATTEMPTS;
  const buildGateFixCounts = new Map<string, number>();

  // --- Git setup (branch + autosave) ---
  if (gitCheckpointConfig?.enabled) {
    if (!canRunGit() || !isGitRepo(workingDir)) {
      const msg = "Git checkpoints are enabled but this working directory is not a valid git repo.";
      session.state = "blocked";
      session.blocked = { blockedAt: "execution", prompt: msg, requiredInputKey: "git" };
      return { status: "blocked", question: msg, requiredInputKey: "git", blockedAt: "execution" };
    }

    const isResume = session.stepResults.size > 0;
    if (!isWorkingTreeClean(workingDir)) {
      const message = isResume
        ? "claw: crash recovery autosave"
        : `claw: autosave before goal ${runId}`;
      const autosave = autosaveIfDirty(workingDir, message);
      if (!autosave.success) {
        const msg = `Git autosave failed: ${autosave.error}`;
        session.state = "blocked";
        session.blocked = { blockedAt: "execution", prompt: msg, requiredInputKey: "git" };
        return {
          status: "blocked",
          question: msg,
          requiredInputKey: "git",
          blockedAt: "execution",
        };
      }
      if (autosave.sha) {
        onProgress?.(`  [git] Autosaved changes (${autosave.sha.slice(0, 7)})`);
      }
    }

    const branchResult = ensureRunBranch(workingDir, runId);
    if (!branchResult.success) {
      const msg = `Git run branch failed: ${branchResult.error}`;
      session.state = "blocked";
      session.blocked = { blockedAt: "execution", prompt: msg, requiredInputKey: "git" };
      return { status: "blocked", question: msg, requiredInputKey: "git", blockedAt: "execution" };
    }
    onProgress?.(`  [git] Run branch at ${branchResult.sha.slice(0, 7)}`);
  }

  const scores = computeCriticalPathScores(plan.steps);
  const orderIndex = new Map(plan.steps.map((step, idx) => [step.id, idx]));
  const successors = buildSuccessorMap(plan.steps);
  let lastExecutedId: string | null = null;
  const orderedSteps = orderStepsCriticalPathFirst(plan.steps, scores);
  // Retry non-user-input blocked tasks once on resume, even without new answers.
  // This lets fixed environments (PATH/auth/network) take effect without requiring
  // fake /goal_answer input, while avoiding retry loops in a single execution run.
  const retryableBlockedIds = new Set(
    orderedSteps
      .filter(
        (step) =>
          step.status === "blocked" &&
          step.blockedReason != null &&
          step.blockedReason !== "user_input",
      )
      .map((step) => step.id),
  );

  const previouslyBlockedIds = new Set<string>();
  let stopAllTasks = false;
  let globalBlock: { kind: PlanStep["blockedReason"]; message: string } | null = null;
  let globalBlockApplied = false;

  const availability = detectBackendAvailability();
  const backendOverride = params.serializedRun?.backendOverride;
  const degradedPlanner =
    backendOverride !== "claude_code" &&
    isAnthropicPlannerDegraded(params.serializedRun?.plannerDegradedReason);
  const defaultBackend: GoalBackendId = degradedPlanner ? "codex" : DEFAULT_BACKEND;

  if (degradedPlanner) {
    for (const step of plan.steps) {
      rewriteStepBackendsForDegradedPlanner(step);
    }
  }

  const piRunner = new PiTaskRunner({
    workingDir,
    runId,
    config,
    provider: params.provider,
    model: params.model,
    maxTurnsPerTask,
  });
  const cliRunners: Record<Exclude<GoalBackendId, "pi">, TaskRunner> = {
    codex: new CliTaskRunner({ backend: "codex", model: params.model }),
    claude_code: new CliTaskRunner({
      backend: "claude_code",
      model: params.model,
      claudeCodeAuth: params.claudeCodeAuth,
    }),
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (effectiveAbort.aborted) break;

    // Check if the goal was stopped externally (e.g., via goal-stop command)
    const currentRun = loadRun(runId);
    if (currentRun?.state === "cancelled") {
      session.state = "cancelled";
      return { status: "cancelled" };
    }

    const runnable = findRunnableTasks(orderedSteps, session.answers, retryableBlockedIds);
    if (runnable.length === 0) break;

    const task = pickNextTask(runnable, scores, orderIndex, successors, lastExecutedId);

    let resumeAnswer: string | undefined;
    let resumeQuestion: string | undefined;
    if (task.status === "blocked") {
      retryableBlockedIds.delete(task.id);
      resumeAnswer = getAnswerForTask(task.id, session.answers);
      resumeQuestion = task.blockedQuestion;
      task.turnsUsed = 0;
      task.blockedReason = undefined;
      task.blockedQuestion = undefined;
      task.failedDetail = undefined;
      task.status = "pending";
      consumeAnswerForTask(task.id, session.answers);
    }

    const taskStartMs = Date.now();
    const taskTimeoutMs = resolveTaskTimeoutMs(task.durationMinutes, timeoutMs);

    const backend = resolveBackendForStep(task, backendOverride, defaultBackend);
    const availabilityResult = isBackendAvailable(backend, availability);
    if (!availabilityResult.available) {
      const reason = availabilityResult.reason ? `: ${availabilityResult.reason}` : "";
      const msg = `Backend '${backend}' is not available${reason}. Install it or use --backend pi to override.`;
      task.status = "blocked";
      task.blockedReason = "error";
      task.blockedQuestion = msg;
      onProgress?.(`  [blocked] ${msg}`);
      recordTaskResult(session, task, taskStartMs, onTaskUpdate);
      lastExecutedId = task.id;
      continue;
    }

    if (!task.executedBackend) task.executedBackend = backend;

    const runner = backend === "pi" ? piRunner : cliRunners[backend];
    if (!runner) {
      const msg = `Backend '${backend}' is not supported.`;
      task.status = "blocked";
      task.blockedReason = "error";
      task.blockedQuestion = msg;
      recordTaskResult(session, task, taskStartMs, onTaskUpdate);
      lastExecutedId = task.id;
      continue;
    }

    // Git task checkpoint at task start
    if (gitCheckpointConfig?.enabled) {
      session.taskCheckpoints ??= {};
      const checkpointResult = startTaskCheckpoint(workingDir, task.id);
      if (!checkpointResult.success) {
        const msg = `Git checkpoint failed: ${checkpointResult.error}`;
        task.status = "blocked";
        task.blockedReason = "error";
        task.blockedQuestion = msg;
        recordTaskResult(session, task, taskStartMs, onTaskUpdate);
        lastExecutedId = task.id;
        continue;
      }
      session.taskCheckpoints[task.id] = checkpointResult.checkpoint;
      onProgress?.(`  [git] Task base ${checkpointResult.checkpoint.baseSha.slice(0, 7)}`);
    }

    const maxAttempts = retryConfig?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const retryDelayMs = retryConfig?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const workerDir = resolveWorkerDir(runId, task.id);
    let latestResult: TaskRunnerResult | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptBundles = loadAttemptBundles(workerDir);

      const completedSummaries = orderedSteps
        .filter((s) => s.status === "done" && s.taskSummary)
        .map((s) => ({ id: s.id, summary: s.taskSummary! }));

      const context: TaskRunnerContext = {
        task,
        plan,
        goal: session.goal,
        workingDir,
        runId,
        denyPolicy: HARD_DENIES,
        completedSummaries,
        resumeAnswer,
        resumeQuestion,
        attemptBundles,
        onProgress,
        abortSignal: effectiveAbort,
        timeoutMs: taskTimeoutMs,
      };

      task.status = "in_progress";
      onTaskStart?.(task.id);
      if (attempt === 1) {
        onProgress?.(`\n--- Task ${task.id} [${backend}]: ${task.description} ---`);
      } else {
        onProgress?.(`  [ralph] Attempt ${attempt}/${maxAttempts}`);
      }

      const result = await runner.execute(context);
      latestResult = result;
      applyTaskResult(task, result, onProgress);

      const latestBundles = loadAttemptBundles(workerDir);

      if (shouldRetry(result, backend, workerDir) && attempt < maxAttempts) {
        const latestAttempt = latestBundles.at(-1);
        if (latestAttempt) {
          appendRetryContext(
            runId,
            task.id,
            formatAttemptBundleSummary(latestAttempt),
            latestAttempt.attemptNumber,
          );
        }
        task.turnsUsed = 0;
        task.status = "pending";
        task.blockedReason = undefined;
        task.blockedQuestion = undefined;
        task.failedDetail = undefined;
        await new Promise((r) => setTimeout(r, retryDelayMs));
        continue;
      }
      break;
    }

    // Commit task changes
    if (gitCheckpointConfig?.enabled && session.taskCheckpoints?.[task.id]) {
      const commitResult = finalizeTaskCheckpoint(workingDir, task.id, task.taskSummary);
      if (commitResult.success && commitResult.sha) {
        session.taskCheckpoints[task.id] = {
          ...session.taskCheckpoints[task.id]!,
          afterCommit: commitResult.sha,
        };
        onProgress?.(`  [git] Task commit ${commitResult.sha.slice(0, 7)}`);
      } else if (!commitResult.success) {
        onProgress?.(`  [git] Task commit failed: ${commitResult.error}`);
      }
    }

    if (latestResult?.status === "ralph") {
      const ralphCount = (session.stepRalphCounts[task.id] ?? 0) + 1;
      session.stepRalphCounts[task.id] = ralphCount;
      const ralphBundles = loadAttemptBundles(workerDir);
      const ralphHistory = buildRalphHistorySummary(task.id, ralphBundles);

      if (ralphCount >= maxRalphAttempts) {
        const question = [
          `Task ${task.id} reached the ralph limit (${ralphCount}/${maxRalphAttempts}).`,
          ralphHistory,
        ].join("\n\n");
        task.status = "blocked";
        task.blockedReason = "task_failed";
        task.blockedQuestion = question;
        task.failedDetail = {
          whatTried: ralphHistory,
          errorType: "ralph_limit_reached",
          suggestedNext:
            "Review the ralph history and provide guidance or constraints for a new strategy.",
          needsRevert: false,
        };
        onProgress?.(
          `  [ralph] Task ${task.id} hit ralph limit (${ralphCount}/${maxRalphAttempts})`,
        );
      } else {
        const reset = resetToTaskBaseSha(workingDir, session.taskCheckpoints?.[task.id]?.baseSha);
        if (!reset.success) {
          task.status = "blocked";
          task.blockedReason = "task_failed";
          task.blockedQuestion = `Ralph reset failed: ${reset.error}`;
          task.failedDetail = {
            whatTried: ralphHistory,
            errorType: "ralph_reset_failed",
            suggestedNext: "Fix git checkpoint state and retry the task.",
            needsRevert: false,
          };
          onProgress?.(`  [ralph] Reset failed for task ${task.id}: ${reset.error}`);
        } else if (task.ralphDetail) {
          appendRalphContext(runId, task.id, ralphCount, task.ralphDetail);
          appendGoalWorkingEntry(
            runId,
            task.id,
            "ralph",
            [
              `Attempt ${ralphCount}/${maxRalphAttempts}`,
              `Approach tried: ${task.ralphDetail.approachTried}`,
              `Key insight: ${task.ralphDetail.keyInsight}`,
              `Suggested approach: ${task.ralphDetail.suggestedApproach}`,
            ].join("\n"),
          );
          onProgress?.(
            `Task ${task.id}: ralph (attempt ${ralphCount}/${maxRalphAttempts}) — reverting to clean state, dispatching new attempt.`,
          );
          task.status = "pending";
          task.blockedReason = undefined;
          task.blockedQuestion = undefined;
          task.failedDetail = undefined;
          task.taskSummary = undefined;
        }
      }
    }

    const gateCommands = plan.buildGate?.commands?.map((cmd) => cmd.trim()).filter(Boolean) ?? [];
    if (
      task.status === "done" &&
      plan.buildGate?.runBetweenSteps === true &&
      gateCommands.length > 0
    ) {
      const gateResult = runBuildGateCommands(gateCommands, workingDir, onProgress);
      const timestamp = new Date().toISOString();
      if (gateResult.passed) {
        session.buildGateResults[task.id] = { passed: true, timestamp };
        buildGateFixCounts.delete(task.id);
        onProgress?.(`  [build-gate] Task ${task.id} passed`);
      } else {
        session.buildGateResults[task.id] = {
          passed: false,
          failedCommand: gateResult.failedCommand,
          output: gateResult.output,
          timestamp,
        };

        const fixCount = (buildGateFixCounts.get(task.id) ?? 0) + 1;
        buildGateFixCounts.set(task.id, fixCount);
        onProgress?.(`  [build-gate] Task ${task.id} failed on ${gateResult.failedCommand}`);

        if (fixCount > DEFAULT_MAX_BUILD_GATE_FIX_CYCLES) {
          const detail = makeBuildGateFailurePrompt(gateResult.failedCommand, gateResult.output);
          task.status = "blocked";
          task.blockedReason = "task_failed";
          task.blockedQuestion = `Build gate failed after ${DEFAULT_MAX_BUILD_GATE_FIX_CYCLES} retry cycles.\n${detail}`;
          task.failedDetail = {
            whatTried: detail,
            errorType: "build_gate_failed",
            suggestedNext:
              "Review the build-gate output and provide guidance for the next attempt.",
            needsRevert: false,
          };
        } else {
          const reset = resetToTaskBaseSha(workingDir, session.taskCheckpoints?.[task.id]?.baseSha);
          if (!reset.success) {
            task.status = "blocked";
            task.blockedReason = "task_failed";
            task.blockedQuestion = `Build gate reset failed: ${reset.error}`;
            task.failedDetail = {
              whatTried: gateResult.output,
              errorType: "build_gate_reset_failed",
              suggestedNext: "Fix git checkpoint state and retry the task.",
              needsRevert: false,
            };
          } else {
            const outputForRetry = makeBuildGateFailurePrompt(
              gateResult.failedCommand,
              gateResult.output,
            );
            const attemptNumber = (loadAttemptBundles(workerDir).at(-1)?.attemptNumber ?? 0) + 1;
            const syntheticBundle: AttemptBundle = {
              attemptNumber,
              backend,
              outcome: "failed",
              errorClassification: "build_gate_failure",
              durationMs: 0,
              buildGateFailure: {
                failedCommand: gateResult.failedCommand,
                output: outputForRetry,
              },
              logExcerpt: truncateForPrompt(outputForRetry),
            };
            writeAttemptBundle(workerDir, syntheticBundle);
            appendRetryContext(
              runId,
              task.id,
              formatAttemptBundleSummary(syntheticBundle),
              syntheticBundle.attemptNumber,
            );
            appendGoalWorkingEntry(
              runId,
              task.id,
              "build-gate",
              `Build gate failed (${fixCount}/${DEFAULT_MAX_BUILD_GATE_FIX_CYCLES}) on ${gateResult.failedCommand}. Retrying after reset.`,
            );
            onProgress?.(
              `Task ${task.id}: build gate failed (cycle ${fixCount}/${DEFAULT_MAX_BUILD_GATE_FIX_CYCLES}) — reverting to clean state, dispatching new attempt.`,
            );
            task.status = "pending";
            task.blockedReason = undefined;
            task.blockedQuestion = undefined;
            task.failedDetail = undefined;
            task.taskSummary = undefined;
          }
        }
      }
    }

    if (task.status === "pending") {
      lastExecutedId = task.id;
      continue;
    }

    recordTaskResult(session, task, taskStartMs, onTaskUpdate);
    lastExecutedId = task.id;

    const status: PlanStep["status"] = task.status;

    if (status === "done") {
      appendGoalWorkingEntry(runId, task.id, "done", task.taskSummary ?? "Completed.");
    } else if (task.blockedReason === "task_failed") {
      appendGoalWorkingEntry(
        runId,
        task.id,
        "failed",
        task.failedDetail?.whatTried ?? task.blockedQuestion ?? "Failed.",
      );
    }

    if (task.blockedReason && FATAL_ERRORS.includes(task.blockedReason)) {
      globalBlock = {
        kind: task.blockedReason ?? "other",
        message: task.blockedQuestion ?? "Execution blocked.",
      };
      stopAllTasks = true;
      session.lastError = task.blockedQuestion ?? session.lastError;
    }

    const hasRunnable =
      findRunnableTasks(orderedSteps, session.answers, retryableBlockedIds).length > 0;
    if (task.blockedReason && !previouslyBlockedIds.has(task.id) && onStatusChange && hasRunnable) {
      previouslyBlockedIds.add(task.id);
      await onStatusChange({
        type: "step_blocked",
        stepId: task.id,
        question: task.blockedQuestion ?? "Unknown",
        steps: [...orderedSteps],
      });
    }

    if (stopAllTasks && globalBlock && !globalBlockApplied) {
      for (const step of orderedSteps) {
        if (step.status !== "pending") continue;
        const depsReady = step.dependsOn.every((depId) => {
          const dep = orderedSteps.find((s) => s.id === depId);
          return dep?.status === "done";
        });
        if (!depsReady) continue;
        step.status = "blocked";
        step.blockedReason = globalBlock.kind;
        step.blockedQuestion = globalBlock.message;
      }
      globalBlockApplied = true;
    }

    if (stopAllTasks) break;
  }

  const finalGateCommands =
    plan.buildGate?.commands?.map((cmd) => cmd.trim()).filter(Boolean) ?? [];
  if (orderedSteps.every((s) => s.status === "done") && finalGateCommands.length > 0) {
    const finalGateResult = runBuildGateCommands(finalGateCommands, workingDir, onProgress);
    const timestamp = new Date().toISOString();
    if (finalGateResult.passed) {
      session.buildGateResults["__final__"] = { passed: true, timestamp };
      onProgress?.("  [build-gate] Final gate passed");
    } else {
      session.buildGateResults["__final__"] = {
        passed: false,
        failedCommand: finalGateResult.failedCommand,
        output: finalGateResult.output,
        timestamp,
      };

      const fallbackStep = orderedSteps.at(-1);
      const targetStep =
        (lastExecutedId ? orderedSteps.find((step) => step.id === lastExecutedId) : undefined) ??
        fallbackStep;

      if (targetStep) {
        const detail = makeBuildGateFailurePrompt(
          finalGateResult.failedCommand,
          finalGateResult.output,
        );
        targetStep.status = "blocked";
        targetStep.blockedReason = "task_failed";
        targetStep.blockedQuestion = `Final build gate failed.\n${detail}`;
        targetStep.failedDetail = {
          whatTried: detail,
          errorType: "build_gate_failed",
          suggestedNext: "Fix the build-gate failures and retry the goal step.",
          needsRevert: false,
        };
        appendGoalWorkingEntry(
          runId,
          targetStep.id,
          "failed",
          `Final build gate failed on ${finalGateResult.failedCommand}.`,
        );
        recordTaskResult(session, targetStep, Date.now(), onTaskUpdate);
      }
      onProgress?.(`  [build-gate] Final gate failed on ${finalGateResult.failedCommand}`);
    }
  }

  const allDone = orderedSteps.every((s) => s.status === "done");
  if (allDone) {
    session.state = "done";
    let manualTests: ManualTestSuggestion[] | undefined;
    let manualTestsError: string | undefined;
    try {
      manualTests = await generateManualTests({
        goal: session.goal,
        steps: orderedSteps,
        client: params.manualTestsClient,
      });
    } catch (err) {
      // Fail-open: completion should still emit even when manual test generation fails.
      manualTests = undefined;
      manualTestsError = err instanceof Error ? err.message : String(err);
    }
    const summary = buildGoalSummary({
      goal: session.goal,
      goalHeadline: plan.shortSummary,
      runId,
      steps: orderedSteps,
      maxTurnsPerTask,
      manualTests,
      channel: params.channel,
    });
    if (onStatusChange) {
      await onStatusChange({
        type: "all_done",
        steps: [...orderedSteps],
        summary,
        ...(manualTests !== undefined ? { manualTests } : {}),
        ...(manualTestsError ? { manualTestsError } : {}),
      });
    }
    return { status: "done", summary };
  }

  const aggregated =
    aggregateBlockedDetails(orderedSteps) ??
    ({ blockedAt: "execution", prompt: "All tasks completed.", requiredInputKey: "none" } as const);
  session.state = "blocked";
  session.blocked = aggregated;
  if (onStatusChange) {
    await onStatusChange({ type: "fully_blocked", steps: [...orderedSteps] });
  }
  return {
    status: "blocked",
    question: aggregated.prompt,
    requiredInputKey: aggregated.requiredInputKey,
    blockedAt: aggregated.blockedAt,
  };
}

function resolveBackendForStep(
  step: PlanStep,
  override: GoalBackendId | undefined,
  fallback: GoalBackendId,
): GoalBackendId {
  if (override) return override;
  if (step.executedBackend) return step.executedBackend;
  if (step.backend) return step.backend;
  return fallback;
}

function applyTaskResult(
  task: PlanStep,
  result: TaskRunnerResult,
  onProgress?: (text: string) => void,
): void {
  task.turnsUsed = result.turnsUsed;
  if (result.status === "complete") {
    task.status = "done";
    task.taskSummary = result.summary;
    task.ralphDetail = undefined;
    onProgress?.(`  [done] ${result.summary ?? "completed"}`);
    return;
  }

  if (result.status === "failed") {
    task.status = "blocked";
    task.blockedReason = "task_failed";
    task.blockedQuestion = result.question ?? "Task failed.";
    task.failedDetail = result.failedDetail;
    task.ralphDetail = undefined;
    onProgress?.(`  [failed] ${task.blockedQuestion}`);
    return;
  }

  if (result.status === "ralph") {
    task.status = "pending";
    task.ralphDetail = result.ralphDetail;
    task.blockedReason = undefined;
    task.blockedQuestion = undefined;
    task.failedDetail = undefined;
    task.taskSummary = undefined;
    onProgress?.("  [ralph] Worker requested strategic reset");
    return;
  }

  task.status = "blocked";
  task.blockedReason = result.blockedReason ?? "other";
  task.blockedQuestion = result.question ?? "Task blocked.";
  task.ralphDetail = undefined;
  onProgress?.(`  [blocked] ${task.blockedQuestion}`);
}

function shouldRetry(result: TaskRunnerResult, backend: GoalBackendId, workerDir: string): boolean {
  if (backend === "pi") {
    return result.status === "blocked" && PI_RETRYABLE.includes(result.blockedReason ?? "other");
  }

  const attempts = loadAttemptBundles(workerDir);
  const latest = attempts.at(-1);
  if (!latest) return false;
  return (
    latest.outcome === "timeout" || latest.outcome === "crash" || latest.outcome === "rate_limit"
  );
}

function recordTaskResult(
  session: GoalSession,
  task: PlanStep,
  taskStartMs: number,
  onTaskUpdate?: (result: TaskExecutionResult) => void,
): void {
  const elapsedMs = Math.max(0, Date.now() - taskStartMs);
  const previous = session.stepResults.get(task.id);
  const durationMs = normalizeDurationMs(previous?.durationMs) + elapsedMs;
  session.stepResults.set(task.id, {
    stepId: task.id,
    success: task.status === "done",
    output: task.taskSummary ?? "",
    error: task.status !== "done" ? (task.blockedQuestion ?? "Task did not complete.") : undefined,
    durationMs,
  });

  const result: TaskExecutionResult = {
    taskId: task.id,
    turnsUsed: task.turnsUsed ?? 0,
    durationMs,
    outcome:
      task.status === "done"
        ? "done"
        : task.blockedReason === "task_failed"
          ? "task_failed"
          : "blocked",
    summary: task.taskSummary,
    blockedQuestion: task.blockedQuestion,
    blockedReason: task.blockedReason,
  };
  onTaskUpdate?.(result);
}

function normalizeDurationMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

function hasAnswerForTask(taskId: string, answers: Record<string, string>): boolean {
  if (answers[`task:${taskId}:input`] != null) return true;
  for (const key of Object.keys(answers)) {
    const match = /^tasks:([^:]+):input$/.exec(key);
    if (match && match[1]!.split(",").includes(taskId)) return true;
  }
  return false;
}

function getAnswerForTask(taskId: string, answers: Record<string, string>): string | undefined {
  const direct = answers[`task:${taskId}:input`];
  if (direct != null) return direct;
  for (const [key, value] of Object.entries(answers)) {
    const match = /^tasks:([^:]+):input$/.exec(key);
    if (match && match[1]!.split(",").includes(taskId)) return value;
  }
  return undefined;
}

function consumeAnswerForTask(taskId: string, answers: Record<string, string>): void {
  const directKey = `task:${taskId}:input`;
  if (answers[directKey]) delete answers[directKey];

  for (const key of Object.keys(answers)) {
    const match = /^tasks:([^:]+):input$/.exec(key);
    if (!match) continue;
    if (!match[1]!.split(",").includes(taskId)) continue;

    const remaining = match[1]!
      .split(",")
      .filter((id) => id !== taskId)
      .map((id) => id.trim())
      .filter(Boolean);

    const value = answers[key]!;
    delete answers[key];
    if (remaining.length === 0) continue;
    const newKey =
      remaining.length === 1 ? `task:${remaining[0]}:input` : `tasks:${remaining.join(",")}:input`;
    answers[newKey] = value;
  }
}

function findRunnableTasks(
  steps: PlanStep[],
  answers?: Record<string, string>,
  retryableBlockedIds?: Set<string>,
): PlanStep[] {
  return steps.filter((step) => {
    const depsReady = step.dependsOn.every((depId) => {
      const dep = steps.find((s) => s.id === depId);
      return dep?.status === "done";
    });
    if (!depsReady) return false;
    if (step.status === "pending") return true;
    if (step.status === "blocked") {
      if (answers && hasAnswerForTask(step.id, answers)) return true;
      return Boolean(retryableBlockedIds?.has(step.id));
    }
    return false;
  });
}

function buildGoalSummary(params: {
  goal: string;
  goalHeadline?: string;
  runId: string;
  steps: PlanStep[];
  maxTurnsPerTask?: number;
  manualTests?: ManualTestSuggestion[];
  channel?: GoalOutputChannel;
}): string {
  const summary = formatCompactGoalCompletionSummary({
    title: params.goalHeadline?.trim() || params.goal,
    steps: params.steps.map((step) => ({
      id: step.id,
      description: step.description,
      summary: step.taskSummary,
      status: step.status,
      turnsUsed: step.turnsUsed,
    })),
    attemptsTotal: params.maxTurnsPerTask,
    resolveStepAttemptsUsed: (stepId) =>
      loadAttemptBundles(resolveWorkerDir(params.runId, stepId)).length,
    manualTests: params.manualTests,
    channel: params.channel ?? "cli",
  }).text;
  return `${summary.trimEnd()}\n**Goal ID:** ${params.runId.slice(0, 8)}`;
}

function buildSuccessorMap(steps: PlanStep[]): Map<string, Set<string>> {
  const successors = new Map<string, Set<string>>();
  for (const step of steps) {
    successors.set(step.id, new Set());
  }
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      const list = successors.get(dep);
      if (list) list.add(step.id);
    }
  }
  return successors;
}

function pickNextTask(
  runnable: PlanStep[],
  scores: CriticalPathScores,
  orderIndex: Map<string, number>,
  successors: Map<string, Set<string>>,
  lastExecutedId: string | null,
): PlanStep {
  if (runnable.length <= 1) return runnable[0]!;

  let maxScore = Number.NEGATIVE_INFINITY;
  for (const step of runnable) {
    const score = scores.get(step.id) ?? 0;
    if (score > maxScore) maxScore = score;
  }

  let candidates = runnable.filter((step) => (scores.get(step.id) ?? 0) === maxScore);
  if (lastExecutedId) {
    const successorSet = successors.get(lastExecutedId);
    if (successorSet && successorSet.size > 0) {
      const successorCandidates = candidates.filter((step) => successorSet.has(step.id));
      if (successorCandidates.length > 0) candidates = successorCandidates;
    }
  }

  candidates.sort((a, b) => {
    return (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0);
  });

  return candidates[0]!;
}
