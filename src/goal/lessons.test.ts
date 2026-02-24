import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeAttemptBundle, resolveWorkerDir } from "./attempt-bundle.js";
import { saveRun } from "./run-store.js";
import {
  addLesson,
  clearLessons,
  extractRunLessons,
  getLessonsForContext,
  loadLessons,
  removeLessons,
  saveLessons,
} from "./lessons.js";
import type { RunCliProcessResult } from "./cli-process.js";
import type { Lesson } from "./lessons.js";
import type { SerializedRun } from "./types.js";

const mockRunCliProcess = vi.fn();
vi.mock("./cli-process.js", () => ({
  runCliProcess: (...args: unknown[]) => mockRunCliProcess(...args),
}));

const mockResolveClaudeBinary = vi.fn();
vi.mock("./scout.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scout.js")>();
  return {
    ...actual,
    resolveClaudeBinary: (...args: unknown[]) => mockResolveClaudeBinary(...args),
  };
});

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

type ExtractionRunOptions = {
  runId: string;
  workingDir: string;
  stepResults?: SerializedRun["stepResults"];
  planHistory?: SerializedRun["planHistory"];
};

function createPlan(workingDir: string, summary: string) {
  return {
    goal: "Extract lessons",
    workingDir,
    summary,
    shortSummary: summary,
    steps: [
      {
        id: "step-alpha",
        description: "Fix parser reliability",
        shortSummary: "Fix parser",
        dependsOn: [],
        status: "done" as const,
      },
    ],
  };
}

function saveExtractionRun(options: ExtractionRunOptions): void {
  const run: SerializedRun = {
    runId: options.runId,
    goal: "Improve extraction reliability",
    state: "done",
    plan: createPlan(options.workingDir, "Current plan"),
    stepResults: options.stepResults ?? {},
    blocked: null,
    answers: {},
    workingDir: options.workingDir,
    model: "claude-sonnet-4-20250514",
    dryRun: false,
    createdAt: "2026-02-24T00:00:00.000Z",
    updatedAt: "2026-02-24T00:01:00.000Z",
    planHistory: options.planHistory,
  };
  saveRun(run);
}

function makeCliResult(overrides: Partial<RunCliProcessResult>): RunCliProcessResult {
  return {
    stdout: "",
    stderr: "",
    timedOut: false,
    exitCode: 0,
    signal: null,
    durationMs: 15,
    ...overrides,
  };
}

describe("extractRunLessons", () => {
  let tmpDir: string;
  let prevMoltbotStateDir: string | undefined;
  let prevClawdbotStateDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-extract-lessons-test-"));
    prevMoltbotStateDir = process.env.MOLTBOT_STATE_DIR;
    prevClawdbotStateDir = process.env.CLAWDBOT_STATE_DIR;
    process.env.MOLTBOT_STATE_DIR = tmpDir;
    delete process.env.CLAWDBOT_STATE_DIR;
    mockRunCliProcess.mockReset();
    mockResolveClaudeBinary.mockReset();
    mockResolveClaudeBinary.mockReturnValue("/usr/bin/claude");
  });

  afterEach(() => {
    if (prevMoltbotStateDir === undefined) delete process.env.MOLTBOT_STATE_DIR;
    else process.env.MOLTBOT_STATE_DIR = prevMoltbotStateDir;
    if (prevClawdbotStateDir === undefined) delete process.env.CLAWDBOT_STATE_DIR;
    else process.env.CLAWDBOT_STATE_DIR = prevClawdbotStateDir;

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads artifacts from temp run directories, includes existing lessons, and records extracted lessons", async () => {
    const runId = "extract-run-success";
    const workingDir = "/repo/project-a";
    saveExtractionRun({
      runId,
      workingDir,
      planHistory: [
        {
          revision: 1,
          source: "user",
          plan: createPlan(workingDir, "Initial plan"),
        },
        {
          revision: 2,
          source: "autocheck",
          editInstructions: "Adjust for monorepo tsconfig lookup",
          plan: createPlan(workingDir, "Adjusted plan"),
        },
      ],
      stepResults: {
        "step-alpha": {
          stepId: "step-alpha",
          success: false,
          output: "pnpm build failed",
          error: "Cannot resolve workspace tsconfig path",
          durationMs: 1532,
        },
      },
    });

    writeAttemptBundle(resolveWorkerDir(runId, "step-alpha"), {
      attemptNumber: 1,
      backend: "codex",
      outcome: "ralph",
      durationMs: 88,
      ralphDetail: {
        approachTried: "Hardcoded default tsconfig path.",
        specificErrors: "Broke monorepo sub-package builds.",
        keyInsight: "Resolve tsconfig from package root before invoking toolchain.",
        suggestedApproach: "Inspect nearest package.json and walk to tsconfig path.",
      },
    });

    mockRunCliProcess.mockResolvedValueOnce(
      makeCliResult({
        stdout: JSON.stringify({
          lessons: [
            {
              pattern: "workspace-tsconfig",
              lesson:
                "Resolve tsconfig from the current package root instead of assuming repo root defaults.",
              stepId: "step-alpha",
            },
          ],
        }),
      }),
    );

    const recorded = await extractRunLessons(runId, workingDir, [
      { pattern: "known-dedup", lesson: "Do not duplicate this existing lesson." },
    ]);

    expect(mockRunCliProcess).toHaveBeenCalledTimes(1);
    const call = mockRunCliProcess.mock.calls[0]?.[0] as {
      command: string;
      cwd: string;
      stdin: string;
    };
    expect(call.command).toBe("/usr/bin/claude");
    expect(call.cwd).toBe(workingDir);
    expect(call.stdin).toContain("Adjust for monorepo tsconfig lookup");
    expect(call.stdin).toContain("Resolve tsconfig from package root before invoking toolchain.");
    expect(call.stdin).toContain("Cannot resolve workspace tsconfig path");
    expect(call.stdin).toContain("- [known-dedup] Do not duplicate this existing lesson.");

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      workingDir,
      pattern: "workspace-tsconfig",
      lesson:
        "Resolve tsconfig from the current package root instead of assuming repo root defaults.",
      source: "autocheck",
      runId,
      stepId: "step-alpha",
    });
    expect(recorded[0]?.id.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(recorded[0]!.createdAt))).toBe(false);

    const stored = loadLessons();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(recorded[0]);
  });

  it.each([
    {
      scenario: "timeout",
      response: makeCliResult({ timedOut: true }),
    },
    {
      scenario: "bad json",
      response: makeCliResult({ stdout: "not-json-at-all" }),
    },
    {
      scenario: "process error",
      response: makeCliResult({ exitCode: 1, stderr: "spawn failed" }),
    },
  ])("fails open for $scenario", async ({ response, scenario }) => {
    const runId = `extract-run-failure-${scenario.replace(/\s+/g, "-")}`;
    const workingDir = "/repo/project-failures";
    saveExtractionRun({
      runId,
      workingDir,
      stepResults: {
        "step-alpha": {
          stepId: "step-alpha",
          success: false,
          output: "failed",
          error: "failure trigger",
          durationMs: 30,
        },
      },
    });

    mockResolveClaudeBinary.mockReturnValue(null);
    mockRunCliProcess.mockResolvedValueOnce(response);

    const recorded = await extractRunLessons(runId, workingDir, []);
    expect(recorded).toEqual([]);
    expect(loadLessons()).toEqual([]);
  });

  it("returns empty when correction summary has no corrections and skips CLI extraction", async () => {
    const runId = "extract-run-no-corrections";
    const workingDir = "/repo/project-clean";
    saveExtractionRun({
      runId,
      workingDir,
      planHistory: [
        {
          revision: 1,
          source: "user",
          plan: createPlan(workingDir, "Only revision with no edits"),
        },
      ],
      stepResults: {
        "step-alpha": {
          stepId: "step-alpha",
          success: true,
          output: "all checks passed",
          durationMs: 24,
        },
      },
    });

    const recorded = await extractRunLessons(runId, workingDir, [
      { pattern: "already-known", lesson: "Known lesson" },
    ]);
    expect(recorded).toEqual([]);
    expect(mockRunCliProcess).not.toHaveBeenCalled();
    expect(loadLessons()).toEqual([]);
  });
});
