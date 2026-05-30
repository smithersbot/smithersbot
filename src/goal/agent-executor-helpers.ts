import type { CliWorkerId } from "../config/types.goal.js";
import { loadAttemptBundles, resolveWorkerDir } from "./attempt-bundle.js";
import { isBackendAvailable } from "./backend-availability.js";
import { claudeCodeSandboxNetworkCapability } from "./backend-sandbox.js";
import type { BackendAvailability, GoalBackendId } from "./backend-types.js";
import { isUsageLimitClassReason } from "./error-patterns.js";
import { formatCompactGoalCompletionSummary, type GoalOutputChannel } from "./compact-output.js";
import type { CriticalPathScores } from "./plan-order.js";
import type { GoalSession, ManualTestSuggestion, PlanStep, TaskExecutionResult } from "./types.js";
import type { TaskRunnerResult } from "./task-runner.js";

/**
 * Whether a backend is eligible to attempt network access for a
 * requiresNetwork=true step. Codex wires net.allowed via its sandbox profile;
 * Claude Code activates network per step under the requiresNetwork policy (no
 * hidden env-var opt-in — see claudeCodeSandboxNetworkCapability); pi has no
 * sandbox network wiring. A backend that is not available at all cannot provide
 * network either. This reports eligibility only: a genuine runtime/sandbox
 * failure to enable network still surfaces as capability_blocked/sandbox_blocked
 * downstream.
 */
export function isBackendNetworkCapable(
  backend: GoalBackendId,
  availability: BackendAvailability[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isBackendAvailable(backend, availability).available) return false;
  if (backend === "codex") return true;
  if (backend === "claude_code") return claudeCodeSandboxNetworkCapability(env).supported;
  return false;
}

export type ResolveBackendNetworkOpts = {
  /** Predicate: can this backend provide network for a requiresNetwork step? */
  networkCapable: (backend: GoalBackendId) => boolean;
  /** Ordered candidate backends to reroute to when the chosen one cannot network. */
  networkCandidates: GoalBackendId[];
};

export function resolveBackendForStep(
  step: PlanStep,
  override: GoalBackendId | undefined,
  fallback: GoalBackendId,
  networkOpts?: ResolveBackendNetworkOpts,
): GoalBackendId {
  const chosen = override ?? step.executedBackend ?? step.backend ?? fallback;
  // A network-required step must never be assigned to a backend that cannot
  // enable network. Reroute to the first network-capable candidate; if none is
  // capable, return the chosen backend unchanged so the caller can surface a
  // capability_blocked block rather than silently running without network.
  if (step.requiresNetwork !== true || !networkOpts) return chosen;
  if (networkOpts.networkCapable(chosen)) return chosen;
  const capable = networkOpts.networkCandidates.find(
    (candidate) => candidate !== chosen && networkOpts.networkCapable(candidate),
  );
  return capable ?? chosen;
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

/**
 * Maximum number of attempts (initial + auto-retries) spent on the *same*
 * transient backend/system failure class for one task within a single execution
 * run before the run surfaces a paused block. A transient blip (Claude 529
 * overloaded, retryable rate limit, transient server 5xx) must never immediately
 * become a user-facing block: the run keeps auto-retrying with backoff up to this
 * budget, staying in a retrying/in-progress state, then pauses (resumable).
 */
export const MAX_TRANSIENT_RETRY_ATTEMPTS = 5;

/**
 * Exponential backoff delay (ms) for transient retries, capped. `retryIndex` is
 * 0-based for the first retry, so delays grow base, 2x, 4x, ... up to `capMs`.
 */
export function computeTransientBackoffMs(
  retryIndex: number,
  baseDelayMs: number,
  capMs = 30_000,
): number {
  const safeBase = Number.isFinite(baseDelayMs) && baseDelayMs > 0 ? baseDelayMs : 1;
  if (retryIndex <= 0) return Math.min(safeBase, capMs);
  return Math.min(safeBase * 2 ** retryIndex, capMs);
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

export type FallbackBackendReason =
  | "not_usage_or_rate_limit"
  | "backend_override"
  | "single_backend_constraint"
  | "fallback_not_enabled"
  | "fallback_unavailable";

export type PickFallbackBackendResult = {
  backend: CliWorkerId | null;
  reason?: FallbackBackendReason;
  detail?: string;
};

type FallbackEligibleResult = Omit<
  Pick<TaskRunnerResult, "status" | "blockedReason">,
  "blockedReason"
> & {
  blockedReason?: TaskRunnerResult["blockedReason"] | "usage_limit";
};

export function pickFallbackBackend(
  currentBackend: CliWorkerId,
  result: FallbackEligibleResult,
  resolvedEnabledWorkers: CliWorkerId[],
  availability: BackendAvailability[],
  backendOverride?: GoalBackendId,
  networkOpts?: {
    requiresNetwork?: boolean;
    networkCapable: (backend: GoalBackendId) => boolean;
  },
): PickFallbackBackendResult {
  if (!isUsageLimitClassReason(result.blockedReason)) {
    return { backend: null, reason: "not_usage_or_rate_limit" };
  }

  if (backendOverride) {
    return { backend: null, reason: "backend_override", detail: backendOverride };
  }

  if (resolvedEnabledWorkers.length <= 1) {
    return { backend: null, reason: "single_backend_constraint" };
  }

  const fallbackBackend: CliWorkerId = currentBackend === "codex" ? "claude_code" : "codex";
  if (!resolvedEnabledWorkers.includes(fallbackBackend)) {
    return { backend: null, reason: "fallback_not_enabled", detail: fallbackBackend };
  }

  const available = isBackendAvailable(fallbackBackend, availability);
  if (!available.available) {
    return {
      backend: null,
      reason: "fallback_unavailable",
      detail: available.reason ?? `${fallbackBackend} is not available on PATH`,
    };
  }

  // A network-required step must not fall back to a backend that cannot enable
  // network (e.g. Claude Code when its build lacks a network grant).
  if (networkOpts?.requiresNetwork === true && !networkOpts.networkCapable(fallbackBackend)) {
    return {
      backend: null,
      reason: "fallback_unavailable",
      detail: `${fallbackBackend} cannot enable network for a requiresNetwork step`,
    };
  }

  return { backend: fallbackBackend };
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
