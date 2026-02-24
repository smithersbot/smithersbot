import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addLesson,
  clearLessons,
  getLessonsForContext,
  loadLessons,
  removeLessons,
  saveLessons,
} from "./lessons.js";
import type { Lesson } from "./lessons.js";

describe("lessons store", () => {
  let tmpDir: string;
  let prevMoltbotStateDir: string | undefined;
  let prevClawdbotStateDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-lessons-test-"));
    prevMoltbotStateDir = process.env.MOLTBOT_STATE_DIR;
    prevClawdbotStateDir = process.env.CLAWDBOT_STATE_DIR;
    process.env.MOLTBOT_STATE_DIR = tmpDir;
    delete process.env.CLAWDBOT_STATE_DIR;
  });

  afterEach(() => {
    if (prevMoltbotStateDir === undefined) delete process.env.MOLTBOT_STATE_DIR;
    else process.env.MOLTBOT_STATE_DIR = prevMoltbotStateDir;
    if (prevClawdbotStateDir === undefined) delete process.env.CLAWDBOT_STATE_DIR;
    else process.env.CLAWDBOT_STATE_DIR = prevClawdbotStateDir;

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adds and loads lessons through disk round-trip", () => {
    const added = addLesson({
      workingDir: "/repo/a",
      pattern: "vitest-config",
      lesson: "Use forks in this workspace for consistency.",
      source: "worker",
      runId: "run-1",
      stepId: "step-1",
    });

    expect(added.id).toBeTypeOf("string");
    expect(added.id.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(added.createdAt))).toBe(false);

    const loaded = loadLessons();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(added);
  });

  it("filters lessons by exact workingDir only", () => {
    const lessons: Lesson[] = [
      {
        id: "exact",
        workingDir: "/repo/project",
        pattern: "exact",
        lesson: "Exact match lesson",
        source: "worker",
        runId: "run-1",
        createdAt: "2026-02-24T00:00:00.000Z",
      },
      {
        id: "ancestor",
        workingDir: "/repo",
        pattern: "ancestor",
        lesson: "Ancestor lesson should not match",
        source: "feedback",
        runId: "run-2",
        createdAt: "2026-02-24T00:00:01.000Z",
      },
      {
        id: "universal",
        workingDir: "*",
        pattern: "universal",
        lesson: "Universal lesson should not match",
        source: "ralph",
        runId: "run-3",
        createdAt: "2026-02-24T00:00:02.000Z",
      },
      {
        id: "other",
        workingDir: "/repo/other",
        pattern: "other",
        lesson: "Other project lesson should not match",
        source: "autocheck",
        runId: "run-4",
        createdAt: "2026-02-24T00:00:03.000Z",
      },
    ];
    saveLessons(lessons);

    const matched = getLessonsForContext("/repo/project");
    expect(matched).toHaveLength(1);
    expect(matched[0]?.id).toBe("exact");
  });

  it("clears lessons by workingDir and globally", () => {
    saveLessons([
      {
        id: "a1",
        workingDir: "/repo/a",
        pattern: "a",
        lesson: "a lesson",
        source: "user_edit",
        runId: "run-a1",
        createdAt: "2026-02-24T00:00:00.000Z",
      },
      {
        id: "a2",
        workingDir: "/repo/a",
        pattern: "a2",
        lesson: "a second lesson",
        source: "worker",
        runId: "run-a2",
        createdAt: "2026-02-24T00:00:01.000Z",
      },
      {
        id: "b1",
        workingDir: "/repo/b",
        pattern: "b",
        lesson: "b lesson",
        source: "feedback",
        runId: "run-b1",
        createdAt: "2026-02-24T00:00:02.000Z",
      },
    ]);

    expect(clearLessons("/repo/a")).toBe(2);
    expect(loadLessons().map((lesson) => lesson.id)).toEqual(["b1"]);

    expect(clearLessons()).toBe(1);
    expect(loadLessons()).toEqual([]);
  });

  it("removes lessons by id and preserves source values", () => {
    saveLessons([
      {
        id: "l1",
        workingDir: "/repo/a",
        pattern: "p1",
        lesson: "lesson 1",
        source: "worker",
        runId: "run-1",
        createdAt: "2026-02-24T00:00:00.000Z",
      },
      {
        id: "l2",
        workingDir: "/repo/a",
        pattern: "p2",
        lesson: "lesson 2",
        source: "feedback",
        runId: "run-2",
        createdAt: "2026-02-24T00:00:01.000Z",
      },
      {
        id: "l3",
        workingDir: "/repo/a",
        pattern: "p3",
        lesson: "lesson 3",
        source: "autocheck",
        runId: "run-3",
        createdAt: "2026-02-24T00:00:02.000Z",
      },
    ]);

    expect(removeLessons(["l2", "missing"])).toBe(1);
    const remaining = loadLessons();
    expect(remaining.map((lesson) => lesson.id)).toEqual(["l1", "l3"]);
    expect(remaining.map((lesson) => lesson.source)).toEqual(["worker", "autocheck"]);
  });
});
