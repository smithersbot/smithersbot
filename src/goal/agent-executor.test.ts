import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoalLlmClient, GoalSession, Plan, PlanStep, SerializedRun } from "./types.js";
import type { BackendAvailability, GoalBackendId } from "./backend-types.js";
import type { TaskRunnerContext, TaskRunnerResult } from "./task-runner.js";
import type { AttemptBundle } from "./attempt-bundle.js";

const mockCliExecute = vi.fn<Promise<TaskRunnerResult>, [TaskRunnerContext]>();
const mockPiExecute = vi.fn<Promise<TaskRunnerResult>, [TaskRunnerContext]>();
const mockLoadAttemptBundles = vi.fn<(dir: string) => AttemptBundle[]>();
const mockWriteAttemptBundle = vi.fn<(dir: string, bundle: AttemptBundle) => void>();
const mockSpawnSync = vi.fn();
const mockExecFileSync = vi.fn();
const attemptBundlesByDir = new Map<string, AttemptBundle[]>();
const WORKER_DIR = "/tmp/moltbot-goal-test/worker";

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
  resolveWorkerDir: () => WORKER_DIR,
  formatAttemptBundleSummary: (bundle: AttemptBundle) => JSON.stringify(bundle),
  writeAttemptBundle: (dir: string, bundle: AttemptBundle) => mockWriteAttemptBundle(dir, bundle),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  };
});

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
    shortSummary: "Do thing",
    dependsOn: [],
    status: "pending",
    ...overrides,
  };
}

function makePlan(steps: PlanStep[]): Plan {
  return {
    goal: "Test goal",
    workingDir: "/tmp/moltbot-goal-test",
    summary: "Test plan",
    shortSummary: "Test plan",
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

function appendAttemptBundle(bundle: AttemptBundle, dir = WORKER_DIR): void {
  const current = attemptBundlesByDir.get(dir) ?? [];
  attemptBundlesByDir.set(dir, [...current, bundle]);
}

describe("agent-executor (TaskRunner orchestration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunStore.clear();
    attemptBundlesByDir.clear();
    mockLoadAttemptBundles.mockImplementation((dir) => [...(attemptBundlesByDir.get(dir) ?? [])]);
    mockWriteAttemptBundle.mockImplementation((dir, bundle) => {
      const current = attemptBundlesByDir.get(dir) ?? [];
      attemptBundlesByDir.set(dir, [...current, bundle]);
    });
    mockSpawnSync.mockReturnValue({
      status: 0,
      signal: null,
      stdout: "",
      stderr: "",
    });
    mockExecFileSync.mockReturnValue("");
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
      expect(outcome.summary).toContain("**Goal ID:** run-cli-");
    }
  });

  it("omits manualTests and emits manualTestsError when manual-test auth fails", async () => {
    const step = makeStep({ backend: "codex", description: "Implement login validation" });
    const plan = makePlan([step]);
    const session = makeSession(plan);

    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "All set",
      turnsUsed: 1,
    });

    const manualTestsClient: GoalLlmClient = {
      complete: vi
        .fn()
        .mockRejectedValue(
          new Error(
            '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
          ),
        ),
    };
    const statusEvents: unknown[] = [];

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-cli-fallback-manual-tests",
      workingDir: "/tmp/moltbot-goal-test",
      manualTestsClient,
      onStatusChange: (event) => {
        statusEvents.push(event);
      },
    });

    expect(outcome.status).toBe("done");
    const allDoneEvent = statusEvents.find(
      (event): event is { type: "all_done"; manualTests?: unknown[]; manualTestsError?: string } =>
        typeof event === "object" &&
        event !== null &&
        (event as { type?: string }).type === "all_done",
    );
    expect(allDoneEvent).toBeDefined();
    expect(allDoneEvent?.manualTests).toBeUndefined();
    expect(allDoneEvent?.manualTestsError).toContain("authentication_error");
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

  it("reverts on ralph and retries with ralph context", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    const session = makeSession(plan);
    session.taskCheckpoints = { "1": { baseSha: "base-sha-1" } };

    const contexts: TaskRunnerContext[] = [];
    const ralphDetail = {
      approachTried: "Fixed import paths manually",
      specificErrors: "Still had unresolved generated module imports",
      keyInsight: "Codegen must run before import cleanup",
      suggestedApproach: "Run codegen first, then patch remaining imports",
    };

    mockCliExecute.mockImplementation(async (context) => {
      contexts.push(context);
      const attemptNumber = (context.attemptBundles?.at(-1)?.attemptNumber ?? 0) + 1;
      if (contexts.length === 1) {
        appendAttemptBundle({
          attemptNumber,
          backend: "codex",
          outcome: "ralph",
          durationMs: 1000,
          ralphDetail,
        });
        return {
          status: "ralph",
          ralphDetail,
          turnsUsed: 1,
        };
      }
      return {
        status: "complete",
        summary: "Recovered with the suggested strategy",
        turnsUsed: 1,
      };
    });

    const progress: string[] = [];
    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-ralph-retry",
      workingDir: "/tmp/moltbot-goal-test",
      onProgress: (text) => progress.push(text),
    });

    expect(outcome.status).toBe("done");
    expect(session.stepRalphCounts?.["1"]).toBe(1);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["-C", "/tmp/moltbot-goal-test", "reset", "--hard", "base-sha-1"],
      expect.any(Object),
    );
    expect(progress.some((text) => text.includes("Task 1: ralph (attempt 1/2)"))).toBe(true);
    expect(contexts[1]?.attemptBundles?.some((bundle) => bundle.ralphDetail?.keyInsight)).toBe(
      true,
    );
  });

  it("escalates to blocked when ralph limit is reached", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    const session = makeSession(plan);
    session.taskCheckpoints = { "1": { baseSha: "base-sha-2" } };

    const ralphDetail = {
      approachTried: "Tried patching unresolved paths",
      specificErrors: "Build still failed with many unresolved imports",
      keyInsight: "Current patch-only approach is structurally wrong",
      suggestedApproach: "Regenerate artifacts before patching imports",
    };

    mockCliExecute.mockImplementation(async (context) => {
      const attemptNumber = (context.attemptBundles?.at(-1)?.attemptNumber ?? 0) + 1;
      appendAttemptBundle({
        attemptNumber,
        backend: "codex",
        outcome: "ralph",
        durationMs: 900,
        ralphDetail,
      });
      return {
        status: "ralph",
        ralphDetail,
        turnsUsed: 1,
      };
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-ralph-limit",
      workingDir: "/tmp/moltbot-goal-test",
      retryConfig: { maxAttempts: 1, retryDelayMs: 1, maxRalphAttempts: 2 },
    });

    expect(outcome.status).toBe("blocked");
    expect(step.status).toBe("blocked");
    expect(step.blockedReason).toBe("task_failed");
    expect(step.blockedQuestion).toContain("reached the ralph limit (2/2)");
    expect(step.blockedQuestion).toContain("Ralph 1");
    expect(session.stepRalphCounts?.["1"]).toBe(2);
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("retries failed build gate and forwards failure context to the next worker attempt", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    plan.buildGate = { commands: ["pnpm build"], runBetweenSteps: true };
    const session = makeSession(plan);
    session.taskCheckpoints = { "1": { baseSha: "base-sha-3" } };

    mockSpawnSync
      .mockReturnValueOnce({
        status: 1,
        signal: null,
        stdout: "",
        stderr: "TS2307: Cannot find module ./generated/client",
      })
      .mockReturnValueOnce({
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
      });

    const contexts: TaskRunnerContext[] = [];
    mockCliExecute.mockImplementation(async (context) => {
      contexts.push(context);
      return {
        status: "complete",
        summary: contexts.length === 1 ? "Initial complete" : "Build-gate fix complete",
        turnsUsed: 1,
      };
    });

    const progress: string[] = [];
    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-build-gate-retry",
      workingDir: "/tmp/moltbot-goal-test",
      onProgress: (text) => progress.push(text),
    });

    expect(outcome.status).toBe("done");
    expect(mockCliExecute).toHaveBeenCalledTimes(2);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["-C", "/tmp/moltbot-goal-test", "reset", "--hard", "base-sha-3"],
      expect.any(Object),
    );
    const retryBundle = contexts[1]?.attemptBundles?.find((bundle) => bundle.buildGateFailure);
    expect(retryBundle?.buildGateFailure?.failedCommand).toBe("pnpm build");
    expect(retryBundle?.buildGateFailure?.output).toContain(
      "The build gate (pnpm build) failed after you reported complete.",
    );
    expect(progress.every((text) => !text.toLowerCase().includes("build gate"))).toBe(true);
    expect(session.buildGateResults?.["1"]?.passed).toBe(true);
  });

  it("marks task blocked when build gate keeps failing after max fix cycles", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    plan.buildGate = { commands: ["pnpm build"], runBetweenSteps: true };
    const session = makeSession(plan);
    session.taskCheckpoints = { "1": { baseSha: "base-sha-4" } };

    mockSpawnSync.mockReturnValue({
      status: 1,
      signal: null,
      stdout: "",
      stderr: "TS2307: Cannot find module ./generated/client",
    });

    mockCliExecute.mockResolvedValue({
      status: "complete",
      summary: "Reported complete",
      turnsUsed: 1,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-build-gate-limit",
      workingDir: "/tmp/moltbot-goal-test",
    });

    expect(outcome.status).toBe("blocked");
    expect(step.status).toBe("blocked");
    expect(step.blockedReason).toBe("task_failed");
    expect(step.blockedQuestion).toContain("Build gate failed after 2 retry cycles.");
    expect(mockCliExecute).toHaveBeenCalledTimes(3);
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });

  it("skips build gate when commands are empty", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    plan.buildGate = { commands: [], runBetweenSteps: true };
    const session = makeSession(plan);

    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "Done",
      turnsUsed: 1,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-build-gate-empty",
      workingDir: "/tmp/moltbot-goal-test",
    });

    expect(outcome.status).toBe("done");
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("runs final build gate even when runBetweenSteps is false", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    plan.buildGate = { commands: ["pnpm build"], runBetweenSteps: false };
    const session = makeSession(plan);

    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "Done",
      turnsUsed: 1,
    });
    mockSpawnSync.mockReturnValueOnce({
      status: 1,
      signal: null,
      stdout: "",
      stderr: "Final gate failure",
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-final-build-gate",
      workingDir: "/tmp/moltbot-goal-test",
    });

    expect(outcome.status).toBe("blocked");
    expect(step.status).toBe("blocked");
    expect(step.blockedReason).toBe("task_failed");
    expect(step.blockedQuestion).toContain("Final build gate failed.");
    expect(session.buildGateResults?.__final__?.passed).toBe(false);
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
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
