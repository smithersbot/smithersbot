import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonExitError } from "../cli/cli-utils.js";
import { loadRun, saveRun } from "../goal/run-store.js";
import { acquireGoalOpLock } from "../goal/goal-lock.js";
import { normalizeAnsweredUserInputBlocks } from "../goal/resume-state.js";
import { computeDisplayStatuses, findRunnableSteps } from "../goal/execution-status.js";
import type { PlanStep, SerializedRun } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";

async function catchJsonExit(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof JsonExitError)) throw err;
  }
}

let testGoalsDir: string;

// Mock goal-resume so goalAnswerCommand's auto-resume doesn't invoke the real agent executor
vi.mock("./goal-resume.js", () => ({
  goalResumeCommand: vi.fn(async () => ({ status: "done", summary: "Done." })),
}));

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

function makeBlockedRun(overrides: Partial<SerializedRun> = {}): SerializedRun {
  return {
    runId: "answer-test-run",
    goal: "Test goal",
    state: "blocked",
    plan: {
      goal: "Test goal",
      summary: "A test plan",
      steps: [
        {
          id: "1",
          description: "Create dir",
          dependsOn: [],
          status: "pending",
        },
      ],
    },
    stepResults: {},
    blocked: {
      blockedAt: "execution",
      prompt: "What is the database password?",
      requiredInputKey: "db_password",
    },
    answers: {},
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

  it("persists answer and clears blocked state", async () => {
    saveRun(makeBlockedRun());
    // The auto-resume holds the run lock while executing; hold it here so loadRun
    // does not reconcile the freshly-persisted "executing" state back to a stale
    // crash-recovery block.
    acquireGoalOpLock("answer-test-run", "test-resume", testGoalsDir);
    const { goalAnswerCommand } = await import("./goal-answer.js");
    const rt = mockRuntime();
    await goalAnswerCommand("answer-test-run", { key: "db_password", value: "s3cret" }, rt);

    const run = loadRun("answer-test-run", testGoalsDir);
    expect(run).toBeDefined();
    expect(run!.answers.db_password).toBe("s3cret");
    expect(run!.blocked).toBeNull();
    expect(run!.state).toBe("executing");
    expect(rt.logs.join("\n")).toContain('Answer saved for key "db_password"');
    expect(rt.logs.join("\n")).toContain("Warning:");
    // Auto-resume is called (mocked goalResumeCommand)
    const { goalResumeCommand } = await import("./goal-resume.js");
    expect(goalResumeCommand).toHaveBeenCalled();
  });

  it("forwards config to goalResumeCommand during execution auto-resume", async () => {
    saveRun(makeBlockedRun());
    const { goalAnswerCommand } = await import("./goal-answer.js");
    const { goalResumeCommand } = await import("./goal-resume.js");
    const goalResumeCommandMock = vi.mocked(goalResumeCommand);
    goalResumeCommandMock.mockClear();

    const rt = mockRuntime();
    const config = { goal: { claudeCodeAuth: "api_key" } } as const;
    await goalAnswerCommand("answer-test-run", { key: "db_password", value: "s3cret", config }, rt);

    expect(goalResumeCommandMock).toHaveBeenCalledTimes(1);
    expect(goalResumeCommandMock).toHaveBeenCalledWith(
      "answer-test-run",
      expect.objectContaining({ config }),
      rt,
    );
  });

  it("fans out multi-task blocked answers", async () => {
    saveRun(
      makeBlockedRun({
        blocked: {
          blockedAt: "execution",
          prompt: "Need creds for multiple steps",
          requiredInputKey: "tasks:1,2:input",
        },
        plan: {
          goal: "Test goal",
          summary: "A test plan",
          steps: [
            { id: "1", description: "Step 1", dependsOn: [], status: "blocked" },
            { id: "2", description: "Step 2", dependsOn: [], status: "blocked" },
          ],
        },
      }),
    );
    // Hold the run lock so loadRun does not reconcile the persisted "executing"
    // state back to a stale crash-recovery block (see test above).
    acquireGoalOpLock("answer-test-run", "test-resume", testGoalsDir);
    const { goalAnswerCommand } = await import("./goal-answer.js");
    const rt = mockRuntime();
    await goalAnswerCommand("answer-test-run", { key: "tasks:1,2:input", value: "ok" }, rt);

    const run = loadRun("answer-test-run", testGoalsDir);
    expect(run).toBeDefined();
    expect(run!.answers["task:1:input"]).toBe("ok");
    expect(run!.answers["task:2:input"]).toBe("ok");
    expect(run!.blocked).toBeNull();
    expect(run!.state).toBe("executing");
  });

  it("rejects mismatched key", async () => {
    saveRun(makeBlockedRun());
    const { goalAnswerCommand } = await import("./goal-answer.js");
    const rt = mockRuntime();
    await goalAnswerCommand("answer-test-run", { key: "wrong_key", value: "val" }, rt);

    expect(rt.errors.join("\n")).toContain('Key mismatch: expected "db_password", got "wrong_key"');
    // State should be unchanged
    const run = loadRun("answer-test-run", testGoalsDir);
    expect(run!.state).toBe("blocked");
  });

  it("rejects non-blocked run", async () => {
    saveRun(makeBlockedRun({ state: "done", blocked: null }));
    const { goalAnswerCommand } = await import("./goal-answer.js");
    const rt = mockRuntime();
    await goalAnswerCommand("answer-test-run", { key: "db_password", value: "val" }, rt);

    expect(rt.errors.join("\n")).toContain("Run is not awaiting input");
  });

  it("JSON mode outputs strict JSON with answered status", async () => {
    saveRun(
      makeBlockedRun({
        blocked: {
          blockedAt: "planning",
          prompt: "Need more detail",
          requiredInputKey: "step:planning:input",
        },
      }),
    );
    const { goalAnswerCommand } = await import("./goal-answer.js");
    const rt = mockRuntime();
    await goalAnswerCommand(
      "answer-test-run",
      { key: "step:planning:input", value: "s3cret", json: true },
      rt,
    );

    const raw = rt.logs.join("");
    expect(raw.trimStart()[0]).toBe("{");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.status).toBe("answered");
    expect(parsed.key).toBe("step:planning:input");
    expect(parsed.warning).toBeDefined();
  });

  it("JSON error for non-blocked run", async () => {
    saveRun(makeBlockedRun({ state: "done", blocked: null }));
    const { goalAnswerCommand } = await import("./goal-answer.js");
    const rt = mockRuntime();
    await catchJsonExit(() =>
      goalAnswerCommand("answer-test-run", { key: "db_password", value: "val", json: true }, rt),
    );

    const raw = rt.logs.join("");
    expect(raw.trimStart()[0]).toBe("{");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.error).toContain("not awaiting input");
  });

  it("unknown run ID returns error", async () => {
    const { goalAnswerCommand } = await import("./goal-answer.js");
    const rt = mockRuntime();
    await goalAnswerCommand("nonexistent", { key: "k", value: "v" }, rt);
    expect(rt.errors.join("\n")).toContain("Run not found: nonexistent");
  });

  it("collider: fans out the answer so the auto-resume normalizes BOTH parents while an unanswered block stays blocked", async () => {
    const runId = "answer-collider-run";
    saveRun(
      makeBlockedRun({
        runId,
        blocked: {
          blockedAt: "execution",
          prompt: "Need details for both parents",
          requiredInputKey: "tasks:parent-a,parent-b:input",
        },
        plan: {
          goal: "Collider",
          summary: "Collider plan",
          steps: [
            {
              id: "parent-a",
              description: "Parent A",
              dependsOn: [],
              status: "blocked",
              blockedReason: "user_input",
              blockedQuestion: "Detail for A?",
            },
            {
              id: "parent-b",
              description: "Parent B",
              dependsOn: [],
              status: "blocked",
              blockedReason: "user_input",
              blockedQuestion: "Detail for B?",
            },
            {
              id: "child",
              description: "Child",
              dependsOn: ["parent-a", "parent-b"],
              status: "pending",
            },
            {
              id: "lone",
              description: "Lone unanswered",
              dependsOn: [],
              status: "blocked",
              blockedReason: "user_input",
              blockedQuestion: "Lone detail?",
            },
          ],
        },
      }),
    );
    // Active resume holds the run lock; keep loadRun from reconciling the
    // persisted "executing" state.
    acquireGoalOpLock(runId, "test-resume", testGoalsDir);

    // Run the real resume normalization slice during auto-resume, exactly as
    // goalResumeCommand does, so we observe the end-to-end persisted result.
    const { goalResumeCommand } = await import("./goal-resume.js");
    vi.mocked(goalResumeCommand).mockImplementationOnce(async (id: string) => {
      const resumed = loadRun(id, testGoalsDir)!;
      normalizeAnsweredUserInputBlocks(resumed.plan!.steps as PlanStep[], resumed.answers);
      resumed.state = "executing";
      saveRun(resumed, testGoalsDir);
      return { status: "done", summary: "All steps completed." };
    });

    const { goalAnswerCommand } = await import("./goal-answer.js");
    const rt = mockRuntime();
    await goalAnswerCommand(runId, { key: "tasks:parent-a,parent-b:input", value: "go ahead" }, rt);

    expect(goalResumeCommand).toHaveBeenCalled();

    const run = loadRun(runId, testGoalsDir)!;
    // Answer fanned out to BOTH parent task keys.
    expect(run.answers["task:parent-a:input"]).toBe("go ahead");
    expect(run.answers["task:parent-b:input"]).toBe("go ahead");

    const byId = new Map((run.plan!.steps as PlanStep[]).map((s) => [s.id, s]));
    // Both answered parents normalized to pending — not just the first.
    expect(byId.get("parent-a")!.status).toBe("pending");
    expect(byId.get("parent-a")!.blockedReason).toBeUndefined();
    expect(byId.get("parent-b")!.status).toBe("pending");
    expect(byId.get("parent-b")!.blockedReason).toBeUndefined();
    // Unanswered user-input block stays hard blocked.
    expect(byId.get("lone")!.status).toBe("blocked");
    expect(byId.get("lone")!.blockedReason).toBe("user_input");

    // Renderer agrees: answered parents are not hard blocked; lone stays blocked.
    const display = computeDisplayStatuses(run.plan!.steps as PlanStep[]);
    expect(display.get("parent-a")).toBe("pending");
    expect(display.get("parent-b")).toBe("pending");
    expect(display.get("lone")).toBe("blocked");
    // Child waits until both parents complete: the runnable set is the two parents.
    expect(
      findRunnableSteps(run.plan!.steps as PlanStep[])
        .map((s) => s.id)
        .sort(),
    ).toEqual(["parent-a", "parent-b"]);
  });
});
