import { execFileSync } from "node:child_process";

import type { MoltbotConfig } from "../config/config.js";
import type { ClaudeCodeAuthMode, CliWorkerId, SemgrepMode } from "../config/types.goal.js";
import {
  loadAttemptBundles,
  resolveWorkerDir,
  formatAttemptBundleSummary,
  writeAttemptBundle,
  type AttemptBundle,
} from "./attempt-bundle.js";
import {
  applyTaskResult,
  buildGoalSummary,
  buildSuccessorMap,
  clampBackendForEnabledWorkers,
  pickNextTask,
  recordTaskResult,
  resolveBackendForStep,
  shouldRetry,
} from "./agent-executor-helpers.js";
import { aggregateBlockedDetails } from "./blocked.js";
import { detectBackendAvailability, isBackendAvailable } from "./backend-availability.js";
import { resolveEnabledWorkers, type GoalBackendId } from "./backend-types.js";
import {
  buildDefaultSastCommand,
  formatExecError,
  makeBuildGateFailurePrompt,
  resetToTaskBaseSha,
  resolveChangedFilesSinceCheckpoint,
  runBuildGateCommands,
  truncateForPrompt,
} from "./build-gate.js";
import type { GoalOutputChannel } from "./compact-output.js";
import { CliTaskRunner } from "./cli-runner.js";
import { HARD_DENIES } from "./hard-deny.js";
import {
  autosaveIfDirty,
  buildRunBranchName,
  canRunGit,
  createRunPullRequest,
  ensureRunBranch,
  finalizeTaskCheckpoint,
  isGitRepo,
  isWorkingTreeClean,
  pushRunBranch,
  startTaskCheckpoint,
} from "./git-checkpoint.js";
import { isRepoPrivate } from "./git-privacy.js";
import { orderStepsCriticalPathFirst, computeCriticalPathScores } from "./plan-order.js";
import { extractRunLessons, getLessonsForContext } from "./lessons.js";
import { generateManualTests } from "./manual-tests.js";
import { PiTaskRunner } from "./pi-runner.js";
import {
  runPostExecutionReview,
  resolvePostExecutionReviewBaseSha,
  truncateSingleLine,
} from "./post-execution-review.js";
import {
  appendGoalWorkingEntry,
  appendRalphContext,
  appendRetryContext,
  buildRalphHistorySummary,
} from "./run-journal.js";
import { loadRun } from "./run-store.js";
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
const DEFAULT_BACKEND: CliWorkerId = "claude_code";
const DEFAULT_MAX_BUILD_GATE_FIX_CYCLES = 2;

const MIN_TASK_TIMEOUT_MS = 10 * 60_000;
const MAX_TASK_TIMEOUT_MS = 2 * 60 * 60_000;

const PI_RETRYABLE: PlanStep["blockedReason"][] = ["timeout", "network", "rate_limit"];
const FATAL_ERRORS: PlanStep["blockedReason"][] = ["out_of_credits", "auth"];

function isAnthropicPlannerDegraded(
  reason: string | undefined,
): reason is "anthropic_rate_limit" | "anthropic_usage_limit" {
  return reason === "anthropic_rate_limit" || reason === "anthropic_usage_limit";
}

function rewriteStepBackendsForDegradedPlanner(
  step: PlanStep,
  enabledWorkers: CliWorkerId[],
): void {
  if (!enabledWorkers.includes("codex")) return;
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
      prUrl?: string;
      manualTests?: ManualTestSuggestion[];
      manualTestsError?: string;
    };

export type ExecuteGoalParams = {
  session: GoalSession;
  runId: string;
  workingDir: string;
  config?: MoltbotConfig;
  enabledWorkers?: CliWorkerId[];
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

function resolveTaskTimeoutMs(durationMinutes: number | undefined, fallbackMs: number): number {
  if (!durationMinutes || durationMinutes <= 0) return Math.max(fallbackMs, MIN_TASK_TIMEOUT_MS);
  const estimateMs = durationMinutes * 3 * 60_000;
  return Math.max(MIN_TASK_TIMEOUT_MS, Math.min(estimateMs, MAX_TASK_TIMEOUT_MS));
}

export async function executeGoalWithAgent(params: ExecuteGoalParams): Promise<GoalOutcome> {
  const {
    session,
    runId,
    workingDir,
    config,
    enabledWorkers,
    maxTurnsPerTask = DEFAULT_MAX_TURNS_PER_TASK,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryConfig,
    gitCheckpointConfig,
    onTaskUpdate,
    onTaskStart,
    onProgress,
    onStatusChange,
    abortSignal,
    claudeCodeAuth = "subscription",
  } = params;

  const plan = session.plan;
  if (!plan) throw new Error("No plan to execute");
  const semgrepMode: SemgrepMode = config?.goal?.semgrep ?? "step";

  session.state = "executing";
  session.buildGateConfig = plan.buildGate;
  session.stepRalphCounts ??= {};
  session.buildGateFixCounts ??= {};
  session.buildGateFixSignatures ??= {};
  session.buildGateResults ??= {};

  const effectiveAbort = abortSignal ?? new AbortController().signal;
  const resolvedEnabledWorkers = resolveEnabledWorkers(
    enabledWorkers ? { enabledWorkers } : config?.goal,
  );
  const maxRalphAttempts = retryConfig?.maxRalphAttempts ?? DEFAULT_MAX_RALPH_ATTEMPTS;
  const buildGateFixCounts = new Map<string, number>(
    Object.entries(params.serializedRun?.buildGateFixCounts ?? session.buildGateFixCounts),
  );
  const buildGateFixSignatures = new Map<string, string>(
    Object.entries(params.serializedRun?.buildGateFixSignatures ?? session.buildGateFixSignatures),
  );
  const persistBuildGateFixState = (): void => {
    session.buildGateFixCounts = Object.fromEntries(buildGateFixCounts);
    session.buildGateFixSignatures = Object.fromEntries(buildGateFixSignatures);
  };
  persistBuildGateFixState();

  const runBranchName = buildRunBranchName(runId, params.serializedRun?.createdAt);

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

    const branchResult = ensureRunBranch(workingDir, runId, runBranchName);
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
  let finalBuildGateFailurePrompt: string | null = null;

  const availability = detectBackendAvailability();
  const backendOverride = params.serializedRun?.backendOverride;
  const degradedPlanner =
    backendOverride !== "claude_code" &&
    isAnthropicPlannerDegraded(params.serializedRun?.plannerDegradedReason);
  const defaultCliBackend: CliWorkerId =
    resolvedEnabledWorkers.length === 1 ? resolvedEnabledWorkers[0]! : DEFAULT_BACKEND;
  const defaultBackend: GoalBackendId =
    degradedPlanner && resolvedEnabledWorkers.includes("codex") ? "codex" : defaultCliBackend;

  if (degradedPlanner) {
    for (const step of plan.steps) {
      rewriteStepBackendsForDegradedPlanner(step, resolvedEnabledWorkers);
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
  const cliRunners: Partial<Record<CliWorkerId, TaskRunner>> = {};
  if (resolvedEnabledWorkers.includes("codex")) {
    cliRunners.codex = new CliTaskRunner({ backend: "codex", model: params.model });
  }
  if (resolvedEnabledWorkers.includes("claude_code")) {
    cliRunners.claude_code = new CliTaskRunner({
      backend: "claude_code",
      model: params.model,
      claudeCodeAuth: params.claudeCodeAuth,
    });
  }

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

    const backend = clampBackendForEnabledWorkers(
      resolveBackendForStep(task, backendOverride, defaultBackend),
      resolvedEnabledWorkers,
    );
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

    if (task.executedBackend !== backend) task.executedBackend = backend;

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
      }

      const result = await runner.execute(context);
      latestResult = result;
      applyTaskResult(task, result, onProgress);

      const latestBundles = loadAttemptBundles(workerDir);

      if (shouldRetry(result, backend, workerDir, PI_RETRYABLE) && attempt < maxAttempts) {
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
      let commandsForThisStep = gateCommands;
      if (semgrepMode === "step") {
        const checkpointBaseSha = session.taskCheckpoints?.[task.id]?.baseSha;
        const changedFilesSinceCheckpoint = resolveChangedFilesSinceCheckpoint({
          workingDir,
          baseSha: checkpointBaseSha,
        });
        if (changedFilesSinceCheckpoint && changedFilesSinceCheckpoint.length === 0) {
          onProgress?.("  [sast] No changed files since checkpoint; skipping semgrep scan.");
        }
        const sastCommand = buildDefaultSastCommand({
          workingDir,
          targetPaths: changedFilesSinceCheckpoint ?? undefined,
        });
        commandsForThisStep = sastCommand ? [sastCommand, ...gateCommands] : gateCommands;
        if (sastCommand) {
          onProgress?.("  [sast] Running semgrep scan...");
        }
      }
      const gateSignature = commandsForThisStep.join("\n");
      const previousGateSignature = buildGateFixSignatures.get(task.id);
      if (previousGateSignature && previousGateSignature !== gateSignature) {
        buildGateFixCounts.delete(task.id);
      }
      buildGateFixSignatures.set(task.id, gateSignature);
      persistBuildGateFixState();

      const gateResult = runBuildGateCommands(commandsForThisStep, workingDir);
      const timestamp = new Date().toISOString();
      if (gateResult.passed) {
        session.buildGateResults[task.id] = { passed: true, timestamp };
        buildGateFixCounts.delete(task.id);
        persistBuildGateFixState();
      } else {
        session.buildGateResults[task.id] = {
          passed: false,
          failedCommand: gateResult.failedCommand,
          output: gateResult.output,
          timestamp,
        };

        if (gateResult.failureKind === "infra_failed") {
          const detail = makeBuildGateFailurePrompt(gateResult.failedCommand, gateResult.output);
          task.status = "blocked";
          task.blockedReason = "task_failed";
          task.blockedQuestion = `Build gate infrastructure failed.\n${detail}`;
          task.failedDetail = {
            whatTried: detail,
            errorType: "build_gate_infra_failed",
            suggestedNext:
              "Fix SAST/build-gate infrastructure (for example semgrep network/auth/timeouts), then retry the step.",
            needsRevert: false,
          };
        } else {
          const fixCount = (buildGateFixCounts.get(task.id) ?? 0) + 1;
          buildGateFixCounts.set(task.id, fixCount);
          persistBuildGateFixState();

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
            const reset = resetToTaskBaseSha(
              workingDir,
              session.taskCheckpoints?.[task.id]?.baseSha,
            );
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
              task.status = "pending";
              task.blockedReason = undefined;
              task.blockedQuestion = undefined;
              task.failedDetail = undefined;
              task.taskSummary = undefined;
            }
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
        step.status = "blocked";
        step.blockedReason = globalBlock.kind;
        step.blockedQuestion = globalBlock.message;
      }
      globalBlockApplied = true;
    }

    if (stopAllTasks) break;
  }

  const allDone = orderedSteps.every((s) => s.status === "done");
  const finalGateCommands =
    plan.buildGate?.commands?.map((cmd) => cmd.trim()).filter(Boolean) ?? [];
  if (allDone && semgrepMode === "goal") {
    const finalSastCommand = buildDefaultSastCommand({ workingDir });
    if (finalSastCommand) {
      finalGateCommands.unshift(finalSastCommand);
      onProgress?.("  [sast] Running semgrep scan...");
    }
  }
  if (allDone && finalGateCommands.length > 0) {
    const finalGateResult = runBuildGateCommands(finalGateCommands, workingDir);
    const timestamp = new Date().toISOString();
    if (finalGateResult.passed) {
      session.buildGateResults["__final__"] = { passed: true, timestamp };
    } else {
      session.buildGateResults["__final__"] = {
        passed: false,
        failedCommand: finalGateResult.failedCommand,
        output: finalGateResult.output,
        timestamp,
      };
      const detail = makeBuildGateFailurePrompt(
        finalGateResult.failedCommand,
        finalGateResult.output,
      );
      finalBuildGateFailurePrompt = `Final build gate failed.\n${detail}`;
      session.lastError = `Final build gate failed on ${finalGateResult.failedCommand}.`;
    }
  }

  if (allDone && !finalBuildGateFailurePrompt) {
    session.state = "done";
    let postExecutionReviewNote: string | undefined;
    const shouldRunPostExecutionReview = plan.buildGate?.postExecutionReview !== false;
    const reviewBaseSha = resolvePostExecutionReviewBaseSha(plan.steps, session.taskCheckpoints);

    if (!shouldRunPostExecutionReview) {
      postExecutionReviewNote =
        "Post-execution review skipped: disabled by buildGate.postExecutionReview.";
    } else if (!reviewBaseSha) {
      postExecutionReviewNote = "Post-execution review skipped: no base SHA available.";
    } else {
      let reviewDiff: string | undefined;
      try {
        reviewDiff = execFileSync("git", ["-C", workingDir, "diff", `${reviewBaseSha}...HEAD`], {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          timeout: 15_000,
        });
      } catch (error) {
        postExecutionReviewNote = `Post-execution review skipped: failed to collect diff (${truncateSingleLine(formatExecError(error))}).`;
      }

      if (reviewDiff !== undefined) {
        onProgress?.("  [review] Running post-execution code review...");
        const initialReview = await runPostExecutionReview({
          goal: session.goal,
          steps: orderedSteps,
          diff: reviewDiff,
          workingDir,
          claudeCodeAuth,
          abortSignal: effectiveAbort,
        });

        if (initialReview.status === "error") {
          postExecutionReviewNote = `Post-execution review skipped: ${initialReview.reason}.`;
        } else if (initialReview.status === "approved") {
          postExecutionReviewNote = "Approved.";
        } else {
          const actionableIssues = initialReview.issues;
          if (actionableIssues.length === 0) {
            postExecutionReviewNote =
              "Issues found, but reviewer did not provide actionable issue details.";
          } else {
            onProgress?.(
              `  [review] Found ${actionableIssues.length} issue${actionableIssues.length === 1 ? "" : "s"}; running system-polish step.`,
            );

            const dependsOn = orderedSteps
              .filter((step) => step.status === "done")
              .map((step) => step.id);
            const polishDescription = [
              "Address post-execution review issues:",
              ...actionableIssues.map((issue, index) => `${index + 1}. ${issue}`),
            ].join("\n");
            const existingPolishStep = plan.steps.find((step) => step.id === "system-polish");
            const polishStep: PlanStep =
              existingPolishStep ??
              ({
                id: "system-polish",
                description: polishDescription,
                shortSummary: "Apply review polish",
                dependsOn,
                successCriteria: "All review issues addressed",
                constraints: ["No ralph; address the review issues directly in this attempt."],
                status: "pending",
                durationMinutes: 20,
              } satisfies PlanStep);
            if (!existingPolishStep) {
              plan.steps.push(polishStep);
              orderedSteps.push(polishStep);
            } else {
              existingPolishStep.description = polishDescription;
              existingPolishStep.shortSummary = "Apply review polish";
              existingPolishStep.dependsOn = dependsOn;
              existingPolishStep.successCriteria = "All review issues addressed";
              existingPolishStep.constraints = [
                "No ralph; address the review issues directly in this attempt.",
              ];
              existingPolishStep.status = "pending";
              existingPolishStep.turnsUsed = 0;
              existingPolishStep.taskSummary = undefined;
              existingPolishStep.blockedReason = undefined;
              existingPolishStep.blockedQuestion = undefined;
              existingPolishStep.failedDetail = undefined;
              existingPolishStep.ralphDetail = undefined;
            }

            const polishBackend = clampBackendForEnabledWorkers(
              resolveBackendForStep(polishStep, backendOverride, defaultBackend),
              resolvedEnabledWorkers,
            );
            if (polishStep.executedBackend !== polishBackend) {
              polishStep.executedBackend = polishBackend;
            }
            const polishRunner = polishBackend === "pi" ? piRunner : cliRunners[polishBackend];
            let polishAttempted = false;
            if (!polishRunner) {
              postExecutionReviewNote =
                "Issues found. System polish skipped because no compatible backend was available.";
            } else {
              polishAttempted = true;
              const polishStartMs = Date.now();
              const polishWorkerDir = resolveWorkerDir(runId, polishStep.id);
              const completedSummaries = orderedSteps
                .filter((step) => step.status === "done" && step.taskSummary)
                .map((step) => ({ id: step.id, summary: step.taskSummary! }));
              const polishContext: TaskRunnerContext = {
                task: polishStep,
                plan,
                goal: session.goal,
                workingDir,
                runId,
                denyPolicy: HARD_DENIES,
                completedSummaries,
                attemptBundles: loadAttemptBundles(polishWorkerDir),
                onProgress,
                abortSignal: effectiveAbort,
                timeoutMs: resolveTaskTimeoutMs(polishStep.durationMinutes, timeoutMs),
              };

              polishStep.status = "in_progress";
              onTaskStart?.(polishStep.id);
              onProgress?.(
                `\n--- Task ${polishStep.id} [${polishBackend}]: ${polishStep.description} ---`,
              );
              const polishResult = await polishRunner.execute(polishContext);
              let polishCompleted = false;
              let polishTaskFailed = false;
              if (polishResult.status === "ralph") {
                polishStep.turnsUsed = polishResult.turnsUsed;
                polishStep.status = "blocked";
                polishStep.blockedReason = "task_failed";
                polishStep.blockedQuestion =
                  "system-polish returned ralph, and additional polish cycles are disabled.";
                polishStep.failedDetail = {
                  whatTried:
                    polishResult.ralphDetail?.approachTried ?? "system-polish returned ralph.",
                  errorType: "system_polish_ralph",
                  suggestedNext: "Proceeding without additional polish attempts.",
                  needsRevert: false,
                };
                polishStep.taskSummary = undefined;
                polishStep.ralphDetail = undefined;
                onProgress?.(
                  "  [warn] system-polish returned ralph; continuing without additional polish cycles.",
                );
                polishTaskFailed = true;
              } else {
                applyTaskResult(polishStep, polishResult, onProgress);
                polishCompleted = polishResult.status === "complete";
                polishTaskFailed = polishStep.blockedReason === "task_failed";
              }
              recordTaskResult(session, polishStep, polishStartMs, onTaskUpdate);
              if (polishCompleted) {
                appendGoalWorkingEntry(
                  runId,
                  polishStep.id,
                  "done",
                  polishStep.taskSummary ?? "Completed.",
                );
              } else if (polishTaskFailed) {
                appendGoalWorkingEntry(
                  runId,
                  polishStep.id,
                  "failed",
                  polishStep.failedDetail?.whatTried ?? polishStep.blockedQuestion ?? "Failed.",
                );
              }

              let postPolishDiff = reviewDiff;
              try {
                postPolishDiff = execFileSync(
                  "git",
                  ["-C", workingDir, "diff", `${reviewBaseSha}...HEAD`],
                  {
                    encoding: "utf8",
                    maxBuffer: 64 * 1024 * 1024,
                    timeout: 15_000,
                  },
                );
              } catch (error) {
                onProgress?.(
                  `  [warn] Post-polish diff collection failed: ${truncateSingleLine(formatExecError(error))}`,
                );
              }

              const postPolishReview = await runPostExecutionReview({
                goal: session.goal,
                steps: orderedSteps,
                diff: postPolishDiff,
                workingDir,
                claudeCodeAuth,
                abortSignal: effectiveAbort,
              });
              if (postPolishReview.status === "approved") {
                postExecutionReviewNote = "Approved after system-polish.";
              } else {
                const remainingIssues =
                  postPolishReview.status === "rejected" && postPolishReview.issues.length > 0
                    ? postPolishReview.issues
                    : actionableIssues;
                const issueLines = remainingIssues.map((issue) => `- ${issue}`).join("\n");
                const suffix =
                  postPolishReview.status === "error"
                    ? `\nReview rerun failed after polish: ${postPolishReview.reason}.`
                    : "";
                postExecutionReviewNote = [
                  "Issues found after review.",
                  polishAttempted ? "System-polish executed once." : "",
                  "Remaining issues:",
                  issueLines,
                  suffix,
                ]
                  .filter(Boolean)
                  .join("\n");
              }
            }
          }
        }
      }
    }

    let prUrl: string | undefined;
    const githubPushConfig = config?.goal?.githubPush;
    if (gitCheckpointConfig?.enabled && githubPushConfig?.enabled) {
      let isPrivateRepo = false;
      try {
        isPrivateRepo = isRepoPrivate(workingDir);
      } catch (error) {
        onProgress?.(
          `  [warn] GitHub push skipped: failed to verify repository privacy (${formatExecError(error)})`,
        );
      }

      if (!isPrivateRepo) {
        onProgress?.("  [warn] GitHub push skipped: working repository is not private.");
      } else {
        const remote = githubPushConfig.remote ?? "origin";
        const pushResult = pushRunBranch(workingDir, runId, remote, runBranchName);
        if (!pushResult.success) {
          onProgress?.(`  [warn] GitHub push failed: ${pushResult.error}`);
        } else {
          onProgress?.(`  [git] Run branch pushed to ${remote} (${pushResult.sha.slice(0, 7)})`);
          if (githubPushConfig.createPr ?? true) {
            const baseBranch = githubPushConfig.baseBranch ?? "main";
            const pullRequestResult = createRunPullRequest(
              workingDir,
              runId,
              session.goal,
              baseBranch,
              runBranchName,
            );
            if (pullRequestResult.ok) {
              prUrl = pullRequestResult.prUrl;
              onProgress?.(`  [git] Pull request created: ${pullRequestResult.prUrl}`);
            } else {
              onProgress?.(`  [warn] GitHub PR creation failed: ${pullRequestResult.error}`);
            }
          }
        }
      }
    }

    try {
      const existingLessons = getLessonsForContext(workingDir);
      const extractedLessons = await extractRunLessons(runId, workingDir, existingLessons);
      if (extractedLessons.length > 0) {
        onProgress?.(
          `  [lessons] Recorded ${extractedLessons.length} lesson${extractedLessons.length === 1 ? "" : "s"}.`,
        );
      }
    } catch {
      // Fail-open: lesson extraction should never block completion.
    }

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
    const baseSummary = buildGoalSummary({
      goal: session.goal,
      goalHeadline: plan.shortSummary,
      runId,
      steps: orderedSteps,
      maxTurnsPerTask,
      manualTests,
      channel: params.channel,
    });
    const summary = postExecutionReviewNote
      ? `${baseSummary}\n\n**Post-Execution Review**\n${postExecutionReviewNote}`
      : baseSummary;
    if (onStatusChange) {
      await onStatusChange({
        type: "all_done",
        steps: [...orderedSteps],
        summary,
        ...(prUrl ? { prUrl } : {}),
        ...(manualTests !== undefined ? { manualTests } : {}),
        ...(manualTestsError ? { manualTestsError } : {}),
      });
    }
    return { status: "done", summary };
  }

  const aggregated =
    (finalBuildGateFailurePrompt
      ? ({
          blockedAt: "execution",
          prompt: finalBuildGateFailurePrompt,
          requiredInputKey: "none",
        } as const)
      : aggregateBlockedDetails(orderedSteps)) ??
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
  const stepMap = new Map(steps.map((step) => [step.id, step]));
  return steps.filter((step) => {
    const depsReady = step.dependsOn.every((depId) => {
      const dep = stepMap.get(depId);
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
