import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoalSession, Plan, PlanStep } from "./types.js";
import type { BackendAvailability, GoalBackendId } from "./backend-types.js";
import type { TaskRunnerContext, TaskRunnerResult } from "./task-runner.js";

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
  resolveWorkerDir: () => "/tmp/moltbot-goal-test/worker",
  formatAttemptBundleSummary: () => "previous attempt",
}));

vi.mock("./run-store.js", () => ({
  resolveGoalWorkingFile: () => "/tmp/moltbot-goal-test/WORKING.md",
  resolveWorkingFile: () => "/tmp/moltbot-goal-test/step.md",
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
});
