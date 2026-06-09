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

// Auto-resume of a planning Needs Decision answer delegates to goalResumeCommand,
// which re-runs the CLI planner. Mock the planner + workspace prep so the
// answer→auto-resume path exercises the real state machine without spawning a
// real planning backend or touching a real working dir.
const mockRunCliPlanning = vi.fn();
vi.mock("../goal/cli-planner.js", () => ({
  runCliPlanning: (...args: unknown[]) => mockRunCliPlanning(...args),
}));

const mockEnsureWorkingDir = vi.fn();
vi.mock("../goal/git-checkpoint.js", () => ({
  ensureWorkingDir: (...args: unknown[]) => mockEnsureWorkingDir(...args),
}));

vi.mock("../goal/workspace-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../goal/workspace-policy.js")>();
  return {
    ...actual,
    assertGoalWorkerWorkspace: vi.fn(),
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
    mockRunCliPlanning.mockReset();
    mockEnsureWorkingDir.mockReset();
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
    expect(run?.state).toBe("blocked");
    const joined = rt.logs.join("\n");
    expect(joined).toContain("Right away, sir. Resuming the goal now.");
    expect(joined).not.toContain("did not start");
    expect(joined).not.toContain("rescheduled");
  });

  it("resumes a run-level resume_execution marker with no step-level blocked steps", async () => {
    saveRun(
      makeRun({
        runId: "answer-test-run",
        state: "blocked",
        blocked: {
          blockedAt: "execution",
          prompt:
            "Run was interrupted (gateway restart or process exit). Use goal resume to continue.",
          requiredInputKey: "resume_execution",
        },
        plan: {
          goal: "Test goal",
          summary: "Interrupted plan",
          steps: [
            {
              id: "step-a",
              description: "Step A",
              shortSummary: "Step A",
              dependsOn: [],
              status: "pending",
            },
            {
              id: "step-b",
              description: "Step B",
              shortSummary: "Step B",
              dependsOn: ["step-a"],
              status: "pending",
            },
          ],
        },
      }),
    );
    // Active run lock keeps the resumed `executing` state from being re-synthesized
    // back to blocked by loadRun's crash-recovery reconciliation.
    acquireGoalOpLock("answer-test-run", "execute", testGoalsDir);
    const { goalAnswerCommand } = await import("./goal-answer.js");
    const rt = mockRuntime();

    await goalAnswerCommand("answer-test-run", { key: "ignored", value: "Carry on." }, rt);

    const run = loadRun("answer-test-run", testGoalsDir);
    expect(run?.state).toBe("blocked");
    expect(run?.blocked).toBeNull();
    expect(run?.resumeNotes).toHaveLength(1);
    expect(run?.resumeNotes?.[0]).toMatchObject({
      source: "goal_answer",
      affectedStepIds: [],
      userText: "Carry on.",
    });
    const joined = rt.logs.join("\n");
    expect(joined).toContain("Right away, sir. Resuming the goal now.");
    expect(joined).not.toContain("did not start");
    expect(joined).not.toContain("rescheduled");
  });

  it("Resume button clears a run-level resume_execution marker without rescheduled copy", async () => {
    saveRun(
      makeRun({
        runId: "answer-test-run",
        state: "blocked",
        blocked: {
          blockedAt: "execution",
          prompt:
            "Run was interrupted (gateway restart or process exit). Use goal resume to continue.",
          requiredInputKey: "resume_execution",
        },
        plan: {
          goal: "Test goal",
          summary: "Interrupted plan",
          steps: [
            {
              id: "step-a",
              description: "Step A",
              shortSummary: "Step A",
              dependsOn: [],
              status: "pending",
            },
          ],
        },
      }),
    );
    acquireGoalOpLock("answer-test-run", "execute", testGoalsDir);
    const { applyGoalResumeNoteById } = await import("./goal-resume-note.js");

    const result = applyGoalResumeNoteById({
      runId: "answer-test-run",
      source: "resume",
      now: () => "2026-05-30T12:00:00.000Z",
    });

    expect(result).toMatchObject({
      status: "applied",
      rescheduledStepIds: [],
      message: "Got it. Resuming the goal now.",
    });
    expect(result.message).not.toContain("rescheduled");
    const run = loadRun("answer-test-run", testGoalsDir);
    expect(run?.state).toBe("blocked");
    expect(run?.blocked).toBeNull();
    expect(run?.resumeNotes?.[0]).toMatchObject({
      source: "resume",
      affectedStepIds: [],
    });
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

  function savePlanningDecisionBlock(): void {
    saveRun(
      makeRun({
        state: "blocked",
        plan: null,
        blocked: {
          blockedAt: "planning",
          prompt: "Decision needed: choose the data store.",
          requiredInputKey: "step:planning:input",
          decisions: [
            {
              id: "data-store",
              question: "Which data store should the first plan use?",
              options: [
                { key: "A", label: "SQLite for local-only storage" },
                { key: "B", label: "Postgres for shared storage", recommended: true },
              ],
            },
          ],
        },
      }),
    );
  }

  it("persists a planning decision answer and auto-resumes planning (no 'Use /goal_resume')", async () => {
    savePlanningDecisionBlock();
    mockRunCliPlanning.mockResolvedValueOnce({
      status: "success",
      plan: {
        workingDir: "/tmp/ws",
        summary: "Plan that used the decision answer",
        steps: [
          {
            id: "answered-step",
            description: "Use the selected data store",
            dependsOn: [],
            durationMinutes: 10,
            status: "pending",
          },
        ],
        goal: "Test goal",
      },
      scoutStatus: "success",
    });

    const { goalAnswerCommand } = await import("./goal-answer.js");
    const rt = mockRuntime();

    await goalAnswerCommand("answer-test-run", { key: "step:planning:input", value: "B" }, rt);

    // The planner ran (auto-resume), and the run left the blocked state.
    expect(mockRunCliPlanning).toHaveBeenCalledOnce();
    const planningCall = mockRunCliPlanning.mock.calls[0]?.[0] as { goalText?: string };
    expect(planningCall.goalText).toContain("User decision answers:");
    expect(planningCall.goalText).toContain("(B) Postgres for shared storage");

    const run = loadRun("answer-test-run", testGoalsDir);
    expect(run?.state).toBe("awaiting_approval");
    expect(run?.state).not.toBe("blocked");
    // The consumed answer must not leak into a later replan.
    expect(run?.answers["step:planning:input"]).toBeUndefined();
    expect(run?.planningDecisionAnswers).toBeUndefined();

    const joined = rt.logs.join("\n");
    expect(joined).not.toContain("Recorded your decision answer");
    expect(joined).not.toContain("Use /goal_resume");
  });

  it("records the planning decision answer before resuming so it reaches the planner", async () => {
    savePlanningDecisionBlock();
    mockRunCliPlanning.mockResolvedValueOnce({
      status: "success",
      plan: {
        workingDir: "/tmp/ws",
        summary: "Plan",
        steps: [
          {
            id: "s1",
            description: "Step",
            dependsOn: [],
            durationMinutes: 5,
            status: "pending",
          },
        ],
        goal: "Test goal",
      },
      scoutStatus: "success",
    });

    const { goalAnswerCommand } = await import("./goal-answer.js");
    const rt = mockRuntime();

    await goalAnswerCommand("answer-test-run", { key: "step:planning:input", value: "B" }, rt);

    // The audit trail still captured the decision answer en route to resume.
    const planningCall = mockRunCliPlanning.mock.calls[0]?.[0] as { goalText?: string };
    expect(planningCall.goalText).toContain(
      "Decision data-store: Which data store should the first plan use?",
    );
  });

  it("surfaces a clear blocker (not stuck-blocked) when auto-resume planning fails", async () => {
    savePlanningDecisionBlock();
    mockRunCliPlanning.mockRejectedValueOnce(new Error("planner backend unavailable"));

    const { goalAnswerCommand } = await import("./goal-answer.js");
    const rt = mockRuntime();

    await goalAnswerCommand("answer-test-run", { key: "step:planning:input", value: "B" }, rt);

    const run = loadRun("answer-test-run", testGoalsDir);
    // retryPlanning leaves the run in "planning" with lastError on failure — never
    // silently stuck in a blocked state with no resumable step.
    expect(run?.state).toBe("planning");
    expect(run?.state).not.toBe("blocked");
    expect(run?.lastError).toContain("planner backend unavailable");
    expect(rt.errors.join("\n")).toContain("planner backend unavailable");
    expect(rt.logs.join("\n")).not.toContain("Recorded your decision answer");
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
