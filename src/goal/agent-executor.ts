import { execFileSync } from "node:child_process";
import fs from "node:fs";
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
  computeTransientBackoffMs,
  isBackendDevGatewayControlCapable,
  isBackendNetworkCapable,
  MAX_TRANSIENT_RETRY_ATTEMPTS,
  pickFallbackBackend,
  pickNextTask,
  recordTaskResult,
  resolveBackendForStep,
  shouldRetry,
  type FallbackBackendReason,
  type PickFallbackBackendResult,
} from "./agent-executor-helpers.js";
import { aggregateBlockedDetails } from "./blocked.js";
import {
  classifyUsageLimit,
  isTransientOverloadText,
  isUsageLimitClassReason,
  type UsageLimitClassReason,
} from "./error-patterns.js";
import {
  formatUsageLimitExhaustedMessage,
  formatUsageLimitFallbackMessage,
  formatUsageLimitRecoveryMessage,
  type UsageLimitEvent,
  type UsageLimitKind,
} from "./usage-limit-message.js";
import { detectBackendAvailability, isBackendAvailable } from "./backend-availability.js";
import { resolveEnabledWorkers, type GoalBackendId } from "./backend-types.js";
import { resolveDefaultSemgrepMode } from "./effective-workers.js";
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
import { buildDevWorkspaceHardDenies, HARD_DENIES } from "./hard-deny.js";
import { resolveDevGatewayWorkerContext } from "./dev-gateway-workspace.js";
import {
  autosaveIfDirty,
  buildGitHubBranchUrl,
  buildRunBranchName,
  canRunGit,
  ensureRunBranch,
  finalizeTaskCheckpoint,
  isGitRepo,
  isWorkingTreeClean,
  pushRunBranch,
  resolveRunBranchNameForResume,
  startTaskCheckpoint,
} from "./git-checkpoint.js";
import { isRepoPrivate } from "./git-privacy.js";
import { extractGoalBriefSection, loadGoalBriefContent } from "./goal-brief.js";
import { orderStepsCriticalPathFirst, computeCriticalPathScores } from "./plan-order.js";
import { extractRunLessons, getLessonsForContext } from "./lessons.js";
import { PiTaskRunner } from "./pi-runner.js";
import {
  appendGoalWorkingEntry,
  appendRalphContext,
  appendRetryContext,
  buildRalphHistorySummary,
} from "./run-journal.js";
import { buildContinuationProposal, type ContinuationAssessment } from "./continuation.js";
import { buildFallbackManualTestsForSteps, generateManualTests } from "./manual-tests.js";
import {
  renderPostExecutionReportMarkdown,
  resolvePostExecutionReportArtifactPaths,
  runPostExecutionReporting,
  type PostExecutionContinuationDecision,
  type PostExecutionDecision,
  type PostExecutionManualTestDisplay,
  type PostExecutionManualTest,
  type PostExecutionReport,
  type PostExecutionReportingFailure,
  type RunPostExecutionReportingResult,
} from "./post-execution-report.js";
import { loadRun, resolveRunDir } from "./run-store.js";
import type {
  ContinuationProposal,
  ContinuationProposalDecision,
  GitCheckpointConfig,
  GithubPushOutcome,
  GoalLlmClient,
  GoalOutcome,
  GoalSession,
  ManualTestSuggestion,
  Plan,
  PlanStep,
  BlockedDetail,
  RetryConfig,
  SerializedRun,
  TaskExecutionResult,
  WorkerSummaryReference,
} from "./types.js";
import type { TaskRunner, TaskRunnerContext, TaskRunnerResult } from "./task-runner.js";
import { assertGoalWorkerWorkspace } from "./workspace-policy.js";
import { appendAgentHistoryEventBestEffort } from "./agent-history-events.js";
import { workspaceNameFromWorkingDir } from "./agent-history.js";
import { mirrorGoalRuntimeToAgentHistory } from "./runtime-mirror.js";
import {
  computeChildlessSummaries,
  deleteWorkerSummaryFile,
  removeWorkerSummaryReference,
  writeWorkerSummary,
} from "./worker-summary.js";

const DEFAULT_MAX_TURNS_PER_TASK = 5;
const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes per prompt
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_MAX_RALPH_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_POST_EXECUTION_MANUAL_TEST_LIMIT = 5;
const DEFAULT_BACKEND: CliWorkerId = "claude_code";
const DEFAULT_MAX_BUILD_GATE_FIX_CYCLES = 2;

const MIN_TASK_TIMEOUT_MS = 10 * 60_000;
const MAX_TASK_TIMEOUT_MS = 2 * 60 * 60_000;

const PI_RETRYABLE: PlanStep["blockedReason"][] = ["timeout", "network", "rate_limit"];
// Only auth is fatal/global-stop. Usage-limit-class reasons (out_of_credits,
// usage_limit, rate_limit) fall back per-task and never globally interrupt the
// goal while other runnable work remains; they stay retryable on resume.
const FATAL_ERRORS: PlanStep["blockedReason"][] = ["auth"];

type NoFallbackReason = FallbackBackendReason | "fallback_already_attempted";

function describeNoFallbackReason(
  backend: CliWorkerId,
  reason: NoFallbackReason | undefined,
  detail: string | undefined,
  maxAttemptsReached: boolean,
): string {
  if (maxAttemptsReached) return "the retry attempt budget is exhausted";
  switch (reason) {
    case "backend_override":
      return `the run is constrained to backend '${detail ?? backend}'`;
    case "single_backend_constraint":
      return "the run is constrained to a single enabled worker";
    case "fallback_not_enabled":
      return `fallback backend '${detail ?? "the alternate worker"}' is not enabled`;
    case "fallback_unavailable":
      return detail ?? "the fallback backend is not available on PATH";
    case "fallback_already_attempted":
      return "the fallback backend already hit a usage or rate limit";
    case "not_usage_or_rate_limit":
    case undefined:
      return "no eligible fallback backend is available";
  }
}

function formatNoFallbackBlockedMessage(
  backend: CliWorkerId,
  events: UsageLimitEvent[],
  reason: NoFallbackReason | undefined,
  detail: string | undefined,
  maxAttemptsReached: boolean,
  originalQuestion: string,
): string {
  return formatUsageLimitExhaustedMessage({
    events,
    noFallbackReason: describeNoFallbackReason(backend, reason, detail, maxAttemptsReached),
    originalQuestion,
  });
}

function formatTechnicalBlockedQuestion(message: string, attempts: AttemptBundle[]): string {
  const trimmedMessage = message.trim() || "Worker failed/interrupted; resume needed.";
  if (trimmedMessage.includes("Attempt history:") || attempts.length === 0) return trimmedMessage;

  const attemptLines = attempts.slice(-3).map((attempt) => {
    const classification = attempt.errorClassification ? ` (${attempt.errorClassification})` : "";
    return `- Attempt ${attempt.attemptNumber} [${attempt.backend}]: ${attempt.outcome}${classification}`;
  });
  return `${trimmedMessage}\n\nAttempt history:\n${attemptLines.join("\n")}`;
}

function normalizedBuildGateCommands(plan: Plan): string[] {
  return plan.buildGate?.commands?.map((cmd) => cmd.trim()).filter(Boolean) ?? [];
}

function upsertWorkerSummary(
  session: GoalSession,
  summary: WorkerSummaryReference,
): WorkerSummaryReference[] {
  const current = session.workerSummaries ?? [];
  session.workerSummaries = [...current.filter((entry) => entry.id !== summary.id), summary];
  return session.workerSummaries;
}

function discardWorkerSummary(params: {
  session: GoalSession;
  runId: string;
  workingDir: string;
  historyWorkspaceSlug?: string;
  goalBriefPath?: string;
  stepId: string;
}): void {
  const before = params.session.workerSummaries ?? [];
  if (before.some((summary) => summary.id === params.stepId)) {
    params.session.workerSummaries = removeWorkerSummaryReference(before, params.stepId);
  }
  deleteWorkerSummaryFile({
    runId: params.runId,
    workingDir: params.workingDir,
    ...(params.historyWorkspaceSlug ? { historyWorkspaceSlug: params.historyWorkspaceSlug } : {}),
    goalBriefPath: params.goalBriefPath,
    stepId: params.stepId,
  });
}

function shouldMintWorkerSummaryAfterStep(params: {
  plan: Plan;
  session: GoalSession;
  task: PlanStep;
}): boolean {
  if (params.task.status !== "done") return false;
  const gateCommands = normalizedBuildGateCommands(params.plan);
  if (gateCommands.length === 0) return true;
  if (params.plan.buildGate?.runBetweenSteps === true) {
    return params.session.buildGateResults?.[params.task.id]?.passed === true;
  }
  return false;
}

function writeVerifiedWorkerSummary(params: {
  session: GoalSession;
  runId: string;
  workingDir: string;
  historyWorkspaceSlug?: string;
  goalBriefPath?: string;
  plan: Plan;
  task: PlanStep;
  usedSummaries: WorkerSummaryReference[];
  buildGateCommands?: string[];
  buildGateTimestamp?: string;
  onProgress?: (text: string) => void;
}): WorkerSummaryReference {
  const summary = writeWorkerSummary({
    runId: params.runId,
    workingDir: params.workingDir,
    ...(params.historyWorkspaceSlug ? { historyWorkspaceSlug: params.historyWorkspaceSlug } : {}),
    goalBriefPath: params.goalBriefPath,
    step: params.task,
    plan: params.plan,
    taskSummary: params.task.taskSummary,
    usedSummaries: params.usedSummaries,
    buildGateCommands: params.buildGateCommands,
    buildGateTimestamp: params.buildGateTimestamp,
  });
  upsertWorkerSummary(params.session, summary);
  params.onProgress?.(`  [wiki] Worker Summary: ${summary.path}`);
  return summary;
}

function appendWorkerFallbackHistoryEvent(params: {
  workingDir: string;
  runId: string;
  stepId: string;
  attemptNumber: number;
  backend: CliWorkerId;
  event: string;
  status: string;
  errorClass?: string;
  fallbackBackend?: CliWorkerId;
  fallbackReason?: string;
  onProgress?: (text: string) => void;
  historyWorkspaceSlug?: string;
}): void {
  const result = appendAgentHistoryEventBestEffort(
    {
      kind: "goal",
      workspaceName: params.historyWorkspaceSlug ?? workspaceNameFromWorkingDir(params.workingDir),
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
      errorClass: params.errorClass,
      fallbackBackend: params.fallbackBackend,
      fallbackReason: params.fallbackReason,
    },
  );
  if (!result.ok) {
    params.onProgress?.(`  [warn] ${result.warning}`);
  }
}

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

export type ManualTestsStatus =
  | "generated"
  | "skipped_no_backend"
  | "skipped_no_embedded_auth"
  | "failed";

export type GoalStatusChangeEvent =
  | { type: "step_blocked"; stepId: string; question: string; steps: PlanStep[] }
  | { type: "fully_blocked"; steps: PlanStep[] }
  | { type: "plan_revised"; revision: number; summary: string; steps: PlanStep[] }
  | {
      type: "post_execution_reporting_failed";
      steps: PlanStep[];
      summary: string;
      reason: string;
      phase: PostExecutionReportingFailure["phase"];
    }
  | {
      type: "all_done";
      steps: PlanStep[];
      summary: string;
      reviewUrl?: string;
      manualTests?: ManualTestSuggestion[];
      manualTestsError?: string;
      manualTestsStatus?: ManualTestsStatus;
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
  /** Called before the final runtime mirror so persisted run.json reflects terminal state. */
  onRunStatePersist?: () => void | Promise<void>;
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

export type ResumePostExecutionReportingParams = Pick<
  ExecuteGoalParams,
  | "session"
  | "runId"
  | "workingDir"
  | "config"
  | "enabledWorkers"
  | "model"
  | "claudeCodeAuth"
  | "channel"
  | "serializedRun"
  | "onRunStatePersist"
  | "onProgress"
  | "onStatusChange"
>;

type PostExecutionLifecycleResult =
  | {
      status: "success";
      summary: string;
      manualTests: ManualTestSuggestion[];
    }
  | {
      status: "failed";
      summary: string;
      failure: PostExecutionReportingFailure;
    };

type SuccessfulPostExecutionReportingResult = Extract<
  RunPostExecutionReportingResult,
  { status: "success" }
>;

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function bestEffortReportLifecycleFailure(params: {
  session: GoalSession;
  steps: PlanStep[];
  summary: string;
  error: unknown;
  onRunStatePersist?: () => void | Promise<void>;
  onStatusChange?: ExecuteGoalParams["onStatusChange"];
  onProgress?: (message: string) => void;
}): Promise<PostExecutionLifecycleResult> {
  const errorText = unknownErrorMessage(params.error);
  const reason =
    params.session.postExecutionReportingFailureReason ??
    `Post-execution reporting failed after plan completion: ${errorText}`;

  params.session.state = "reporting_failed";
  params.session.blocked = null;
  params.session.lastError = undefined;
  params.session.pendingContinuation = undefined;
  params.session.postExecutionReportingFailureReason = reason;

  try {
    await params.onRunStatePersist?.();
  } catch (persistError) {
    params.onProgress?.(
      `  [warn] Failed to persist post-execution reporting failure: ${unknownErrorMessage(
        persistError,
      )}`,
    );
  }

  try {
    await params.onStatusChange?.({
      type: "post_execution_reporting_failed",
      steps: params.steps,
      summary: params.summary,
      reason,
      phase: "generateReport",
    });
  } catch (statusError) {
    params.onProgress?.(
      `  [warn] Failed to emit post-execution reporting failure status: ${unknownErrorMessage(
        statusError,
      )}`,
    );
  }

  return {
    status: "failed",
    summary: params.summary,
    failure: {
      status: "failed",
      phase: "generateReport",
      reason,
      usageLimitEvents: [],
      lastErrorText: errorText,
    },
  };
}

function normalizePostExecutionText(value: string | null | undefined): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  return text || undefined;
}

function mapPostExecutionManualTests(
  tests: readonly PostExecutionManualTest[],
): ManualTestSuggestion[] {
  return tests.map((test) => ({
    description: test.description,
    criticality: test.criticality,
    ...(test.reason ? { reason: test.reason } : {}),
    detail: test.detail,
  }));
}

function buildManualTestDisplayFromSuggestions(
  tests: readonly ManualTestSuggestion[],
): PostExecutionManualTestDisplay {
  return {
    manualTests: tests.map((test) => ({
      description: test.description,
      criticality: test.criticality,
      ...(test.reason ? { reason: test.reason } : {}),
      detail: test.detail,
    })),
    displayMarkdown:
      tests.length === 0
        ? "No manual tests are needed."
        : tests
            .map((test, index) =>
              [
                `${index + 1}. ${test.description} (criticality ${test.criticality}/10)`,
                test.reason ? `   - Why: ${test.reason}` : undefined,
                `   - Steps: ${test.detail}`,
              ]
                .filter((line): line is string => Boolean(line))
                .join("\n"),
            )
            .join("\n"),
  };
}

function buildFallbackManualTestDisplay(
  steps: readonly PlanStep[],
): PostExecutionManualTestDisplay {
  return buildManualTestDisplayFromSuggestions(
    buildFallbackManualTestsForSteps(steps, {
      maxTests: DEFAULT_POST_EXECUTION_MANUAL_TEST_LIMIT,
    }),
  );
}

async function buildLifecycleManualTestDisplay(params: {
  goal: string;
  steps: readonly PlanStep[];
  runId: string;
  workingDir: string;
  client?: GoalLlmClient;
  existingDisplay?: PostExecutionManualTestDisplay;
  onProgress?: (message: string) => void;
}): Promise<PostExecutionManualTestDisplay> {
  const fallbackDisplay = buildFallbackManualTestDisplay(params.steps);
  if (!params.client) {
    return params.existingDisplay?.manualTests.length ? params.existingDisplay : fallbackDisplay;
  }

  try {
    const generated = await generateManualTests({
      goal: params.goal,
      steps: [...params.steps],
      client: params.client,
      minTests: fallbackDisplay.manualTests.length > 0 ? 1 : 0,
      maxTests: DEFAULT_POST_EXECUTION_MANUAL_TEST_LIMIT,
      runId: params.runId,
      workingDir: params.workingDir,
    });
    if (generated.tests.length > 0) {
      return buildManualTestDisplayFromSuggestions(generated.tests);
    }
  } catch (error) {
    params.onProgress?.(
      `  [warn] Bounded manual-test generation failed; using deterministic fallback: ${unknownErrorMessage(
        error,
      )}`,
    );
  }

  return fallbackDisplay.manualTests.length > 0
    ? fallbackDisplay
    : (params.existingDisplay ?? fallbackDisplay);
}

function mapPostExecutionDecision(
  decision: PostExecutionDecision,
): ContinuationProposalDecision | undefined {
  const question = normalizePostExecutionText(decision.question);
  const options = decision.options.map((option) => option.trim()).filter(Boolean);
  if (!question || options.length === 0) return undefined;

  const recommendedOption =
    normalizePostExecutionText(decision.recommendedOption ?? undefined) ?? options[0]!;
  const rationale =
    normalizePostExecutionText(decision.rationale) ?? "Recommended by the post-execution report.";
  const promptImpact = normalizePostExecutionText(decision.promptImpact);
  return {
    question,
    options,
    recommendedOption,
    rationale,
    ...(promptImpact ? { promptImpact } : {}),
  };
}

type DegradedRemainingWorkEvidence = {
  summary: string;
  nextPlanPrompt: string;
};

function normalizeDegradedRemainingText(value: string | undefined, maxLength = 700): string {
  const text = value?.replace(/\s+/g, " ").trim() ?? "";
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength - 3).trimEnd()}...` : text;
}

function isActionableDegradedRemainingText(value: string | undefined): value is string {
  const text = normalizeDegradedRemainingText(value, 1_000);
  if (!text) return false;
  if (
    /^(?:none|n\/a|not applicable|complete|completed)\.?$/i.test(text) ||
    /\b(?:no|nothing)\b.{0,40}\b(?:remaining|left|unfinished|incomplete|to do|todo|work)\b/i.test(
      text,
    ) ||
    /\b(?:goal|work|task)\b.{0,40}\b(?:is|was|appears|looks)\b.{0,20}\b(?:complete|completed|done)\b/i.test(
      text,
    )
  ) {
    return false;
  }
  return true;
}

function buildDegradedNextPlanPrompt(params: { runId: string; summary: string }): string {
  return [
    `Create the next plan under the same Goal ID (${params.runId}) to complete the remaining original-goal work.`,
    `Remaining work: ${params.summary}`,
    "Do not redo completed plan steps. Use the Goal Brief, current plan context, and saved artifacts as the source of truth.",
  ].join("\n");
}

function collectGoalBriefDegradedRemainingWork(params: {
  runId: string;
  workingDir: string;
  historyWorkspaceSlug?: string;
  serializedRun?: SerializedRun;
}): DegradedRemainingWorkEvidence | undefined {
  const brief = loadGoalBriefContent({
    runId: params.runId,
    workingDir: params.workingDir,
    ...(params.serializedRun?.goalBriefPath
      ? { goalBriefPath: params.serializedRun.goalBriefPath }
      : {}),
    ...(params.historyWorkspaceSlug ? { historyWorkspaceSlug: params.historyWorkspaceSlug } : {}),
  });
  if (!brief.ok) return undefined;

  const remainingWork = extractGoalBriefSection(brief.content, ["Remaining Work"]);
  if (!isActionableDegradedRemainingText(remainingWork)) return undefined;

  const observationPoint =
    extractGoalBriefSection(brief.content, ["Next Observation Point", "Observation Point"]) ?? "";
  const summary = normalizeDegradedRemainingText(remainingWork);
  const observation = normalizeDegradedRemainingText(observationPoint, 400);
  return {
    summary,
    nextPlanPrompt: [
      `Create the next plan under the same Goal ID (${params.runId}) to complete the remaining work recorded in the Goal Brief.`,
      `Remaining work: ${summary}`,
      observation ? `Observation point: ${observation}` : "",
      "Do not redo completed plan steps. Do not claim the remaining work is already complete without concrete evidence.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function lineIdentifiesRemainingPlanWork(line: string): boolean {
  const text = normalizeDegradedRemainingText(line, 1_000);
  if (!isActionableDegradedRemainingText(text)) return false;
  return (
    /\bremaining (?:original[- ]goal )?work\b/i.test(text) ||
    /\bstill needs?\b/i.test(text) ||
    /\bunfinished\b/i.test(text) ||
    /\bincomplete\b/i.test(text) ||
    /\bnext plan\b/i.test(text) ||
    /\bstage\s*(?:2|two|3|three|next|later)\b/i.test(text) ||
    /\bleav(?:e|es|ing|ed)\b.{0,100}\b(?:continuation|later|next|stage)\b/i.test(text) ||
    /\bcontinue(?:s|d)?\b.{0,100}\b(?:same goal|after|stage|remaining|with another plan)\b/i.test(
      text,
    )
  );
}

function collectPlanDegradedRemainingWork(params: {
  runId: string;
  goal: string;
  plan: Plan;
}): DegradedRemainingWorkEvidence | undefined {
  const candidates = [
    params.goal,
    params.plan.goal,
    params.plan.summary,
    params.plan.shortSummary,
    ...params.plan.steps.flatMap((step) => [
      step.description,
      step.shortSummary,
      step.taskSummary,
      step.blockedQuestion,
    ]),
  ];
  const matching = candidates
    .map((line) => normalizeDegradedRemainingText(line, 500))
    .filter((line) => lineIdentifiesRemainingPlanWork(line));
  if (matching.length === 0) return undefined;

  const summary = normalizeDegradedRemainingText(matching.slice(0, 3).join(" "), 700);
  return {
    summary,
    nextPlanPrompt: buildDegradedNextPlanPrompt({ runId: params.runId, summary }),
  };
}

function collectDegradedRemainingWork(params: {
  runId: string;
  goal: string;
  plan: Plan;
  workingDir: string;
  historyWorkspaceSlug?: string;
  serializedRun?: SerializedRun;
}): DegradedRemainingWorkEvidence | undefined {
  return (
    collectGoalBriefDegradedRemainingWork(params) ??
    collectPlanDegradedRemainingWork({
      runId: params.runId,
      goal: params.goal,
      plan: params.plan,
    })
  );
}

function buildDegradedPostExecutionReport(params: {
  summary: string;
  failure: PostExecutionReportingFailure;
  manualTests?: readonly PostExecutionManualTest[];
  remainingWork?: DegradedRemainingWorkEvidence;
}): PostExecutionReport {
  return {
    planCompleted: true,
    goalAchieved: false,
    summary: params.summary,
    filesChanged: [],
    verificationCommands: [],
    manualTests: params.manualTests ? [...params.manualTests] : [],
    nextPlanRecommended: Boolean(params.remainingWork),
    nextPlanSummary: params.remainingWork?.summary ?? null,
    nextPlanPrompt: params.remainingWork?.nextPlanPrompt ?? null,
    decisionsNeeded: [],
    failureOrBlockedReason: `Post-execution reporting could not generate a full report during ${params.failure.phase}: ${params.failure.reason}`,
  };
}

function writeFallbackPostExecutionArtifacts(params: {
  runId: string;
  workingDir: string;
  historyWorkspaceSlug?: string;
  report: PostExecutionReport;
}) {
  const artifacts = resolvePostExecutionReportArtifactPaths({
    runId: params.runId,
    workingDir: params.workingDir,
    ...(params.historyWorkspaceSlug ? { historyWorkspaceSlug: params.historyWorkspaceSlug } : {}),
  });
  const markdown = renderPostExecutionReportMarkdown(params.report);
  fs.mkdirSync(artifacts.historyDir, { recursive: true, mode: 0o755 });
  fs.writeFileSync(artifacts.markdownPath, markdown, "utf8");
  fs.chmodSync(artifacts.markdownPath, 0o644);
  fs.writeFileSync(artifacts.jsonPath, `${JSON.stringify(params.report, null, 2)}\n`, "utf8");
  fs.chmodSync(artifacts.jsonPath, 0o644);
  return { artifacts, markdown };
}

function buildDegradedPostExecutionResult(params: {
  runId: string;
  goal: string;
  plan: Plan;
  workingDir: string;
  historyWorkspaceSlug?: string;
  serializedRun?: SerializedRun;
  summary: string;
  failure: PostExecutionReportingFailure;
  backend: CliWorkerId;
}): SuccessfulPostExecutionReportingResult {
  const remainingWork = collectDegradedRemainingWork({
    runId: params.runId,
    goal: params.goal,
    plan: params.plan,
    workingDir: params.workingDir,
    ...(params.historyWorkspaceSlug ? { historyWorkspaceSlug: params.historyWorkspaceSlug } : {}),
    ...(params.serializedRun ? { serializedRun: params.serializedRun } : {}),
  });
  const manualTestDisplay = buildFallbackManualTestDisplay(params.plan.steps);
  const report = buildDegradedPostExecutionReport({
    summary: params.summary,
    failure: params.failure,
    manualTests: manualTestDisplay.manualTests,
    ...(remainingWork ? { remainingWork } : {}),
  });
  const { artifacts, markdown } = writeFallbackPostExecutionArtifacts({
    runId: params.runId,
    workingDir: params.workingDir,
    ...(params.historyWorkspaceSlug ? { historyWorkspaceSlug: params.historyWorkspaceSlug } : {}),
    report,
  });
  const continuation: PostExecutionContinuationDecision = {
    goalAchieved: false,
    nextPlanRecommended: Boolean(remainingWork),
    nextPlanSummary: remainingWork?.summary ?? null,
    nextPlanPrompt: remainingWork?.nextPlanPrompt ?? null,
    decisionsNeeded: [],
    failureOrBlockedReason: report.failureOrBlockedReason,
  };
  return {
    status: "success",
    report,
    markdown,
    artifacts,
    manualTestDisplay,
    continuation,
    backend: params.backend,
  };
}

function buildRunSnapshotForContinuation(params: {
  session: GoalSession;
  runId: string;
  workingDir: string;
  model?: string;
  serializedRun?: SerializedRun;
}): SerializedRun {
  const previous = params.serializedRun;
  const now = new Date().toISOString();
  return {
    runId: params.runId,
    goal: params.session.goal,
    state: params.session.state,
    plan: params.session.plan,
    stepResults: Object.fromEntries(params.session.stepResults),
    blocked: params.session.blocked,
    answers: params.session.answers,
    resumeNotes: params.session.resumeNotes ?? previous?.resumeNotes ?? [],
    lastError: params.session.lastError,
    workingDir: params.workingDir,
    model: params.model ?? previous?.model,
    dryRun: previous?.dryRun ?? false,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    planNumber: previous?.planNumber ?? 1,
    ...(previous?.historyWorkspaceSlug
      ? { historyWorkspaceSlug: previous.historyWorkspaceSlug }
      : {}),
    ...(previous?.goalBriefPath ? { goalBriefPath: previous.goalBriefPath } : {}),
    ...(previous?.planRevision != null ? { planRevision: previous.planRevision } : {}),
    ...(previous?.activePlanRevision != null
      ? { activePlanRevision: previous.activePlanRevision }
      : {}),
  };
}

function buildReportDerivedContinuationProposal(params: {
  session: GoalSession;
  runId: string;
  workingDir: string;
  model?: string;
  serializedRun?: SerializedRun;
  continuation: PostExecutionContinuationDecision;
  fallbackSummary: string;
}): ContinuationProposal {
  const proposedPrompt = normalizePostExecutionText(params.continuation.nextPlanPrompt);
  const briefSummary =
    normalizePostExecutionText(params.continuation.nextPlanSummary) ?? params.fallbackSummary;
  const decisions = params.continuation.decisionsNeeded
    .map(mapPostExecutionDecision)
    .filter((decision): decision is ContinuationProposalDecision => Boolean(decision));
  const assessment: ContinuationAssessment =
    params.continuation.nextPlanRecommended && proposedPrompt
      ? {
          outcome: "continuation-recommended-now",
          goalAchieved: params.continuation.goalAchieved,
          briefSummary,
          proposedPrompt,
          ...(decisions.length > 0 ? { decisions } : {}),
        }
      : {
          outcome: "goal-achieved-no-continuation",
          goalAchieved: true,
          briefSummary,
        };
  const proposal = buildContinuationProposal({
    run: buildRunSnapshotForContinuation(params),
    assessment,
  });
  proposal.goalAchieved = params.continuation.goalAchieved;
  return proposal;
}

function resolveReportingBackend(params: {
  session: GoalSession;
  serializedRun?: SerializedRun;
  enabledWorkers: CliWorkerId[];
}): CliWorkerId {
  const explicit =
    params.session.executionSessionBackend ?? params.serializedRun?.executionSessionBackend;
  if (explicit && params.enabledWorkers.includes(explicit)) return explicit;
  if (params.enabledWorkers.includes(DEFAULT_BACKEND)) return DEFAULT_BACKEND;
  return params.enabledWorkers[0] ?? DEFAULT_BACKEND;
}

async function runPostExecutionLifecycle(
  params: ResumePostExecutionReportingParams & {
    summary: string;
    reviewUrl?: string;
    maxTurnsPerTask?: number;
    manualTestsClient?: GoalLlmClient;
    failOnReportingFailure?: boolean;
  },
): Promise<PostExecutionLifecycleResult> {
  const { session, runId, workingDir, onProgress, onStatusChange } = params;
  const plan = session.plan;
  if (!plan) {
    const failure: PostExecutionReportingFailure = {
      status: "failed",
      phase: "generateReport",
      reason: "Cannot run post-execution reporting without a plan.",
      usageLimitEvents: [],
      lastErrorText: "missing plan",
    };
    return { status: "failed", summary: params.summary, failure };
  }

  const steps = [...plan.steps];
  const enabled = resolveEnabledWorkers(
    params.enabledWorkers ? { enabledWorkers: params.enabledWorkers } : params.config?.goal,
  );
  const backend = resolveReportingBackend({
    session,
    serializedRun: params.serializedRun,
    enabledWorkers: enabled,
  });
  const sessionId = session.executionSessionId ?? params.serializedRun?.executionSessionId;
  const historyWorkspaceSlug =
    params.serializedRun?.historyWorkspaceSlug ?? session.historyWorkspaceSlug;
  const serializedRunForReporting =
    params.serializedRun ??
    (historyWorkspaceSlug
      ? ({
          runId,
          goal: session.goal,
          state: session.state,
          plan,
          stepResults: Object.fromEntries(session.stepResults),
          blocked: session.blocked,
          answers: session.answers,
          workingDir,
          historyWorkspaceSlug,
          model: params.model,
          dryRun: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as SerializedRun)
      : undefined);

  session.state = "reporting";
  session.blocked = null;
  session.lastError = undefined;
  session.postExecutionReportingFailureReason = undefined;
  await params.onRunStatePersist?.();

  let reportingDegraded = false;
  let result: RunPostExecutionReportingResult = await runPostExecutionReporting({
    runId,
    goal: session.goal,
    plan,
    workingDir,
    backend,
    ...(sessionId ? { sessionId } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.claudeCodeAuth ? { claudeCodeAuth: params.claudeCodeAuth } : {}),
    enabledBackends: enabled,
    ...(serializedRunForReporting ? { serializedRun: serializedRunForReporting } : {}),
    workerSummaries: session.workerSummaries ?? [],
    buildGateResults: session.buildGateResults,
    completionSummary: params.summary,
    onProgress,
  });

  if (result.status === "failed") {
    const reportingFailure = result;
    const reason = `Post-execution reporting failed during ${reportingFailure.phase}: ${reportingFailure.reason}`;
    if (params.failOnReportingFailure) {
      session.state = "reporting_failed";
      session.postExecutionReportingFailureReason = reason;
      if (reportingFailure.artifacts) {
        session.postExecutionReportArtifacts = reportingFailure.artifacts;
      }
      await params.onRunStatePersist?.();
      await onStatusChange?.({
        type: "post_execution_reporting_failed",
        steps,
        summary: params.summary,
        reason,
        phase: reportingFailure.phase,
      });
      return { status: "failed", summary: params.summary, failure: reportingFailure };
    }

    try {
      result = buildDegradedPostExecutionResult({
        runId,
        goal: session.goal,
        plan,
        workingDir,
        ...(historyWorkspaceSlug ? { historyWorkspaceSlug } : {}),
        ...(serializedRunForReporting ? { serializedRun: serializedRunForReporting } : {}),
        summary: params.summary,
        failure: reportingFailure,
        backend,
      });
      reportingDegraded = true;
      onProgress?.(`  [warn] ${reason}. Continuing with a degraded post-execution report.`);
    } catch (error) {
      const fallbackReason = error instanceof Error ? error.message : String(error);
      const fallbackFailure: PostExecutionReportingFailure = {
        status: "failed",
        phase: reportingFailure.phase,
        reason: `${reason}; degraded report fallback failed: ${fallbackReason}`,
        usageLimitEvents: reportingFailure.usageLimitEvents,
        lastErrorText: fallbackReason,
        ...(reportingFailure.artifacts ? { artifacts: reportingFailure.artifacts } : {}),
      };
      session.state = "reporting_failed";
      session.postExecutionReportingFailureReason = fallbackFailure.reason;
      if (fallbackFailure.artifacts) {
        session.postExecutionReportArtifacts = fallbackFailure.artifacts;
      }
      await params.onRunStatePersist?.();
      await onStatusChange?.({
        type: "post_execution_reporting_failed",
        steps,
        summary: params.summary,
        reason: fallbackFailure.reason,
        phase: fallbackFailure.phase,
      });
      return { status: "failed", summary: params.summary, failure: fallbackFailure };
    }
  }

  result = {
    ...result,
    manualTestDisplay: await buildLifecycleManualTestDisplay({
      goal: session.goal,
      steps,
      runId,
      workingDir,
      ...(params.manualTestsClient ? { client: params.manualTestsClient } : {}),
      existingDisplay: result.manualTestDisplay,
      onProgress,
    }),
  };

  const manualTests = mapPostExecutionManualTests(result.manualTestDisplay.manualTests);
  const continuation = buildReportDerivedContinuationProposal({
    session,
    runId,
    workingDir,
    model: params.model,
    ...(serializedRunForReporting ? { serializedRun: serializedRunForReporting } : {}),
    continuation: result.continuation,
    fallbackSummary: result.report.summary,
  });
  const summary = buildGoalSummary({
    goal: session.goal,
    goalHeadline: plan.shortSummary,
    runId,
    steps,
    maxTurnsPerTask: params.maxTurnsPerTask ?? DEFAULT_MAX_TURNS_PER_TASK,
    ...(reportingDegraded ? {} : { manualTests }),
    channel: params.channel,
  });

  session.state = "done";
  session.postExecutionReport = result.report;
  session.postExecutionReportArtifacts = result.artifacts;
  session.postExecutionManualTestDisplay = result.manualTestDisplay;
  session.postExecutionContinuation = result.continuation;
  session.postExecutionReportingFailureReason = undefined;
  session.manualTests = manualTests;
  session.manualTestsError = undefined;
  session.pendingContinuation = continuation;
  session.completionSummary = summary;
  session.executionSessionBackend = result.backend;
  if (result.sessionId) session.executionSessionId = result.sessionId;
  await params.onRunStatePersist?.();

  await onStatusChange?.({
    type: "all_done",
    steps,
    summary,
    ...(params.reviewUrl ? { reviewUrl: params.reviewUrl } : {}),
    manualTests,
    manualTestsStatus: "generated",
  });

  return { status: "success", summary, manualTests };
}

export async function resumePostExecutionReporting(
  params: ResumePostExecutionReportingParams,
): Promise<GoalOutcome> {
  if (!params.session.plan) {
    const question = "Cannot resume post-execution reporting: run has no plan.";
    params.session.state = "blocked";
    params.session.blocked = {
      blockedAt: "execution",
      prompt: question,
      requiredInputKey: "resume_post_execution",
    };
    await params.onRunStatePersist?.();
    return {
      status: "blocked",
      question,
      requiredInputKey: "resume_post_execution",
      blockedAt: "execution",
    };
  }
  const summary =
    params.session.completionSummary ??
    buildGoalSummary({
      goal: params.session.goal,
      goalHeadline: params.session.plan.shortSummary,
      runId: params.runId,
      steps: params.session.plan.steps,
      maxTurnsPerTask: DEFAULT_MAX_TURNS_PER_TASK,
      channel: params.channel,
    });
  const result = await runPostExecutionLifecycle({
    ...params,
    summary,
    failOnReportingFailure: true,
  });
  return { status: "done", summary: result.summary };
}

function resolveTaskTimeoutMs(durationMinutes: number | undefined, fallbackMs: number): number {
  if (!durationMinutes || durationMinutes <= 0) return Math.max(fallbackMs, MIN_TASK_TIMEOUT_MS);
  const estimateMs = durationMinutes * 3 * 60_000;
  return Math.max(MIN_TASK_TIMEOUT_MS, Math.min(estimateMs, MAX_TASK_TIMEOUT_MS));
}

function readGitRemoteUrl(workingDir: string, remote: string): string | null {
  try {
    return execFileSync("git", ["-C", workingDir, "remote", "get-url", remote], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
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
  } = params;

  const plan = session.plan;
  if (!plan) throw new Error("No plan to execute");
  const semgrepMode: SemgrepMode = config?.goal?.semgrep ?? resolveDefaultSemgrepMode();
  assertGoalWorkerWorkspace({ workingDir, config: config?.goal, onWarning: onProgress });

  session.state = "executing";
  // Clear stale run-level blocker fields from a prior interruption so a resumed
  // run does not render an old blocker (e.g. a usage-limit message) while it is
  // actively executing. Mirrors the resume command, which already nulls
  // session.blocked before executing. Any genuinely new block sets these again.
  session.blocked = null;
  session.lastError = undefined;
  session.buildGateConfig = plan.buildGate;
  session.stepRalphCounts ??= {};
  session.buildGateFixCounts ??= {};
  session.buildGateFixSignatures ??= {};
  session.buildGateResults ??= {};
  session.workerSummaries ??= params.serializedRun?.workerSummaries ?? [];
  const historyWorkspaceSlug =
    params.serializedRun?.historyWorkspaceSlug ?? session.historyWorkspaceSlug;

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

  const isResume = session.stepResults.size > 0;
  const runBranchName = isResume
    ? resolveRunBranchNameForResume(workingDir, runId, params.serializedRun?.createdAt)
    : buildRunBranchName(runId, params.serializedRun?.createdAt);

  // --- Git setup (branch + autosave) ---
  if (gitCheckpointConfig?.enabled) {
    if (!canRunGit() || !isGitRepo(workingDir)) {
      const msg = "Git checkpoints are enabled but this working directory is not a valid git repo.";
      session.state = "blocked";
      session.blocked = { blockedAt: "execution", prompt: msg, requiredInputKey: "git" };
      return { status: "blocked", question: msg, requiredInputKey: "git", blockedAt: "execution" };
    }

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
  let finalBuildGateBlockedDetail: BlockedDetail | null = null;
  const workerSummariesUsedByStep = new Map<string, WorkerSummaryReference[]>();

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

  // Dev-gateway workspace workers get a dev-aware hard-deny policy (allowing only
  // the dev unit's systemctl/journalctl commands) while stable stays protected.
  // Detection is checkout/cwd-based guidance and never alters runtime config.
  const goalDenyPolicy = resolveDevGatewayWorkerContext({ workingDir, cfg: config?.goal }).active
    ? buildDevWorkspaceHardDenies(HARD_DENIES)
    : HARD_DENIES;

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
    cliRunners.codex = new CliTaskRunner({
      backend: "codex",
      model: params.model,
      goalConfig: config?.goal,
    });
  }
  if (resolvedEnabledWorkers.includes("claude_code")) {
    cliRunners.claude_code = new CliTaskRunner({
      backend: "claude_code",
      model: params.model,
      claudeCodeAuth: params.claudeCodeAuth,
      goalConfig: config?.goal,
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

    const resetInProgressStepIds: string[] = [];
    for (const step of orderedSteps) {
      if (step.status !== "in_progress") continue;
      step.status = "pending";
      resetInProgressStepIds.push(step.id);
    }
    if (resetInProgressStepIds.length > 0) {
      const label = resetInProgressStepIds.length === 1 ? "step" : "steps";
      onProgress?.(
        `  [warn] Reset stuck in_progress ${label} to pending: ${resetInProgressStepIds.join(", ")}`,
      );
    }

    const runnable = findRunnableTasks(orderedSteps, session.answers, retryableBlockedIds);
    if (runnable.length === 0) break;

    const retryableBlockedRunnable = runnable.filter(
      (step) => step.status === "blocked" && retryableBlockedIds.has(step.id),
    );
    const task = pickNextTask(
      retryableBlockedRunnable.length > 0 ? retryableBlockedRunnable : runnable,
      scores,
      orderIndex,
      successors,
      lastExecutedId,
    );

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

    const networkCapable = (candidate: GoalBackendId): boolean =>
      isBackendNetworkCapable(candidate, availability);
    const devGatewayControlCapable = (candidate: GoalBackendId): boolean =>
      isBackendDevGatewayControlCapable(candidate, availability);
    let backend = clampBackendForEnabledWorkers(
      resolveBackendForStep(task, backendOverride, defaultBackend, {
        networkCapable,
        networkCandidates: resolvedEnabledWorkers,
        devGatewayControlCapable,
        devGatewayControlCandidates: resolvedEnabledWorkers,
      }),
      resolvedEnabledWorkers,
    );

    // A network-required step must not run on a backend that cannot enable
    // network. resolveBackendForStep reroutes when a capable backend exists; if
    // none does, block deterministically (capability_blocked) instead of running
    // without network or surfacing a vague retryable process error.
    if (task.requiresNetwork === true && !networkCapable(backend)) {
      const attempted = resolvedEnabledWorkers.filter((candidate) => candidate !== backend);
      const attemptedNote =
        attempted.length > 0
          ? ` No network-capable backend available (also checked: ${attempted.join(", ")}).`
          : " No alternate backend was available to take it over.";
      const msg = `Step requires network but backend '${backend}' cannot enable it.${attemptedNote}`;
      task.status = "blocked";
      task.blockedReason = "capability_blocked";
      task.blockedQuestion = msg;
      onProgress?.(`  [blocked] ${msg}`);
      recordTaskResult(session, task, taskStartMs, onTaskUpdate);
      lastExecutedId = task.id;
      continue;
    }

    if (task.requiresDevGatewayControl === true && !devGatewayControlCapable(backend)) {
      const attempted = resolvedEnabledWorkers.filter((candidate) => candidate !== backend);
      const attemptedNote =
        attempted.length > 0
          ? ` No dev-gateway-control-capable backend available (also checked: ${attempted.join(
              ", ",
            )}).`
          : " No alternate backend was available to take it over.";
      const msg =
        `Step requires mediated dev-gateway control but backend '${backend}' cannot use it.` +
        `${attemptedNote}`;
      task.status = "blocked";
      task.blockedReason = "capability_blocked";
      task.blockedQuestion = msg;
      onProgress?.(`  [blocked] ${msg}`);
      recordTaskResult(session, task, taskStartMs, onTaskUpdate);
      lastExecutedId = task.id;
      continue;
    }

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

    let runner = backend === "pi" ? piRunner : cliRunners[backend];
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
    let fallbackAttempted = false;
    const usageLimitEvents: UsageLimitEvent[] = [];
    // Auto-retries spent on the same transient backend/system failure class
    // (529 overloaded / transient server 5xx). Capped at
    // MAX_TRANSIENT_RETRY_ATTEMPTS so a transient blip stays in a retrying state
    // and never immediately surfaces as a user-facing block. Every path through
    // the body below ends in `continue` (retry) or `break` (terminal), so the
    // loop terminates without relying on a fixed attempt ceiling.
    let transientRetryAttempts = 0;
    // The inner guards (attempt < maxAttempts; transientRetryAttempts budget)
    // decide when to stop; this ceiling just bounds the loop above the larger of
    // the two budgets so transient auto-retries can exceed maxAttempts.
    const attemptCeiling = Math.max(maxAttempts, MAX_TRANSIENT_RETRY_ATTEMPTS);

    for (let attempt = 1; attempt <= attemptCeiling; attempt++) {
      const attemptBundles = loadAttemptBundles(workerDir);

      const completedSummaries = computeChildlessSummaries(plan, session.workerSummaries ?? []);
      workerSummariesUsedByStep.set(task.id, completedSummaries);

      const context: TaskRunnerContext = {
        task,
        plan,
        goal: session.goal,
        workingDir,
        runId,
        ...(historyWorkspaceSlug ? { historyWorkspaceSlug } : {}),
        denyPolicy: goalDenyPolicy,
        completedSummaries,
        resumeAnswer,
        resumeQuestion,
        resumeNotes: session.resumeNotes ?? [],
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

      const result: TaskRunnerResult = await runner.execute(context);
      latestResult = result;
      if (backend !== "pi" && result.executionSessionId) {
        session.executionSessionId = result.executionSessionId;
        session.executionSessionBackend = backend;
      }
      applyTaskResult(task, result, onProgress);
      if (result.status !== "complete") {
        discardWorkerSummary({
          session,
          runId,
          workingDir,
          ...(historyWorkspaceSlug ? { historyWorkspaceSlug } : {}),
          goalBriefPath: params.serializedRun?.goalBriefPath,
          stepId: task.id,
        });
      }

      const latestBundles = loadAttemptBundles(workerDir);
      const isUsageOrRateLimit =
        result.status === "blocked" && isUsageLimitClassReason(result.blockedReason);

      if (isUsageOrRateLimit && backend !== "pi") {
        const limitReason = result.blockedReason as UsageLimitClassReason;
        const limitText = task.blockedQuestion ?? result.question ?? "";

        // A *transient* provider overload (Claude 529 / server 5xx /
        // "overloaded") is not a quota limit: it clears on its own. Auto-retry on
        // the same backend with exponential backoff and keep the run in a
        // retrying state instead of surfacing a user-facing block. Only after the
        // transient retry budget is exhausted do we fall through to the usage
        // limit fallback/paused handling below.
        if (
          isTransientOverloadText(limitText) &&
          transientRetryAttempts < MAX_TRANSIENT_RETRY_ATTEMPTS - 1
        ) {
          transientRetryAttempts += 1;
          const latestAttempt = latestBundles.at(-1);
          if (latestAttempt) {
            appendRetryContext(
              runId,
              task.id,
              formatAttemptBundleSummary(latestAttempt),
              latestAttempt.attemptNumber,
            );
          }
          appendWorkerFallbackHistoryEvent({
            workingDir,
            runId,
            stepId: task.id,
            attemptNumber: attempt + 1,
            backend,
            event: "transient_overload_retry",
            status: "pending",
            errorClass: "transient_overload",
            onProgress,
            ...(historyWorkspaceSlug ? { historyWorkspaceSlug } : {}),
          });
          task.turnsUsed = 0;
          task.status = "pending";
          task.blockedReason = undefined;
          task.blockedQuestion = undefined;
          task.failedDetail = undefined;
          onProgress?.(
            `  [retrying] Transient backend overload; auto-retry ${
              transientRetryAttempts + 1
            }/${MAX_TRANSIENT_RETRY_ATTEMPTS} after backoff.`,
          );
          await new Promise((r) =>
            setTimeout(r, computeTransientBackoffMs(transientRetryAttempts - 1, retryDelayMs)),
          );
          continue;
        }

        // out_of_credits is quota exhaustion; surface it as a usage limit (not a
        // transient rate limit) in user-facing messaging.
        const eventKind: UsageLimitKind =
          limitReason === "rate_limit" ? "rate_limit" : "usage_limit";
        const usageLimitEvent: UsageLimitEvent = {
          kind: eventKind,
          ...classifyUsageLimit({ backend, text: limitText }),
        };
        usageLimitEvents.push(usageLimitEvent);
        appendWorkerFallbackHistoryEvent({
          workingDir,
          runId,
          stepId: task.id,
          attemptNumber: attempt,
          backend,
          event: "usage_limit",
          status: "blocked",
          errorClass: limitReason,
          onProgress,
          ...(historyWorkspaceSlug ? { historyWorkspaceSlug } : {}),
        });
        const fallback:
          | PickFallbackBackendResult
          | { backend: null; reason: NoFallbackReason; detail?: string } = fallbackAttempted
          ? { backend: null, reason: "fallback_already_attempted" as const }
          : pickFallbackBackend(
              backend,
              result,
              resolvedEnabledWorkers,
              availability,
              backendOverride,
              {
                requiresNetwork: task.requiresNetwork === true,
                networkCapable,
                requiresDevGatewayControl: task.requiresDevGatewayControl === true,
                devGatewayControlCapable,
              },
            );

        if (fallback.backend && attempt < maxAttempts) {
          const latestAttempt = latestBundles.at(-1);
          if (latestAttempt) {
            appendRetryContext(
              runId,
              task.id,
              formatAttemptBundleSummary(latestAttempt),
              latestAttempt.attemptNumber,
            );
          }
          fallbackAttempted = true;
          const fallbackBackend = fallback.backend;
          runner = cliRunners[fallbackBackend];
          if (!runner) {
            const msg = `Backend '${fallbackBackend}' is not supported.`;
            task.status = "blocked";
            task.blockedReason = "error";
            task.blockedQuestion = msg;
            break;
          }
          backend = fallbackBackend;
          task.executedBackend = backend;
          task.turnsUsed = 0;
          task.status = "pending";
          task.blockedReason = undefined;
          task.blockedQuestion = undefined;
          task.failedDetail = undefined;
          onProgress?.(
            `  [usage-limit] ${formatUsageLimitFallbackMessage({
              event: usageLimitEvent,
              fallbackBackend,
            })}`,
          );
          appendWorkerFallbackHistoryEvent({
            workingDir,
            runId,
            stepId: task.id,
            attemptNumber: attempt + 1,
            backend: fallbackBackend,
            event: "usage_limit_fallback",
            status: "pending",
            fallbackReason: usageLimitEvent.limitType,
            ...(historyWorkspaceSlug ? { historyWorkspaceSlug } : {}),
            onProgress,
          });
          await new Promise((r) => setTimeout(r, retryDelayMs));
          continue;
        }

        const originalQuestion = task.blockedQuestion ?? result.question ?? "Task blocked.";
        // No compatible fallback backend could run this task. Keep it as a
        // non-fatal, retryable usage-limit block (never fatal out_of_credits/error)
        // so resume can retry it on an available backend and the scheduler keeps
        // draining other runnable work instead of globally interrupting.
        task.status = "blocked";
        task.blockedReason = "usage_limit";
        task.blockedQuestion = formatNoFallbackBlockedMessage(
          backend,
          usageLimitEvents,
          fallback.reason,
          fallback.detail,
          attempt >= maxAttempts,
          originalQuestion,
        );
        break;
      }

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

    // Preserve usage-limit failure history when a fallback backend recovered the
    // task, e.g. "Claude Code hit a usage limit (resets at 3pm). Fell back to
    // Codex. Codex succeeded."
    if (usageLimitEvents.length > 0 && latestResult?.status === "complete" && backend !== "pi") {
      onProgress?.(
        `  [usage-limit] ${formatUsageLimitRecoveryMessage({
          events: usageLimitEvents,
          succeededBackend: backend,
        })}`,
      );
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

    const gateCommands = normalizedBuildGateCommands(plan);
    let verifiedBuildGateCommandsForStep: string[] | undefined;
    let verifiedBuildGateTimestampForStep: string | undefined;
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
        verifiedBuildGateCommandsForStep = commandsForThisStep;
        verifiedBuildGateTimestampForStep = timestamp;
        buildGateFixCounts.delete(task.id);
        persistBuildGateFixState();
      } else {
        discardWorkerSummary({
          session,
          runId,
          workingDir,
          ...(historyWorkspaceSlug ? { historyWorkspaceSlug } : {}),
          goalBriefPath: params.serializedRun?.goalBriefPath,
          stepId: task.id,
        });
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
      onTaskUpdate?.({
        taskId: task.id,
        turnsUsed: task.turnsUsed ?? 0,
        durationMs: Math.max(0, Date.now() - taskStartMs),
        outcome: "blocked",
        summary: task.ralphDetail
          ? "Task reset to pending after ralph; retrying."
          : "Build-gate reset task to pending for retry.",
      });
      lastExecutedId = task.id;
      continue;
    }

    if (shouldMintWorkerSummaryAfterStep({ plan, session, task })) {
      try {
        writeVerifiedWorkerSummary({
          session,
          runId,
          workingDir,
          ...(historyWorkspaceSlug ? { historyWorkspaceSlug } : {}),
          goalBriefPath: params.serializedRun?.goalBriefPath,
          plan,
          task,
          usedSummaries: workerSummariesUsedByStep.get(task.id) ?? [],
          buildGateCommands: verifiedBuildGateCommandsForStep,
          buildGateTimestamp: verifiedBuildGateTimestampForStep,
          onProgress,
        });
      } catch (err) {
        // Worker Summary files are best-effort evidence; a write failure
        // (e.g. an unwritable wiki dir) must never crash goal execution.
        onProgress?.(
          `  [wiki] Worker Summary skipped (write failed): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (task.status === "blocked" && task.blockedReason !== "user_input") {
      task.blockedQuestion = formatTechnicalBlockedQuestion(
        task.blockedQuestion ?? "Worker failed/interrupted; resume needed.",
        loadAttemptBundles(workerDir),
      );
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
    const finalGateSignature = finalGateCommands.join("\n");
    const finalGateResult = runBuildGateCommands(finalGateCommands, workingDir);
    const timestamp = new Date().toISOString();
    if (finalGateResult.passed) {
      session.buildGateResults["__final__"] = { passed: true, timestamp };
      buildGateFixCounts.delete("__final__");
      persistBuildGateFixState();
      if (plan.buildGate?.runBetweenSteps !== true) {
        for (const completedStep of orderedSteps) {
          if (completedStep.status !== "done") continue;
          writeVerifiedWorkerSummary({
            session,
            runId,
            workingDir,
            ...(historyWorkspaceSlug ? { historyWorkspaceSlug } : {}),
            goalBriefPath: params.serializedRun?.goalBriefPath,
            plan,
            task: completedStep,
            usedSummaries: workerSummariesUsedByStep.get(completedStep.id) ?? [],
            buildGateCommands: finalGateCommands,
            buildGateTimestamp: timestamp,
            onProgress,
          });
        }
      }
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
      session.lastError = `Final build gate failed on ${finalGateResult.failedCommand}.`;

      const targetStep =
        orderedSteps.find((step) => step.id === lastExecutedId) ??
        orderedSteps
          .slice()
          .reverse()
          .find((step) => step.status === "done");

      if (!targetStep) {
        finalBuildGateBlockedDetail = {
          blockedAt: "execution",
          prompt: `Final build gate failed, but no completed step could be selected for retry.\n${detail}`,
          requiredInputKey: "resume_execution",
        };
      } else {
        discardWorkerSummary({
          session,
          runId,
          workingDir,
          ...(historyWorkspaceSlug ? { historyWorkspaceSlug } : {}),
          goalBriefPath: params.serializedRun?.goalBriefPath,
          stepId: targetStep.id,
        });
        const targetWorkerDir = resolveWorkerDir(runId, targetStep.id);
        const previousGateSignature = buildGateFixSignatures.get("__final__");
        if (previousGateSignature && previousGateSignature !== finalGateSignature) {
          buildGateFixCounts.delete("__final__");
        }
        buildGateFixSignatures.set("__final__", finalGateSignature);
        const fixCount = (buildGateFixCounts.get("__final__") ?? 0) + 1;
        buildGateFixCounts.set("__final__", fixCount);
        persistBuildGateFixState();

        if (fixCount > DEFAULT_MAX_BUILD_GATE_FIX_CYCLES) {
          const question = `Final build gate failed after ${DEFAULT_MAX_BUILD_GATE_FIX_CYCLES} retry cycles.\n${detail}`;
          targetStep.status = "blocked";
          targetStep.blockedReason = "task_failed";
          targetStep.blockedQuestion = question;
          targetStep.failedDetail = {
            whatTried: detail,
            errorType: "build_gate_failed",
            suggestedNext:
              "Review the build-gate output and provide guidance for the next attempt.",
            needsRevert: false,
          };
          finalBuildGateBlockedDetail = {
            blockedAt: "execution",
            prompt: question,
            requiredInputKey: `task:${targetStep.id}:input`,
            stepId: targetStep.id,
          };
          appendGoalWorkingEntry(
            runId,
            targetStep.id,
            "build-gate",
            `Final build gate failed after ${DEFAULT_MAX_BUILD_GATE_FIX_CYCLES} retry cycles on ${finalGateResult.failedCommand}.`,
          );
        } else {
          const checkpointSha = session.taskCheckpoints?.[targetStep.id]?.baseSha;
          const reset = checkpointSha
            ? resetToTaskBaseSha(workingDir, checkpointSha)
            : ({ success: true } as const);
          if (!reset.success) {
            const question = `Final build gate reset failed: ${reset.error}\n${detail}`;
            targetStep.status = "blocked";
            targetStep.blockedReason = "task_failed";
            targetStep.blockedQuestion = question;
            targetStep.failedDetail = {
              whatTried: detail,
              errorType: "build_gate_reset_failed",
              suggestedNext: "Fix git checkpoint state and retry the task.",
              needsRevert: false,
            };
            finalBuildGateBlockedDetail = {
              blockedAt: "execution",
              prompt: question,
              requiredInputKey: `task:${targetStep.id}:input`,
              stepId: targetStep.id,
            };
          } else {
            const attemptNumber =
              (loadAttemptBundles(targetWorkerDir).at(-1)?.attemptNumber ?? 0) + 1;
            const syntheticBundle: AttemptBundle = {
              attemptNumber,
              backend: targetStep.executedBackend ?? targetStep.backend ?? defaultBackend,
              outcome: "failed",
              errorClassification: "build_gate_failure",
              durationMs: 0,
              buildGateFailure: {
                failedCommand: finalGateResult.failedCommand,
                output: detail,
              },
              logExcerpt: truncateForPrompt(detail),
            };
            writeAttemptBundle(targetWorkerDir, syntheticBundle);
            appendRetryContext(
              runId,
              targetStep.id,
              formatAttemptBundleSummary(syntheticBundle),
              syntheticBundle.attemptNumber,
            );
            appendGoalWorkingEntry(
              runId,
              targetStep.id,
              "build-gate",
              `Final build gate failed (${fixCount}/${DEFAULT_MAX_BUILD_GATE_FIX_CYCLES}) on ${finalGateResult.failedCommand}. ${
                checkpointSha ? "Retrying after reset." : "Retrying target step."
              }`,
            );
            targetStep.status = "pending";
            targetStep.blockedReason = undefined;
            targetStep.blockedQuestion = undefined;
            targetStep.failedDetail = undefined;
            targetStep.taskSummary = undefined;
            lastExecutedId = targetStep.id;
            return executeGoalWithAgent({
              ...params,
              serializedRun: {
                ...params.serializedRun,
                buildGateFixCounts: session.buildGateFixCounts,
                buildGateFixSignatures: session.buildGateFixSignatures,
              } as SerializedRun,
            });
          }
        }
      }
    }
  }

  if (allDone && !finalBuildGateBlockedDetail) {
    session.state = "done";
    // A completed run must carry no blocker. Clear any stale blocker/lastError
    // left over from an interruption earlier in this run so /goal_status and the
    // done message never render a phantom top-level blocker.
    session.blocked = null;
    session.lastError = undefined;

    let reviewUrl: string | undefined;
    const githubPushConfig = config?.goal?.githubPush;
    const githubPushRemote = githubPushConfig?.remote ?? "origin";
    const setGithubPushOutcome = (outcome: Omit<GithubPushOutcome, "timestamp">): void => {
      session.githubPushOutcome = { ...outcome, timestamp: new Date().toISOString() };
    };
    if (!githubPushConfig?.enabled) {
      setGithubPushOutcome({
        enabled: false,
        branch: runBranchName,
        attempted: false,
        succeeded: false,
        message: "GitHub push is disabled.",
      });
    } else if (!gitCheckpointConfig?.enabled) {
      setGithubPushOutcome({
        enabled: true,
        branch: runBranchName,
        remote: githubPushRemote,
        attempted: false,
        succeeded: false,
        message: "GitHub push skipped: git checkpoints are disabled.",
      });
    } else {
      let isPrivateRepo = false;
      let privacySkipMessage: string | undefined;
      try {
        isPrivateRepo = isRepoPrivate(workingDir);
      } catch (error) {
        privacySkipMessage = `GitHub push skipped: failed to verify repository privacy (${formatExecError(error)})`;
        onProgress?.(`  [warn] ${privacySkipMessage}`);
      }

      if (!isPrivateRepo) {
        const message =
          privacySkipMessage ?? "GitHub push skipped: working repository is not private.";
        if (!privacySkipMessage) onProgress?.(`  [warn] ${message}`);
        setGithubPushOutcome({
          enabled: true,
          branch: runBranchName,
          remote: githubPushRemote,
          attempted: false,
          succeeded: false,
          message,
        });
      } else {
        const pushResult = pushRunBranch(workingDir, runId, githubPushRemote, runBranchName);
        if (!pushResult.success) {
          onProgress?.(`  [warn] GitHub push failed: ${pushResult.error}`);
          setGithubPushOutcome({
            enabled: true,
            branch: runBranchName,
            remote: githubPushRemote,
            attempted: true,
            succeeded: false,
            message: `GitHub push failed: ${pushResult.error}`,
          });
        } else {
          const pushedMessage = `Run branch pushed to ${githubPushRemote} (${pushResult.sha.slice(0, 7)})`;
          onProgress?.(`  [git] ${pushedMessage}`);
          const remoteUrl = readGitRemoteUrl(workingDir, githubPushRemote);
          reviewUrl = remoteUrl
            ? (buildGitHubBranchUrl(remoteUrl, runBranchName) ?? undefined)
            : undefined;
          setGithubPushOutcome({
            enabled: true,
            branch: runBranchName,
            remote: githubPushRemote,
            attempted: true,
            succeeded: true,
            pushedSha: pushResult.sha,
            reviewUrl,
            message: pushedMessage,
          });
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

    const summary = buildGoalSummary({
      goal: session.goal,
      goalHeadline: plan.shortSummary,
      runId,
      steps: orderedSteps,
      maxTurnsPerTask,
      channel: params.channel,
    });
    session.completionSummary = summary;
    let reportLifecycle: PostExecutionLifecycleResult;
    try {
      reportLifecycle = await runPostExecutionLifecycle({
        session,
        runId,
        workingDir,
        config,
        enabledWorkers,
        model: params.model,
        claudeCodeAuth: params.claudeCodeAuth,
        manualTestsClient: params.manualTestsClient,
        channel: params.channel,
        serializedRun: params.serializedRun,
        onRunStatePersist: params.onRunStatePersist,
        onProgress,
        onStatusChange,
        summary,
        ...(reviewUrl ? { reviewUrl } : {}),
        maxTurnsPerTask,
      });
    } catch (error) {
      reportLifecycle = await bestEffortReportLifecycleFailure({
        session,
        steps: orderedSteps,
        summary,
        error,
        onRunStatePersist: params.onRunStatePersist,
        onProgress,
        onStatusChange,
      });
    }
    try {
      mirrorGoalRuntimeToAgentHistory({
        workspaceName: historyWorkspaceSlug ?? workspaceNameFromWorkingDir(workingDir),
        goalId: runId,
        sourceDir: resolveRunDir(runId),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onProgress?.(`  [warn] Runtime mirror after completion failed: ${message}`);
    }
    return { status: "done", summary: reportLifecycle.summary };
  }

  const aggregated =
    finalBuildGateBlockedDetail ??
    aggregateBlockedDetails(orderedSteps) ??
    (() => {
      const nonDoneStepIds = orderedSteps
        .filter((step) => step.status !== "done")
        .map((step) => step.id);
      if (nonDoneStepIds.length > 0) {
        return {
          blockedAt: "execution",
          prompt: `Steps stuck — unable to make progress: ${nonDoneStepIds.join(", ")}`,
          requiredInputKey: "resume_execution",
        } as const;
      }
      return {
        blockedAt: "execution",
        prompt: "Execution blocked unexpectedly.",
        requiredInputKey: "none",
      } as const;
    })();
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

export function hasAnswerForTask(taskId: string, answers: Record<string, string>): boolean {
  if (answers[`task:${taskId}:input`] != null) return true;
  for (const key of Object.keys(answers)) {
    const match = /^tasks:([^:]+):input$/.exec(key);
    if (match && match[1]!.split(",").includes(taskId)) return true;
  }
  return false;
}

export function getAnswerForTask(
  taskId: string,
  answers: Record<string, string>,
): string | undefined {
  const direct = answers[`task:${taskId}:input`];
  if (direct != null) return direct;
  for (const [key, value] of Object.entries(answers)) {
    const match = /^tasks:([^:]+):input$/.exec(key);
    if (match && match[1]!.split(",").includes(taskId)) return value;
  }
  return undefined;
}

export function consumeAnswerForTask(taskId: string, answers: Record<string, string>): void {
  const directKey = `task:${taskId}:input`;
  if (directKey in answers) delete answers[directKey];

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
