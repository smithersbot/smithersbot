import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonExitError, runCommandWithRuntime } from "../cli/cli-utils.js";
import { saveRun, loadRun } from "../goal/run-store.js";
import type { Plan, SerializedRun } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";

/** Run an async fn, swallowing JsonExitError (expected in JSON-mode error tests). */
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

// Mock @clack/prompts so we can control confirm() behavior
const mockConfirm = vi.fn();
vi.mock("@clack/prompts", () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
  isCancel: (value: unknown) => typeof value === "symbol",
}));

// Mock unified CLI planner
const mockRunCliPlanning = vi.fn();
vi.mock("../goal/cli-planner.js", () => ({
  runCliPlanning: (...args: unknown[]) => mockRunCliPlanning(...args),
}));

const mockEnsureWorkingDir = vi.fn();
vi.mock("../goal/git-checkpoint.js", () => ({
  ensureWorkingDir: (...args: unknown[]) => mockEnsureWorkingDir(...args),
}));

// Mock the agent executor so resume tests don't need a real PI agent session
const mockExecuteGoalWithAgent = vi.fn(
  async (params: {
    session: { plan: { steps: Array<{ status: string }> } | null; state: string };
  }) => {
    // Mark all pending/blocked steps as done
    if (params.session.plan) {
      for (const step of params.session.plan.steps) {
        if (step.status === "pending" || step.status === "blocked") {
          step.status = "done";
        }
      }
    }
    params.session.state = "done";
    return { status: "done", summary: "All tasks completed." };
  },
);

vi.mock("../goal/agent-executor.js", () => ({
  executeGoalWithAgent: (...args: unknown[]) => mockExecuteGoalWithAgent(...args),
}));

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

const samplePlan: Plan = {
  goal: "Test goal",
  workingDir: "/tmp/ws",
  summary: "A test plan",
  steps: [
    {
      id: "1",
      description: "Create dir",
      dependsOn: [],
      status: "pending",
      durationMinutes: 1,
    },
  ],
};

function makeRun(overrides: Partial<SerializedRun>): SerializedRun {
  return {
    runId: "test-run-aaa",
    goal: "Test goal",
    state: "done",
    plan: null,
    stepResults: {},
    blocked: null,
    answers: {},
    workingDir: "/tmp/ws",
    model: undefined,
    dryRun: false,
    createdAt: "2026-01-30T00:00:00.000Z",
    updatedAt: "2026-01-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("goal-resume command", () => {
  beforeEach(() => {
    testGoalsDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-resume-test-"));
    vi.clearAllMocks();
    mockRunCliPlanning.mockResolvedValue({
      status: "success",
      plan: {
        workingDir: "/tmp/ws",
        summary: "Default replanned plan",
        steps: [
          {
            id: "default-step",
            description: "Default replanned task",
            dependsOn: [],
            status: "pending",
            durationMinutes: 15,
          },
        ],
        goal: "Test goal",
      },
      scoutStatus: "success",
    });
  });

  afterEach(() => {
    fs.rmSync(testGoalsDir, { recursive: true, force: true });
  });

  it("refuses to resume a completed run", async () => {
    saveRun(makeRun({ runId: "done-run", state: "done" }));
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("done-run", {}, rt);
    expect(result).toBeUndefined();
    expect(rt.errors).toContain("Run already completed.");
  });

  it("allows resuming a done run when explicitly enabled for feedback", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-done-feedback-ws-"));
    saveRun(
      makeRun({
        runId: "done-feedback-run",
        state: "done",
        plan: {
          goal: "Test goal",
          summary: "Feedback re-run plan",
          steps: [
            {
              id: "1",
              description: "Run follow-up fix",
              dependsOn: [],
              status: "pending",
              durationMinutes: 1,
            },
          ],
        },
        workingDir: workDir,
      }),
    );

    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand(
      "done-feedback-run",
      { allowDoneStateResume: true, quiet: true },
      rt,
    );

    expect(result?.status).toBe("done");
    const persisted = loadRun("done-feedback-run", testGoalsDir);
    expect(persisted?.state).toBe("done");
    expect(rt.errors).not.toContain("Run already completed.");
  });

  it("prints blocked details and exits without re-planning", async () => {
    saveRun(
      makeRun({
        runId: "blocked-run",
        state: "blocked",
        blocked: {
          blockedAt: "execution",
          prompt: "Need database credentials",
          requiredInputKey: "db_password",
        },
      }),
    );
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("blocked-run", {}, rt);
    expect(result).toEqual({
      status: "blocked",
      question: "Need database credentials",
      requiredInputKey: "db_password",
      blockedAt: "execution",
    });
    expect(rt.logs.join("\n")).toContain("Need database credentials");
    expect(rt.logs.join("\n")).toContain("moltbot goal answer");
  });

  it("retries execution-time blocked runs without answer when blocked reason is error", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-error-blocked-ws-"));
    saveRun(
      makeRun({
        runId: "blocked-error-run",
        state: "blocked",
        plan: {
          goal: "Test goal",
          summary: "Error block",
          steps: [
            {
              id: "error-step",
              description: "Retry after env fix",
              dependsOn: [],
              status: "blocked",
              durationMinutes: 1,
              blockedReason: "error",
              blockedQuestion: "Backend unavailable",
            },
          ],
        },
        blocked: {
          blockedAt: "execution",
          prompt: "Backend unavailable",
          requiredInputKey: "task:error-step:input",
          stepId: "error-step",
        },
        workingDir: workDir,
      }),
    );

    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("blocked-error-run", { yes: true, quiet: true }, rt);

    expect(result?.status).toBe("done");
    expect(mockExecuteGoalWithAgent).toHaveBeenCalledTimes(1);
    const persisted = loadRun("blocked-error-run", testGoalsDir);
    expect(persisted?.state).toBe("done");

    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("retries execution-time git blocks without requiring /goal_answer", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-git-blocked-ws-"));
    const runId = "blocked-git-run";
    saveRun(
      makeRun({
        runId,
        state: "blocked",
        plan: {
          goal: "Test goal",
          summary: "Git preflight block",
          steps: [
            {
              id: "done-step",
              description: "Already done",
              dependsOn: [],
              status: "done",
              durationMinutes: 1,
            },
          ],
        },
        blocked: {
          blockedAt: "execution",
          prompt: "Git checkpoints are enabled but this working directory is not a valid git repo.",
          requiredInputKey: "git",
        },
        stepResults: {
          "done-step": {
            stepId: "done-step",
            success: true,
            output: "Done",
            durationMs: 1,
          },
        },
        workingDir: workDir,
      }),
    );

    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand(runId, { yes: true, quiet: true }, rt);

    expect(result).toEqual({ status: "done", summary: "All steps already completed." });
    expect(mockExecuteGoalWithAgent).not.toHaveBeenCalled();

    const persisted = loadRun(runId, testGoalsDir);
    expect(persisted?.state).toBe("done");
    expect(persisted?.blocked).toBeNull();

    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("retries interrupted execution blocks without requiring /goal_answer", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-interrupted-ws-"));
    saveRun(
      makeRun({
        runId: "blocked-interrupted-run",
        state: "blocked",
        plan: {
          goal: "Test goal",
          summary: "Interrupted run",
          steps: [
            {
              id: "pending-step",
              description: "Continue work",
              dependsOn: [],
              status: "pending",
              durationMinutes: 1,
            },
          ],
        },
        blocked: {
          blockedAt: "execution",
          prompt: "Run was interrupted. Resume to continue.",
          requiredInputKey: "resume_execution",
        },
        workingDir: workDir,
      }),
    );

    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand(
      "blocked-interrupted-run",
      { yes: true, quiet: true },
      rt,
    );

    expect(result?.status).toBe("done");
    expect(mockExecuteGoalWithAgent).toHaveBeenCalledTimes(1);
    const persisted = loadRun("blocked-interrupted-run", testGoalsDir);
    expect(persisted?.state).toBe("done");
    expect(persisted?.blocked).toBeNull();

    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("blocked run in JSON mode outputs strict JSON", async () => {
    saveRun(
      makeRun({
        runId: "blocked-json",
        state: "blocked",
        blocked: {
          blockedAt: "execution",
          prompt: "Missing config",
          requiredInputKey: "config_key",
        },
      }),
    );
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    await goalResumeCommand("blocked-json", { json: true }, rt);
    const raw = rt.logs.join("");
    expect(raw.trimStart()[0]).toBe("{");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.status).toBe("blocked");
    expect(parsed.question).toBe("Missing config");
    expect(parsed.requiredInputKey).toBe("config_key");
  });

  it("--output json produces strict JSON for blocked run", async () => {
    saveRun(
      makeRun({
        runId: "blocked-output-json",
        state: "blocked",
        blocked: {
          blockedAt: "execution",
          prompt: "Need creds",
          requiredInputKey: "creds_key",
        },
      }),
    );
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    await goalResumeCommand("blocked-output-json", { output: "json" }, rt);
    const raw = rt.logs.join("");
    expect(raw.trimStart()[0]).toBe("{");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.status).toBe("blocked");
    expect(parsed.question).toBe("Need creds");
    expect(parsed.requiredInputKey).toBe("creds_key");
  });

  it("--output json produces strict JSON for done error", async () => {
    saveRun(makeRun({ runId: "done-output-json", state: "done" }));
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    await catchJsonExit(() => goalResumeCommand("done-output-json", { output: "json" }, rt));
    const raw = rt.logs.join("");
    expect(raw.trimStart()[0]).toBe("{");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.error).toBe("Run already completed.");
  });

  it("errors for unknown run ID", async () => {
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("nonexistent", {}, rt);
    expect(result).toBeUndefined();
    expect(rt.errors).toContain("Run not found: nonexistent");
  });

  it("resolves partial run IDs", async () => {
    saveRun(
      makeRun({
        runId: "abcdef12-3456-7890-abcd-ef1234567890",
        state: "done",
      }),
    );
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    await goalResumeCommand("abcdef12", {}, rt);
    expect(rt.errors).toContain("Run already completed.");
  });

  it("cancelled run without a plan suggests --replan", async () => {
    saveRun(
      makeRun({
        runId: "cancelled-no-plan",
        state: "cancelled",
        plan: null,
        lastError: "Planning error",
      }),
    );
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("cancelled-no-plan", {}, rt);
    expect(result).toBeUndefined();
    expect(rt.errors.join("\n")).toContain("Run has no plan");
    expect(rt.errors.join("\n")).toContain("--replan");
  });

  it("refuses stale planning state without --replan", async () => {
    saveRun(makeRun({ runId: "planning-run", state: "planning" }));
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("planning-run", {}, rt);
    expect(result).toBeUndefined();
    expect(rt.errors.join("\n")).toContain("incomplete state");
    expect(rt.errors.join("\n")).toContain("--replan");
  });

  it("done run in JSON mode outputs error JSON", async () => {
    saveRun(makeRun({ runId: "done-json", state: "done" }));
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    await catchJsonExit(() => goalResumeCommand("done-json", { json: true }, rt));
    const parsed = JSON.parse(rt.logs.join("")) as Record<string, unknown>;
    expect(parsed.error).toBe("Run already completed.");
  });

  // --- Cancel vs reject ---

  it("resumes a cancelled run with --yes (re-approval, no re-plan)", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-cancelled-ws-"));
    saveRun(
      makeRun({
        runId: "cancelled-run",
        state: "cancelled",
        plan: samplePlan,
        workingDir: workDir,
      }),
    );
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("cancelled-run", { yes: true }, rt);
    expect(result).toBeDefined();
    expect(result!.status).toBe("done");
    expect(mockEnsureWorkingDir).toHaveBeenCalledWith(workDir);
    const persisted = loadRun("cancelled-run", testGoalsDir);
    expect(persisted?.state).toBe("done");
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("persists executing before invoking executor for cancelled resume", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-ordering-ws-"));
    const runId = "resume-ordering";
    saveRun(
      makeRun({
        runId,
        state: "cancelled",
        plan: samplePlan,
        workingDir: workDir,
      }),
    );

    mockExecuteGoalWithAgent.mockImplementationOnce(
      async (params: {
        session: { plan: { steps: Array<{ status: string }> } | null; state: string };
      }) => {
        const persisted = loadRun(runId, testGoalsDir);
        expect(persisted?.state).toBe("executing");
        expect(params.session.state).toBe("executing");
        if (params.session.plan) {
          for (const step of params.session.plan.steps) {
            if (step.status === "pending" || step.status === "blocked") step.status = "done";
          }
        }
        params.session.state = "done";
        return { status: "done", summary: "All tasks completed." };
      },
    );

    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand(runId, { yes: true, quiet: true }, rt);

    expect(result?.status).toBe("done");
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("preserves external cancellation when onTaskUpdate persists during resume", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-cancel-race-ws-"));
    const runId = "resume-cancel-race";
    saveRun(
      makeRun({
        runId,
        state: "cancelled",
        plan: samplePlan,
        workingDir: workDir,
      }),
    );

    mockExecuteGoalWithAgent.mockImplementationOnce(
      async (params: { session: { state: string }; onTaskUpdate?: () => void }) => {
        const persistedBeforeStop = loadRun(runId, testGoalsDir);
        expect(persistedBeforeStop?.state).toBe("executing");

        // Simulate /goal_stop updating run state externally while execution is in progress.
        saveRun({
          ...persistedBeforeStop!,
          state: "cancelled",
          updatedAt: new Date().toISOString(),
        });

        // Simulate a task update callback that triggers goal-resume persistence.
        params.onTaskUpdate?.();

        const persistedAfterUpdate = loadRun(runId, testGoalsDir);
        expect(persistedAfterUpdate?.state).toBe("cancelled");
        expect(params.session.state).toBe("cancelled");

        return { status: "done", summary: "Mock execution complete." };
      },
    );

    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand(runId, { yes: true, quiet: true }, rt);

    expect(result?.status).toBe("done");
    const persisted = loadRun(runId, testGoalsDir);
    expect(persisted?.state).toBe("cancelled");

    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("resumes a cancelled run interactively — explicit No keeps cancelled", async () => {
    saveRun(
      makeRun({
        runId: "cancelled-reprompt",
        state: "cancelled",
        plan: samplePlan,
      }),
    );
    mockConfirm.mockResolvedValueOnce(false);
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("cancelled-reprompt", {}, rt);
    expect(result).toEqual({ status: "cancelled" });
    expect(rt.logs.join("\n")).toContain("Plan rejected.");
    const persisted = loadRun("cancelled-reprompt", testGoalsDir);
    expect(persisted?.state).toBe("cancelled");
  });

  it("confirm throw during resume persists cancelled state", async () => {
    saveRun(
      makeRun({
        runId: "cancel-throw",
        state: "awaiting_approval",
        plan: samplePlan,
      }),
    );
    mockConfirm.mockRejectedValueOnce(new Error("SIGINT"));
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("cancel-throw", {}, rt);
    expect(result).toEqual({ status: "cancelled" });
    expect(rt.logs.join("\n")).toContain("Cancelled.");
    const persisted = loadRun("cancel-throw", testGoalsDir);
    expect(persisted?.state).toBe("cancelled");
  });

  it("isCancel symbol during resume persists cancelled state", async () => {
    saveRun(
      makeRun({
        runId: "cancel-symbol",
        state: "awaiting_approval",
        plan: samplePlan,
      }),
    );
    mockConfirm.mockResolvedValueOnce(Symbol("cancel"));
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("cancel-symbol", {}, rt);
    expect(result).toEqual({ status: "cancelled" });
    expect(rt.logs.join("\n")).toContain("Cancelled.");
    const persisted = loadRun("cancel-symbol", testGoalsDir);
    expect(persisted?.state).toBe("cancelled");
  });

  it("JSON-mode error sets non-zero exit code via runCommandWithRuntime", async () => {
    const saved = process.exitCode;
    process.exitCode = undefined;
    try {
      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();

      await runCommandWithRuntime(rt, async () => {
        await goalResumeCommand("not-a-real-id", { json: true }, rt);
      });

      expect(process.exitCode).toBe(1);

      // stdout is strict JSON
      const raw = rt.logs.join("");
      expect(raw.trimStart()[0]).toBe("{");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed.error).toContain("Run not found");

      // No stderr output
      expect(rt.errors).toHaveLength(0);
    } finally {
      process.exitCode = saved;
    }
  });

  it("warns once when explicit claude backend override is used in degraded planner mode", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-degraded-warning-ws-"));
    saveRun(
      makeRun({
        runId: "resume-degraded-warning",
        state: "awaiting_approval",
        plan: samplePlan,
        workingDir: workDir,
        backendOverride: "claude_code",
        plannerDegradedReason: "anthropic_usage_limit",
      }),
    );

    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("resume-degraded-warning", { yes: true }, rt);

    expect(result?.status).toBe("done");
    const warningLogs = rt.logs.filter((line) =>
      line.includes("overriding that safeguard for this execution."),
    );
    expect(warningLogs).toHaveLength(1);

    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("quiet mode suppresses progress output but preserves return value", async () => {
    // This test verifies quiet mode by using a run with all steps already done
    // (no agent executor needed — resumableSteps === 0)
    const donePlan: Plan = {
      goal: "Test goal",
      summary: "Already done plan",
      steps: [
        {
          id: "1",
          description: "Create dir",
          dependsOn: [],
          status: "done",
          durationMinutes: 1,
        },
      ],
    };

    saveRun(
      makeRun({
        runId: "quiet-run",
        state: "awaiting_approval",
        plan: donePlan,
        stepResults: {
          "1": { stepId: "1", success: true, output: "Created", durationMs: 1 },
        },
      }),
    );

    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("quiet-run", { yes: true, quiet: true }, rt);

    // Return value is still correct
    expect(result).toBeDefined();
    expect(result!.status).toBe("done");

    // No progress/transcript output printed — quiet suppresses everything
    expect(rt.logs).toHaveLength(0);

    // State still persisted
    const persisted = loadRun("quiet-run", testGoalsDir);
    expect(persisted?.state).toBe("done");
  });

  it("non-quiet mode prints plan and status output for same scenario", async () => {
    const donePlan: Plan = {
      goal: "Test goal",
      summary: "Already done plan",
      steps: [
        {
          id: "1",
          description: "Create dir",
          dependsOn: [],
          status: "done",
          durationMinutes: 1,
        },
      ],
    };

    saveRun(
      makeRun({
        runId: "loud-run",
        state: "awaiting_approval",
        plan: donePlan,
        stepResults: {
          "1": { stepId: "1", success: true, output: "Created", durationMs: 1 },
        },
      }),
    );

    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("loud-run", { yes: true }, rt);

    // Return value is the same
    expect(result).toBeDefined();
    expect(result!.status).toBe("done");

    // Non-quiet mode DOES print output
    const allLogs = rt.logs.join("\n");
    expect(allLogs).toContain("All steps already completed.");
  });

  it("resume after answering runs remaining steps", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-answered-ws-"));
    // Start with a blocked run that has a pending step
    saveRun(
      makeRun({
        runId: "answered-run",
        state: "blocked",
        plan: samplePlan,
        blocked: { blockedAt: "execution", prompt: "Need input", requiredInputKey: "some_key" },
        workingDir: workDir,
      }),
    );

    // Answer the question — auto-resumes blocked runs via goalResumeCommand
    const { goalAnswerCommand } = await import("./goal-answer.js");
    const answerRt = mockRuntime();
    const result = await goalAnswerCommand(
      "answered-run",
      { key: "some_key", value: "the_answer" },
      answerRt,
    );

    // Auto-resume should complete the run
    expect(result).toBeDefined();
    expect(result!.status).toBe("done");

    const finalRun = loadRun("answered-run", testGoalsDir);
    expect(finalRun?.state).toBe("done");
    expect(finalRun!.answers.some_key).toBe("the_answer");
    expect(finalRun!.blocked).toBeNull();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  // --- Replan functionality tests ---

  describe("--replan flag", () => {
    it("retries planning for a run in 'planning' state", async () => {
      mockRunCliPlanning.mockResolvedValueOnce({
        status: "success",
        plan: {
          workingDir: "/tmp/ws",
          summary: "Replanned successfully",
          steps: [
            {
              id: "replanned-step",
              description: "A replanned task",
              dependsOn: [],
              durationMinutes: 30,
              status: "pending",
            },
          ],
          goal: "Original goal text",
        },
        scoutStatus: "success",
      });

      saveRun(
        makeRun({
          runId: "planning-stuck",
          state: "planning",
          goal: "Original goal text",
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      const result = await goalResumeCommand("planning-stuck", { replan: true }, rt);

      // Should not auto-execute, just transition to awaiting_approval
      expect(result).toBeUndefined();
      const persisted = loadRun("planning-stuck", testGoalsDir);
      expect(persisted?.state).toBe("awaiting_approval");
      expect(persisted?.plan).toBeDefined();
      expect(persisted?.plan?.summary).toBe("Replanned successfully");
      expect(persisted?.plan?.steps).toHaveLength(1);
      expect(persisted?.scoutStatus).toBe("success");
      expect(rt.logs.join("\n")).toContain("Replanned successfully");
    });

    it("updates run.workingDir from replanned plan output", async () => {
      const runId = "replan-workingdir-update";
      const oldWorkingDir = "/tmp/ws-old";
      const newWorkingDir = "/tmp/ws-new";
      mockRunCliPlanning.mockResolvedValueOnce({
        status: "success",
        plan: {
          goal: "Original goal text",
          workingDir: newWorkingDir,
          summary: "Replanned to a new workspace",
          steps: [
            {
              id: "replanned-step",
              description: "A replanned task",
              dependsOn: [],
              durationMinutes: 30,
              status: "pending",
            },
          ],
        },
        scoutStatus: "success",
      });

      saveRun(
        makeRun({
          runId,
          state: "planning",
          goal: "Original goal text",
          workingDir: oldWorkingDir,
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      await goalResumeCommand(runId, { replan: true, quiet: true }, rt);

      expect(mockRunCliPlanning).toHaveBeenCalledWith({
        runId,
        goalText: "Original goal text",
        cwd: oldWorkingDir,
        includeScoutArtifacts: true,
      });
      const persisted = loadRun(runId, testGoalsDir);
      expect(persisted?.workingDir).toBe(newWorkingDir);
      expect(persisted?.plan?.workingDir).toBe(newWorkingDir);
    });

    it("logs planner fallback notice with reset hint and persists degraded metadata on replan", async () => {
      mockRunCliPlanning.mockResolvedValueOnce({
        status: "success",
        plan: {
          workingDir: "/tmp/ws",
          summary: "Replanned with codex fallback",
          steps: [
            {
              id: "replanned-step",
              description: "A replanned task",
              dependsOn: [],
              durationMinutes: 30,
              status: "pending",
            },
          ],
          goal: "Original goal text",
        },
        scoutStatus: "success",
        plannerBackendUsed: "codex",
        plannerDegradedReason: "anthropic_usage_limit",
        plannerDegradedResetHint: "resets 6pm (America/Toronto)",
      });

      saveRun(
        makeRun({
          runId: "planning-degraded",
          state: "planning",
          goal: "Original goal text",
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      await goalResumeCommand("planning-degraded", { replan: true }, rt);

      expect(
        rt.logs.some(
          (line) =>
            line.includes("Planner notice: Anthropic usage limit reached") &&
            line.includes("resets 6pm (America/Toronto)") &&
            line.includes("Falling back to Codex planning for this run."),
        ),
      ).toBe(true);

      const persisted = loadRun("planning-degraded", testGoalsDir);
      expect(persisted?.plannerBackendUsed).toBe("codex");
      expect(persisted?.plannerDegradedReason).toBe("anthropic_usage_limit");
      expect(persisted?.plannerDegradedResetHint).toBe("resets 6pm (America/Toronto)");
    });

    it("retries planning for a cancelled run with no plan", async () => {
      mockRunCliPlanning.mockResolvedValueOnce({
        status: "success",
        plan: {
          workingDir: "/tmp/ws",
          summary: "Recovery plan",
          steps: [
            {
              id: "recovery-step",
              description: "Recovered from failure",
              dependsOn: [],
              durationMinutes: 20,
              status: "pending",
            },
          ],
          goal: "Goal that failed during planning",
        },
        scoutStatus: "success",
      });

      saveRun(
        makeRun({
          runId: "failed-planning",
          state: "cancelled",
          goal: "Goal that failed during planning",
          lastError: "Rate limit hit during planning",
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      await goalResumeCommand("failed-planning", { replan: true }, rt);

      const persisted = loadRun("failed-planning", testGoalsDir);
      expect(persisted?.state).toBe("awaiting_approval");
      expect(persisted?.lastError).toBeUndefined();
      expect(persisted?.plan?.summary).toBe("Recovery plan");
    });

    it("suggests --replan when planning state encountered without flag", async () => {
      saveRun(
        makeRun({
          runId: "planning-no-replan",
          state: "planning",
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      const result = await goalResumeCommand("planning-no-replan", {}, rt);

      expect(result).toBeUndefined();
      expect(rt.errors.join("\n")).toContain("incomplete state");
      expect(rt.errors.join("\n")).toContain("--replan");
    });

    it("suggests --replan when cancelled run with no plan encountered without flag", async () => {
      saveRun(
        makeRun({
          runId: "failed-no-replan",
          state: "cancelled",
          lastError: "Network error during planning",
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      const result = await goalResumeCommand("failed-no-replan", {}, rt);

      expect(result).toBeUndefined();
      expect(rt.errors.join("\n")).toContain("Run has no plan");
      expect(rt.errors.join("\n")).toContain("--replan");
    });

    it("handles replanning that results in blocked", async () => {
      mockRunCliPlanning.mockResolvedValueOnce({
        status: "blocked",
        question: "Need more info about the database",
        scoutStatus: "needs_clarification",
      });

      saveRun(
        makeRun({
          runId: "replan-blocked",
          state: "planning",
          goal: "Complex goal needing clarification",
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      const result = await goalResumeCommand("replan-blocked", { replan: true }, rt);

      expect(result).toBeDefined();
      expect(result?.status).toBe("blocked");
      expect(result?.question).toBe("Need more info about the database");

      const persisted = loadRun("replan-blocked", testGoalsDir);
      expect(persisted?.state).toBe("blocked");
      expect(persisted?.blocked?.prompt).toBe("Need more info about the database");
      expect(persisted?.scoutStatus).toBe("needs_clarification");
    });

    it("persists error when replanning fails again", async () => {
      mockRunCliPlanning.mockRejectedValueOnce(new Error("Still rate limited"));

      saveRun(
        makeRun({
          runId: "replan-fails",
          state: "planning",
          goal: "Goal that keeps failing",
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      const result = await goalResumeCommand("replan-fails", { replan: true }, rt);

      expect(result).toBeUndefined();
      expect(rt.errors.join("\n")).toContain("Planning failed");

      const persisted = loadRun("replan-fails", testGoalsDir);
      expect(persisted?.state).toBe("planning");
      expect(persisted?.lastError).toContain("Still rate limited");
    });

    it("--replan works in JSON mode", async () => {
      mockRunCliPlanning.mockResolvedValueOnce({
        status: "success",
        plan: {
          workingDir: "/tmp/ws",
          summary: "JSON mode replan",
          steps: [
            {
              id: "json-step",
              description: "A step",
              dependsOn: [],
              durationMinutes: 15,
              status: "pending",
            },
          ],
          goal: "Goal for JSON mode test",
        },
        scoutStatus: "success",
      });

      saveRun(
        makeRun({
          runId: "replan-json",
          state: "planning",
          goal: "Goal for JSON mode test",
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      await goalResumeCommand("replan-json", { replan: true, json: true }, rt);

      const raw = rt.logs.join("");
      expect(raw.trimStart()[0]).toBe("{");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed.status).toBe("awaiting_approval");
      expect(parsed.runId).toBe("replan-json");
      expect(parsed.stepCount).toBe(1);

      const persisted = loadRun("replan-json", testGoalsDir);
      expect(persisted?.state).toBe("awaiting_approval");
      expect(persisted?.plan?.summary).toBe("JSON mode replan");
    });

    it("--replan in quiet mode suppresses output", async () => {
      mockRunCliPlanning.mockResolvedValueOnce({
        status: "success",
        plan: {
          workingDir: "/tmp/ws",
          summary: "Quiet replan",
          steps: [
            {
              id: "quiet-step",
              description: "Silently replanned",
              dependsOn: [],
              durationMinutes: 10,
              status: "pending",
            },
          ],
          goal: "Quiet mode goal",
        },
        scoutStatus: "success",
      });

      saveRun(
        makeRun({
          runId: "replan-quiet",
          state: "planning",
          goal: "Quiet mode goal",
          lastError: "Previous planning failure",
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      await goalResumeCommand("replan-quiet", { replan: true, quiet: true }, rt);

      // Quiet mode should suppress most output except critical info
      expect(rt.logs.length).toBeLessThan(3);

      const persisted = loadRun("replan-quiet", testGoalsDir);
      expect(persisted?.state).toBe("awaiting_approval");
      expect(persisted?.plan?.summary).toBe("Quiet replan");
    });

    it("calls unified CLI planner when replanning", async () => {
      const runId = "replan-check-call";

      mockRunCliPlanning.mockResolvedValueOnce({
        status: "success",
        plan: {
          workingDir: "/tmp/ws",
          summary: "Generated plan",
          steps: [
            {
              id: "generated-step",
              description: "A generated task",
              dependsOn: [],
              durationMinutes: 25,
              status: "pending",
            },
          ],
          goal: "Goal text",
        },
        scoutStatus: "success",
      });

      saveRun(
        makeRun({
          runId,
          state: "planning",
          goal: "Goal text",
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      await goalResumeCommand(runId, { replan: true }, rt);

      expect(mockRunCliPlanning).toHaveBeenCalledWith({
        runId,
        goalText: "Goal text",
        cwd: "/tmp/ws",
        includeScoutArtifacts: true,
      });

      const persisted = loadRun(runId, testGoalsDir);
      expect(persisted?.state).toBe("awaiting_approval");
      expect(persisted?.plan?.summary).toBe("Generated plan");
    });

    it("loads canonical scout artifact names when replanning", async () => {
      const runId = "replan-canonical-scout";
      const scoutDir = path.join(testGoalsDir, runId, "scout");
      fs.mkdirSync(scoutDir, { recursive: true });
      fs.writeFileSync(
        path.join(scoutDir, "scout_report.json"),
        '{"goal_id":"g","nodes":[],"edges":[]}',
        "utf8",
      );
      fs.writeFileSync(path.join(scoutDir, "plan_draft.md"), "canonical plan draft", "utf8");

      saveRun(
        makeRun({
          runId,
          state: "planning",
          goal: "Goal text",
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      await goalResumeCommand(runId, { replan: true }, rt);

      expect(rt.logs.join("\n")).toContain("Replanning with cached scout data...");
    });

    it("falls back to legacy scout artifact names when replanning", async () => {
      const runId = "replan-legacy-scout";
      const scoutDir = path.join(testGoalsDir, runId, "scout");
      fs.mkdirSync(scoutDir, { recursive: true });
      fs.writeFileSync(
        path.join(scoutDir, "report.json"),
        '{"goal_id":"g","nodes":[],"edges":[]}',
        "utf8",
      );
      fs.writeFileSync(path.join(scoutDir, "plan.md"), "legacy plan draft", "utf8");

      saveRun(
        makeRun({
          runId,
          state: "planning",
          goal: "Goal text",
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      await goalResumeCommand(runId, { replan: true }, rt);

      expect(rt.logs.join("\n")).toContain("Replanning with cached scout data...");
    });

    it("falls back to legacy scout artifacts when canonical artifacts are incomplete", async () => {
      const runId = "replan-legacy-partial-canonical";
      const scoutDir = path.join(testGoalsDir, runId, "scout");
      fs.mkdirSync(scoutDir, { recursive: true });

      // Canonical artifact set is incomplete (missing plan_draft.md).
      fs.writeFileSync(
        path.join(scoutDir, "scout_report.json"),
        '{"goal_id":"g","nodes":[],"edges":[]}',
        "utf8",
      );

      // Legacy pair is complete and should be accepted as fallback.
      fs.writeFileSync(
        path.join(scoutDir, "report.json"),
        '{"goal_id":"g","nodes":[],"edges":[]}',
        "utf8",
      );
      fs.writeFileSync(path.join(scoutDir, "plan.md"), "legacy fallback draft", "utf8");

      saveRun(
        makeRun({
          runId,
          state: "planning",
          goal: "Goal text",
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      await goalResumeCommand(runId, { replan: true }, rt);

      expect(rt.logs.join("\n")).toContain("Replanning with cached scout data...");
    });

    it("preserves --no-scout mode on replanning", async () => {
      const runId = "replan-no-scout";
      mockRunCliPlanning.mockResolvedValueOnce({
        status: "success",
        plan: {
          workingDir: "/tmp/ws",
          summary: "No scout replan",
          steps: [
            {
              id: "ns-step",
              description: "No scout task",
              dependsOn: [],
              durationMinutes: 12,
              status: "pending",
            },
          ],
          goal: "Goal text",
        },
        scoutStatus: "skipped",
        scoutSkipReason: "--no-scout flag",
      });

      saveRun(
        makeRun({
          runId,
          state: "planning",
          goal: "Goal text",
          scoutStatus: "skipped",
          scoutSkipReason: "--no-scout flag",
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      await goalResumeCommand(runId, { replan: true }, rt);

      expect(mockRunCliPlanning).toHaveBeenCalledWith({
        runId,
        goalText: "Goal text",
        cwd: "/tmp/ws",
        includeScoutArtifacts: false,
      });
      expect(rt.logs.join("\n")).toContain("Replanning (--no-scout mode)...");
    });
  });
});
