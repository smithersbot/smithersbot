import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoalSession, Plan, PlanStep, SerializedRun } from "./types.js";
import type { BackendAvailability, GoalBackendId } from "./backend-types.js";
import type { TaskRunnerContext, TaskRunnerResult } from "./task-runner.js";

// --- Mock task runners ---

const mockCliExecute = vi.fn<Promise<TaskRunnerResult>, [TaskRunnerContext]>();
const mockPiExecute = vi.fn<Promise<TaskRunnerResult>, [TaskRunnerContext]>();

class MockCliTaskRunner {
  constructor(_params: unknown) {}
  execute(context: TaskRunnerContext) {
    return mockCliExecute(context);
  }
}

class MockPiTaskRunner {
  constructor(_params: unknown) {}
  execute(context: TaskRunnerContext) {
    return mockPiExecute(context);
  }
}

let availability: BackendAvailability[] = [
  { id: "pi", available: true },
  { id: "codex", available: true },
  { id: "claude_code", available: true },
];

vi.mock("./cli-runner.js", () => ({
  CliTaskRunner: MockCliTaskRunner,
}));

vi.mock("./pi-runner.js", () => ({
  PiTaskRunner: MockPiTaskRunner,
}));

vi.mock("./backend-availability.js", () => ({
  detectBackendAvailability: () => availability,
  isBackendAvailable: (backend: GoalBackendId, avail: BackendAvailability[]) => {
    const entry = avail.find((item) => item.id === backend);
    if (!entry) return { available: false, reason: "Unknown backend" };
    return entry.available ? { available: true } : { available: false, reason: entry.reason };
  },
}));

vi.mock("./attempt-bundle.js", () => ({
  loadAttemptBundles: () => [],
  resolveWorkerDir: () => "/tmp/moltbot-goal-integration-test/worker",
  formatAttemptBundleSummary: () => "previous attempt",
}));

// --- Real run-store backed by temp directory ---

let testGoalsDir: string;

vi.mock("./run-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./run-store.js")>();
  return {
    ...actual,
    resolveGoalsDir: () => testGoalsDir,
    resolveGoalWorkingFile: () => "/tmp/moltbot-goal-integration-test/WORKING.md",
    resolveWorkingFile: () => "/tmp/moltbot-goal-integration-test/step.md",
    loadRun: (runId: string, dir?: string) => actual.loadRun(runId, dir ?? testGoalsDir),
    saveRun: (run: SerializedRun, dir?: string) => actual.saveRun(run, dir ?? testGoalsDir),
    listRuns: (dir?: string) => actual.listRuns(dir ?? testGoalsDir),
    resolveRunId: (partial: string, dir?: string) =>
      actual.resolveRunId(partial, dir ?? testGoalsDir),
    resolveRunDir: (runId: string, dir?: string) =>
      actual.resolveRunDir(runId, dir ?? testGoalsDir),
    sessionToSerialized: actual.sessionToSerialized,
    serializedToSession: actual.serializedToSession,
  };
});

// --- Helpers ---

function makeStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: "1",
    description: "Do thing",
    dependsOn: [],
    status: "pending",
    ...overrides,
  };
}

function makePlan(steps: PlanStep[]): Plan {
  return {
    goal: "Test goal",
    workingDir: "/tmp/moltbot-goal-integration-test",
    summary: "Test plan",
    steps,
  };
}

function makeSession(plan: Plan): GoalSession {
  return {
    goal: plan.goal,
    state: "awaiting_approval",
    plan,
    stepResults: new Map(),
    blocked: null,
    answers: {},
  };
}

function makeSerializedRun(overrides: Partial<SerializedRun> = {}): SerializedRun {
  return {
    runId: "test-run-001",
    goal: "Test goal",
    state: "executing",
    plan: null,
    stepResults: {},
    blocked: null,
    answers: {},
    workingDir: "/tmp/moltbot-goal-integration-test",
    model: undefined,
    dryRun: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as unknown as (code: number) => never,
  };
}

function summaryLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function findLineIndex(lines: string[], prefix: string): number {
  return lines.findIndex((line) => line.startsWith(prefix));
}

describe("goal workflow integration tests", () => {
  beforeEach(() => {
    testGoalsDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-integration-test-"));
    vi.clearAllMocks();
    availability = [
      { id: "pi", available: true },
      { id: "codex", available: true },
      { id: "claude_code", available: true },
    ];
  });

  afterEach(() => {
    fs.rmSync(testGoalsDir, { recursive: true, force: true });
  });

  // =========================================================================
  // 1. Full lifecycle: single task → complete
  // =========================================================================
  describe("complete goal lifecycle", () => {
    it("executes a single-task plan to completion and transitions to done", async () => {
      const step = makeStep({ id: "task-1", backend: "claude_code" });
      const plan = makePlan([step]);
      const session = makeSession(plan);

      mockCliExecute.mockResolvedValueOnce({
        status: "complete",
        summary: "Created index.html",
        turnsUsed: 1,
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const outcome = await executeGoalWithAgent({
        session,
        runId: "lifecycle-single",
        workingDir: "/tmp/moltbot-goal-integration-test",
      });

      expect(outcome.status).toBe("done");
      expect(session.state).toBe("done");
      expect(step.status).toBe("done");
      expect(step.taskSummary).toBe("Created index.html");
      expect(session.stepResults.has("task-1")).toBe(true);
      expect(session.stepResults.get("task-1")!.success).toBe(true);
    });

    it("executes a multi-step plan with dependencies in order", async () => {
      const step1 = makeStep({ id: "1", description: "Setup project", backend: "claude_code" });
      const step2 = makeStep({
        id: "2",
        description: "Write code",
        dependsOn: ["1"],
        backend: "claude_code",
      });
      const step3 = makeStep({
        id: "3",
        description: "Run tests",
        dependsOn: ["2"],
        backend: "claude_code",
      });
      const plan = makePlan([step1, step2, step3]);
      const session = makeSession(plan);

      const executionOrder: string[] = [];
      mockCliExecute.mockImplementation(async (ctx) => {
        executionOrder.push(ctx.task.id);
        return {
          status: "complete",
          summary: `Completed ${ctx.task.description}`,
          turnsUsed: 1,
        };
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const outcome = await executeGoalWithAgent({
        session,
        runId: "lifecycle-multi",
        workingDir: "/tmp/moltbot-goal-integration-test",
      });

      expect(outcome.status).toBe("done");
      expect(executionOrder).toEqual(["1", "2", "3"]);
      expect(plan.steps.every((s) => s.status === "done")).toBe(true);
      expect(session.state).toBe("done");
    });

    it("tracks task update callbacks for each step", async () => {
      const step1 = makeStep({ id: "A", backend: "codex" });
      const step2 = makeStep({ id: "B", dependsOn: ["A"], backend: "codex" });
      const plan = makePlan([step1, step2]);
      const session = makeSession(plan);

      mockCliExecute.mockResolvedValue({
        status: "complete",
        summary: "Done",
        turnsUsed: 1,
      });

      const updates: Array<{ taskId: string; outcome: string }> = [];

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      await executeGoalWithAgent({
        session,
        runId: "callback-test",
        workingDir: "/tmp/moltbot-goal-integration-test",
        onTaskUpdate: (result) => {
          updates.push({ taskId: result.taskId, outcome: result.outcome });
        },
      });

      expect(updates).toHaveLength(2);
      expect(updates[0]).toEqual({ taskId: "A", outcome: "done" });
      expect(updates[1]).toEqual({ taskId: "B", outcome: "done" });
    });
  });

  // =========================================================================
  // 2. External cancellation via goal-stop during execution
  // =========================================================================
  describe("external cancellation (goal-stop)", () => {
    it("detects cancellation between tasks and stops gracefully", async () => {
      const { saveRun, loadRun } = await import("./run-store.js");

      const step1 = makeStep({ id: "1", backend: "codex" });
      const step2 = makeStep({ id: "2", dependsOn: ["1"], backend: "codex" });
      const step3 = makeStep({ id: "3", dependsOn: ["2"], backend: "codex" });
      const plan = makePlan([step1, step2, step3]);
      const session = makeSession(plan);
      const runId = "cancel-between-tasks";

      saveRun(
        makeSerializedRun({
          runId,
          state: "executing",
          plan,
        }),
      );

      let taskCount = 0;
      mockCliExecute.mockImplementation(async () => {
        taskCount++;
        if (taskCount === 1) {
          // Simulate external cancellation after first task completes
          const current = loadRun(runId)!;
          saveRun({ ...current, state: "cancelled", updatedAt: new Date().toISOString() });
        }
        return { status: "complete", summary: `Task ${taskCount} done`, turnsUsed: 1 };
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const outcome = await executeGoalWithAgent({
        session,
        runId,
        workingDir: "/tmp/moltbot-goal-integration-test",
      });

      expect(outcome.status).toBe("cancelled");
      expect(session.state).toBe("cancelled");
      // Only the first task should have been executed
      expect(step1.status).toBe("done");
      expect(step2.status).toBe("pending");
      expect(step3.status).toBe("pending");
      expect(mockCliExecute).toHaveBeenCalledOnce();
    });

    it("cancellation is detected even with parallel-eligible tasks", async () => {
      const { saveRun, loadRun } = await import("./run-store.js");

      // Two independent tasks, then a dependent one
      const step1 = makeStep({ id: "1", backend: "codex" });
      const step2 = makeStep({ id: "2", backend: "codex" });
      const step3 = makeStep({ id: "3", dependsOn: ["1", "2"], backend: "codex" });
      const plan = makePlan([step1, step2, step3]);
      const session = makeSession(plan);
      const runId = "cancel-parallel";

      saveRun(makeSerializedRun({ runId, state: "executing", plan }));

      let taskCount = 0;
      mockCliExecute.mockImplementation(async () => {
        taskCount++;
        if (taskCount === 1) {
          // Cancel after first independent task
          const current = loadRun(runId)!;
          saveRun({ ...current, state: "cancelled", updatedAt: new Date().toISOString() });
        }
        return { status: "complete", summary: `Task ${taskCount}`, turnsUsed: 1 };
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const outcome = await executeGoalWithAgent({
        session,
        runId,
        workingDir: "/tmp/moltbot-goal-integration-test",
      });

      expect(outcome.status).toBe("cancelled");
      // Only one task executed since cancellation is checked at the top of the loop
      expect(mockCliExecute).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  // 3. AbortSignal-based cancellation
  // =========================================================================
  describe("AbortSignal cancellation", () => {
    it("respects AbortSignal and stops before starting new tasks", async () => {
      const step1 = makeStep({ id: "1", backend: "codex" });
      const step2 = makeStep({ id: "2", dependsOn: ["1"], backend: "codex" });
      const plan = makePlan([step1, step2]);
      const session = makeSession(plan);

      const controller = new AbortController();

      mockCliExecute.mockImplementation(async () => {
        // Abort after first task
        controller.abort();
        return { status: "complete", summary: "Done", turnsUsed: 1 };
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      await executeGoalWithAgent({
        session,
        runId: "abort-signal",
        workingDir: "/tmp/moltbot-goal-integration-test",
        abortSignal: controller.signal,
      });

      // AbortSignal causes the loop to break, but all tasks may be done
      // The first task completed; the loop then checks aborted before the next
      expect(step1.status).toBe("done");
      expect(mockCliExecute).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  // 4. Concurrent access: listing during execution
  // =========================================================================
  describe("concurrent listing during execution", () => {
    it("listRuns returns accurate status while execution is ongoing", async () => {
      const { saveRun, listRuns } = await import("./run-store.js");

      // Create an "executing" run
      const plan: Plan = {
        goal: "Build website",
        workingDir: "/tmp/moltbot-goal-integration-test",
        summary: "A plan",
        steps: [
          makeStep({ id: "1", status: "done" }),
          makeStep({ id: "2", status: "in_progress", dependsOn: ["1"] }),
          makeStep({ id: "3", status: "pending", dependsOn: ["2"] }),
        ],
      };

      saveRun(
        makeSerializedRun({
          runId: "executing-run-1",
          goal: "Build website",
          state: "executing",
          plan,
        }),
      );

      // Also save a completed run
      saveRun(
        makeSerializedRun({
          runId: "done-run-1",
          goal: "Old project",
          state: "done",
          plan: makePlan([makeStep({ id: "1", status: "done" })]),
        }),
      );

      // List should work and show both runs
      const runs = listRuns();
      expect(runs).toHaveLength(2);

      const executingRun = runs.find((r) => r.runId === "executing-run-1");
      expect(executingRun).toBeDefined();
      expect(executingRun!.state).toBe("executing");
      expect(executingRun!.stepCount).toBe(3);
      expect(executingRun!.completedSteps).toBe(1);

      const doneRun = runs.find((r) => r.runId === "done-run-1");
      expect(doneRun).toBeDefined();
      expect(doneRun!.state).toBe("done");
    });

    it("concurrent reads and writes to run-store do not corrupt data", async () => {
      const { saveRun, listRuns, loadRun } = await import("./run-store.js");

      // Create multiple runs
      for (let i = 0; i < 5; i++) {
        saveRun(
          makeSerializedRun({
            runId: `concurrent-${i}`,
            goal: `Goal ${i}`,
            state: i < 3 ? "executing" : "done",
          }),
        );
      }

      // Concurrent reads and writes
      const results = await Promise.all([
        // Read operations
        (async () => listRuns())(),
        (async () => loadRun("concurrent-0"))(),
        (async () => loadRun("concurrent-4"))(),
        // Write operations (updating state)
        (async () => {
          const run = loadRun("concurrent-0");
          if (run) saveRun({ ...run, state: "done", updatedAt: new Date().toISOString() });
          return "write-done";
        })(),
        // More reads
        (async () => listRuns())(),
      ]);

      // All reads should succeed without errors
      expect(Array.isArray(results[0])).toBe(true);
      expect(results[1]).toBeDefined();
      expect(results[2]).toBeDefined();
      expect(results[3]).toBe("write-done");
      expect(Array.isArray(results[4])).toBe(true);
    });

    it("no lock files are created during read/write operations", async () => {
      const { saveRun, listRuns } = await import("./run-store.js");

      saveRun(makeSerializedRun({ runId: "no-lock-test", state: "executing" }));
      listRuns();

      const runDir = path.join(testGoalsDir, "no-lock-test");
      const files = fs.readdirSync(runDir);
      expect(files).not.toContain(".lock");
      expect(files).toContain("run.json");
    });
  });

  // =========================================================================
  // 5. Blocked task → answer → resume
  // =========================================================================
  describe("blocked task lifecycle with answer and resume", () => {
    it("blocks on user_input, then resumes with answer and completes", async () => {
      const step1 = makeStep({ id: "1", backend: "pi" });
      const step2 = makeStep({ id: "2", dependsOn: ["1"], backend: "codex" });
      const plan = makePlan([step1, step2]);
      const session = makeSession(plan);

      // First execution: step 1 blocks
      mockPiExecute.mockResolvedValueOnce({
        status: "blocked",
        question: "What database engine?",
        blockedReason: "user_input",
        turnsUsed: 1,
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const outcome1 = await executeGoalWithAgent({
        session,
        runId: "block-resume",
        workingDir: "/tmp/moltbot-goal-integration-test",
      });

      expect(outcome1.status).toBe("blocked");
      expect(session.state).toBe("blocked");
      expect(step1.status).toBe("blocked");
      expect(step1.blockedQuestion).toBe("What database engine?");
      expect(session.blocked?.requiredInputKey).toBe("task:1:input");

      // Supply an answer
      session.answers["task:1:input"] = "PostgreSQL";

      // Resume: step 1 completes with answer, step 2 completes
      mockPiExecute.mockResolvedValueOnce({
        status: "complete",
        summary: "Configured PostgreSQL",
        turnsUsed: 1,
      });
      mockCliExecute.mockResolvedValueOnce({
        status: "complete",
        summary: "Migration scripts done",
        turnsUsed: 1,
      });

      session.state = "executing";
      session.blocked = null;

      const outcome2 = await executeGoalWithAgent({
        session,
        runId: "block-resume",
        workingDir: "/tmp/moltbot-goal-integration-test",
      });

      expect(outcome2.status).toBe("done");
      expect(session.state).toBe("done");
      expect(step1.status).toBe("done");
      expect(step1.taskSummary).toBe("Configured PostgreSQL");
      expect(step2.status).toBe("done");
      // Answer should have been consumed
      expect(session.answers["task:1:input"]).toBeUndefined();
    });

    it("multi-task answer key (tasks:A,B:input) gets consumed correctly", async () => {
      const stepA = makeStep({ id: "A", backend: "pi" });
      const stepB = makeStep({ id: "B", backend: "pi" });
      const plan = makePlan([stepA, stepB]);
      const session = makeSession(plan);

      // Both block
      mockPiExecute
        .mockResolvedValueOnce({
          status: "blocked",
          question: "Need creds",
          blockedReason: "user_input",
          turnsUsed: 1,
        })
        .mockResolvedValueOnce({
          status: "blocked",
          question: "Also need creds",
          blockedReason: "user_input",
          turnsUsed: 1,
        });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      await executeGoalWithAgent({
        session,
        runId: "multi-answer",
        workingDir: "/tmp/moltbot-goal-integration-test",
      });

      expect(stepA.status).toBe("blocked");
      expect(stepB.status).toBe("blocked");

      // Answer both with shared key
      session.answers["tasks:A,B:input"] = "shared-cred";

      // Resume
      mockPiExecute
        .mockResolvedValueOnce({ status: "complete", summary: "A done", turnsUsed: 1 })
        .mockResolvedValueOnce({ status: "complete", summary: "B done", turnsUsed: 1 });

      session.state = "executing";
      session.blocked = null;

      const outcome = await executeGoalWithAgent({
        session,
        runId: "multi-answer",
        workingDir: "/tmp/moltbot-goal-integration-test",
      });

      expect(outcome.status).toBe("done");
      expect(stepA.status).toBe("done");
      expect(stepB.status).toBe("done");
    });
  });

  // =========================================================================
  // 6. Fatal error propagation
  // =========================================================================
  describe("fatal error propagation", () => {
    it("out_of_credits blocks all remaining tasks immediately", async () => {
      const step1 = makeStep({ id: "1", backend: "codex" });
      const step2 = makeStep({ id: "2", backend: "codex" });
      const step3 = makeStep({ id: "3", dependsOn: ["1"], backend: "codex" });
      const plan = makePlan([step1, step2, step3]);
      const session = makeSession(plan);

      mockCliExecute.mockResolvedValueOnce({
        status: "blocked",
        question: "Out of credits",
        blockedReason: "out_of_credits",
        turnsUsed: 1,
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const outcome = await executeGoalWithAgent({
        session,
        runId: "fatal-credits",
        workingDir: "/tmp/moltbot-goal-integration-test",
      });

      expect(outcome.status).toBe("blocked");
      expect(step1.status).toBe("blocked");
      expect(step1.blockedReason).toBe("out_of_credits");

      // The runnable task (step2) should have been marked blocked with the fatal error
      expect(step2.status).toBe("blocked");
      expect(step2.blockedReason).toBe("out_of_credits");

      // Step 3 depends on step 1, which isn't done, so it stays pending
      expect(step3.status).toBe("pending");

      // Only one task should have been executed
      expect(mockCliExecute).toHaveBeenCalledOnce();
    });

    it("auth error blocks all runnable tasks", async () => {
      const step1 = makeStep({ id: "1", backend: "codex" });
      const step2 = makeStep({ id: "2", backend: "codex" });
      const plan = makePlan([step1, step2]);
      const session = makeSession(plan);

      mockCliExecute.mockResolvedValueOnce({
        status: "blocked",
        question: "Authentication failed",
        blockedReason: "auth",
        turnsUsed: 0,
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const outcome = await executeGoalWithAgent({
        session,
        runId: "fatal-auth",
        workingDir: "/tmp/moltbot-goal-integration-test",
      });

      expect(outcome.status).toBe("blocked");
      expect(step1.blockedReason).toBe("auth");
      expect(step2.blockedReason).toBe("auth");
      expect(session.lastError).toBe("Authentication failed");
    });
  });

  // =========================================================================
  // 7. Retry logic (PI timeouts, CLI retries)
  // =========================================================================
  describe("retry logic", () => {
    it("retries PI timeout and succeeds on second attempt", async () => {
      const step = makeStep({ id: "1", backend: "pi" });
      const plan = makePlan([step]);
      const session = makeSession(plan);

      mockPiExecute
        .mockResolvedValueOnce({
          status: "blocked",
          question: "Timed out",
          blockedReason: "timeout",
          turnsUsed: 1,
        })
        .mockResolvedValueOnce({
          status: "complete",
          summary: "Recovered",
          turnsUsed: 1,
        });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const outcome = await executeGoalWithAgent({
        session,
        runId: "retry-pi",
        workingDir: "/tmp/moltbot-goal-integration-test",
        retryConfig: { maxAttempts: 2, retryDelayMs: 1 },
      });

      expect(outcome.status).toBe("done");
      expect(step.status).toBe("done");
      expect(mockPiExecute).toHaveBeenCalledTimes(2);
    });

    it("blocks after exhausting retry attempts", async () => {
      const step = makeStep({ id: "1", backend: "pi" });
      const plan = makePlan([step]);
      const session = makeSession(plan);

      mockPiExecute
        .mockResolvedValueOnce({
          status: "blocked",
          question: "Network error",
          blockedReason: "network",
          turnsUsed: 1,
        })
        .mockResolvedValueOnce({
          status: "blocked",
          question: "Still network error",
          blockedReason: "network",
          turnsUsed: 1,
        });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const outcome = await executeGoalWithAgent({
        session,
        runId: "retry-exhaust",
        workingDir: "/tmp/moltbot-goal-integration-test",
        retryConfig: { maxAttempts: 2, retryDelayMs: 1 },
      });

      expect(outcome.status).toBe("blocked");
      expect(step.status).toBe("blocked");
      expect(step.blockedReason).toBe("network");
      expect(mockPiExecute).toHaveBeenCalledTimes(2);
    });

    it("non-retryable PI errors (user_input) do not retry", async () => {
      const step = makeStep({ id: "1", backend: "pi" });
      const plan = makePlan([step]);
      const session = makeSession(plan);

      mockPiExecute.mockResolvedValueOnce({
        status: "blocked",
        question: "Need input",
        blockedReason: "user_input",
        turnsUsed: 1,
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      await executeGoalWithAgent({
        session,
        runId: "no-retry-input",
        workingDir: "/tmp/moltbot-goal-integration-test",
        retryConfig: { maxAttempts: 3, retryDelayMs: 1 },
      });

      // Should not retry user_input blocks
      expect(mockPiExecute).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  // 8. Mixed backend execution
  // =========================================================================
  describe("mixed backend execution", () => {
    it("routes tasks to the correct backend runner", async () => {
      const step1 = makeStep({ id: "1", backend: "pi" });
      const step2 = makeStep({ id: "2", dependsOn: ["1"], backend: "codex" });
      const step3 = makeStep({ id: "3", dependsOn: ["2"], backend: "claude_code" });
      const plan = makePlan([step1, step2, step3]);
      const session = makeSession(plan);

      mockPiExecute.mockResolvedValueOnce({
        status: "complete",
        summary: "PI task done",
        turnsUsed: 2,
      });
      mockCliExecute
        .mockResolvedValueOnce({
          status: "complete",
          summary: "Codex task done",
          turnsUsed: 1,
        })
        .mockResolvedValueOnce({
          status: "complete",
          summary: "Claude Code task done",
          turnsUsed: 1,
        });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const outcome = await executeGoalWithAgent({
        session,
        runId: "mixed-backend",
        workingDir: "/tmp/moltbot-goal-integration-test",
      });

      expect(outcome.status).toBe("done");
      expect(mockPiExecute).toHaveBeenCalledOnce();
      expect(mockCliExecute).toHaveBeenCalledTimes(2);
    });

    it("blocks when assigned backend is unavailable", async () => {
      availability = [
        { id: "pi", available: true },
        { id: "codex", available: false, reason: "codex not found on PATH" },
        { id: "claude_code", available: true },
      ];

      const step1 = makeStep({ id: "1", backend: "codex" });
      const step2 = makeStep({ id: "2", backend: "claude_code" });
      const plan = makePlan([step1, step2]);
      const session = makeSession(plan);

      mockCliExecute.mockResolvedValueOnce({
        status: "complete",
        summary: "Claude Code done",
        turnsUsed: 1,
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const outcome = await executeGoalWithAgent({
        session,
        runId: "unavailable-backend",
        workingDir: "/tmp/moltbot-goal-integration-test",
      });

      expect(outcome.status).toBe("blocked");
      expect(step1.status).toBe("blocked");
      expect(step1.blockedQuestion).toContain("Backend 'codex' is not available");
      // Step 2 should still complete since it uses claude_code
      expect(step2.status).toBe("done");
    });
  });

  // =========================================================================
  // 9. Status change callbacks
  // =========================================================================
  describe("status change callbacks", () => {
    it("fires step_blocked event when a task blocks", async () => {
      const step1 = makeStep({ id: "1", backend: "codex" });
      const step2 = makeStep({ id: "2", backend: "codex" });
      const plan = makePlan([step1, step2]);
      const session = makeSession(plan);

      mockCliExecute
        .mockResolvedValueOnce({
          status: "blocked",
          question: "Need input for task 1",
          blockedReason: "user_input",
          turnsUsed: 1,
        })
        .mockResolvedValueOnce({
          status: "complete",
          summary: "Task 2 done",
          turnsUsed: 1,
        });

      const events: Array<{ type: string; stepId?: string }> = [];

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      await executeGoalWithAgent({
        session,
        runId: "status-callback",
        workingDir: "/tmp/moltbot-goal-integration-test",
        onStatusChange: async (event) => {
          events.push({ type: event.type, stepId: "stepId" in event ? event.stepId : undefined });
        },
      });

      // Should have a step_blocked event for task 1, and a fully_blocked event at the end
      expect(events.some((e) => e.type === "step_blocked" && e.stepId === "1")).toBe(true);
      expect(events.some((e) => e.type === "fully_blocked")).toBe(true);
    });

    it("fires all_done event when all tasks complete", async () => {
      const step = makeStep({ id: "1", backend: "codex" });
      const plan = makePlan([step]);
      const session = makeSession(plan);

      mockCliExecute.mockResolvedValueOnce({
        status: "complete",
        summary: "Done",
        turnsUsed: 1,
      });

      const events: string[] = [];

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      await executeGoalWithAgent({
        session,
        runId: "all-done-event",
        workingDir: "/tmp/moltbot-goal-integration-test",
        onStatusChange: async (event) => {
          events.push(event.type);
        },
      });

      expect(events).toContain("all_done");
    });
  });

  // =========================================================================
  // 10. Run store persistence and serialization round-trip
  // =========================================================================
  describe("run store persistence round-trip", () => {
    it("session serialization preserves all fields through round-trip", async () => {
      const { sessionToSerialized, serializedToSession } = await import("./run-store.js");

      const session: GoalSession = {
        goal: "Integration test goal",
        state: "executing",
        plan: makePlan([
          makeStep({ id: "1", status: "done", taskSummary: "Created files" }),
          makeStep({
            id: "2",
            dependsOn: ["1"],
            status: "blocked",
            blockedReason: "user_input",
            blockedQuestion: "What next?",
          }),
        ]),
        stepResults: new Map([
          [
            "1",
            {
              stepId: "1",
              success: true,
              output: "Created 3 files",
              durationMs: 5000,
            },
          ],
        ]),
        blocked: {
          blockedAt: "execution",
          prompt: "What next?",
          requiredInputKey: "task:2:input",
          stepId: "2",
        },
        answers: { "task:2:input": "Continue with tests" },
        lastError: undefined,
      };

      const serialized = sessionToSerialized({
        session,
        runId: "roundtrip-test",
        workingDir: "/tmp/ws",
        model: "claude-sonnet-4-20250514",
        dryRun: false,
        createdAt: "2026-01-30T00:00:00.000Z",
      });

      expect(serialized.runId).toBe("roundtrip-test");
      expect(serialized.state).toBe("executing");
      expect(serialized.stepResults["1"]?.success).toBe(true);

      const restored = serializedToSession(serialized);
      expect(restored.state).toBe("executing");
      expect(restored.goal).toBe("Integration test goal");
      expect(restored.stepResults.get("1")?.success).toBe(true);
      expect(restored.blocked?.requiredInputKey).toBe("task:2:input");
      expect(restored.answers["task:2:input"]).toBe("Continue with tests");
      expect(restored.plan?.steps[0]?.status).toBe("done");
      expect(restored.plan?.steps[1]?.status).toBe("blocked");
    });

    it("save and load preserves run data through disk round-trip", async () => {
      const { saveRun, loadRun } = await import("./run-store.js");

      const run = makeSerializedRun({
        runId: "disk-roundtrip",
        goal: "Disk persistence test",
        state: "blocked",
        plan: makePlan([
          makeStep({ id: "1", status: "done" }),
          makeStep({ id: "2", status: "blocked", blockedQuestion: "Need API key" }),
        ]),
        blocked: {
          blockedAt: "execution",
          prompt: "Need API key",
          requiredInputKey: "task:2:input",
        },
        answers: { "task:2:input": "sk-test-123" },
      });

      saveRun(run);
      const loaded = loadRun("disk-roundtrip");

      expect(loaded).toBeDefined();
      expect(loaded!.runId).toBe("disk-roundtrip");
      expect(loaded!.state).toBe("blocked");
      expect(loaded!.plan?.steps[0]?.status).toBe("done");
      expect(loaded!.plan?.steps[1]?.status).toBe("blocked");
      expect(loaded!.blocked?.requiredInputKey).toBe("task:2:input");
      expect(loaded!.answers["task:2:input"]).toBe("sk-test-123");
    });
  });

  // =========================================================================
  // 11. Run migration (legacy states)
  // =========================================================================
  describe("run migration", () => {
    it("migrates legacy in_progress steps to pending on load", async () => {
      const { loadRun } = await import("./run-store.js");

      // Write raw JSON to simulate a crashed run with in_progress step
      const runDir = path.join(testGoalsDir, "crash-recovery");
      fs.mkdirSync(runDir, { recursive: true });
      const rawRun = {
        runId: "crash-recovery",
        goal: "Crashed goal",
        state: "executing",
        plan: {
          goal: "Crashed goal",
          workingDir: "/tmp",
          summary: "Plan",
          steps: [
            { id: "1", description: "Step 1", dependsOn: [], status: "done" },
            { id: "2", description: "Step 2", dependsOn: ["1"], status: "in_progress" },
            { id: "3", description: "Step 3", dependsOn: ["2"], status: "pending" },
          ],
        },
        stepResults: {},
        blocked: null,
        answers: {},
        workingDir: "/tmp",
        model: undefined,
        dryRun: false,
        createdAt: "2026-01-30T00:00:00.000Z",
        updatedAt: "2026-01-30T00:00:00.000Z",
      };
      fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify(rawRun));

      const loaded = loadRun("crash-recovery");
      expect(loaded).toBeDefined();
      // in_progress should be migrated to pending for crash recovery
      expect(loaded!.plan?.steps[1]?.status).toBe("pending");
    });

    it("migrates legacy 'failed' state to blocked", async () => {
      const { loadRun } = await import("./run-store.js");

      const runDir = path.join(testGoalsDir, "legacy-failed");
      fs.mkdirSync(runDir, { recursive: true });
      const rawRun = {
        runId: "legacy-failed",
        goal: "Failed goal",
        state: "failed",
        plan: {
          goal: "Failed goal",
          workingDir: "/tmp",
          summary: "Plan",
          steps: [{ id: "1", description: "Step 1", dependsOn: [], status: "failed" }],
        },
        stepResults: {},
        blockReason: "Something went wrong",
        workingDir: "/tmp",
        model: undefined,
        dryRun: false,
        createdAt: "2026-01-30T00:00:00.000Z",
        updatedAt: "2026-01-30T00:00:00.000Z",
      };
      fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify(rawRun));

      const loaded = loadRun("legacy-failed");
      expect(loaded).toBeDefined();
      expect(loaded!.state).toBe("blocked");
      // blockReason should be migrated to structured blocked
      expect(loaded!.blocked).toBeDefined();
      expect(loaded!.blocked?.blockedAt).toBe("execution");
      // failed step should be migrated to blocked
      expect(loaded!.plan?.steps[0]?.status).toBe("blocked");
    });
  });

  // =========================================================================
  // 12. Progress tracking and task summary building
  // =========================================================================
  describe("progress tracking", () => {
    it("progress callback receives expected messages for each task", async () => {
      const step1 = makeStep({ id: "1", description: "Init project", backend: "codex" });
      const step2 = makeStep({
        id: "2",
        description: "Write code",
        dependsOn: ["1"],
        backend: "codex",
      });
      const plan = makePlan([step1, step2]);
      const session = makeSession(plan);

      mockCliExecute
        .mockResolvedValueOnce({ status: "complete", summary: "Initialized", turnsUsed: 1 })
        .mockResolvedValueOnce({ status: "complete", summary: "Code written", turnsUsed: 2 });

      const progressMessages: string[] = [];

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const outcome = await executeGoalWithAgent({
        session,
        runId: "progress-track",
        workingDir: "/tmp/moltbot-goal-integration-test",
        onProgress: (text) => progressMessages.push(text),
      });

      expect(outcome.status).toBe("done");
      // Should contain task start messages and done messages
      expect(progressMessages.some((m) => m.includes("Task 1"))).toBe(true);
      expect(progressMessages.some((m) => m.includes("Task 2"))).toBe(true);
      expect(progressMessages.some((m) => m.includes("[done]"))).toBe(true);
    });

    it("done outcome includes summary with task details", async () => {
      const step1 = makeStep({ id: "1", backend: "codex" });
      const step2 = makeStep({ id: "2", dependsOn: ["1"], backend: "codex" });
      const plan = makePlan([step1, step2]);
      const session = makeSession(plan);

      mockCliExecute
        .mockResolvedValueOnce({ status: "complete", summary: "Created files", turnsUsed: 1 })
        .mockResolvedValueOnce({ status: "complete", summary: "Ran tests", turnsUsed: 2 });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const outcome = await executeGoalWithAgent({
        session,
        runId: "summary-test",
        workingDir: "/tmp/moltbot-goal-integration-test",
      });

      expect(outcome.status).toBe("done");
      if (outcome.status === "done") {
        const lines = summaryLines(outcome.summary);
        const headlineIndex = findLineIndex(lines, "✅ Done:");
        const progressIndex = findLineIndex(lines, "**Progress** 2/2");
        const retriesIndex = findLineIndex(lines, "**Retries** 1 retry across 1 step");
        const topStepsIndex = findLineIndex(lines, "**Top Steps**");
        expect(headlineIndex).toBe(0);
        expect(progressIndex).toBeGreaterThan(headlineIndex);
        expect(retriesIndex).toBeGreaterThan(progressIndex);
        expect(topStepsIndex).toBeGreaterThan(retriesIndex);

        const stepLines = lines.filter((line) => line.startsWith("- "));
        expect(stepLines).toHaveLength(2);
        expect(stepLines.some((line) => line.includes("Created files"))).toBe(true);
        expect(stepLines.some((line) => line.includes("Ran tests"))).toBe(true);
        expect(stepLines.some((line) => line.includes("[2/5]"))).toBe(true);
        expect(stepLines.some((line) => line.includes("[1/1]"))).toBe(false);
      }
    });
  });

  // =========================================================================
  // 13. Edge cases
  // =========================================================================
  describe("edge cases", () => {
    it("handles a plan with no steps (empty plan)", async () => {
      const plan = makePlan([]);
      const session = makeSession(plan);

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const outcome = await executeGoalWithAgent({
        session,
        runId: "empty-plan",
        workingDir: "/tmp/moltbot-goal-integration-test",
      });

      // No runnable tasks → all done (vacuously true)
      expect(outcome.status).toBe("done");
      expect(session.state).toBe("done");
      expect(mockCliExecute).not.toHaveBeenCalled();
    });

    it("handles task that fails with structured failure detail", async () => {
      const step = makeStep({ id: "1", backend: "codex" });
      const plan = makePlan([step]);
      const session = makeSession(plan);

      mockCliExecute.mockResolvedValueOnce({
        status: "failed",
        question: "Could not compile project",
        turnsUsed: 3,
        failedDetail: {
          whatTried: "Attempted to fix build errors",
          errorType: "compilation",
          suggestedNext: "Check tsconfig.json",
          needsRevert: true,
        },
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const outcome = await executeGoalWithAgent({
        session,
        runId: "task-failed",
        workingDir: "/tmp/moltbot-goal-integration-test",
      });

      expect(outcome.status).toBe("blocked");
      expect(step.status).toBe("blocked");
      expect(step.blockedReason).toBe("task_failed");
      expect(step.failedDetail?.errorType).toBe("compilation");
      expect(step.failedDetail?.needsRevert).toBe(true);
    });

    it("completed summaries are passed to subsequent task contexts", async () => {
      const step1 = makeStep({ id: "1", backend: "codex" });
      const step2 = makeStep({ id: "2", dependsOn: ["1"], backend: "codex" });
      const plan = makePlan([step1, step2]);
      const session = makeSession(plan);

      const capturedContexts: TaskRunnerContext[] = [];
      mockCliExecute.mockImplementation(async (ctx) => {
        capturedContexts.push(ctx);
        return { status: "complete", summary: `${ctx.task.id} summary`, turnsUsed: 1 };
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      await executeGoalWithAgent({
        session,
        runId: "context-pass",
        workingDir: "/tmp/moltbot-goal-integration-test",
      });

      // First task should have empty completed summaries
      expect(capturedContexts[0]!.completedSummaries).toHaveLength(0);
      // Second task should see first task's summary
      expect(capturedContexts[1]!.completedSummaries).toHaveLength(1);
      expect(capturedContexts[1]!.completedSummaries[0]!.id).toBe("1");
      expect(capturedContexts[1]!.completedSummaries[0]!.summary).toBe("1 summary");
    });

    it("executedBackend is set once and sticky across retries", async () => {
      const step = makeStep({ id: "1", backend: "pi" });
      const plan = makePlan([step]);
      const session = makeSession(plan);

      mockPiExecute
        .mockResolvedValueOnce({
          status: "blocked",
          question: "Timeout",
          blockedReason: "timeout",
          turnsUsed: 1,
        })
        .mockResolvedValueOnce({
          status: "complete",
          summary: "Done",
          turnsUsed: 1,
        });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      await executeGoalWithAgent({
        session,
        runId: "sticky-backend",
        workingDir: "/tmp/moltbot-goal-integration-test",
        retryConfig: { maxAttempts: 2, retryDelayMs: 1 },
      });

      expect(step.executedBackend).toBe("pi");
    });
  });

  // =========================================================================
  // 14. Goal-stop command integration with run store
  // =========================================================================
  describe("goal-stop integration with run store", () => {
    it("goal-stop command sets state to cancelled, loadRun reflects it", async () => {
      const { saveRun, loadRun } = await import("./run-store.js");

      const plan = makePlan([
        makeStep({ id: "1", status: "done" }),
        makeStep({ id: "2", status: "pending", dependsOn: ["1"] }),
      ]);

      saveRun(
        makeSerializedRun({
          runId: "stop-integration",
          state: "executing",
          plan,
        }),
      );

      // Simulate what goal-stop does: load, set cancelled, save
      const run = loadRun("stop-integration")!;
      run.state = "cancelled";
      run.blocked = null;
      run.updatedAt = new Date().toISOString();
      saveRun(run);

      // Verify the state persists
      const reloaded = loadRun("stop-integration")!;
      expect(reloaded.state).toBe("cancelled");
      expect(reloaded.blocked).toBeNull();
      // Done tasks should stay done
      expect(reloaded.plan?.steps[0]?.status).toBe("done");
    });
  });

  // =========================================================================
  // 15. Concurrent goal-stop + execution
  // =========================================================================
  describe("concurrent goal-stop and execution", () => {
    it("execution loop detects goal-stop (via loadRun) and exits", async () => {
      const { saveRun, loadRun } = await import("./run-store.js");

      const step1 = makeStep({ id: "1", backend: "codex" });
      const step2 = makeStep({ id: "2", dependsOn: ["1"], backend: "codex" });
      const plan = makePlan([step1, step2]);
      const session = makeSession(plan);
      const runId = "concurrent-stop-exec";

      saveRun(makeSerializedRun({ runId, state: "executing", plan }));

      // Mock: first task takes time, during which goal is stopped
      mockCliExecute.mockImplementation(async (ctx) => {
        if (ctx.task.id === "1") {
          // Simulate goal-stop happening during task execution
          const run = loadRun(runId)!;
          run.state = "cancelled";
          run.updatedAt = new Date().toISOString();
          saveRun(run);
        }
        return { status: "complete", summary: `${ctx.task.id} done`, turnsUsed: 1 };
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const outcome = await executeGoalWithAgent({
        session,
        runId,
        workingDir: "/tmp/moltbot-goal-integration-test",
      });

      // Should detect cancellation after task 1 completes
      expect(outcome.status).toBe("cancelled");
      expect(step1.status).toBe("done");
      expect(step2.status).toBe("pending");

      // Verify only one task was actually executed
      expect(mockCliExecute).toHaveBeenCalledOnce();
    });

    it("listing runs works correctly even during simulated concurrent execution", async () => {
      const { saveRun, listRuns } = await import("./run-store.js");

      // Create some runs in various states
      saveRun(
        makeSerializedRun({
          runId: "exec-a",
          goal: "Goal A",
          state: "executing",
        }),
      );
      saveRun(
        makeSerializedRun({
          runId: "exec-b",
          goal: "Goal B",
          state: "executing",
        }),
      );
      saveRun(
        makeSerializedRun({
          runId: "done-c",
          goal: "Goal C",
          state: "done",
        }),
      );

      // Interleave list operations with state updates
      const runs1 = listRuns();
      expect(runs1).toHaveLength(3);

      // Stop one goal
      const runA = runs1.find((r) => r.runId === "exec-a");
      expect(runA?.state).toBe("executing");

      // List again after state change simulation
      saveRun(
        makeSerializedRun({
          runId: "exec-a",
          goal: "Goal A",
          state: "cancelled",
          updatedAt: new Date().toISOString(),
        }),
      );

      const runs2 = listRuns();
      expect(runs2).toHaveLength(3);
      const updated = runs2.find((r) => r.runId === "exec-a");
      expect(updated?.state).toBe("cancelled");
    });
  });

  // =========================================================================
  // 16. Resume from cancelled run
  // =========================================================================
  describe("resume from cancelled run", () => {
    it("resumes a cancelled run and executes at least one task", async () => {
      const { goalResumeCommand } = await import("../commands/goal-resume.js");
      const { saveRun, loadRun } = await import("./run-store.js");

      const step = makeStep({ id: "resume-1", backend: "codex" });
      const plan = makePlan([step]);
      const runId = "resume-from-cancelled";
      saveRun(
        makeSerializedRun({
          runId,
          state: "cancelled",
          plan,
          stepResults: {},
          workingDir: "/tmp/moltbot-goal-integration-test",
        }),
      );

      mockCliExecute.mockResolvedValueOnce({
        status: "complete",
        summary: "Resumed task completed",
        turnsUsed: 1,
      });

      const statusEvents: string[] = [];
      const runtime = makeRuntime();
      const prevNoGitCheckpoints = process.env.MOLTBOT_NO_GIT_CHECKPOINTS;
      process.env.MOLTBOT_NO_GIT_CHECKPOINTS = "1";
      let outcome;
      try {
        outcome = await goalResumeCommand(
          runId,
          {
            yes: true,
            quiet: true,
            onStatusChange: async (event) => {
              statusEvents.push(event.type);
            },
          },
          runtime,
        );
      } finally {
        if (prevNoGitCheckpoints == null) delete process.env.MOLTBOT_NO_GIT_CHECKPOINTS;
        else process.env.MOLTBOT_NO_GIT_CHECKPOINTS = prevNoGitCheckpoints;
      }

      expect(outcome?.status).toBe("done");
      expect(mockCliExecute).toHaveBeenCalled();
      expect(statusEvents).toContain("all_done");
      expect(loadRun(runId)?.state).toBe("done");
    });
  });
});
