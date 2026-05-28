import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireGoalOpLock, acquirePlanningLock, isGoalOpLocked } from "./goal-lock.js";

let testGoalsDir: string;

beforeEach(() => {
  testGoalsDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-lock-test-"));
});

afterEach(() => {
  fs.rmSync(testGoalsDir, { recursive: true, force: true });
});

describe("acquireGoalOpLock", () => {
  it("acquires an exclusive lock", () => {
    const result = acquireGoalOpLock("run-1", "approve", testGoalsDir);
    expect(result.acquired).toBe(true);
    if (result.acquired) result.release();
  });

  it("second acquire returns acquired: false with existingLabel", () => {
    const first = acquireGoalOpLock("run-1", "approve", testGoalsDir);
    expect(first.acquired).toBe(true);

    const second = acquireGoalOpLock("run-1", "edit", testGoalsDir);
    expect(second.acquired).toBe(false);
    expect(second.existingLabel).toBe("approve");

    if (first.acquired) first.release();
  });

  it("release then re-acquire works", () => {
    const first = acquireGoalOpLock("run-1", "approve", testGoalsDir);
    expect(first.acquired).toBe(true);
    if (first.acquired) first.release();

    const second = acquireGoalOpLock("run-1", "edit", testGoalsDir);
    expect(second.acquired).toBe(true);
    if (second.acquired) second.release();
  });

  it("stale PID is auto-cleaned", () => {
    // Write a lock with a bogus PID that's definitely not alive
    const lockDir = path.join(testGoalsDir, ".locks", "runs");
    fs.mkdirSync(lockDir, { recursive: true });
    const lockPath = path.join(lockDir, "run-stale.lock");
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999, label: "old-op", createdAt: new Date().toISOString() }),
    );

    // Acquiring should auto-remove the stale lock
    const result = acquireGoalOpLock("run-stale", "approve", testGoalsDir);
    expect(result.acquired).toBe(true);
    if (result.acquired) result.release();
  });

  it("different runIds get independent locks", () => {
    const a = acquireGoalOpLock("run-a", "approve", testGoalsDir);
    const b = acquireGoalOpLock("run-b", "edit", testGoalsDir);
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
    if (a.acquired) a.release();
    if (b.acquired) b.release();
  });

  it("release is idempotent", () => {
    const result = acquireGoalOpLock("run-1", "approve", testGoalsDir);
    expect(result.acquired).toBe(true);
    if (result.acquired) {
      result.release();
      // Second release should not throw
      result.release();
    }
  });
});

describe("isGoalOpLocked", () => {
  it("returns locked: false when no lock exists", () => {
    const status = isGoalOpLocked("nonexistent", testGoalsDir);
    expect(status.locked).toBe(false);
  });

  it("returns locked: true with label when lock is held", () => {
    const lock = acquireGoalOpLock("run-1", "answer", testGoalsDir);
    expect(lock.acquired).toBe(true);

    const status = isGoalOpLocked("run-1", testGoalsDir);
    expect(status.locked).toBe(true);
    expect(status.label).toBe("answer");

    if (lock.acquired) lock.release();
  });

  it("auto-cleans stale lock and returns locked: false", () => {
    const lockDir = path.join(testGoalsDir, ".locks", "runs");
    fs.mkdirSync(lockDir, { recursive: true });
    const lockPath = path.join(lockDir, "run-dead.lock");
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999, label: "stale", createdAt: new Date().toISOString() }),
    );

    const status = isGoalOpLocked("run-dead", testGoalsDir);
    expect(status.locked).toBe(false);
    // Lock file should be removed
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

describe("acquirePlanningLock", () => {
  it("acquires a planning lock", () => {
    const result = acquirePlanningLock("12345", testGoalsDir);
    expect(result.acquired).toBe(true);
    if (result.acquired) result.release();
  });

  it("blocks concurrent planning in same scope", () => {
    const first = acquirePlanningLock("12345", testGoalsDir);
    expect(first.acquired).toBe(true);

    const second = acquirePlanningLock("12345", testGoalsDir);
    expect(second.acquired).toBe(false);

    if (first.acquired) first.release();
  });

  it("supports scope key with threadId", () => {
    const a = acquirePlanningLock("12345-678", testGoalsDir);
    expect(a.acquired).toBe(true);

    // Different thread in same chat gets independent lock
    const b = acquirePlanningLock("12345-999", testGoalsDir);
    expect(b.acquired).toBe(true);

    // Same scope is blocked
    const c = acquirePlanningLock("12345-678", testGoalsDir);
    expect(c.acquired).toBe(false);

    if (a.acquired) a.release();
    if (b.acquired) b.release();
  });

  it("auto-cleans stale planning lock", () => {
    const lockDir = path.join(testGoalsDir, ".locks", "planning");
    fs.mkdirSync(lockDir, { recursive: true });
    const lockPath = path.join(lockDir, "99999.lock");
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999, createdAt: new Date().toISOString() }),
    );

    const result = acquirePlanningLock("99999", testGoalsDir);
    expect(result.acquired).toBe(true);
    if (result.acquired) result.release();
  });

  it("lock dir is auto-created on fresh state dir", () => {
    const freshDir = path.join(testGoalsDir, "fresh-goals");
    // Directory doesn't exist yet
    expect(fs.existsSync(freshDir)).toBe(false);

    const result = acquirePlanningLock("chat-1", freshDir);
    expect(result.acquired).toBe(true);

    // Lock dir was auto-created
    expect(fs.existsSync(path.join(freshDir, ".locks", "planning"))).toBe(true);

    if (result.acquired) result.release();
  });
});
