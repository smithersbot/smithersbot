import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile } from "../infra/json-file.js";
import { aggregateBlockedDetails } from "./blocked.js";
import { mirrorGoalRunToAgentHistory } from "./agent-history.js";
import type {
  GoalSession,
  PlanStep,
  RunSummary,
  SerializedRun,
  StepResult,
  BlockedDetail,
} from "./types.js";

const GOALS_DIRNAME = "goals";
const RUN_FILENAME = "run.json";
const LOCKS_DIRNAME = ".locks";
const RUN_LOCKS_DIRNAME = "runs";

/** Returns the goals storage directory: $STATE_DIR/goals/ */
export function resolveGoalsDir(stateDir: string = resolveStateDir()): string {
  return path.join(stateDir, GOALS_DIRNAME);
}

/** Returns the run directory: $STATE_DIR/goals/<runId>/ */
export function resolveRunDir(runId: string, goalsDir: string = resolveGoalsDir()): string {
  return path.join(goalsDir, runId);
}

/** Atomically write JSON to a file (temp + rename). */
function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

/** Persist a run to disk. Creates the run directory if needed. */
export function saveRun(run: SerializedRun, goalsDir: string = resolveGoalsDir()): void {
  // Stage 2S transition: ~/.smithersbot/goals remains the canonical runtime store;
  // agent/history receives a sanitized mirror for agent-readable context.
  const runDir = resolveRunDir(run.runId, goalsDir);
  const filePath = path.join(runDir, RUN_FILENAME);
  atomicWriteJson(filePath, run);
  if (
    run.state === "done" ||
    run.state === "blocked" ||
    run.state === "reporting_failed" ||
    run.state === "cancelled"
  ) {
    mirrorGoalRunToAgentHistory(run);
  }
}

/** Load a run by ID. Returns undefined if the file does not exist. */
export function loadRun(
  runId: string,
  goalsDir: string = resolveGoalsDir(),
): SerializedRun | undefined {
  const filePath = path.join(resolveRunDir(runId, goalsDir), RUN_FILENAME);
  const data = loadJsonFile(filePath);
  if (!data || typeof data !== "object") return undefined;
  const rawState = (data as { state?: unknown }).state;
  const migrated = migrateRun(data as Record<string, unknown>, goalsDir);
  if (rawState !== migrated.state) {
    atomicWriteJson(filePath, migrated);
  }
  return migrated as SerializedRun;
}

/** Migrate old run data (blockReason → blocked, add answers, step status normalization). */
function migrateRun(data: Record<string, unknown>, goalsDir: string): Record<string, unknown> {
  // Backward compat: migrate blockReason → structured blocked
  if (!data.blocked && typeof data.blockReason === "string") {
    data.blocked = {
      blockedAt: "execution",
      prompt: data.blockReason,
      requiredInputKey: "step:unknown:input",
    } satisfies BlockedDetail;
  }
  if (!data.answers) {
    data.answers = {};
  }
  if (!Array.isArray(data.resumeNotes)) {
    data.resumeNotes = [];
  }
  if (data.planNumber == null) {
    data.planNumber = 1;
  }
  // Default plan revision fields for runs that have a plan
  if (data.planRevision == null && data.plan) {
    data.planRevision = 1;
    data.activePlanRevision = 1;
  }
  delete data.blockReason;

  // Migrate legacy step statuses (running/failed/skipped → new enum)
  const plan = data.plan as { steps?: Array<Record<string, unknown>> } | null;
  const runId = typeof data.runId === "string" ? data.runId : null;
  const keepInProgress = runId ? hasActiveRunLock(runId, goalsDir) : false;
  if (plan?.steps) {
    for (const step of plan.steps) {
      if (step.status === "running") {
        // Legacy "running" status: preserve for active runs, otherwise recover to pending.
        step.status = keepInProgress ? "in_progress" : "pending";
      } else if (step.status === "in_progress") {
        // Preserve active task colouring while a live run lock exists.
        if (!keepInProgress) {
          // Process crash mid-task → reset to pending so resume can re-run it.
          step.status = "pending";
        }
      } else if (step.status === "failed") {
        step.status = "blocked";
        step.blockedReason = step.blockedReason ?? "error";
        step.blockedQuestion =
          step.blockedQuestion ?? "Step failed in a previous run — replan or resume.";
      } else if (step.status === "skipped") {
        step.status = "blocked";
        step.blockedReason = step.blockedReason ?? "error";
        step.blockedQuestion =
          step.blockedQuestion ??
          "Step was skipped in a previous run due to dependency failure — replan or resume.";
      }
    }
  }

  // Migrate state machine to simplified set
  if (data.state === "init") data.state = "planning";
  if (data.state === "needs_clarification") data.state = "blocked";
  if (data.state === "rejected") data.state = "cancelled";
  if (data.state === "failed") {
    if (data.plan) {
      data.state = "blocked";
      if (!data.blocked && plan?.steps) {
        const synthesized = aggregateBlockedDetails(plan.steps as PlanStep[]);
        if (synthesized) data.blocked = synthesized;
      }
    } else {
      data.state = "cancelled";
    }
  }

  // Recover stale executing runs after process restarts/crashes.
  // If no active run lock exists, the run is not currently executing.
  if (data.state === "executing" && !keepInProgress) {
    const steps = (plan?.steps ?? []) as Array<Record<string, unknown>>;
    const hasSteps = steps.length > 0;
    const allStepsDone = hasSteps && steps.every((step) => step.status === "done");
    if (allStepsDone) {
      data.state = "done";
      data.blocked = null;
    } else {
      data.state = "blocked";
      if (!data.blocked) {
        data.blocked = {
          blockedAt: "execution",
          prompt:
            "Run was interrupted (gateway restart or process exit). Use goal resume to continue.",
          requiredInputKey: "resume_execution",
        } satisfies BlockedDetail;
      }
    }
  }

  if (data.state === "reporting" && !keepInProgress) {
    const steps = (plan?.steps ?? []) as Array<Record<string, unknown>>;
    const allStepsDone = steps.length > 0 && steps.every((step) => step.status === "done");
    data.state = allStepsDone ? "done" : "reporting_failed";
    data.blocked = null;
    if (!allStepsDone) {
      data.postExecutionReportingFailureReason ??=
        "Post-execution reporting was interrupted. Resume post execution to retry reporting without rerunning the completed plan.";
    } else {
      delete data.postExecutionReportingFailureReason;
    }
  }

  // Reconcile a stale run-level resume_execution blocked marker. An interrupted
  // run is synthesized to `blocked` + `resume_execution`; if every step has since
  // completed, the run is actually done. Leaving it blocked produces a split-brain
  // where /goal_status renders PAUSED but nothing is resumable. Clear the dangling
  // marker and finish the run instead.
  if (
    data.state === "blocked" &&
    data.blocked &&
    typeof data.blocked === "object" &&
    (data.blocked as Record<string, unknown>).requiredInputKey === "resume_execution"
  ) {
    const steps = (plan?.steps ?? []) as Array<Record<string, unknown>>;
    const allStepsDone = steps.length > 0 && steps.every((step) => step.status === "done");
    if (allStepsDone) {
      data.state = "done";
      data.blocked = null;
    }
  }

  // Ensure blocked details include blockedAt
  if (data.blocked && typeof data.blocked === "object") {
    const blocked = data.blocked as Record<string, unknown>;
    if (!blocked.blockedAt) {
      const rawKey = blocked.requiredInputKey;
      const key = typeof rawKey === "string" ? rawKey : "";
      const blockedAt =
        key.startsWith("step:planning") || data.state === "planning" ? "planning" : "execution";
      blocked.blockedAt = blockedAt;
    }
  }

  if (!data.taskCheckpoints) {
    data.taskCheckpoints = {};
  }

  return data;
}

function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function hasActiveRunLock(runId: string, goalsDir: string): boolean {
  const lockPath = path.join(goalsDir, LOCKS_DIRNAME, RUN_LOCKS_DIRNAME, `${runId}.lock`);
  let payload: { pid?: unknown } | undefined;
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    payload = JSON.parse(raw) as { pid?: unknown };
  } catch {
    return false;
  }

  const pid = typeof payload.pid === "number" ? payload.pid : Number.NaN;
  if (isAlive(pid)) return true;

  // Stale lock from a dead process — best effort cleanup.
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Already removed or inaccessible; treat as unlocked.
  }
  return false;
}

function toRunSummary(run: SerializedRun): RunSummary {
  const stepCount = run.plan?.steps?.length ?? 0;
  const completedSteps = (run.plan?.steps ?? []).filter(
    (step) => (step as PlanStep).status === "done",
  ).length;

  return {
    runId: run.runId,
    goal: run.goal,
    state: run.state,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    stepCount,
    completedSteps,
    dryRun: run.dryRun ?? false,
  };
}

/** Reconcile stale executing runs on disk and return how many changed state. */
export function reconcileStaleRuns(goalsDir: string = resolveGoalsDir()): number {
  if (!fs.existsSync(goalsDir)) return 0;

  let entries: string[];
  try {
    entries = fs.readdirSync(goalsDir);
  } catch {
    return 0;
  }

  let reconciledCount = 0;
  for (const entry of entries) {
    const runFile = path.join(goalsDir, entry, RUN_FILENAME);
    const data = loadJsonFile(runFile);
    if (!data || typeof data !== "object") continue;
    if ((data as { state?: unknown }).state !== "executing") continue;

    const reconciled = loadRun(entry, goalsDir);
    if (reconciled && reconciled.state !== "executing") {
      reconciledCount += 1;
    }
  }

  return reconciledCount;
}

/** List all runs as summaries, sorted by updatedAt descending (newest first). */
export function listRuns(goalsDir: string = resolveGoalsDir()): RunSummary[] {
  if (!fs.existsSync(goalsDir)) return [];

  let entries: string[];
  try {
    entries = fs.readdirSync(goalsDir);
  } catch {
    return [];
  }

  const summaries: RunSummary[] = [];
  for (const entry of entries) {
    const runFile = path.join(goalsDir, entry, RUN_FILENAME);
    const data = loadJsonFile(runFile);
    if (!data || typeof data !== "object") continue;
    let run = data as SerializedRun;
    if (run.state === "executing") {
      const runId = typeof run.runId === "string" && run.runId.length > 0 ? run.runId : entry;
      if (!hasActiveRunLock(runId, goalsDir)) {
        run = loadRun(entry, goalsDir) ?? run;
      }
    }
    summaries.push(toRunSummary(run));
  }

  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return summaries;
}

/** Delete a run directory. Returns true if deleted, false if not found. */
export function deleteRun(runId: string, goalsDir: string = resolveGoalsDir()): boolean {
  const runDir = resolveRunDir(runId, goalsDir);
  try {
    fs.rmSync(runDir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/** Resolve a potentially partial run ID to a full ID. */
export function resolveRunId(
  partialId: string,
  goalsDir: string = resolveGoalsDir(),
): string | undefined {
  const runs = listRuns(goalsDir);
  const exact = runs.find((r) => r.runId === partialId);
  if (exact) return exact.runId;
  const matches = runs.filter((r) => r.runId.startsWith(partialId));
  if (matches.length === 1) return matches[0]!.runId;
  return undefined;
}

type CarryForwardMode = "falsy" | "nullish";
type CarryForwardFieldKey =
  | "planRevision"
  | "planNumber"
  | "activePlanRevision"
  | "historyWorkspaceSlug"
  | "goalBriefPath"
  | "pendingContinuation"
  | "continuationDelivery"
  | "continuationHistory"
  | "planHistory"
  | "telegramPlanMessage"
  | "telegramQuestionMessages"
  | "telegramEditPromptMessages"
  | "telegramDoneMessage"
  | "telegramFeedbackPromptMessages"
  | "agentSessionFile"
  | "agentSessionId"
  | "agentMaxTurnsPerTask"
  | "scoutStatus"
  | "backendOverride"
  | "plannerBackendUsed"
  | "plannerDegradedReason"
  | "plannerDegradedResetHint"
  | "autocheckRounds"
  | "autocheckMaxRounds"
  | "autocheckBackend"
  | "autocheckSessionId"
  | "executionSessionId"
  | "executionSessionBackend"
  | "autocheckSkipReason"
  | "autocheckSkipMetadataPath"
  | "completionSummary"
  | "postExecutionReport"
  | "postExecutionReportArtifacts"
  | "postExecutionManualTestDisplay"
  | "postExecutionContinuation"
  | "deliveryFailed"
  | "deliveryError"
  | "imageFailure"
  | "taskCheckpoints"
  | "buildGateConfig"
  | "stepRalphCounts"
  | "buildGateFixCounts"
  | "buildGateFixSignatures"
  | "buildGateResults"
  | "workerSummaries";

type CarryForwardField<K extends CarryForwardFieldKey = CarryForwardFieldKey> = {
  key: K;
  mode: CarryForwardMode;
  onCarry?: (serialized: SerializedRun, previous: SerializedRun) => void;
};

const carryForwardFields: readonly CarryForwardField[] = [
  { key: "planRevision", mode: "nullish" },
  { key: "planNumber", mode: "nullish" },
  { key: "activePlanRevision", mode: "nullish" },
  { key: "historyWorkspaceSlug", mode: "falsy" },
  { key: "goalBriefPath", mode: "falsy" },
  { key: "pendingContinuation", mode: "falsy" },
  { key: "continuationDelivery", mode: "falsy" },
  { key: "continuationHistory", mode: "falsy" },
  { key: "planHistory", mode: "falsy" },
  { key: "telegramPlanMessage", mode: "falsy" },
  { key: "telegramQuestionMessages", mode: "falsy" },
  { key: "telegramEditPromptMessages", mode: "falsy" },
  { key: "telegramDoneMessage", mode: "falsy" },
  { key: "telegramFeedbackPromptMessages", mode: "falsy" },
  { key: "agentSessionFile", mode: "falsy" },
  { key: "agentSessionId", mode: "falsy" },
  { key: "agentMaxTurnsPerTask", mode: "falsy" },
  {
    key: "scoutStatus",
    mode: "falsy",
    onCarry: (serialized, previous) => {
      serialized.scoutSkipReason ??= previous.scoutSkipReason;
    },
  },
  { key: "backendOverride", mode: "falsy" },
  { key: "plannerBackendUsed", mode: "falsy" },
  { key: "plannerDegradedReason", mode: "falsy" },
  { key: "plannerDegradedResetHint", mode: "falsy" },
  { key: "autocheckRounds", mode: "nullish" },
  { key: "autocheckMaxRounds", mode: "nullish" },
  { key: "autocheckBackend", mode: "falsy" },
  { key: "autocheckSessionId", mode: "falsy" },
  { key: "executionSessionId", mode: "falsy" },
  { key: "executionSessionBackend", mode: "falsy" },
  { key: "autocheckSkipReason", mode: "falsy" },
  { key: "autocheckSkipMetadataPath", mode: "falsy" },
  { key: "completionSummary", mode: "falsy" },
  { key: "postExecutionReport", mode: "falsy" },
  { key: "postExecutionReportArtifacts", mode: "falsy" },
  { key: "postExecutionManualTestDisplay", mode: "falsy" },
  { key: "postExecutionContinuation", mode: "falsy" },
  { key: "deliveryFailed", mode: "falsy" },
  { key: "deliveryError", mode: "falsy" },
  { key: "imageFailure", mode: "falsy" },
  { key: "taskCheckpoints", mode: "falsy" },
  { key: "buildGateConfig", mode: "falsy" },
  { key: "stepRalphCounts", mode: "falsy" },
  { key: "buildGateFixCounts", mode: "falsy" },
  { key: "buildGateFixSignatures", mode: "falsy" },
  { key: "buildGateResults", mode: "falsy" },
  { key: "workerSummaries", mode: "falsy" },
];

function shouldCarryForwardValue(
  mode: CarryForwardMode,
  currentValue: unknown,
  previousValue: unknown,
): boolean {
  if (mode === "nullish") {
    return currentValue == null && previousValue != null;
  }
  return !currentValue && Boolean(previousValue);
}

function carryForwardField<K extends CarryForwardFieldKey>(params: {
  serialized: SerializedRun;
  previous: SerializedRun;
  field: CarryForwardField<K>;
}): void {
  const { serialized, previous, field } = params;
  const currentValue = serialized[field.key];
  const previousValue = previous[field.key];
  if (!shouldCarryForwardValue(field.mode, currentValue, previousValue)) return;

  serialized[field.key] = previousValue;
  field.onCarry?.(serialized, previous);
}

/** Convert an in-memory GoalSession to a serializable run record. */
export function sessionToSerialized(params: {
  session: GoalSession;
  runId: string;
  workingDir: string;
  model: string | undefined;
  dryRun: boolean;
  createdAt: string;
  updatedAt?: string;
  goalBriefPath?: SerializedRun["goalBriefPath"];
  agentSessionFile?: string;
  agentSessionId?: string;
  agentMaxTurnsPerTask?: number;
  scoutStatus?: SerializedRun["scoutStatus"];
  scoutSkipReason?: string;
  backendOverride?: SerializedRun["backendOverride"];
  plannerBackendUsed?: SerializedRun["plannerBackendUsed"];
  plannerDegradedReason?: SerializedRun["plannerDegradedReason"];
  plannerDegradedResetHint?: SerializedRun["plannerDegradedResetHint"];
  autocheckRounds?: SerializedRun["autocheckRounds"];
  autocheckMaxRounds?: SerializedRun["autocheckMaxRounds"];
  autocheckBackend?: SerializedRun["autocheckBackend"];
  autocheckSessionId?: SerializedRun["autocheckSessionId"];
  autocheckSkipReason?: SerializedRun["autocheckSkipReason"];
  autocheckSkipMetadataPath?: SerializedRun["autocheckSkipMetadataPath"];
  manualTests?: SerializedRun["manualTests"];
  manualTestsError?: SerializedRun["manualTestsError"];
  telegramDoneMessage?: SerializedRun["telegramDoneMessage"];
  telegramFeedbackPromptMessages?: SerializedRun["telegramFeedbackPromptMessages"];
  previousRun?: SerializedRun;
}): SerializedRun {
  const { session, runId, workingDir, model, dryRun, createdAt } = params;
  const manualTests = params.manualTests ?? session.manualTests;
  const manualTestsError = params.manualTestsError ?? session.manualTestsError;
  const serialized: SerializedRun = {
    runId,
    goal: session.goal,
    state: session.state,
    plan: session.plan,
    stepResults: Object.fromEntries(session.stepResults),
    blocked: session.blocked,
    answers: session.answers,
    ...(session.planningDecisionAnswers
      ? { planningDecisionAnswers: session.planningDecisionAnswers }
      : {}),
    resumeNotes: session.resumeNotes ?? params.previousRun?.resumeNotes ?? [],
    lastError: session.lastError,
    workingDir,
    ...(session.historyWorkspaceSlug ? { historyWorkspaceSlug: session.historyWorkspaceSlug } : {}),
    ...(params.goalBriefPath ? { goalBriefPath: params.goalBriefPath } : {}),
    model,
    dryRun,
    createdAt,
    updatedAt: params.updatedAt ?? new Date().toISOString(),
    planNumber: params.previousRun?.planNumber ?? 1,
    ...(params.agentSessionFile ? { agentSessionFile: params.agentSessionFile } : {}),
    ...(params.agentSessionId ? { agentSessionId: params.agentSessionId } : {}),
    ...(params.agentMaxTurnsPerTask ? { agentMaxTurnsPerTask: params.agentMaxTurnsPerTask } : {}),
    ...(params.scoutStatus ? { scoutStatus: params.scoutStatus } : {}),
    ...(params.scoutSkipReason ? { scoutSkipReason: params.scoutSkipReason } : {}),
    ...(params.backendOverride ? { backendOverride: params.backendOverride } : {}),
    ...(params.plannerBackendUsed ? { plannerBackendUsed: params.plannerBackendUsed } : {}),
    ...(params.plannerDegradedReason
      ? { plannerDegradedReason: params.plannerDegradedReason }
      : {}),
    ...(params.plannerDegradedResetHint
      ? { plannerDegradedResetHint: params.plannerDegradedResetHint }
      : {}),
    ...(params.autocheckRounds != null ? { autocheckRounds: params.autocheckRounds } : {}),
    ...(params.autocheckMaxRounds != null ? { autocheckMaxRounds: params.autocheckMaxRounds } : {}),
    ...(params.autocheckBackend ? { autocheckBackend: params.autocheckBackend } : {}),
    ...(params.autocheckSessionId ? { autocheckSessionId: params.autocheckSessionId } : {}),
    ...(session.executionSessionId ? { executionSessionId: session.executionSessionId } : {}),
    ...(session.executionSessionBackend
      ? { executionSessionBackend: session.executionSessionBackend }
      : {}),
    ...(params.autocheckSkipReason ? { autocheckSkipReason: params.autocheckSkipReason } : {}),
    ...(params.autocheckSkipMetadataPath
      ? { autocheckSkipMetadataPath: params.autocheckSkipMetadataPath }
      : {}),
    ...(manualTests != null ? { manualTests } : {}),
    ...(manualTestsError ? { manualTestsError } : {}),
    ...(session.completionSummary ? { completionSummary: session.completionSummary } : {}),
    ...(session.postExecutionReport ? { postExecutionReport: session.postExecutionReport } : {}),
    ...(session.postExecutionReportArtifacts
      ? { postExecutionReportArtifacts: session.postExecutionReportArtifacts }
      : {}),
    ...(session.postExecutionManualTestDisplay
      ? { postExecutionManualTestDisplay: session.postExecutionManualTestDisplay }
      : {}),
    ...(session.postExecutionContinuation
      ? { postExecutionContinuation: session.postExecutionContinuation }
      : {}),
    ...(session.postExecutionReportingFailureReason
      ? { postExecutionReportingFailureReason: session.postExecutionReportingFailureReason }
      : {}),
    ...(session.pendingContinuation ? { pendingContinuation: session.pendingContinuation } : {}),
    ...(session.continuationHistory ? { continuationHistory: session.continuationHistory } : {}),
    ...(session.deliveryFailed ? { deliveryFailed: true } : {}),
    ...(session.deliveryError ? { deliveryError: session.deliveryError } : {}),
    ...(session.imageFailure ? { imageFailure: session.imageFailure } : {}),
    ...(params.telegramDoneMessage != null
      ? { telegramDoneMessage: params.telegramDoneMessage }
      : {}),
    ...(params.telegramFeedbackPromptMessages != null
      ? { telegramFeedbackPromptMessages: params.telegramFeedbackPromptMessages }
      : {}),
    ...(session.taskCheckpoints ? { taskCheckpoints: session.taskCheckpoints } : {}),
    ...(session.buildGateConfig ? { buildGateConfig: session.buildGateConfig } : {}),
    ...(session.stepRalphCounts ? { stepRalphCounts: session.stepRalphCounts } : {}),
    ...(session.buildGateFixCounts ? { buildGateFixCounts: session.buildGateFixCounts } : {}),
    ...(session.buildGateFixSignatures
      ? { buildGateFixSignatures: session.buildGateFixSignatures }
      : {}),
    ...(session.buildGateResults ? { buildGateResults: session.buildGateResults } : {}),
    ...(session.workerSummaries ? { workerSummaries: session.workerSummaries } : {}),
    ...(session.githubPushOutcome ? { githubPushOutcome: session.githubPushOutcome } : {}),
  };
  const previous = params.previousRun;
  if (!previous) return serialized;

  for (const field of carryForwardFields) {
    carryForwardField({
      serialized,
      previous,
      field,
    });
  }
  if (manualTests == null && !manualTestsError) {
    if (previous.manualTests != null) serialized.manualTests = previous.manualTests;
    if (previous.manualTestsError) serialized.manualTestsError = previous.manualTestsError;
  }
  return serialized;
}

/** Resolve per-task working notes file path. */
export function resolveWorkingFile(runId: string, stepId: string, goalsDir?: string): string {
  return path.join(resolveRunDir(runId, goalsDir), "working", `${stepId}.md`);
}

/** Resolve top-level WORKING.md for the goal run. */
export function resolveGoalWorkingFile(runId: string, goalsDir?: string): string {
  return path.join(resolveRunDir(runId, goalsDir), "WORKING.md");
}

/** Resolve a per-task agent session file path. */
export function resolveAgentTaskSessionFile(
  runId: string,
  taskId: string,
  goalsDir?: string,
): string {
  return path.join(resolveRunDir(runId, goalsDir), "sessions", `${taskId}.jsonl`);
}

/** Convert a serialized run back to an in-memory GoalSession. */
export function serializedToSession(run: SerializedRun): GoalSession {
  const stepResults = new Map<string, StepResult>();
  if (run.stepResults) {
    for (const [key, value] of Object.entries(run.stepResults)) {
      stepResults.set(key, value as StepResult);
    }
  }
  return {
    goal: run.goal,
    state: run.state,
    plan: run.plan,
    stepResults,
    blocked: run.blocked ?? null,
    answers: run.answers ?? {},
    planningDecisionAnswers: run.planningDecisionAnswers,
    resumeNotes: run.resumeNotes ?? [],
    lastError: run.lastError,
    taskCheckpoints: run.taskCheckpoints ?? {},
    buildGateConfig: run.buildGateConfig,
    stepRalphCounts: run.stepRalphCounts ?? {},
    buildGateFixCounts: run.buildGateFixCounts ?? {},
    buildGateFixSignatures: run.buildGateFixSignatures ?? {},
    buildGateResults: run.buildGateResults ?? {},
    workerSummaries: run.workerSummaries ?? [],
    historyWorkspaceSlug: run.historyWorkspaceSlug,
    githubPushOutcome: run.githubPushOutcome,
    completionSummary: run.completionSummary,
    manualTests: run.manualTests,
    manualTestsError: run.manualTestsError,
    postExecutionReport: run.postExecutionReport,
    postExecutionReportArtifacts: run.postExecutionReportArtifacts,
    postExecutionManualTestDisplay: run.postExecutionManualTestDisplay,
    postExecutionContinuation: run.postExecutionContinuation,
    postExecutionReportingFailureReason: run.postExecutionReportingFailureReason,
    pendingContinuation: run.pendingContinuation,
    continuationHistory: run.continuationHistory,
    deliveryFailed: run.deliveryFailed,
    deliveryError: run.deliveryError,
    imageFailure: run.imageFailure,
    executionSessionId: run.executionSessionId,
    executionSessionBackend: run.executionSessionBackend,
  };
}
