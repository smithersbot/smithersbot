import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoalSession, Plan, PlanStep, SerializedRun } from "./types.js";
import type { BackendAvailability, GoalBackendId } from "./backend-types.js";
import type { TaskRunnerContext, TaskRunnerResult } from "./task-runner.js";
import type { AttemptBundle } from "./attempt-bundle.js";

const mockCliExecute = vi.fn<Promise<TaskRunnerResult>, [TaskRunnerContext]>();
const mockPiExecute = vi.fn<Promise<TaskRunnerResult>, [TaskRunnerContext]>();
const mockLoadAttemptBundles = vi.fn<(dir: string) => AttemptBundle[]>();

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
  loadAttemptBundles: (dir: string) => mockLoadAttemptBundles(dir),
  resolveWorkerDir: () => "/tmp/moltbot-goal-test/worker",
  formatAttemptBundleSummary: () => "previous attempt",
}));

let mockRunStore: Map<string, any> = new Map();

vi.mock("./run-store.js", () => ({
  resolveGoalWorkingFile: () => "/tmp/moltbot-goal-test/WORKING.md",
  resolveWorkingFile: () => "/tmp/moltbot-goal-test/step.md",
  loadRun: (runId: string) => mockRunStore.get(runId),
  saveRun: (run: any) => mockRunStore.set(run.runId, run),
}));

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
  return { goal: "Test goal", summary: "Test plan", steps };
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

describe("agent-executor (TaskRunner orchestration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunStore.clear();
    mockLoadAttemptBundles.mockImplementation(() => []);
    availability = [
      { id: "pi", available: true },
      { id: "codex", available: true },
      { id: "claude_code", available: true },
    ];
  });

  it("completes a task via CLI runner and marks run done", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    const session = makeSession(plan);

    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "All set",
      turnsUsed: 1,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-cli-complete",
      workingDir: "/tmp/moltbot-goal-test",
    });

    expect(outcome.status).toBe("done");
    expect(step.status).toBe("done");
    expect(step.taskSummary).toBe("All set");
    expect(mockCliExecute).toHaveBeenCalledOnce();
    if (outcome.status === "done") {
      expect(outcome.summary).toContain("✅ Done:");
      expect(outcome.summary).toContain("**Progress** 1/1");
      expect(outcome.summary).toContain("**Retries** 0 retries");
    }
  });

  it("blocks a task via PI runner and sets blocked details", async () => {
    const step = makeStep({ backend: "pi" });
    const plan = makePlan([step]);
    const session = makeSession(plan);

    mockPiExecute.mockResolvedValueOnce({
      status: "blocked",
      question: "Need input",
      blockedReason: "user_input",
      turnsUsed: 1,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-pi-blocked",
      workingDir: "/tmp/moltbot-goal-test",
    });

    expect(outcome.status).toBe("blocked");
    expect(step.status).toBe("blocked");
    expect(session.blocked?.blockedAt).toBe("execution");
    expect(session.blocked?.requiredInputKey).toBe("task:1:input");
  });

  it("retries on PI timeout and succeeds on second attempt", async () => {
    const step = makeStep({ backend: "pi" });
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
      runId: "run-pi-retry",
      workingDir: "/tmp/moltbot-goal-test",
      retryConfig: { maxAttempts: 2, retryDelayMs: 1 },
    });

    expect(outcome.status).toBe("done");
    expect(step.status).toBe("done");
    expect(mockPiExecute).toHaveBeenCalledTimes(2);
  });

  it("retries CLI backend when latest attempt outcome is rate_limit", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    const session = makeSession(plan);

    const rateLimitAttempt: AttemptBundle = {
      attemptNumber: 1,
      backend: "codex",
      outcome: "rate_limit",
      durationMs: 500,
    };
    const completeAttempt: AttemptBundle = {
      attemptNumber: 2,
      backend: "codex",
      outcome: "complete",
      durationMs: 400,
    };

    let loadCalls = 0;
    mockLoadAttemptBundles.mockImplementation(() => {
      loadCalls += 1;
      switch (loadCalls) {
        case 1:
          return [];
        case 2:
        case 3:
        case 4:
          return [rateLimitAttempt];
        default:
          return [completeAttempt];
      }
    });

    mockCliExecute
      .mockResolvedValueOnce({
        status: "failed",
        question: "Rate limited",
        turnsUsed: 1,
        failedDetail: {
          reason: "usage limit",
          whatTried: "waited",
          errorType: "rate_limit",
          suggestedNext: "retry",
          needsRevert: false,
        },
      })
      .mockResolvedValueOnce({
        status: "complete",
        summary: "Recovered after rate limit",
        turnsUsed: 1,
      });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-cli-rate-limit-retry",
      workingDir: "/tmp/moltbot-goal-test",
      retryConfig: { maxAttempts: 2, retryDelayMs: 1 },
    });

    expect(outcome.status).toBe("done");
    expect(step.status).toBe("done");
    expect(mockCliExecute).toHaveBeenCalledTimes(2);
  });

  it("blocks when the selected backend is unavailable", async () => {
    availability = [
      { id: "pi", available: true },
      { id: "codex", available: false, reason: "codex not found on PATH" },
      { id: "claude_code", available: true },
    ];

    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    const session = makeSession(plan);

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-backend-unavailable",
      workingDir: "/tmp/moltbot-goal-test",
    });

    expect(outcome.status).toBe("blocked");
    expect(step.status).toBe("blocked");
    expect(step.blockedQuestion).toContain("Backend 'codex' is not available");
  });

  it("re-runs blocked non-user-input steps without requiring an answer", async () => {
    const step = makeStep({
      backend: "codex",
      status: "blocked",
      blockedReason: "error",
      blockedQuestion: "Backend unavailable earlier",
    });
    const plan = makePlan([step]);
    const session = makeSession(plan);

    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "Recovered after retry",
      turnsUsed: 1,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-blocked-error-rerun",
      workingDir: "/tmp/moltbot-goal-test",
    });

    expect(outcome.status).toBe("done");
    expect(step.status).toBe("done");
    expect(mockCliExecute).toHaveBeenCalledOnce();
  });

  it("accumulates duration across resumed attempts and keeps it on done steps", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

      const step = makeStep({ backend: "codex" });
      const plan = makePlan([step]);
      const session = makeSession(plan);

      mockCliExecute.mockImplementationOnce(async () => {
        vi.advanceTimersByTime(1200);
        return {
          status: "blocked",
          question: "Need input",
          blockedReason: "user_input",
          turnsUsed: 1,
        };
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");

      const firstOutcome = await executeGoalWithAgent({
        session,
        runId: "run-duration-resume-1",
        workingDir: "/tmp/moltbot-goal-test",
      });

      expect(firstOutcome.status).toBe("blocked");
      expect(session.stepResults.get("1")?.durationMs).toBe(1200);

      session.answers["task:1:input"] = "continue";
      mockCliExecute.mockImplementationOnce(async () => {
        vi.advanceTimersByTime(800);
        return {
          status: "complete",
          summary: "Completed after answer",
          turnsUsed: 1,
        };
      });

      const secondOutcome = await executeGoalWithAgent({
        session,
        runId: "run-duration-resume-1",
        workingDir: "/tmp/moltbot-goal-test",
      });

      expect(secondOutcome.status).toBe("done");
      const finalResult = session.stepResults.get("1");
      expect(finalResult?.success).toBe(true);
      expect(finalResult?.durationMs).toBe(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses codex on resume when planner degraded and executedBackend was stale claude_code", async () => {
    availability = [
      { id: "pi", available: true },
      { id: "codex", available: true },
      { id: "claude_code", available: false, reason: "claude unavailable in degraded mode test" },
    ];

    const step = makeStep({
      backend: "claude_code",
      executedBackend: "claude_code",
      status: "blocked",
      blockedReason: "error",
      blockedQuestion: "Previous Anthropic limit",
    });
    const plan = makePlan([step]);
    const session = makeSession(plan);

    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "Recovered with codex",
      turnsUsed: 1,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-degraded-resume",
      workingDir: "/tmp/moltbot-goal-test",
      serializedRun: { plannerDegradedReason: "anthropic_rate_limit" } as unknown as SerializedRun,
    });

    expect(outcome.status).toBe("done");
    expect(step.backend).toBe("codex");
    expect(step.executedBackend).toBe("codex");
    expect(mockCliExecute).toHaveBeenCalledOnce();
  });

  it("keeps claude_code when explicit backend override is set during degraded mode", async () => {
    availability = [
      { id: "pi", available: true },
      { id: "codex", available: false, reason: "codex intentionally unavailable" },
      { id: "claude_code", available: true },
    ];

    const step = makeStep({
      backend: "claude_code",
      executedBackend: "claude_code",
      status: "blocked",
      blockedReason: "error",
      blockedQuestion: "Previous Anthropic limit",
    });
    const plan = makePlan([step]);
    const session = makeSession(plan);

    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "Forced claude override worked",
      turnsUsed: 1,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-degraded-override-claude",
      workingDir: "/tmp/moltbot-goal-test",
      serializedRun: {
        plannerDegradedReason: "anthropic_usage_limit",
        backendOverride: "claude_code",
      } as unknown as SerializedRun,
    });

    expect(outcome.status).toBe("done");
    expect(step.backend).toBe("claude_code");
    expect(step.executedBackend).toBe("claude_code");
    expect(mockCliExecute).toHaveBeenCalledOnce();
  });

  it("detects external cancellation via goal-stop and exits gracefully", async () => {
    const { saveRun } = await import("./run-store.js");

    // Create two tasks
    const step1 = makeStep({ id: "1", backend: "codex" });
    const step2 = makeStep({ id: "2", backend: "codex", dependsOn: ["1"] });
    const plan = makePlan([step1, step2]);
    const session = makeSession(plan);
    const runId = "run-external-cancel";

    // Store the initial run state
    saveRun({
      runId,
      goal: plan.goal,
      state: "executing",
      plan,
      stepResults: {},
      blocked: null,
      answers: {},
      workingDir: "/tmp/moltbot-goal-test",
      model: undefined,
      dryRun: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Mock the first task to complete and immediately trigger cancellation
    mockCliExecute.mockImplementation(async () => {
      // Simulate external cancellation immediately during first task
      mockRunStore.set(runId, {
        ...mockRunStore.get(runId),
        state: "cancelled",
        updatedAt: new Date().toISOString(),
      });

      return {
        status: "complete",
        summary: "Task 1 done",
        turnsUsed: 1,
      };
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");

    // Start execution
    const outcomePromise = executeGoalWithAgent({
      session,
      runId,
      workingDir: "/tmp/moltbot-goal-test",
    });

    // Wait for execution to detect cancellation
    const outcome = await outcomePromise;

    // Should detect cancellation and return cancelled status
    expect(outcome.status).toBe("cancelled");
    expect(session.state).toBe("cancelled");
    // First task should be done
    expect(step1.status).toBe("done");
    // Second task should not have been executed (still pending)
    expect(step2.status).toBe("pending");
    // Only one task should have been executed
    expect(mockCliExecute).toHaveBeenCalledOnce();
  });
});
