import fs from "node:fs";
import path from "node:path";

import type { MoltbotConfig } from "../config/config.js";
import type { ClaudeCodeAuthMode } from "../config/types.goal.js";
import {
  loadAttemptBundles,
  resolveWorkerDir,
  formatAttemptBundleSummary,
} from "./attempt-bundle.js";
import { aggregateBlockedDetails } from "./blocked.js";
import { detectBackendAvailability, isBackendAvailable } from "./backend-availability.js";
import type { GoalBackendId } from "./backend-types.js";
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
import { PiTaskRunner } from "./pi-runner.js";
import { loadRun, resolveGoalWorkingFile, resolveWorkingFile } from "./run-store.js";
import type {
  GitCheckpointConfig,
  GoalOutcome,
  GoalSession,
  PlanStep,
  RetryConfig,
  SerializedRun,
  TaskExecutionResult,
} from "./types.js";
import type { TaskRunner, TaskRunnerContext, TaskRunnerResult } from "./task-runner.js";

const DEFAULT_MAX_TURNS_PER_TASK = 5;
const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes per prompt
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_BACKEND: GoalBackendId = "claude_code";

const MIN_TASK_TIMEOUT_MS = 10 * 60_000;
const MAX_TASK_TIMEOUT_MS = 2 * 60 * 60_000;

const PI_RETRYABLE: PlanStep["blockedReason"][] = ["timeout", "network", "rate_limit"];
const FATAL_ERRORS: PlanStep["blockedReason"][] = ["out_of_credits", "auth"];

export type GoalStatusChangeEvent =
  | { type: "step_blocked"; stepId: string; question: string; steps: PlanStep[] }
  | { type: "fully_blocked"; steps: PlanStep[] }
  | { type: "all_done"; steps: PlanStep[]; summary: string };

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
  onProgress?: (text: string) => void;
  onStatusChange?: (event: GoalStatusChangeEvent) => void | Promise<void>;
  abortSignal?: AbortSignal;
  serializedRun?: SerializedRun;
  /** How Claude Code workers authenticate: subscription (default) or api_key. */
  claudeCodeAuth?: ClaudeCodeAuthMode;
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
    onProgress,
    onStatusChange,
    abortSignal,
  } = params;

  const plan = session.plan;
  if (!plan) throw new Error("No plan to execute");

  session.state = "executing";

  const effectiveAbort = abortSignal ?? new AbortController().signal;

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
  const defaultBackend = DEFAULT_BACKEND;

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

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const workerDir = resolveWorkerDir(runId, task.id);
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
      if (attempt === 1) {
        onProgress?.(`\n--- Task ${task.id} [${backend}]: ${task.description} ---`);
      } else {
        onProgress?.(`  [ralph] Attempt ${attempt}/${maxAttempts}`);
      }

      const result = await runner.execute(context);
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

  const allDone = orderedSteps.every((s) => s.status === "done");
  if (allDone) {
    session.state = "done";
    const summary = buildGoalSummary(orderedSteps);
    if (onStatusChange) {
      await onStatusChange({ type: "all_done", steps: [...orderedSteps], summary });
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
    onProgress?.(`  [done] ${result.summary ?? "completed"}`);
    return;
  }

  if (result.status === "failed") {
    task.status = "blocked";
    task.blockedReason = "task_failed";
    task.blockedQuestion = result.question ?? "Task failed.";
    task.failedDetail = result.failedDetail;
    onProgress?.(`  [failed] ${task.blockedQuestion}`);
    return;
  }

  task.status = "blocked";
  task.blockedReason = result.blockedReason ?? "other";
  task.blockedQuestion = result.question ?? "Task blocked.";
  onProgress?.(`  [blocked] ${task.blockedQuestion}`);
}

function shouldRetry(result: TaskRunnerResult, backend: GoalBackendId, workerDir: string): boolean {
  if (backend === "pi") {
    return result.status === "blocked" && PI_RETRYABLE.includes(result.blockedReason ?? "other");
  }

  const attempts = loadAttemptBundles(workerDir);
  const latest = attempts.at(-1);
  if (!latest) return false;
  return latest.outcome === "timeout" || latest.outcome === "crash";
}

function recordTaskResult(
  session: GoalSession,
  task: PlanStep,
  taskStartMs: number,
  onTaskUpdate?: (result: TaskExecutionResult) => void,
): void {
  const durationMs = Date.now() - taskStartMs;
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

function buildGoalSummary(steps: PlanStep[]): string {
  const done = steps.filter((s) => s.status === "done");
  const blocked = steps.filter((s) => s.status === "blocked");
  const parts = [`${done.length}/${steps.length} tasks completed`];
  if (blocked.length > 0) parts.push(`${blocked.length} blocked`);
  const summaries = done.filter((s) => s.taskSummary).map((s) => `- ${s.id}: ${s.taskSummary}`);
  if (summaries.length > 0) {
    return `${parts.join(", ")}.\n\n${summaries.join("\n")}`;
  }
  return `${parts.join(", ")}.`;
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
