import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonExitError } from "../cli/cli-utils.js";
import { acquireGoalOpLock } from "../goal/goal-lock.js";
import { loadRun, saveRun } from "../goal/run-store.js";
import type { SerializedRun } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";

async function catchJsonExit(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof JsonExitError)) throw err;
  }
}

let testGoalsDir: string;

vi.mock("../goal/run-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../goal/run-store.js")>();
  return {
    ...actual,
    resolveGoalsDir: () => testGoalsDir,
    listRuns: (dir?: string) => actual.listRuns(dir ?? testGoalsDir),
    loadRun: (id: string, dir?: string) => actual.loadRun(id, dir ?? testGoalsDir),
    saveRun: (run: SerializedRun, dir?: string) => actual.saveRun(run, dir ?? testGoalsDir),
    resolveRunId: (partial: string, dir?: string) =>
      actual.resolveRunId(partial, dir ?? testGoalsDir),
  };
});

function mockRuntime(): RuntimeEnv & { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log: (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    },
    error: (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    },
    exit: (() => {
      throw new Error("exit called");
    }) as never,
  };
}

function makeRun(overrides: Partial<SerializedRun> = {}): SerializedRun {
  return {
    runId: "answer-test-run",
    goal: "Test goal",
    state: "blocked",
    plan: {
      goal: "Test goal",
      summary: "A test plan",
      steps: [
        {
          id: "blocked-a",
          description: "Blocked A",
          shortSummary: "Blocked A",
          dependsOn: [],
          status: "blocked",
          blockedReason: "user_input",
          blockedQuestion: "Need detail for A.",
        },
        {
          id: "blocked-b",
          description: "Blocked B",
          shortSummary: "Blocked B",
          dependsOn: [],
          status: "blocked",
          blockedReason: "error",
          blockedQuestion: "Need retry for B.",
        },
        {
          id: "running",
          description: "Running",
          shortSummary: "Running",
          dependsOn: [],
          status: "in_progress",
        },
        {
          id: "done",
          description: "Done",
          shortSummary: "Done",
          dependsOn: [],
          status: "done",
        },
      ],
    },
    stepResults: {},
    blocked: {
      blockedAt: "execution",
      prompt: "Need input",
      requiredInputKey: "tasks:other:input",
    },
    answers: {},
    resumeNotes: [],
    workingDir: "/tmp/ws",
    model: undefined,
    dryRun: false,
    createdAt: "2026-01-30T00:00:00.000Z",
    updatedAt: "2026-01-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("goal-answer command", () => {
  beforeEach(() => {
    testGoalsDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-answer-test-"));
  });

  afterEach(() => {
    fs.rmSync(testGoalsDir, { recursive: true, force: true });
  });

  it("records a goal-level resume note and reschedules all blocked steps", async () => {
    saveRun(makeRun());
    acquireGoalOpLock("answer-test-run", "test", testGoalsDir);
    const { goalAnswerCommand } = await import("./goal-answer.js");
    const rt = mockRuntime();

    await goalAnswerCommand("answer-test-run", { key: "wrong-key", value: "Use postgres." }, rt);

    const run = loadRun("answer-test-run", testGoalsDir);
    expect(run?.resumeNotes).toHaveLength(1);
    expect(run?.resumeNotes?.[0]).toMatchObject({
      source: "goal_answer",
      affectedStepIds: ["blocked-a", "blocked-b"],
      userText: "Use postgres.",
    });
    expect(run?.plan?.steps.find((step) => step.id === "blocked-a")?.status).toBe("pending");
    expect(run?.plan?.steps.find((step) => step.id === "blocked-b")?.status).toBe("pending");
    expect(run?.plan?.steps.find((step) => step.id === "running")?.status).toBe("in_progress");
    expect(run?.plan?.steps.find((step) => step.id === "done")?.status).toBe("done");
    expect(run?.blocked).toBeNull();
    expect(run?.state).toBe("executing");
    expect(rt.logs.join("\n")).toContain("Got it. Added your note and rescheduled 2 steps.");
  });

  it("records the note while another goal operation lock is held", async () => {
    saveRun(makeRun());
    acquireGoalOpLock("answer-test-run", "resume", testGoalsDir);
    const { goalAnswerCommand } = await import("./goal-answer.js");
    const rt = mockRuntime();

    await goalAnswerCommand("answer-test-run", { key: "ignored", value: "Retry now." }, rt);

    const run = loadRun("answer-test-run", testGoalsDir);
    expect(run?.resumeNotes?.[0]?.userText).toBe("Retry now.");
    expect(run?.plan?.steps.filter((step) => step.status === "blocked")).toHaveLength(0);
    expect(rt.errors).toEqual([]);
  });

  it("returns idempotent copy when no steps are eligible", async () => {
    saveRun(
      makeRun({
        state: "executing",
        blocked: null,
        plan: {
          goal: "Test goal",
          summary: "Done",
          steps: [
            {
              id: "running",
              description: "Running",
              shortSummary: "Running",
              dependsOn: [],
              status: "in_progress",
            },
          ],
        },
      }),
    );
    acquireGoalOpLock("answer-test-run", "test", testGoalsDir);
    const { goalAnswerCommand } = await import("./goal-answer.js");
    const rt = mockRuntime();

    await goalAnswerCommand("answer-test-run", { key: "ignored", value: "FYI" }, rt);

    expect(loadRun("answer-test-run", testGoalsDir)?.resumeNotes).toEqual([]);
    expect(rt.logs.join("\n")).toContain(
      "No blocked, paused, or failed steps need input/resume right now. The goal is currently executing.",
    );
  });

  it("reports completed goals as a no-op without rescheduling stale details", async () => {
    saveRun(makeRun({ state: "done", blocked: null }));
    const { goalAnswerCommand } = await import("./goal-answer.js");
    const rt = mockRuntime();

    await goalAnswerCommand("answer-test-run", { key: "ignored", value: "FYI" }, rt);

    const run = loadRun("answer-test-run", testGoalsDir);
    expect(run?.state).toBe("done");
    expect(rt.logs.join("\n")).toContain("The goal is currently done.");
  });

  it("JSON mode emits strict JSON for a successful note", async () => {
    saveRun(makeRun());
    const { goalAnswerCommand } = await import("./goal-answer.js");
    const rt = mockRuntime();

    await goalAnswerCommand(
      "answer-test-run",
      {
        key: "ignored",
        value: "Use sqlite.",
        json: true,
      },
      rt,
    );

    const parsed = JSON.parse(rt.logs.join("")) as Record<string, unknown>;
    expect(parsed.status).toBe("resumed");
    expect(parsed.rescheduledStepIds).toEqual(["blocked-a", "blocked-b"]);
  });

  it("JSON mode reports unknown runs as an error", async () => {
    const { goalAnswerCommand } = await import("./goal-answer.js");
    const rt = mockRuntime();

    await catchJsonExit(() =>
      goalAnswerCommand("missing", { key: "ignored", value: "FYI", json: true }, rt),
    );

    const parsed = JSON.parse(rt.logs.join("")) as Record<string, unknown>;
    expect(parsed.error).toBe("Run not found: missing");
  });
});
