import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile } from "../infra/json-file.js";
import type { GoalSession, RunSummary, SerializedRun, StepResult, BlockedDetail } from "./types.js";

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

/** Migrate old run data (blockReason → blocked, add answers). */
function migrateRun(data: Record<string, unknown>): Record<string, unknown> {
  // Backward compat: migrate blockReason → structured blocked
  if (!data.blocked && typeof data.blockReason === "string") {
    data.blocked = {
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
    const completedSteps = Object.values(run.stepResults ?? {}).filter(
      (r) => (r as StepResult).success,
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
}): SerializedRun {
  const { session, runId, workingDir, model, dryRun, createdAt } = params;
  return {
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
  };
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
  };
}
