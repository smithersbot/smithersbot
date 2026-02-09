import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile } from "../infra/json-file.js";
import { aggregateBlockedDetails } from "./blocked.js";
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
  const runDir = resolveRunDir(run.runId, goalsDir);
  const filePath = path.join(runDir, RUN_FILENAME);
  atomicWriteJson(filePath, run);
}

/** Load a run by ID. Returns undefined if the file does not exist. */
export function loadRun(
  runId: string,
  goalsDir: string = resolveGoalsDir(),
): SerializedRun | undefined {
  const filePath = path.join(resolveRunDir(runId, goalsDir), RUN_FILENAME);
  const data = loadJsonFile(filePath);
  if (!data || typeof data !== "object") return undefined;
  return migrateRun(data as Record<string, unknown>) as SerializedRun;
}

/** Migrate old run data (blockReason → blocked, add answers, step status normalization). */
function migrateRun(data: Record<string, unknown>): Record<string, unknown> {
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
  // Default plan revision fields for runs that have a plan
  if (data.planRevision == null && data.plan) {
    data.planRevision = 1;
    data.activePlanRevision = 1;
  }
  delete data.blockReason;

  // Migrate legacy step statuses (running/failed/skipped → new enum)
  const plan = data.plan as { steps?: Array<Record<string, unknown>> } | null;
  if (plan?.steps) {
    for (const step of plan.steps) {
      if (step.status === "running") {
        // Process crash mid-task → reset to pending so it re-runs
        step.status = "pending";
      } else if (step.status === "in_progress") {
        // Process crash mid-task → reset to pending
        step.status = "pending";
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

  // Ensure blocked details include blockedAt
  if (data.blocked && typeof data.blocked === "object") {
    const blocked = data.blocked as Record<string, unknown>;
    if (!blocked.blockedAt) {
      const key = String(blocked.requiredInputKey ?? "");
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
    const run = data as SerializedRun;
    const stepCount = run.plan?.steps?.length ?? 0;
    const completedSteps = (run.plan?.steps ?? []).filter(
      (s) => (s as PlanStep).status === "done",
    ).length;
    summaries.push({
      runId: run.runId,
      goal: run.goal,
      state: run.state,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      stepCount,
      completedSteps,
      dryRun: run.dryRun ?? false,
    });
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

/** Convert an in-memory GoalSession to a serializable run record. */
export function sessionToSerialized(params: {
  session: GoalSession;
  runId: string;
  workingDir: string;
  model: string | undefined;
  dryRun: boolean;
  createdAt: string;
  updatedAt?: string;
  agentSessionFile?: string;
  agentSessionId?: string;
  agentMaxTurnsPerTask?: number;
  scoutStatus?: SerializedRun["scoutStatus"];
  scoutSkipReason?: string;
  backendOverride?: SerializedRun["backendOverride"];
  previousRun?: SerializedRun;
}): SerializedRun {
  const { session, runId, workingDir, model, dryRun, createdAt } = params;
  const serialized: SerializedRun = {
    runId,
    goal: session.goal,
    state: session.state,
    plan: session.plan,
    stepResults: Object.fromEntries(session.stepResults),
    blocked: session.blocked,
    answers: session.answers,
    lastError: session.lastError,
    workingDir,
    model,
    dryRun,
    createdAt,
    updatedAt: params.updatedAt ?? new Date().toISOString(),
    ...(params.agentSessionFile ? { agentSessionFile: params.agentSessionFile } : {}),
    ...(params.agentSessionId ? { agentSessionId: params.agentSessionId } : {}),
    ...(params.agentMaxTurnsPerTask ? { agentMaxTurnsPerTask: params.agentMaxTurnsPerTask } : {}),
    ...(params.scoutStatus ? { scoutStatus: params.scoutStatus } : {}),
    ...(params.scoutSkipReason ? { scoutSkipReason: params.scoutSkipReason } : {}),
    ...(params.backendOverride ? { backendOverride: params.backendOverride } : {}),
    ...(session.taskCheckpoints ? { taskCheckpoints: session.taskCheckpoints } : {}),
  };
  const previous = params.previousRun;
  if (!previous) return serialized;

  if (previous.planRevision != null) serialized.planRevision = previous.planRevision;
  if (previous.activePlanRevision != null)
    serialized.activePlanRevision = previous.activePlanRevision;
  if (previous.planHistory) serialized.planHistory = previous.planHistory;
  if (previous.telegramPlanMessage) serialized.telegramPlanMessage = previous.telegramPlanMessage;
  if (previous.telegramQuestionMessages) {
    serialized.telegramQuestionMessages = previous.telegramQuestionMessages;
  }
  if (!serialized.agentSessionFile && previous.agentSessionFile) {
    serialized.agentSessionFile = previous.agentSessionFile;
  }
  if (!serialized.agentSessionId && previous.agentSessionId) {
    serialized.agentSessionId = previous.agentSessionId;
  }
  if (!serialized.agentMaxTurnsPerTask && previous.agentMaxTurnsPerTask) {
    serialized.agentMaxTurnsPerTask = previous.agentMaxTurnsPerTask;
  }
  if (!serialized.scoutStatus && previous.scoutStatus) {
    serialized.scoutStatus = previous.scoutStatus;
    serialized.scoutSkipReason ??= previous.scoutSkipReason;
  }
  if (!serialized.backendOverride && previous.backendOverride) {
    serialized.backendOverride = previous.backendOverride;
  }
  if (!serialized.taskCheckpoints && previous.taskCheckpoints) {
    serialized.taskCheckpoints = previous.taskCheckpoints;
  }
  return serialized;
}

/** Resolve the agent session file path for a goal run. */
export function resolveAgentSessionFile(runId: string, goalsDir?: string): string {
  return path.join(resolveRunDir(runId, goalsDir), "session.jsonl");
}

/** Resolve per-task working notes file path. */
export function resolveWorkingFile(runId: string, stepId: string, goalsDir?: string): string {
  return path.join(resolveRunDir(runId, goalsDir), "working", `${stepId}.md`);
}

/** Resolve top-level WORKING.md for the goal run. */
export function resolveGoalWorkingFile(runId: string, goalsDir?: string): string {
  return path.join(resolveRunDir(runId, goalsDir), "WORKING.md");
}

/** Resolve per-step CLI worker artifact directory. */
export function resolveWorkerDir(runId: string, stepId: string, goalsDir?: string): string {
  return path.join(resolveRunDir(runId, goalsDir), "workers", stepId);
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
    lastError: run.lastError,
    taskCheckpoints: run.taskCheckpoints ?? {},
  };
}
