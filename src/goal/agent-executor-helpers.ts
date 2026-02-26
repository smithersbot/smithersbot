import type { CliWorkerId } from "../config/types.goal.js";
import { loadAttemptBundles, resolveWorkerDir } from "./attempt-bundle.js";
import type { GoalBackendId } from "./backend-types.js";
import { formatCompactGoalCompletionSummary, type GoalOutputChannel } from "./compact-output.js";
import type { CriticalPathScores } from "./plan-order.js";
import type { GoalSession, ManualTestSuggestion, PlanStep, TaskExecutionResult } from "./types.js";
import type { TaskRunnerResult } from "./task-runner.js";

export function resolveBackendForStep(
  step: PlanStep,
  override: GoalBackendId | undefined,
  fallback: GoalBackendId,
): GoalBackendId {
  if (override) return override;
  if (step.executedBackend) return step.executedBackend;
  if (step.backend) return step.backend;
  return fallback;
}

export function clampBackendForEnabledWorkers(
  backend: GoalBackendId,
  enabledWorkers: CliWorkerId[],
): GoalBackendId {
  if (backend === "pi") return backend;
  if (enabledWorkers.includes(backend)) return backend;
  return enabledWorkers.length === 1 ? enabledWorkers[0]! : backend;
}

export function applyTaskResult(
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
    return;
  }

  task.status = "blocked";
  task.blockedReason = result.blockedReason ?? "other";
  task.blockedQuestion = result.question ?? "Task blocked.";
  task.ralphDetail = undefined;
  onProgress?.(`  [blocked] ${task.blockedQuestion}`);
}

export function shouldRetry(
  result: TaskRunnerResult,
  backend: GoalBackendId,
  workerDir: string,
  retryableReasons: PlanStep["blockedReason"][],
): boolean {
  if (backend === "pi") {
    return (
      result.status === "blocked" && retryableReasons.includes(result.blockedReason ?? "other")
    );
  }

  const attempts = loadAttemptBundles(workerDir);
  const latest = attempts.at(-1);
  if (!latest) return false;
  return (
    latest.outcome === "timeout" || latest.outcome === "crash" || latest.outcome === "rate_limit"
  );
}

export function recordTaskResult(
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

export function buildGoalSummary(params: {
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

export function buildSuccessorMap(steps: PlanStep[]): Map<string, Set<string>> {
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

export function pickNextTask(
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
