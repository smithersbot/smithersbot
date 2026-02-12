import fsSync from "node:fs";
import path from "node:path";
import { resolveGoalsDir } from "./run-store.js";

// ---------------------------------------------------------------------------
// File-based lock primitives for goal operations
//
// Uses fs.openSync(path, 'wx') exclusive-create pattern (same as gateway-lock.ts).
// Lock files live under $GOALS_DIR/.locks/ so they survive gateway restarts.
// ---------------------------------------------------------------------------

const LOCKS_DIRNAME = ".locks";
const RUNS_LOCK_DIR = "runs";
const PLANNING_LOCK_DIR = "planning";

type GoalOpLockPayload = {
  pid: number;
  label: string;
  createdAt: string;
};

type PlanningLockPayload = {
  pid: number;
  createdAt: string;
};

export type GoalOpLockResult =
  | { acquired: true; existingLabel?: string; release: () => void }
  | { acquired: false; existingLabel?: string };

export type PlanningLockResult = { acquired: true; release: () => void } | { acquired: false };

// ---------------------------------------------------------------------------
// PID liveness check (reused from gateway-lock.ts pattern)
// ---------------------------------------------------------------------------

function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveLocksDir(goalsDir: string = resolveGoalsDir()): string {
  return path.join(goalsDir, LOCKS_DIRNAME);
}

function resolveRunLockPath(runId: string, goalsDir?: string): string {
  return path.join(resolveLocksDir(goalsDir), RUNS_LOCK_DIR, `${runId}.lock`);
}

function resolvePlanningLockPath(scopeKey: string, goalsDir?: string): string {
  return path.join(resolveLocksDir(goalsDir), PLANNING_LOCK_DIR, `${scopeKey}.lock`);
}

/** Read and parse a lock file payload, returning null if unreadable. */
function readLockPayload<T>(lockPath: string): T | null {
  try {
    const raw = fsSync.readFileSync(lockPath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Check if a lock file is stale (owning PID is dead).
 * If stale, removes the lock file and returns true.
 */
function cleanStaleIfDead(lockPath: string, pid: number): boolean {
  if (!isAlive(pid)) {
    try {
      fsSync.unlinkSync(lockPath);
    } catch {
      // Already removed by another process — that's fine
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Goal operation lock (per-run)
// ---------------------------------------------------------------------------

/**
 * Acquire an exclusive lock for a goal run operation (approve/answer/edit).
 * Returns `{ acquired: true, release }` on success, or `{ acquired: false }`.
 */
export function acquireGoalOpLock(
  runId: string,
  label: string,
  goalsDir?: string,
): GoalOpLockResult {
  const lockPath = resolveRunLockPath(runId, goalsDir);
  const lockDir = path.dirname(lockPath);
  fsSync.mkdirSync(lockDir, { recursive: true });

  // Check for existing lock and clean if stale
  const existing = readLockPayload<GoalOpLockPayload>(lockPath);
  if (existing) {
    if (!cleanStaleIfDead(lockPath, existing.pid)) {
      return { acquired: false, existingLabel: existing.label };
    }
    // Stale lock was removed, proceed to acquire
  }

  const payload: GoalOpLockPayload = {
    pid: process.pid,
    label,
    createdAt: new Date().toISOString(),
  };

  try {
    const fd = fsSync.openSync(lockPath, "wx");
    fsSync.writeSync(fd, JSON.stringify(payload));
    fsSync.closeSync(fd);
  } catch (err) {
    // EEXIST: another process raced us and won
    if ((err as { code?: string }).code === "EEXIST") {
      const raced = readLockPayload<GoalOpLockPayload>(lockPath);
      return { acquired: false, existingLabel: raced?.label };
    }
    throw err;
  }

  const released = { value: false };
  return {
    acquired: true,
    existingLabel: existing?.label,
    release: () => {
      if (released.value) return;
      released.value = true;
      try {
        fsSync.unlinkSync(lockPath);
      } catch {
        // Already removed — fine
      }
    },
  };
}

/**
 * Read-only check: is a goal run currently locked?
 */
export function isGoalOpLocked(
  runId: string,
  goalsDir?: string,
): { locked: boolean; label?: string } {
  const lockPath = resolveRunLockPath(runId, goalsDir);
  const payload = readLockPayload<GoalOpLockPayload>(lockPath);
  if (!payload) return { locked: false };
  if (cleanStaleIfDead(lockPath, payload.pid)) {
    return { locked: false };
  }
  return { locked: true, label: payload.label };
}

// ---------------------------------------------------------------------------
// Planning lock (per-scope)
// ---------------------------------------------------------------------------

/**
 * Acquire an exclusive planning lock for a chat scope.
 * `scopeKey` is an opaque string built by the caller (e.g. `"${chatId}"` or `"${chatId}-${threadId}"`).
 */
export function acquirePlanningLock(scopeKey: string, goalsDir?: string): PlanningLockResult {
  const lockPath = resolvePlanningLockPath(scopeKey, goalsDir);
  const lockDir = path.dirname(lockPath);
  fsSync.mkdirSync(lockDir, { recursive: true });

  // Check for existing lock and clean if stale
  const existing = readLockPayload<PlanningLockPayload>(lockPath);
  if (existing) {
    if (!cleanStaleIfDead(lockPath, existing.pid)) {
      return { acquired: false };
    }
  }

  const payload: PlanningLockPayload = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };

  try {
    const fd = fsSync.openSync(lockPath, "wx");
    fsSync.writeSync(fd, JSON.stringify(payload));
    fsSync.closeSync(fd);
  } catch (err) {
    if ((err as { code?: string }).code === "EEXIST") {
      return { acquired: false };
    }
    throw err;
  }

  const released = { value: false };
  return {
    acquired: true,
    release: () => {
      if (released.value) return;
      released.value = true;
      try {
        fsSync.unlinkSync(lockPath);
      } catch {
        // Already removed — fine
      }
    },
  };
}
