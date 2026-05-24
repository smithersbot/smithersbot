import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonExitError, runCommandWithRuntime } from "../cli/cli-utils.js";
import { saveRun, loadRun } from "../goal/run-store.js";
import { computeDisplayStatuses } from "../goal/execution-status.js";
import type { BackendAvailability } from "../goal/backend-types.js";
import type { Plan, PlanStep, SerializedRun } from "../goal/types.js";
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

// Preserve the real module exports (e.g. hasAnswerForTask, used by the resume
// normalization in goal-resume.ts) and override only the executor entry point.
vi.mock("../goal/agent-executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../goal/agent-executor.js")>();
  return {
    ...actual,
    executeGoalWithAgent: (...args: unknown[]) => mockExecuteGoalWithAgent(...args),
  };
});

// Control backend availability without spawning real codex/claude probes.
// Keep the real isBackendAvailable so the resume recheck + pickFallbackBackend
// exercise their actual selection logic against the mocked availability table.
const ALL_BACKENDS_AVAILABLE: BackendAvailability[] = [
  { id: "pi", available: true },
  { id: "codex", available: true },
  { id: "claude_code", available: true },
];
let mockAvailability: BackendAvailability[] = [...ALL_BACKENDS_AVAILABLE];
vi.mock("../goal/backend-availability.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../goal/backend-availability.js")>();
  return {
    ...actual,
    detectBackendAvailability: () => mockAvailability,
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

/**
 * Simulate the run lock that the real resume caller (Telegram/CLI handler via
 * acquireGoalOpLock) holds for the duration of an execution. Without it,
 * loadRun() treats a persisted "executing" run as a crashed/stale run and
 * downgrades it to "blocked" for recovery — which is correct production
 * behaviour but defeats tests that drive goalResumeCommand directly.
 */
function createRunLock(runId: string): void {
  const lockDir = path.join(testGoalsDir, ".locks", "runs");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, `${runId}.lock`), JSON.stringify({ pid: process.pid }));
}

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
    mockAvailability = [...ALL_BACKENDS_AVAILABLE];
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

  it("retries execution-time none blocks without requiring /goal_answer", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-none-blocked-ws-"));
    saveRun(
      makeRun({
        runId: "blocked-none-run",
        state: "blocked",
        plan: {
          goal: "Test goal",
          summary: "No input key retry",
          steps: [
            {
              id: "pending-step",
              description: "Continue execution",
              dependsOn: [],
              status: "pending",
              durationMinutes: 1,
            },
          ],
        },
        blocked: {
          blockedAt: "execution",
          prompt: "Final build gate failed.\nCommand: pnpm build",
          requiredInputKey: "none",
        },
        workingDir: workDir,
      }),
    );

    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("blocked-none-run", { yes: true, quiet: true }, rt);

    expect(result?.status).toBe("done");
    expect(mockExecuteGoalWithAgent).toHaveBeenCalledTimes(1);
    const persisted = loadRun("blocked-none-run", testGoalsDir);
    expect(persisted?.state).toBe("done");
    expect(persisted?.blocked).toBeNull();

    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("passes config goal.claudeCodeAuth to agent executor", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-auth-propagation-ws-"));
    saveRun(
      makeRun({
        runId: "resume-auth-propagation-run",
        state: "blocked",
        plan: {
          goal: "Test goal",
          summary: "Auth propagation",
          steps: [
            {
              id: "pending-step",
              description: "Continue execution",
              dependsOn: [],
              status: "pending",
              durationMinutes: 1,
            },
          ],
        },
        blocked: {
          blockedAt: "execution",
          prompt: "Resume after interruption",
          requiredInputKey: "none",
        },
        workingDir: workDir,
      }),
    );

    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    await goalResumeCommand(
      "resume-auth-propagation-run",
      {
        yes: true,
        quiet: true,
        config: { goal: { claudeCodeAuth: "api_key" } },
      },
      rt,
    );

    expect(mockExecuteGoalWithAgent).toHaveBeenCalledTimes(1);
    expect(mockExecuteGoalWithAgent.mock.calls[0]?.[0]).toMatchObject({
      claudeCodeAuth: "api_key",
    });

    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("retries failed final build gate instead of short-circuiting completed steps", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-final-gate-ws-"));
    const runId = "blocked-final-gate-run";
    saveRun(
      makeRun({
        runId,
        state: "blocked",
        plan: {
          goal: "Test goal",
          summary: "All steps done but final gate failed",
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
        stepResults: {
          "done-step": {
            stepId: "done-step",
            success: true,
            output: "Done",
            durationMs: 1,
          },
        },
        blocked: {
          blockedAt: "execution",
          prompt: "Final build gate failed.\nCommand: pnpm build",
          requiredInputKey: "none",
        },
        buildGateResults: {
          __final__: {
            passed: false,
            failedCommand: "pnpm build",
            output: "Build failed",
            timestamp: "2026-01-30T00:00:00.000Z",
          },
        },
        workingDir: workDir,
      }),
    );

    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand(runId, { yes: true, quiet: true }, rt);

    expect(result).toEqual({ status: "done", summary: "All tasks completed." });
    expect(mockExecuteGoalWithAgent).toHaveBeenCalledTimes(1);
    const persisted = loadRun(runId, testGoalsDir);
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
    // Simulate the run lock the real caller holds while execution is in flight,
    // so loadRun() reports the persisted "executing" state instead of
    // downgrading it to "blocked" as a crashed run.
    createRunLock(runId);

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
    // Hold the run lock so the in-flight "executing" state is not downgraded.
    createRunLock(runId);

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

    it("returns cancelled and does not save plan when run is stopped during replan", async () => {
      const runId = "planning-cancelled-during-replan";
      const plannerWorkingDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "resume-replan-cancelled-planner-ws-"),
      );

      mockRunCliPlanning.mockImplementationOnce(
        async ({ runId: plannerRunId }: { runId: string }) => {
          const existingRun = loadRun(plannerRunId, testGoalsDir);
          expect(existingRun?.state).toBe("planning");
          saveRun({ ...existingRun!, state: "cancelled" }, testGoalsDir);
          return {
            status: "success",
            plan: {
              goal: "Should not persist after stop",
              workingDir: plannerWorkingDir,
              summary: "Replanned after stop",
              steps: [
                {
                  id: "replanned-step",
                  description: "A replanned task",
                  dependsOn: [],
                  status: "pending",
                  durationMinutes: 30,
                },
              ],
            },
            scoutStatus: "success",
          };
        },
      );

      saveRun(
        makeRun({
          runId,
          state: "planning",
          goal: "Stop me during replan",
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      const result = await goalResumeCommand(runId, { replan: true }, rt);

      expect(result).toEqual({ status: "cancelled" });
      const persisted = loadRun(runId, testGoalsDir);
      expect(persisted?.state).toBe("cancelled");
      expect(persisted?.plan).toBeNull();
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
        claudeCodeAuth: "subscription",
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
        claudeCodeAuth: "subscription",
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
      expect(mockRunCliPlanning).toHaveBeenCalledWith(
        expect.objectContaining({
          runId,
          includeScoutArtifacts: true,
          scoutData: {
            status: "success",
            report: { goal_id: "g", nodes: [], edges: [] },
            planDraft: "canonical plan draft",
          },
        }),
      );
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
      expect(mockRunCliPlanning).toHaveBeenCalledWith(
        expect.objectContaining({
          runId,
          includeScoutArtifacts: true,
          scoutData: {
            status: "success",
            report: { goal_id: "g", nodes: [], edges: [] },
            planDraft: "legacy plan draft",
          },
        }),
      );
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
      expect(mockRunCliPlanning).toHaveBeenCalledWith(
        expect.objectContaining({
          runId,
          includeScoutArtifacts: true,
          scoutData: {
            status: "success",
            report: { goal_id: "g", nodes: [], edges: [] },
            planDraft: "legacy fallback draft",
          },
        }),
      );
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
        claudeCodeAuth: "subscription",
        includeScoutArtifacts: false,
      });
      expect(mockRunCliPlanning.mock.calls[0]?.[0]).not.toHaveProperty("scoutData");
      expect(rt.logs.join("\n")).toContain("Replanning (--no-scout mode)...");
    });
  });

  // --- Usage-limit backend recheck on resume ---

  describe("usage-limit backend recheck", () => {
    it("recheckUsageLimitBackends retargets a usage-limit step to an available alternate", async () => {
      const { recheckUsageLimitBackends } = await import("./goal-resume.js");
      const steps: PlanStep[] = [
        {
          id: "codex-step",
          description: "Hit codex usage limit",
          dependsOn: [],
          status: "blocked",
          blockedReason: "out_of_credits",
          executedBackend: "codex",
        },
      ];
      const result = recheckUsageLimitBackends({
        steps,
        availability: [
          { id: "pi", available: true },
          { id: "codex", available: false, reason: "codex not found on PATH" },
          { id: "claude_code", available: true },
        ],
        enabledWorkers: ["codex", "claude_code"],
      });

      expect(result.reassigned).toEqual(["codex-step"]);
      expect(result.stillBlocked).toEqual([]);
      expect(steps[0]!.executedBackend).toBe("claude_code");
      // The block classification is preserved (only the target backend changes).
      expect(steps[0]!.blockedReason).toBe("out_of_credits");
      expect(steps[0]!.status).toBe("blocked");
    });

    it("recheckUsageLimitBackends leaves a step usage-limit blocked when no compatible backend is available", async () => {
      const { recheckUsageLimitBackends } = await import("./goal-resume.js");
      const steps: PlanStep[] = [
        {
          id: "codex-only",
          description: "No fallback available",
          dependsOn: [],
          status: "blocked",
          blockedReason: "usage_limit",
          blockedQuestion: "Codex is out of credits.",
          executedBackend: "codex",
        },
      ];
      const result = recheckUsageLimitBackends({
        steps,
        availability: [
          { id: "pi", available: true },
          { id: "codex", available: false, reason: "codex not found on PATH" },
          { id: "claude_code", available: false, reason: "claude not found on PATH" },
        ],
        enabledWorkers: ["codex", "claude_code"],
      });

      expect(result.reassigned).toEqual([]);
      expect(result.stillBlocked).toEqual(["codex-only"]);
      // Stays a usage-limit blocker — never downgraded to "error" or user-input.
      expect(steps[0]!.status).toBe("blocked");
      expect(steps[0]!.blockedReason).toBe("usage_limit");
      expect(steps[0]!.executedBackend).toBe("codex");
    });

    it("recheckUsageLimitBackends leaves a step alone when its sticky backend is available again", async () => {
      const { recheckUsageLimitBackends } = await import("./goal-resume.js");
      const steps: PlanStep[] = [
        {
          id: "codex-step",
          description: "Limit may have reset",
          dependsOn: [],
          status: "blocked",
          blockedReason: "rate_limit",
          executedBackend: "codex",
        },
      ];
      const result = recheckUsageLimitBackends({
        steps,
        availability: [...ALL_BACKENDS_AVAILABLE],
        enabledWorkers: ["codex", "claude_code"],
      });

      expect(result.reassigned).toEqual([]);
      expect(result.stillBlocked).toEqual([]);
      // Executor will retry on codex (and fall back at runtime if it limits again).
      expect(steps[0]!.executedBackend).toBe("codex");
    });

    it("recheckUsageLimitBackends respects an explicit backendOverride lock", async () => {
      const { recheckUsageLimitBackends } = await import("./goal-resume.js");
      const steps: PlanStep[] = [
        {
          id: "locked-step",
          description: "Pinned to codex",
          dependsOn: [],
          status: "blocked",
          blockedReason: "usage_limit",
          executedBackend: "codex",
        },
      ];
      const result = recheckUsageLimitBackends({
        steps,
        availability: [
          { id: "pi", available: true },
          { id: "codex", available: false, reason: "codex not found on PATH" },
          { id: "claude_code", available: true },
        ],
        enabledWorkers: ["codex", "claude_code"],
        backendOverride: "codex",
      });

      expect(result.reassigned).toEqual([]);
      expect(result.stillBlocked).toEqual(["locked-step"]);
      expect(steps[0]!.executedBackend).toBe("codex");
    });

    it("resume after Codex exhausted with Claude available retries the affected step on Claude", async () => {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-usage-fallback-ws-"));
      const runId = "resume-usage-fallback";
      mockAvailability = [
        { id: "pi", available: true },
        { id: "codex", available: false, reason: "codex not found on PATH" },
        { id: "claude_code", available: true },
      ];
      saveRun(
        makeRun({
          runId,
          state: "blocked",
          plan: {
            goal: "Test goal",
            summary: "Codex out of credits",
            steps: [
              {
                id: "codex-step",
                description: "Ran on codex and hit the usage limit",
                dependsOn: [],
                status: "blocked",
                durationMinutes: 1,
                blockedReason: "out_of_credits",
                blockedQuestion: "Codex is out of credits.",
                executedBackend: "codex",
              },
            ],
          },
          blocked: {
            blockedAt: "execution",
            prompt: "Codex is out of credits.",
            requiredInputKey: "resume_execution",
            stepId: "codex-step",
          },
          stepResults: {
            "codex-step": {
              stepId: "codex-step",
              success: false,
              output: "",
              error: "Codex is out of credits.",
              durationMs: 1,
            },
          },
          workingDir: workDir,
        }),
      );

      let capturedBackend: string | undefined;
      let capturedReason: string | undefined;
      mockExecuteGoalWithAgent.mockImplementationOnce(
        async (params: {
          session: {
            plan: {
              steps: Array<{
                id: string;
                status: string;
                executedBackend?: string;
                blockedReason?: string;
              }>;
            } | null;
            state: string;
          };
        }) => {
          const step = params.session.plan?.steps.find((s) => s.id === "codex-step");
          capturedBackend = step?.executedBackend;
          capturedReason = step?.blockedReason;
          for (const s of params.session.plan?.steps ?? []) {
            if (s.status === "pending" || s.status === "blocked") s.status = "done";
          }
          params.session.state = "done";
          return { status: "done", summary: "All tasks completed." };
        },
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      const result = await goalResumeCommand(runId, { yes: true, quiet: true }, rt);

      expect(result?.status).toBe("done");
      expect(mockExecuteGoalWithAgent).toHaveBeenCalledTimes(1);
      // Step was retargeted to Claude, and its usage-limit reason was preserved
      // through resume (not overwritten with a generic "error").
      expect(capturedBackend).toBe("claude_code");
      expect(capturedReason).toBe("out_of_credits");

      fs.rmSync(workDir, { recursive: true, force: true });
    });

    it("auto-retries a usage-limit block without a fake /goal_answer even with a stale input key", async () => {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-usage-autoretry-ws-"));
      const runId = "resume-usage-autoretry";
      // codex available again here, so no reassignment — this verifies that a
      // usage-limit block is treated as auto-retryable even when the persisted
      // requiredInputKey looks like a user-input key.
      saveRun(
        makeRun({
          runId,
          state: "blocked",
          plan: {
            goal: "Test goal",
            summary: "Codex usage limit, stale input key",
            steps: [
              {
                id: "codex-step",
                description: "Hit codex usage limit",
                dependsOn: [],
                status: "blocked",
                durationMinutes: 1,
                blockedReason: "usage_limit",
                blockedQuestion: "Codex usage limit reached.",
                executedBackend: "codex",
              },
            ],
          },
          blocked: {
            blockedAt: "execution",
            prompt: "Codex usage limit reached.",
            requiredInputKey: "task:codex-step:input",
            stepId: "codex-step",
          },
          stepResults: {
            "codex-step": {
              stepId: "codex-step",
              success: false,
              output: "",
              error: "Codex usage limit reached.",
              durationMs: 1,
            },
          },
          workingDir: workDir,
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      const result = await goalResumeCommand(runId, { yes: true, quiet: true }, rt);

      // No fake answer required: resume runs the executor directly.
      expect(result?.status).toBe("done");
      expect(mockExecuteGoalWithAgent).toHaveBeenCalledTimes(1);
      expect(rt.logs.join("\n")).not.toContain("needs input");

      fs.rmSync(workDir, { recursive: true, force: true });
    });

    it("resume recomputes display state for all nodes, not just the first unblocked task", async () => {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-recompute-ws-"));
      const runId = "resume-recompute-display";
      mockAvailability = [
        { id: "pi", available: true },
        { id: "codex", available: false, reason: "codex not found on PATH" },
        { id: "claude_code", available: true },
      ];
      // 8cec60ca-shaped: a codex usage-limit blocker, an independent stale
      // error-blocked step, a downstream dependent, and an independent pending step.
      saveRun(
        makeRun({
          runId,
          state: "blocked",
          plan: {
            goal: "Test goal",
            summary: "Mixed-backend interruption",
            steps: [
              {
                id: "codex-step",
                description: "Codex usage limit",
                dependsOn: [],
                status: "blocked",
                durationMinutes: 1,
                blockedReason: "out_of_credits",
                blockedQuestion: "Codex is out of credits.",
                executedBackend: "codex",
              },
              {
                id: "indep-error",
                description: "Independent, stale error block",
                dependsOn: [],
                status: "blocked",
                durationMinutes: 1,
                blockedReason: "error",
                blockedQuestion: "Interrupted.",
              },
              {
                id: "downstream",
                description: "Depends on codex-step",
                dependsOn: ["codex-step"],
                status: "blocked",
                durationMinutes: 1,
                blockedReason: "error",
                blockedQuestion: "Interrupted (cascade).",
              },
              {
                id: "indep-pending",
                description: "Independent pending Claude task",
                dependsOn: [],
                status: "pending",
                durationMinutes: 1,
              },
            ],
          },
          blocked: {
            blockedAt: "execution",
            prompt: "Run interrupted by Codex usage limit.",
            requiredInputKey: "resume_execution",
          },
          workingDir: workDir,
        }),
      );

      let capturedDisplay: Map<string, string> | undefined;
      let capturedCodexBackend: string | undefined;
      mockExecuteGoalWithAgent.mockImplementationOnce(
        async (params: { session: { plan: { steps: PlanStep[] } | null; state: string } }) => {
          if (params.session.plan) {
            capturedDisplay = computeDisplayStatuses(params.session.plan.steps);
            capturedCodexBackend = params.session.plan.steps.find(
              (s) => s.id === "codex-step",
            )?.executedBackend;
            for (const s of params.session.plan.steps) {
              if (s.status === "pending" || s.status === "blocked") s.status = "done";
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
      expect(capturedDisplay).toBeDefined();
      // Usage-limit blocker is visibly usage-limited (not pending, not plain blocked).
      expect(capturedDisplay!.get("codex-step")).toBe("usage_limited");
      // Independent stale error block recomputes to runnable (pending), not blocked.
      expect(capturedDisplay!.get("indep-error")).toBe("pending");
      // Downstream of the usage-limit blocker waits (soft_blocked), not stale-blocked.
      expect(capturedDisplay!.get("downstream")).toBe("soft_blocked");
      // Independent runnable Claude task stays runnable while a sibling is blocked.
      expect(capturedDisplay!.get("indep-pending")).toBe("pending");
      // The codex usage-limit step was retargeted to the available Claude backend.
      expect(capturedCodexBackend).toBe("claude_code");

      fs.rmSync(workDir, { recursive: true, force: true });
    });
  });

  // --- Pi backend disabled for launch ---

  describe("pi backend disabled for launch", () => {
    it("remapDisabledPiSteps remaps not-yet-done pi steps to a supported backend", async () => {
      const { remapDisabledPiSteps } = await import("./goal-resume.js");
      const steps: PlanStep[] = [
        {
          id: "pi-pending",
          description: "pi step",
          dependsOn: [],
          status: "pending",
          backend: "pi",
        },
        {
          id: "pi-sticky",
          description: "pi sticky",
          dependsOn: [],
          status: "blocked",
          backend: "pi",
          executedBackend: "pi",
        },
        { id: "pi-done", description: "pi done", dependsOn: [], status: "done", backend: "pi" },
        {
          id: "codex-step",
          description: "codex step",
          dependsOn: [],
          status: "pending",
          backend: "codex",
        },
      ];

      const result = remapDisabledPiSteps({
        steps,
        supportedWorkers: ["claude_code", "codex"],
      });

      expect(result.reassigned).toEqual(["pi-pending", "pi-sticky"]);
      expect(result.rejected).toEqual([]);
      expect(result.target).toBe("claude_code");
      expect(steps[0]!.backend).toBe("claude_code");
      expect(steps[1]!.backend).toBe("claude_code");
      expect(steps[1]!.executedBackend).toBe("claude_code");
      // Completed pi steps are historical and left untouched.
      expect(steps[2]!.backend).toBe("pi");
      // Non-pi steps are not touched.
      expect(steps[3]!.backend).toBe("codex");
    });

    it("remapDisabledPiSteps rejects pi steps when no supported backend is available", async () => {
      const { remapDisabledPiSteps } = await import("./goal-resume.js");
      const steps: PlanStep[] = [
        {
          id: "pi-pending",
          description: "pi step",
          dependsOn: [],
          status: "pending",
          backend: "pi",
        },
      ];

      const result = remapDisabledPiSteps({ steps, supportedWorkers: [] });

      expect(result.reassigned).toEqual([]);
      expect(result.rejected).toEqual(["pi-pending"]);
      expect(result.target).toBeUndefined();
      // Backend is left as pi so the caller can reject the resume cleanly.
      expect(steps[0]!.backend).toBe("pi");
    });

    it("supported worker list excludes pi while Codex and Claude remain available", async () => {
      const { resolveEffectiveEnabledWorkers } = await import("../goal/effective-workers.js");
      const workers = resolveEffectiveEnabledWorkers({
        availability: [
          { id: "pi", available: false, reason: "Pi backend disabled for launch" },
          { id: "codex", available: true },
          { id: "claude_code", available: true },
        ],
      });
      expect(workers).not.toContain("pi");
      expect(workers).toContain("codex");
      expect(workers).toContain("claude_code");
    });

    it("resumes an old run with a pi step by remapping it to a supported backend", async () => {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-pi-remap-ws-"));
      const runId = "resume-pi-remap";
      saveRun(
        makeRun({
          runId,
          state: "cancelled",
          plan: {
            goal: "Test goal",
            summary: "Old run with a pi step",
            steps: [
              {
                id: "pi-step",
                description: "Was assigned to pi",
                dependsOn: [],
                status: "pending",
                durationMinutes: 1,
                backend: "pi",
              },
            ],
          },
          workingDir: workDir,
        }),
      );

      let capturedBackend: string | undefined;
      mockExecuteGoalWithAgent.mockImplementationOnce(
        async (params: {
          session: {
            plan: { steps: Array<{ id: string; status: string; backend?: string }> } | null;
            state: string;
          };
        }) => {
          capturedBackend = params.session.plan?.steps.find((s) => s.id === "pi-step")?.backend;
          for (const s of params.session.plan?.steps ?? []) {
            if (s.status === "pending" || s.status === "blocked") s.status = "done";
          }
          params.session.state = "done";
          return { status: "done", summary: "All tasks completed." };
        },
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      const result = await goalResumeCommand(runId, { yes: true, quiet: true }, rt);

      expect(result?.status).toBe("done");
      // The pi step was remapped to a supported backend before execution.
      expect(capturedBackend).toBe("claude_code");
      const persisted = loadRun(runId, testGoalsDir);
      expect(persisted?.plan?.steps.find((s) => s.id === "pi-step")?.backend).toBe("claude_code");

      fs.rmSync(workDir, { recursive: true, force: true });
    });

    it("rejects resuming a pi-step run when no supported backend is available", async () => {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-pi-reject-ws-"));
      const runId = "resume-pi-reject";
      mockAvailability = [
        { id: "pi", available: false, reason: "Pi backend disabled for launch" },
        { id: "codex", available: false, reason: "codex not found on PATH" },
        { id: "claude_code", available: false, reason: "claude not found on PATH" },
      ];
      saveRun(
        makeRun({
          runId,
          state: "cancelled",
          plan: {
            goal: "Test goal",
            summary: "Old run with a pi step and no fallback",
            steps: [
              {
                id: "pi-step",
                description: "Was assigned to pi",
                dependsOn: [],
                status: "pending",
                durationMinutes: 1,
                backend: "pi",
              },
            ],
          },
          workingDir: workDir,
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      const result = await goalResumeCommand(runId, { yes: true, quiet: true }, rt);

      expect(result).toBeUndefined();
      expect(mockExecuteGoalWithAgent).not.toHaveBeenCalled();
      expect(rt.errors.join("\n")).toContain("pi backend");
      expect(rt.errors.join("\n")).toContain("disabled for launch");

      fs.rmSync(workDir, { recursive: true, force: true });
    });
  });

  // --- Resume recompute: reset stale retryable blocks across ALL nodes ---

  describe("resume recompute (resetRetryableBlockedSteps)", () => {
    it("resets a retryable technical block to pending and clears stale fields", async () => {
      const { resetRetryableBlockedSteps } = await import("./goal-resume.js");
      const steps: PlanStep[] = [
        {
          id: "error-step",
          description: "Interrupted with a technical error",
          dependsOn: [],
          status: "blocked",
          blockedReason: "error",
          blockedQuestion: "Backend unavailable.",
          turnsUsed: 3,
        },
      ];

      const reset = resetRetryableBlockedSteps(steps);

      expect(reset).toEqual(["error-step"]);
      expect(steps[0]!.status).toBe("pending");
      expect(steps[0]!.blockedReason).toBeUndefined();
      expect(steps[0]!.blockedQuestion).toBeUndefined();
      expect(steps[0]!.turnsUsed).toBe(0);
    });

    it("resets every retryable technical reason back to pending", async () => {
      const { resetRetryableBlockedSteps } = await import("./goal-resume.js");
      const reasons = [
        "timeout",
        "auth",
        "network",
        "task_failed",
        "process_lost",
        "turn_limit",
        "error",
        "other",
      ] as const;
      const steps: PlanStep[] = reasons.map((reason, i) => ({
        id: `step-${i}`,
        description: reason,
        dependsOn: [],
        status: "blocked",
        blockedReason: reason,
      }));

      const reset = resetRetryableBlockedSteps(steps);

      expect(reset).toEqual(steps.map((s) => s.id));
      expect(steps.every((s) => s.status === "pending")).toBe(true);
      expect(steps.every((s) => s.blockedReason === undefined)).toBe(true);
    });

    it("leaves usage-limit blocks untouched (owned by the usage-limit recheck)", async () => {
      const { resetRetryableBlockedSteps } = await import("./goal-resume.js");
      const steps: PlanStep[] = [
        {
          id: "u1",
          description: "out of credits",
          dependsOn: [],
          status: "blocked",
          blockedReason: "out_of_credits",
        },
        {
          id: "u2",
          description: "usage limit",
          dependsOn: [],
          status: "blocked",
          blockedReason: "usage_limit",
        },
        {
          id: "u3",
          description: "rate limit",
          dependsOn: [],
          status: "blocked",
          blockedReason: "rate_limit",
        },
      ];

      const reset = resetRetryableBlockedSteps(steps);

      expect(reset).toEqual([]);
      expect(steps.every((s) => s.status === "blocked")).toBe(true);
      expect(steps.map((s) => s.blockedReason)).toEqual([
        "out_of_credits",
        "usage_limit",
        "rate_limit",
      ]);
    });

    it("leaves hard blocks (user_input / no reason) untouched", async () => {
      const { resetRetryableBlockedSteps } = await import("./goal-resume.js");
      const steps: PlanStep[] = [
        {
          id: "ui",
          description: "needs input",
          dependsOn: [],
          status: "blocked",
          blockedReason: "user_input",
          blockedQuestion: "Which DB?",
        },
        {
          id: "noreason",
          description: "reason-less block",
          dependsOn: [],
          status: "blocked",
        },
      ];

      const reset = resetRetryableBlockedSteps(steps);

      expect(reset).toEqual([]);
      expect(steps[0]!.status).toBe("blocked");
      expect(steps[0]!.blockedReason).toBe("user_input");
      expect(steps[0]!.blockedQuestion).toBe("Which DB?");
      expect(steps[1]!.status).toBe("blocked");
    });

    it("leaves done / pending / in_progress untouched", async () => {
      const { resetRetryableBlockedSteps } = await import("./goal-resume.js");
      const steps: PlanStep[] = [
        { id: "d", description: "done", dependsOn: [], status: "done" },
        { id: "p", description: "pending", dependsOn: [], status: "pending" },
        { id: "ip", description: "running", dependsOn: [], status: "in_progress" },
      ];

      const reset = resetRetryableBlockedSteps(steps);

      expect(reset).toEqual([]);
      expect(steps.map((s) => s.status)).toEqual(["done", "pending", "in_progress"]);
    });

    it("keeps only the user-input task blocked while a retryable sibling resets to pending", async () => {
      const { resetRetryableBlockedSteps } = await import("./goal-resume.js");
      const steps: PlanStep[] = [
        {
          id: "ui",
          description: "needs input",
          dependsOn: [],
          status: "blocked",
          blockedReason: "user_input",
        },
        {
          id: "tech",
          description: "retryable",
          dependsOn: [],
          status: "blocked",
          blockedReason: "error",
        },
      ];

      resetRetryableBlockedSteps(steps);

      expect(steps[0]!.status).toBe("blocked");
      expect(steps[1]!.status).toBe("pending");
    });

    it("recomputes display so an independent sibling is pending and a downstream dep waits", async () => {
      const { resetRetryableBlockedSteps } = await import("./goal-resume.js");
      const steps: PlanStep[] = [
        {
          id: "ui",
          description: "hard user-input block",
          dependsOn: [],
          status: "blocked",
          blockedReason: "user_input",
        },
        {
          id: "indep",
          description: "independent retryable block",
          dependsOn: [],
          status: "blocked",
          blockedReason: "error",
        },
        {
          id: "down",
          description: "downstream of the hard block",
          dependsOn: ["ui"],
          status: "blocked",
          blockedReason: "error",
        },
      ];

      resetRetryableBlockedSteps(steps);
      const display = computeDisplayStatuses(steps);

      // Hard block stays blocked; independent retryable becomes runnable; the
      // downstream of an unresolved hard block waits rather than staying blocked.
      expect(display.get("ui")).toBe("blocked");
      expect(display.get("indep")).toBe("pending");
      expect(display.get("down")).toBe("soft_blocked");
    });

    it("recomputes ALL node statuses before execution, not just the first picked task", async () => {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-recompute-all-ws-"));
      const runId = "resume-recompute-all-status";
      mockAvailability = [
        { id: "pi", available: true },
        { id: "codex", available: false, reason: "codex not found on PATH" },
        { id: "claude_code", available: true },
      ];
      saveRun(
        makeRun({
          runId,
          state: "blocked",
          plan: {
            goal: "Test goal",
            summary: "Mixed-backend interruption",
            steps: [
              {
                id: "codex-step",
                description: "Codex usage limit",
                dependsOn: [],
                status: "blocked",
                durationMinutes: 1,
                blockedReason: "out_of_credits",
                blockedQuestion: "Codex is out of credits.",
                executedBackend: "codex",
              },
              {
                id: "indep-error",
                description: "Independent, stale error block",
                dependsOn: [],
                status: "blocked",
                durationMinutes: 1,
                blockedReason: "error",
                blockedQuestion: "Interrupted.",
              },
              {
                id: "downstream",
                description: "Depends on codex-step",
                dependsOn: ["codex-step"],
                status: "blocked",
                durationMinutes: 1,
                blockedReason: "error",
                blockedQuestion: "Interrupted (cascade).",
              },
              {
                id: "indep-pending",
                description: "Independent pending task",
                dependsOn: [],
                status: "pending",
                durationMinutes: 1,
              },
            ],
          },
          blocked: {
            blockedAt: "execution",
            prompt: "Run interrupted by Codex usage limit.",
            requiredInputKey: "resume_execution",
          },
          workingDir: workDir,
        }),
      );

      let captured:
        | Map<string, { status: string; blockedReason?: string; executedBackend?: string }>
        | undefined;
      mockExecuteGoalWithAgent.mockImplementationOnce(
        async (params: { session: { plan: { steps: PlanStep[] } | null; state: string } }) => {
          if (params.session.plan) {
            captured = new Map(
              params.session.plan.steps.map((s) => [
                s.id,
                {
                  status: s.status,
                  blockedReason: s.blockedReason,
                  executedBackend: s.executedBackend,
                },
              ]),
            );
            for (const s of params.session.plan.steps) {
              if (s.status === "pending" || s.status === "blocked") s.status = "done";
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
      expect(captured).toBeDefined();
      // Usage-limit blocker: still blocked, reason preserved, retargeted to Claude.
      expect(captured!.get("codex-step")).toEqual({
        status: "blocked",
        blockedReason: "out_of_credits",
        executedBackend: "claude_code",
      });
      // Independent + downstream technical blocks are reset to pending (not stale).
      expect(captured!.get("indep-error")?.status).toBe("pending");
      expect(captured!.get("indep-error")?.blockedReason).toBeUndefined();
      expect(captured!.get("downstream")?.status).toBe("pending");
      expect(captured!.get("downstream")?.blockedReason).toBeUndefined();
      // Already-pending sibling is unchanged.
      expect(captured!.get("indep-pending")?.status).toBe("pending");

      fs.rmSync(workDir, { recursive: true, force: true });
    });

    it("leaves a cancelled goal cancelled and does not reset its blocked steps when rejected", async () => {
      saveRun(
        makeRun({
          runId: "resume-recompute-cancelled",
          state: "cancelled",
          plan: {
            goal: "Test goal",
            summary: "Cancelled with a retryable block",
            steps: [
              {
                id: "blk",
                description: "Retryable but cancelled",
                dependsOn: [],
                status: "blocked",
                durationMinutes: 1,
                blockedReason: "error",
                blockedQuestion: "Interrupted.",
              },
            ],
          },
        }),
      );
      mockConfirm.mockResolvedValueOnce(false);

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      const result = await goalResumeCommand("resume-recompute-cancelled", {}, rt);

      expect(result).toEqual({ status: "cancelled" });
      expect(mockExecuteGoalWithAgent).not.toHaveBeenCalled();
      const persisted = loadRun("resume-recompute-cancelled", testGoalsDir);
      expect(persisted?.state).toBe("cancelled");
      // Rejecting the resume must not resurrect the cancelled goal's blocked step.
      expect(persisted?.plan?.steps.find((s) => s.id === "blk")?.status).toBe("blocked");
    });

    it("completes a done goal with no stale blocked nodes left behind", async () => {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-recompute-done-ws-"));
      const runId = "resume-recompute-done";
      saveRun(
        makeRun({
          runId,
          state: "blocked",
          plan: {
            goal: "Test goal",
            summary: "One done step, one stale retryable block",
            steps: [
              {
                id: "done-step",
                description: "Already done",
                dependsOn: [],
                status: "done",
                durationMinutes: 1,
              },
              {
                id: "stale",
                description: "Stale retryable block",
                dependsOn: ["done-step"],
                status: "blocked",
                durationMinutes: 1,
                blockedReason: "error",
                blockedQuestion: "Interrupted.",
              },
            ],
          },
          stepResults: {
            "done-step": { stepId: "done-step", success: true, output: "Done", durationMs: 1 },
          },
          blocked: {
            blockedAt: "execution",
            prompt: "Run interrupted.",
            requiredInputKey: "resume_execution",
          },
          workingDir: workDir,
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      const result = await goalResumeCommand(runId, { yes: true, quiet: true }, rt);

      expect(result?.status).toBe("done");
      const persisted = loadRun(runId, testGoalsDir);
      expect(persisted?.state).toBe("done");
      // No node is left in a stale blocked state after completion.
      expect(persisted?.plan?.steps.every((s) => s.status === "done")).toBe(true);
      expect(persisted?.blocked).toBeNull();

      fs.rmSync(workDir, { recursive: true, force: true });
    });
  });

  describe("answered user-input normalization (normalizeAnsweredUserInputBlocks)", () => {
    it("collider: resumes two answered user-input parents to pending before execution, no stale blocked node", async () => {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-collider-ws-"));
      const runId = "resume-collider";
      const combinedKey = "tasks:collider-parent-a,collider-parent-b:input";
      saveRun(
        makeRun({
          runId,
          state: "blocked",
          plan: {
            goal: "Test goal",
            summary: "Collider: two answered user-input parents + one child",
            steps: [
              {
                id: "collider-parent-a",
                description: "Parent A blocked for operator detail",
                dependsOn: [],
                status: "blocked",
                durationMinutes: 1,
                blockedReason: "user_input",
                blockedQuestion: "Detail for A?",
                turnsUsed: 2,
              },
              {
                id: "collider-parent-b",
                description: "Parent B blocked for operator detail",
                dependsOn: [],
                status: "blocked",
                durationMinutes: 1,
                blockedReason: "user_input",
                blockedQuestion: "Detail for B?",
                turnsUsed: 2,
              },
              {
                id: "collider-child",
                description: "Child depends on both parents",
                dependsOn: ["collider-parent-a", "collider-parent-b"],
                status: "pending",
                durationMinutes: 1,
              },
            ],
          },
          blocked: {
            blockedAt: "execution",
            prompt: "Two parent steps need operator details.",
            requiredInputKey: combinedKey,
          },
          answers: { [combinedKey]: "operator details for both" },
          workingDir: workDir,
        }),
      );

      let captured: Map<string, { status: string; blockedReason?: string }> | undefined;
      mockExecuteGoalWithAgent.mockImplementationOnce(
        async (params: { session: { plan: { steps: PlanStep[] } | null; state: string } }) => {
          if (params.session.plan) {
            captured = new Map(
              params.session.plan.steps.map((s) => [
                s.id,
                { status: s.status, blockedReason: s.blockedReason },
              ]),
            );
            for (const s of params.session.plan.steps) {
              if (s.status === "pending" || s.status === "blocked") s.status = "done";
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
      expect(captured).toBeDefined();
      // BOTH answered parents were reset to pending before the executor ran —
      // not just the first — with their user-input block fields cleared.
      expect(captured!.get("collider-parent-a")).toEqual({
        status: "pending",
        blockedReason: undefined,
      });
      expect(captured!.get("collider-parent-b")).toEqual({
        status: "pending",
        blockedReason: undefined,
      });
      expect(captured!.get("collider-child")?.status).toBe("pending");
      // No node entered the executor in a hard-blocked state.
      expect([...captured!.values()].some((v) => v.status === "blocked")).toBe(false);

      // The persisted answer is NOT consumed by normalization (scheduler owns that).
      // Since the executor mock here never consumes it, it must survive resume.
      const persisted = loadRun(runId, testGoalsDir);
      expect(persisted?.state).toBe("done");
      expect(persisted?.plan?.steps.every((s) => s.status === "done")).toBe(true);
      expect(persisted?.blocked).toBeNull();

      fs.rmSync(workDir, { recursive: true, force: true });
    });

    it("leaves an unanswered user-input block hard blocked on resume", async () => {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-unanswered-ws-"));
      const runId = "resume-unanswered-userinput";
      saveRun(
        makeRun({
          runId,
          state: "blocked",
          plan: {
            goal: "Test goal",
            summary: "Unanswered user-input block",
            steps: [
              {
                id: "needs-input",
                description: "Needs operator detail, no answer provided",
                dependsOn: [],
                status: "blocked",
                durationMinutes: 1,
                blockedReason: "user_input",
                blockedQuestion: "Which DB?",
              },
            ],
          },
          blocked: {
            blockedAt: "execution",
            prompt: "Needs operator detail.",
            requiredInputKey: "task:needs-input:input",
          },
          workingDir: workDir,
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      const result = await goalResumeCommand(runId, { yes: true, quiet: true }, rt);

      // Without an answer the run stays blocked and the executor is not invoked.
      expect(result?.status).toBe("blocked");
      expect(mockExecuteGoalWithAgent).not.toHaveBeenCalled();
      const persisted = loadRun(runId, testGoalsDir);
      const step = persisted?.plan?.steps.find((s) => s.id === "needs-input");
      expect(step?.status).toBe("blocked");
      expect(step?.blockedReason).toBe("user_input");

      fs.rmSync(workDir, { recursive: true, force: true });
    });

    it("resume_execution technical auto-retry is unaffected (no fake user input)", async () => {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-exec-unaffected-ws-"));
      const runId = "resume-exec-unaffected";
      saveRun(
        makeRun({
          runId,
          state: "blocked",
          plan: {
            goal: "Test goal",
            summary: "Technical block resumed via resume_execution, no answers",
            steps: [
              {
                id: "tech",
                description: "Interrupted with a technical error",
                dependsOn: [],
                status: "blocked",
                durationMinutes: 1,
                blockedReason: "error",
                blockedQuestion: "Interrupted.",
              },
            ],
          },
          blocked: {
            blockedAt: "execution",
            prompt: "Run interrupted.",
            requiredInputKey: "resume_execution",
          },
          workingDir: workDir,
        }),
      );

      let captured: Map<string, { status: string; blockedReason?: string }> | undefined;
      mockExecuteGoalWithAgent.mockImplementationOnce(
        async (params: { session: { plan: { steps: PlanStep[] } | null; state: string } }) => {
          if (params.session.plan) {
            captured = new Map(
              params.session.plan.steps.map((s) => [
                s.id,
                { status: s.status, blockedReason: s.blockedReason },
              ]),
            );
            for (const s of params.session.plan.steps) {
              if (s.status === "pending" || s.status === "blocked") s.status = "done";
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
      // The technical block was reset by resetRetryableBlockedSteps (not by the
      // answered-user-input normalization), exactly as before this change.
      expect(captured!.get("tech")).toEqual({ status: "pending", blockedReason: undefined });

      fs.rmSync(workDir, { recursive: true, force: true });
    });
  });
});
