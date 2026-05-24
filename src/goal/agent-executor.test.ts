import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoalLlmClient, GoalSession, Plan, PlanStep, SerializedRun } from "./types.js";
import type { BackendAvailability, GoalBackendId } from "./backend-types.js";
import type { TaskRunnerContext, TaskRunnerResult } from "./task-runner.js";
import type { AttemptBundle } from "./attempt-bundle.js";
import { resolveAgentHistoryEventsPath } from "./agent-history-events.js";
import { workspaceNameFromWorkingDir } from "./agent-history.js";
type BuildGateModule = typeof import("./build-gate.js");

const mockCliExecute = vi.fn<Promise<TaskRunnerResult>, [TaskRunnerContext]>();
const mockPiExecute = vi.fn<Promise<TaskRunnerResult>, [TaskRunnerContext]>();
const mockLoadAttemptBundles = vi.fn<(dir: string) => AttemptBundle[]>();
const mockWriteAttemptBundle = vi.fn<(dir: string, bundle: AttemptBundle) => void>();
const mockBuildDefaultSastCommand = vi.fn<
  ReturnType<BuildGateModule["buildDefaultSastCommand"]>,
  Parameters<BuildGateModule["buildDefaultSastCommand"]>
>();
let actualBuildDefaultSastCommand: BuildGateModule["buildDefaultSastCommand"] | undefined;
const mockSpawnSync = vi.fn();
const mockExecFileSync = vi.fn();
const mockRunCliProcess = vi.fn();
const mockResolveClaudeBinary = vi.fn();
const mockExtractRunLessons = vi.fn();
const mockMirrorGoalRuntimeToAgentHistory = vi.fn();
const attemptBundlesByDir = new Map<string, AttemptBundle[]>();
const WORKER_DIR = "/tmp/moltbot-goal-test/worker";
const constructedCliBackends: Array<Exclude<GoalBackendId, "pi">> = [];
const executedCliBackends: Array<Exclude<GoalBackendId, "pi">> = [];
let testManagedRoot: string | undefined;
let previousManagedRoot: string | undefined;

class MockCliTaskRunner {
  private readonly backend: Exclude<GoalBackendId, "pi">;

  constructor(params: { backend: Exclude<GoalBackendId, "pi"> }) {
    this.backend = params.backend;
    constructedCliBackends.push(params.backend);
  }

  execute(context: TaskRunnerContext) {
    executedCliBackends.push(this.backend);
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

vi.mock("./build-gate.js", async () => {
  const actual = await vi.importActual<BuildGateModule>("./build-gate.js");
  actualBuildDefaultSastCommand = actual.buildDefaultSastCommand;
  return {
    ...actual,
    buildDefaultSastCommand: (...args: Parameters<BuildGateModule["buildDefaultSastCommand"]>) =>
      mockBuildDefaultSastCommand(...args),
  };
});

vi.mock("./attempt-bundle.js", () => ({
  loadAttemptBundles: (dir: string) => mockLoadAttemptBundles(dir),
  resolveWorkerDir: () => WORKER_DIR,
  formatAttemptBundleSummary: (bundle: AttemptBundle) => JSON.stringify(bundle),
  writeAttemptBundle: (dir: string, bundle: AttemptBundle) => mockWriteAttemptBundle(dir, bundle),
}));

vi.mock("./cli-process.js", () => ({
  runCliProcess: (...args: unknown[]) => mockRunCliProcess(...args),
}));

vi.mock("./scout.js", () => ({
  resolveClaudeBinary: (...args: unknown[]) => mockResolveClaudeBinary(...args),
}));

vi.mock("./lessons.js", async () => {
  const actual = await vi.importActual<typeof import("./lessons.js")>("./lessons.js");
  return {
    ...actual,
    extractRunLessons: (...args: Parameters<typeof actual.extractRunLessons>) =>
      mockExtractRunLessons(...args),
  };
});

vi.mock("./runtime-mirror.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-mirror.js")>("./runtime-mirror.js");
  return {
    ...actual,
    mirrorGoalRuntimeToAgentHistory: (
      ...args: Parameters<typeof actual.mirrorGoalRuntimeToAgentHistory>
    ) => mockMirrorGoalRuntimeToAgentHistory(...args),
  };
});

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
  resolveRunDir: (runId: string) => `/tmp/moltbot-goal-test/runs/${runId}`,
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

function getGitResetCalls() {
  return mockExecFileSync.mock.calls.filter((call) => {
    const argv = call[1];
    return Array.isArray(argv) && argv.includes("reset") && argv.includes("--hard");
  });
}

function readGoalHistoryEvents(workingDir: string, runId: string): Array<Record<string, unknown>> {
  const eventsPath = resolveAgentHistoryEventsPath({
    kind: "goal",
    workspaceName: workspaceNameFromWorkingDir(workingDir),
    goalId: runId,
  });
  return fs
    .readFileSync(eventsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("agent-executor (TaskRunner orchestration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunStore.clear();
    attemptBundlesByDir.clear();
    mockBuildDefaultSastCommand.mockImplementation((...args) => {
      if (!actualBuildDefaultSastCommand) {
        throw new Error("buildDefaultSastCommand mock used before actual initialization");
      }
      return actualBuildDefaultSastCommand(...args);
    });
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
    mockResolveClaudeBinary.mockReturnValue("/usr/bin/claude");
    mockExtractRunLessons.mockResolvedValue([]);
    mockMirrorGoalRuntimeToAgentHistory.mockReturnValue({
      generatedAt: "2026-05-24T00:00:00.000Z",
      sourceKind: "goal-runtime",
      entries: [],
    });
    mockRunCliProcess.mockResolvedValue({
      stdout: '{"approved":true,"issues":[]}',
      stderr: "",
      timedOut: false,
      exitCode: 0,
      signal: null,
      durationMs: 50,
    });
    availability = [
      { id: "pi", available: true },
      { id: "codex", available: true },
      { id: "claude_code", available: true },
    ];
    constructedCliBackends.length = 0;
    executedCliBackends.length = 0;
    previousManagedRoot = process.env.SMITHERSBOT_GOALS_ROOT;
    testManagedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-executor-managed-"));
    process.env.SMITHERSBOT_GOALS_ROOT = testManagedRoot;
  });

  afterEach(() => {
    if (previousManagedRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
    else process.env.SMITHERSBOT_GOALS_ROOT = previousManagedRoot;
    if (testManagedRoot) fs.rmSync(testManagedRoot, { recursive: true, force: true });
    testManagedRoot = undefined;
    previousManagedRoot = undefined;
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

  it("clears stale run-level blocker fields on transition to done", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    const session = makeSession(plan);
    // Simulate a prior interruption that left stale blocker/lastError fields.
    session.state = "blocked";
    session.blocked = {
      blockedAt: "execution",
      prompt: "You've hit your usage limit. Upgrade at https://example.com/upgrade",
      requiredInputKey: "resume_execution",
    };
    session.lastError = "You've hit your usage limit.";

    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "All set",
      turnsUsed: 1,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-clears-blocker-on-done",
      workingDir: "/tmp/moltbot-goal-test",
    });

    expect(outcome.status).toBe("done");
    expect(session.state).toBe("done");
    // Stale blocker/lastError must be cleared so /goal_status renders no blocker.
    expect(session.blocked).toBeNull();
    expect(session.lastError).toBeUndefined();
  });

  it("allows legacy workingDir by default with a warning", async () => {
    const root = "/tmp/smithersbot-managed-agent-executor";
    const previousRoot = process.env.SMITHERSBOT_GOALS_ROOT;
    process.env.SMITHERSBOT_GOALS_ROOT = root;
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    const session = makeSession(plan);
    const onProgress = vi.fn();
    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "All set",
      turnsUsed: 1,
    });

    try {
      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const outcome = await executeGoalWithAgent({
        session,
        runId: "run-legacy-warning",
        workingDir: "/tmp/moltbot-goal-test",
        onProgress,
      });

      expect(outcome.status).toBe("done");
      expect(onProgress.mock.calls.flat().join("\n")).toContain(
        "outside the SmithersBot managed agent root",
      );
    } finally {
      if (previousRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
      else process.env.SMITHERSBOT_GOALS_ROOT = previousRoot;
    }
  });

  it("rejects legacy workingDir when compatibility is disabled", async () => {
    const root = "/tmp/smithersbot-managed-agent-executor";
    const previousRoot = process.env.SMITHERSBOT_GOALS_ROOT;
    process.env.SMITHERSBOT_GOALS_ROOT = root;
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    const session = makeSession(plan);

    try {
      const { executeGoalWithAgent } = await import("./agent-executor.js");
      await expect(
        executeGoalWithAgent({
          session,
          runId: "run-legacy-reject",
          workingDir: "/tmp/moltbot-goal-test",
          config: { goal: { allowLegacyWorkingDir: false } },
        }),
      ).rejects.toThrow("managed agent root");
      expect(mockCliExecute).not.toHaveBeenCalled();
    } finally {
      if (previousRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
      else process.env.SMITHERSBOT_GOALS_ROOT = previousRoot;
    }
  });

  it("clamps claude_code steps to codex when codex is the only enabled worker", async () => {
    const step = makeStep({ backend: "claude_code", executedBackend: "claude_code" });
    const plan = makePlan([step]);
    const session = makeSession(plan);

    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "Done via codex",
      turnsUsed: 1,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-codex-only-clamp",
      workingDir: "/tmp/moltbot-goal-test",
      enabledWorkers: ["codex"],
    });

    expect(outcome.status).toBe("done");
    expect(step.executedBackend).toBe("codex");
    expect(executedCliBackends).toEqual(["codex"]);
    expect(constructedCliBackends).toEqual(["codex"]);
  });

  it("clamps codex steps to claude_code when claude_code is the only enabled worker", async () => {
    const step = makeStep({ backend: "codex", executedBackend: "codex" });
    const plan = makePlan([step]);
    const session = makeSession(plan);

    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "Done via claude",
      turnsUsed: 1,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-claude-only-clamp",
      workingDir: "/tmp/moltbot-goal-test",
      enabledWorkers: ["claude_code"],
    });

    expect(outcome.status).toBe("done");
    expect(step.executedBackend).toBe("claude_code");
    expect(executedCliBackends).toEqual(["claude_code"]);
    expect(constructedCliBackends).toEqual(["claude_code"]);
  });

  it("keeps existing CLI backend routing when both workers are enabled", async () => {
    const step = makeStep({ backend: "claude_code" });
    const plan = makePlan([step]);
    const session = makeSession(plan);

    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "Done via claude",
      turnsUsed: 1,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-both-workers",
      workingDir: "/tmp/moltbot-goal-test",
      enabledWorkers: ["codex", "claude_code"],
    });

    expect(outcome.status).toBe("done");
    expect(step.executedBackend).toBe("claude_code");
    expect(executedCliBackends).toEqual(["claude_code"]);
    expect(constructedCliBackends).toEqual(["codex", "claude_code"]);
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
      (
        event,
      ): event is {
        type: "all_done";
        manualTests?: unknown[];
        manualTestsError?: string;
        manualTestsStatus?: "generated" | "skipped_no_backend" | "failed";
      } =>
        typeof event === "object" &&
        event !== null &&
        (event as { type?: string }).type === "all_done",
    );
    expect(allDoneEvent).toBeDefined();
    expect(allDoneEvent?.manualTests).toBeUndefined();
    expect(allDoneEvent?.manualTestsError).toContain("authentication_error");
    expect(allDoneEvent?.manualTestsStatus).toBe("failed");
  });

  it('emits manualTestsStatus "generated" when manual-test generation succeeds', async () => {
    const step = makeStep({ backend: "codex", description: "Implement login validation" });
    const plan = makePlan([step]);
    const session = makeSession(plan);

    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "All set",
      turnsUsed: 1,
    });

    const manualTestsClient: GoalLlmClient = {
      complete: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          tests: [
            {
              description: "Verify login banner",
              criticality: 6,
              detail: "Step 1. Submit invalid credentials.\nStep 2. Confirm inline error.",
            },
          ],
        }),
      }),
    };
    const statusEvents: unknown[] = [];

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-manual-tests-generated",
      workingDir: "/tmp/moltbot-goal-test",
      manualTestsClient,
      onStatusChange: (event) => {
        statusEvents.push(event);
      },
    });

    expect(outcome.status).toBe("done");
    const allDoneEvent = statusEvents.find(
      (
        event,
      ): event is {
        type: "all_done";
        manualTests?: unknown[];
        manualTestsError?: string;
        manualTestsStatus?: "generated" | "skipped_no_backend" | "failed";
      } =>
        typeof event === "object" &&
        event !== null &&
        (event as { type?: string }).type === "all_done",
    );
    expect(allDoneEvent?.manualTestsStatus).toBe("generated");
    expect(allDoneEvent?.manualTestsError).toBeUndefined();
    expect(allDoneEvent?.manualTests).toBeDefined();
  });

  it('emits manualTestsStatus "skipped_no_backend" when manual-tests reports no available backend', async () => {
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
        .mockRejectedValue(new Error("no worker backend available — install Codex or Claude Code")),
    };
    const statusEvents: unknown[] = [];

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-manual-tests-no-backend",
      workingDir: "/tmp/moltbot-goal-test",
      manualTestsClient,
      onStatusChange: (event) => {
        statusEvents.push(event);
      },
    });

    expect(outcome.status).toBe("done");
    const allDoneEvent = statusEvents.find(
      (
        event,
      ): event is {
        type: "all_done";
        manualTests?: unknown[];
        manualTestsError?: string;
        manualTestsStatus?: "generated" | "skipped_no_backend" | "failed";
      } =>
        typeof event === "object" &&
        event !== null &&
        (event as { type?: string }).type === "all_done",
    );
    expect(allDoneEvent?.manualTestsStatus).toBe("skipped_no_backend");
    expect(allDoneEvent?.manualTestsError).toContain("no worker backend available");
    expect(allDoneEvent?.manualTests).toBeUndefined();
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

  it("collider: runs both answered user-input parents then the child to completion", async () => {
    // Two independent parents blocked on user input, each with an operator
    // answer, plus one child depending on both. The scheduler treats answered
    // blocked parents as runnable, runs BOTH (not just the first), and only then
    // runs the child once both are done — finishing with an all-done graph.
    const parentA = makeStep({
      id: "collider-parent-a",
      backend: "codex",
      status: "blocked",
      blockedReason: "user_input",
      blockedQuestion: "Detail for A?",
    });
    const parentB = makeStep({
      id: "collider-parent-b",
      backend: "codex",
      status: "blocked",
      blockedReason: "user_input",
      blockedQuestion: "Detail for B?",
    });
    const child = makeStep({
      id: "collider-child",
      backend: "codex",
      status: "pending",
      dependsOn: ["collider-parent-a", "collider-parent-b"],
    });
    const plan = makePlan([parentA, parentB, child]);
    const session = makeSession(plan);
    session.answers = {
      "task:collider-parent-a:input": "A details",
      "task:collider-parent-b:input": "B details",
    };

    mockCliExecute.mockResolvedValue({ status: "complete", summary: "ok", turnsUsed: 1 });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-collider-complete",
      workingDir: "/tmp/moltbot-goal-test",
    });

    expect(outcome.status).toBe("done");
    expect(parentA.status).toBe("done");
    expect(parentB.status).toBe("done");
    expect(child.status).toBe("done");
    // All three tasks actually executed (both parents, not just the first).
    expect(mockCliExecute).toHaveBeenCalledTimes(3);
    // The scheduler consumed both answers while running the parents.
    expect(session.answers["task:collider-parent-a:input"]).toBeUndefined();
    expect(session.answers["task:collider-parent-b:input"]).toBeUndefined();
  });

  it("blocks all pending steps when a fatal auth error triggers global block", async () => {
    const step1 = makeStep({ id: "1", backend: "codex" });
    const step2 = makeStep({ id: "2", backend: "codex", dependsOn: ["1"] });
    const step3 = makeStep({ id: "3", backend: "codex", dependsOn: ["2"] });
    const plan = makePlan([step1, step2, step3]);
    const session = makeSession(plan);

    mockCliExecute.mockResolvedValueOnce({
      status: "blocked",
      question: "Authentication failed",
      blockedReason: "auth",
      turnsUsed: 1,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-fatal-global-block",
      workingDir: "/tmp/moltbot-goal-test",
    });

    expect(outcome.status).toBe("blocked");
    expect(session.state).toBe("blocked");
    expect(step1.status).toBe("blocked");
    expect(step2.status).toBe("blocked");
    expect(step3.status).toBe("blocked");
    expect(step2.blockedReason).toBe("auth");
    expect(step3.blockedReason).toBe("auth");
    expect(step2.blockedQuestion).toBe("Authentication failed");
    expect(step3.blockedQuestion).toBe("Authentication failed");
    expect(mockCliExecute).toHaveBeenCalledTimes(1);
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

  it("falls back from Codex to Claude Code when Codex hits a rate limit", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    const session = makeSession(plan);
    const progress: string[] = [];
    const runId = "run-codex-rate-limit-fallback";
    const workingDir = "/tmp/moltbot-goal-test";

    mockCliExecute
      .mockResolvedValueOnce({
        status: "blocked",
        question: "Codex usage limit reached",
        blockedReason: "rate_limit",
        turnsUsed: 1,
      })
      .mockResolvedValueOnce({
        status: "complete",
        summary: "Recovered with Claude Code",
        turnsUsed: 1,
      });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId,
      workingDir,
      enabledWorkers: ["codex", "claude_code"],
      retryConfig: { maxAttempts: 2, retryDelayMs: 1 },
      onProgress: (message) => progress.push(message),
    });

    expect(outcome.status).toBe("done");
    expect(step.status).toBe("done");
    expect(step.executedBackend).toBe("claude_code");
    expect(executedCliBackends).toEqual(["codex", "claude_code"]);
    expect(progress).toContain(
      "  [usage-limit] Codex hit a rate limit. Falling back to Claude Code.",
    );
    expect(readGoalHistoryEvents(workingDir, runId)).toEqual([
      expect.objectContaining({
        event: "usage_limit",
        phase: "worker",
        backend: "codex",
        stepId: step.id,
        attemptNumber: 1,
        status: "blocked",
        errorClass: "rate_limit",
      }),
      expect.objectContaining({
        event: "usage_limit_fallback",
        phase: "worker",
        backend: "claude_code",
        stepId: step.id,
        attemptNumber: 2,
        status: "pending",
      }),
    ]);
  });

  it("blocks clearly when Codex rate-limits and Claude Code is disabled", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    const session = makeSession(plan);

    mockCliExecute.mockResolvedValueOnce({
      status: "blocked",
      question: "Codex usage limit reached",
      blockedReason: "rate_limit",
      turnsUsed: 1,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-codex-rate-limit-claude-disabled",
      workingDir: "/tmp/moltbot-goal-test",
      enabledWorkers: ["codex"],
      retryConfig: { maxAttempts: 2, retryDelayMs: 1 },
    });

    expect(outcome.status).toBe("blocked");
    expect(step.status).toBe("blocked");
    expect(step.executedBackend).toBe("codex");
    expect(executedCliBackends).toEqual(["codex"]);
    expect(step.blockedQuestion).toContain("Codex hit a rate limit");
    expect(step.blockedQuestion).toContain("single enabled worker");
  });

  it("falls back from Claude Code to Codex when Claude Code hits a rate limit", async () => {
    const step = makeStep({ backend: "claude_code" });
    const plan = makePlan([step]);
    const session = makeSession(plan);

    mockCliExecute
      .mockResolvedValueOnce({
        status: "blocked",
        question: "Claude usage limit reached",
        blockedReason: "usage_limit",
        turnsUsed: 1,
      })
      .mockResolvedValueOnce({
        status: "complete",
        summary: "Recovered with Codex",
        turnsUsed: 1,
      });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-claude-rate-limit-fallback",
      workingDir: "/tmp/moltbot-goal-test",
      enabledWorkers: ["codex", "claude_code"],
      retryConfig: { maxAttempts: 2, retryDelayMs: 1 },
    });

    expect(outcome.status).toBe("done");
    expect(step.status).toBe("done");
    expect(step.executedBackend).toBe("codex");
    expect(executedCliBackends).toEqual(["claude_code", "codex"]);
  });

  it("preserves usage-limit failure history with reset time after a successful fallback", async () => {
    const step = makeStep({ backend: "claude_code" });
    const plan = makePlan([step]);
    const session = makeSession(plan);
    const progress: string[] = [];

    mockCliExecute
      .mockResolvedValueOnce({
        status: "blocked",
        question: "Claude Code usage limit reached. Resets at 3pm.",
        blockedReason: "usage_limit",
        turnsUsed: 1,
      })
      .mockResolvedValueOnce({
        status: "complete",
        summary: "Recovered with Codex",
        turnsUsed: 1,
      });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-claude-usage-fallback-history",
      workingDir: "/tmp/moltbot-goal-test",
      enabledWorkers: ["codex", "claude_code"],
      retryConfig: { maxAttempts: 2, retryDelayMs: 1 },
      onProgress: (message) => progress.push(message),
    });

    expect(outcome.status).toBe("done");
    expect(step.executedBackend).toBe("codex");
    expect(progress).toContain(
      "  [usage-limit] Claude Code hit a usage limit (resets at 3pm). Falling back to Codex.",
    );
    expect(progress).toContain(
      "  [usage-limit] Claude Code hit a usage limit (resets at 3pm). Fell back to Codex. Codex succeeded.",
    );
  });

  it("renders reset times in the final message when both backends are exhausted", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    const session = makeSession(plan);

    mockCliExecute
      .mockResolvedValueOnce({
        status: "blocked",
        question: "Codex hit its usage limit. Resets at 3pm.",
        blockedReason: "usage_limit",
        turnsUsed: 1,
      })
      .mockResolvedValueOnce({
        status: "blocked",
        question: "Claude Code weekly usage limit reached. Resets Monday.",
        blockedReason: "usage_limit",
        turnsUsed: 1,
      });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-both-backends-exhausted",
      workingDir: "/tmp/moltbot-goal-test",
      enabledWorkers: ["codex", "claude_code"],
      retryConfig: { maxAttempts: 3, retryDelayMs: 1 },
    });

    expect(outcome.status).toBe("blocked");
    expect(executedCliBackends).toEqual(["codex", "claude_code"]);
    const blockedQuestion = step.blockedQuestion ?? "";
    expect(blockedQuestion).toContain("Codex hit a usage limit (resets at 3pm).");
    expect(blockedQuestion).toContain(
      "Claude Code hit a usage limit (weekly limit, resets Monday).",
    );
    expect(blockedQuestion).toContain("the fallback backend already hit a usage or rate limit");
    expect(blockedQuestion).toContain(
      "Reset times: Codex resets at 3pm; Claude Code resets Monday.",
    );
    expect(blockedQuestion).not.toContain("org's monthly usage limit");
  });

  it("classifies a Claude Code monthly limit as Claude Code, not a generic org message", async () => {
    const step = makeStep({ backend: "claude_code" });
    const plan = makePlan([step]);
    const session = makeSession(plan);

    mockCliExecute.mockResolvedValueOnce({
      status: "blocked",
      question: "API 429: You've hit your org's monthly usage limit",
      blockedReason: "usage_limit",
      turnsUsed: 1,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-claude-monthly-classification",
      workingDir: "/tmp/moltbot-goal-test",
      enabledWorkers: ["claude_code"],
      retryConfig: { maxAttempts: 2, retryDelayMs: 1 },
    });

    expect(outcome.status).toBe("blocked");
    expect(step.blockedQuestion).toContain(
      "Claude Code hit a usage limit (monthly extra-usage limit)",
    );
  });

  it("surfaces Codex usage limit plus Claude missing result as technical resume-needed block", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    const session = makeSession(plan);

    mockCliExecute.mockImplementation(async () => {
      if (mockCliExecute.mock.calls.length === 1) {
        appendAttemptBundle({
          attemptNumber: 1,
          backend: "codex",
          outcome: "rate_limit",
          errorClassification: "usage_limit",
          durationMs: 10,
        });
        return {
          status: "blocked",
          question: "Codex hit usage limit",
          blockedReason: "usage_limit",
          turnsUsed: 1,
        };
      }

      appendAttemptBundle({
        attemptNumber: 2,
        backend: "claude_code",
        outcome: "process_lost",
        errorClassification: "missing_result",
        durationMs: 10,
      });
      return {
        status: "blocked",
        question: "Claude Code fallback exited without result artifact",
        blockedReason: "process_lost",
        turnsUsed: 1,
      };
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-codex-usage-claude-missing",
      workingDir: "/tmp/moltbot-goal-test",
      enabledWorkers: ["codex", "claude_code"],
      retryConfig: { maxAttempts: 2, retryDelayMs: 1 },
    });

    expect(outcome.status).toBe("blocked");
    expect(step.status).toBe("blocked");
    expect(step.blockedReason).toBe("process_lost");
    expect(step.blockedQuestion).toContain("Claude Code fallback exited without result artifact");
    expect(step.blockedQuestion).toContain("Attempt 1 [codex]: rate_limit (usage_limit)");
    expect(step.blockedQuestion).toContain(
      "Attempt 2 [claude_code]: process_lost (missing_result)",
    );
    expect(step.blockedQuestion).not.toContain("needs input");
    expect(session.blocked?.requiredInputKey).toBe("resume_execution");
    expect(session.blocked?.prompt).not.toContain("needs input");
    expect(executedCliBackends).toEqual(["codex", "claude_code"]);
  });

  it("resumes a technical error-blocked step before unrelated pending steps", async () => {
    const pendingEarlierStep = makeStep({
      id: "1",
      backend: "codex",
      description: "Unrelated later work",
    });
    const blockedStep = makeStep({
      id: "2",
      backend: "codex",
      description: "Retry interrupted work",
      status: "blocked",
      blockedReason: "process_lost",
      blockedQuestion: "Worker process lost; resume needed",
    });
    const plan = makePlan([pendingEarlierStep, blockedStep]);
    const session = makeSession(plan);
    const executedTaskIds: string[] = [];

    mockCliExecute.mockImplementation(async (context) => {
      executedTaskIds.push(context.task.id);
      return {
        status: "complete",
        summary: `Done ${context.task.id}`,
        turnsUsed: 1,
      };
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-resume-technical-first",
      workingDir: "/tmp/moltbot-goal-test",
      enabledWorkers: ["codex"],
      retryConfig: { maxAttempts: 1, retryDelayMs: 1 },
    });

    expect(outcome.status).toBe("done");
    expect(executedTaskIds).toEqual(["2", "1"]);
  });

  it("does not fallback outside an explicit backend override", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    const session = makeSession(plan);

    mockCliExecute.mockResolvedValueOnce({
      status: "blocked",
      question: "Codex usage limit reached",
      blockedReason: "rate_limit",
      turnsUsed: 1,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-codex-rate-limit-override",
      workingDir: "/tmp/moltbot-goal-test",
      enabledWorkers: ["codex", "claude_code"],
      serializedRun: { backendOverride: "codex" } as unknown as SerializedRun,
      retryConfig: { maxAttempts: 2, retryDelayMs: 1 },
    });

    expect(outcome.status).toBe("blocked");
    expect(step.executedBackend).toBe("codex");
    expect(executedCliBackends).toEqual(["codex"]);
    expect(step.blockedQuestion).toContain("constrained to backend 'codex'");
  });

  it("blocks with the PATH availability reason when fallback backend is unavailable", async () => {
    availability = [
      { id: "pi", available: true },
      { id: "codex", available: true },
      { id: "claude_code", available: false, reason: "claude_code not found on PATH" },
    ];

    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    const session = makeSession(plan);

    mockCliExecute.mockResolvedValueOnce({
      status: "blocked",
      question: "Codex usage limit reached",
      blockedReason: "rate_limit",
      turnsUsed: 1,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-codex-rate-limit-claude-path",
      workingDir: "/tmp/moltbot-goal-test",
      enabledWorkers: ["codex", "claude_code"],
      retryConfig: { maxAttempts: 2, retryDelayMs: 1 },
    });

    expect(outcome.status).toBe("blocked");
    expect(step.executedBackend).toBe("codex");
    expect(executedCliBackends).toEqual(["codex"]);
    expect(step.blockedQuestion).toContain("claude_code not found on PATH");
  });

  it("records the fallback backend on task artifacts used by captions", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    const session = makeSession(plan);
    const updates: unknown[] = [];

    mockCliExecute
      .mockResolvedValueOnce({
        status: "blocked",
        question: "Codex usage limit reached",
        blockedReason: "usage_limit",
        turnsUsed: 1,
      })
      .mockResolvedValueOnce({
        status: "complete",
        summary: "Fallback worker completed the task",
        turnsUsed: 1,
      });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-codex-fallback-caption-backend",
      workingDir: "/tmp/moltbot-goal-test",
      enabledWorkers: ["codex", "claude_code"],
      retryConfig: { maxAttempts: 2, retryDelayMs: 1 },
      onTaskUpdate: (update) => updates.push(update),
    });

    expect(outcome.status).toBe("done");
    expect(step.executedBackend).toBe("claude_code");
    expect(session.plan.steps[0]?.executedBackend).toBe("claude_code");
    expect(session.stepResults.get("1")?.output).toBe("Fallback worker completed the task");
    expect(updates).toEqual([
      expect.objectContaining({
        taskId: "1",
        outcome: "done",
        summary: "Fallback worker completed the task",
      }),
    ]);
  });

  it("reverts on ralph and retries with ralph context", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    plan.buildGate = { commands: [], runBetweenSteps: false, postExecutionReview: false };
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

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-ralph-retry",
      workingDir: "/tmp/moltbot-goal-test",
    });

    expect(outcome.status).toBe("done");
    expect(session.stepRalphCounts?.["1"]).toBe(1);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["-C", "/tmp/moltbot-goal-test", "reset", "--hard", "base-sha-1"],
      expect.any(Object),
    );
    expect(contexts[1]?.attemptBundles?.some((bundle) => bundle.ralphDetail?.keyInsight)).toBe(
      true,
    );
  });

  it("escalates to blocked when ralph limit is reached", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    plan.buildGate = { commands: [], runBetweenSteps: false, postExecutionReview: false };
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
    const blockedQuestion = step.blockedQuestion ?? "";
    expect(blockedQuestion).toContain("**Ralph 1 (attempt 1):**");
    expect(blockedQuestion).toContain("**Ralph 2 (attempt 2):**");
    expect(blockedQuestion).toContain("• **Approach tried:** Tried patching unresolved paths");
    expect(blockedQuestion).toContain(
      "• **Errors:** Build still failed with many unresolved imports",
    );
    expect(blockedQuestion).toContain(
      "• **Key insight:** Current patch-only approach is structurally wrong",
    );
    expect(blockedQuestion).toContain(
      "• **Suggested approach:** Regenerate artifacts before patching imports",
    );
    expect(blockedQuestion.match(/\*\*Approach tried:\*\*/g)).toHaveLength(2);
    expect(blockedQuestion.match(/\*\*Errors:\*\*/g)).toHaveLength(2);
    expect(blockedQuestion.match(/\*\*Key insight:\*\*/g)).toHaveLength(2);
    expect(blockedQuestion.match(/\*\*Suggested approach:\*\*/g)).toHaveLength(2);
    expect(blockedQuestion).toMatch(
      /\*\*Suggested approach:\*\* Regenerate artifacts before patching imports\n\n\*\*Ralph 2 \(attempt 2\):\*\*/,
    );
    expect(session.stepRalphCounts?.["1"]).toBe(2);
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("retries failed build gate and forwards failure context to the next worker attempt", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    plan.buildGate = {
      commands: ["pnpm build"],
      runBetweenSteps: true,
      postExecutionReview: false,
    };
    const session = makeSession(plan);
    session.taskCheckpoints = { "1": { baseSha: "base-sha-3" } };

    mockSpawnSync
      .mockReturnValueOnce({
        status: 1,
        signal: null,
        stdout: "",
        stderr: "semgrep not found",
      })
      .mockReturnValueOnce({
        status: 1,
        signal: null,
        stdout: "",
        stderr: "TS2307: Cannot find module ./generated/client",
      })
      .mockReturnValueOnce({
        status: 1,
        signal: null,
        stdout: "",
        stderr: "semgrep not found",
      })
      .mockReturnValueOnce({
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
      })
      .mockReturnValue({
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
      config: { goal: { semgrep: "step" } },
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

  it("notifies task updates when build-gate reset returns a step to pending", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    plan.buildGate = {
      commands: ["pnpm build"],
      runBetweenSteps: true,
      postExecutionReview: false,
    };
    const session = makeSession(plan);
    session.taskCheckpoints = { "1": { baseSha: "base-sha-pending-notify" } };

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

    mockCliExecute
      .mockResolvedValueOnce({
        status: "complete",
        summary: "Initial complete",
        turnsUsed: 1,
      })
      .mockResolvedValueOnce({
        status: "blocked",
        question: "Need user input after retry",
        blockedReason: "user_input",
        turnsUsed: 1,
      });

    const updates: Array<{
      taskId: string;
      outcome: string;
      summary?: string;
      statusSnapshot: PlanStep["status"] | undefined;
    }> = [];

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-build-gate-pending-notify",
      workingDir: "/tmp/moltbot-goal-test",
      config: { goal: { semgrep: "off" } },
      onTaskUpdate: (result) => {
        updates.push({
          taskId: result.taskId,
          outcome: result.outcome,
          summary: result.summary,
          statusSnapshot: session.plan?.steps.find((candidate) => candidate.id === result.taskId)
            ?.status,
        });
      },
    });

    expect(outcome.status).toBe("blocked");
    expect(mockCliExecute).toHaveBeenCalledTimes(2);
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: "1",
          outcome: "blocked",
          summary: "Build-gate reset task to pending for retry.",
          statusSnapshot: "pending",
        }),
      ]),
    );
  });

  it("marks task blocked when build gate keeps failing after max fix cycles", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    plan.buildGate = {
      commands: ["pnpm build"],
      runBetweenSteps: true,
      postExecutionReview: false,
    };
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
      config: { goal: { semgrep: "step" } },
    });

    expect(outcome.status).toBe("blocked");
    expect(step.status).toBe("blocked");
    expect(step.blockedReason).toBe("task_failed");
    expect(step.blockedQuestion).toContain("Build gate failed after 2 retry cycles.");
    expect(mockCliExecute).toHaveBeenCalledTimes(3);
    expect(getGitResetCalls()).toHaveLength(2);
  });

  it("respects persisted build-gate fix counts when resuming", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    plan.buildGate = {
      commands: ["pnpm build"],
      runBetweenSteps: true,
      postExecutionReview: false,
    };
    const session = makeSession(plan);
    session.taskCheckpoints = { "1": { baseSha: "base-sha-5" } };

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
      runId: "run-build-gate-resume-count",
      workingDir: "/tmp/moltbot-goal-test",
      config: { goal: { semgrep: "step" } },
      serializedRun: { buildGateFixCounts: { "1": 2 } } as unknown as SerializedRun,
    });

    expect(outcome.status).toBe("blocked");
    expect(step.status).toBe("blocked");
    expect(step.blockedReason).toBe("task_failed");
    expect(step.blockedQuestion).toContain("Build gate failed after 2 retry cycles.");
    expect(mockCliExecute).toHaveBeenCalledTimes(1);
    expect(getGitResetCalls()).toHaveLength(0);
    expect(session.buildGateFixCounts?.["1"]).toBe(3);
  });

  it("resets persisted build-gate fix counts when gate signature changes", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    plan.buildGate = {
      commands: ["pnpm build"],
      runBetweenSteps: true,
      postExecutionReview: false,
    };
    const session = makeSession(plan);
    session.taskCheckpoints = { "1": { baseSha: "base-sha-signature" } };

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
      runId: "run-build-gate-signature-reset",
      workingDir: "/tmp/moltbot-goal-test",
      serializedRun: {
        buildGateFixCounts: { "1": 2 },
        buildGateFixSignatures: { "1": "pnpm build --old-signature" },
      } as unknown as SerializedRun,
    });

    expect(outcome.status).toBe("blocked");
    expect(step.blockedReason).toBe("task_failed");
    expect(step.blockedQuestion).toContain("Build gate failed after 2 retry cycles.");
    expect(mockCliExecute).toHaveBeenCalledTimes(3);
    expect(getGitResetCalls()).toHaveLength(2);
  });

  it("blocks immediately on semgrep infrastructure failures without consuming fix cycles", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    plan.buildGate = {
      commands: ["semgrep scan --config auto --error .", "pnpm build"],
      runBetweenSteps: true,
      postExecutionReview: false,
    };
    const session = makeSession(plan);

    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      signal: null,
      stdout: "/usr/local/bin/semgrep\n",
      stderr: "",
    });
    mockSpawnSync.mockReturnValueOnce({
      status: 2,
      signal: null,
      stdout: "",
      stderr: "Failed to resolve 'semgrep.dev' while downloading auto config",
    });

    mockCliExecute.mockResolvedValue({
      status: "complete",
      summary: "Reported complete",
      turnsUsed: 1,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-build-gate-semgrep-infra",
      workingDir: "/tmp/moltbot-goal-test",
      config: { goal: { semgrep: "step" } },
    });

    expect(outcome.status).toBe("blocked");
    expect(step.status).toBe("blocked");
    expect(step.blockedReason).toBe("task_failed");
    expect(step.blockedQuestion).toContain("Build gate infrastructure failed.");
    expect(mockCliExecute).toHaveBeenCalledTimes(1);
    expect(session.buildGateFixCounts?.["1"]).toBeUndefined();
    expect(getGitResetCalls()).toHaveLength(0);
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
      config: { goal: { semgrep: "off" } },
    });

    expect(outcome.status).toBe("done");
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("skips semgrep for both step and final gates when goal.semgrep is off", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    plan.buildGate = {
      commands: ["pnpm build"],
      runBetweenSteps: true,
      postExecutionReview: false,
    };
    const session = makeSession(plan);

    mockBuildDefaultSastCommand.mockReturnValue("semgrep scan --config auto --error .");
    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "Done",
      turnsUsed: 1,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-semgrep-mode-off",
      workingDir: "/tmp/moltbot-goal-test",
      config: { goal: { semgrep: "off" } },
    });

    expect(outcome.status).toBe("done");
    expect(mockBuildDefaultSastCommand).not.toHaveBeenCalled();
    const bashCommands = mockSpawnSync.mock.calls
      .filter((call) => call[0] === "bash")
      .map((call) => (Array.isArray(call[1]) ? call[1][1] : undefined))
      .filter((command): command is string => typeof command === "string");
    expect(bashCommands).toEqual(["pnpm build", "pnpm build"]);
  });

  it("runs semgrep between steps only when goal.semgrep is step", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    plan.buildGate = {
      commands: ["pnpm build"],
      runBetweenSteps: true,
      postExecutionReview: false,
    };
    const session = makeSession(plan);

    mockBuildDefaultSastCommand.mockReturnValue("semgrep scan --config auto --error .");
    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "Done",
      turnsUsed: 1,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-semgrep-mode-step",
      workingDir: "/tmp/moltbot-goal-test",
      config: { goal: { semgrep: "step" } },
    });

    expect(outcome.status).toBe("done");
    expect(mockBuildDefaultSastCommand).toHaveBeenCalledTimes(1);
    expect(mockBuildDefaultSastCommand).toHaveBeenCalledWith({
      workingDir: "/tmp/moltbot-goal-test",
      targetPaths: undefined,
    });
    const bashCommands = mockSpawnSync.mock.calls
      .filter((call) => call[0] === "bash")
      .map((call) => (Array.isArray(call[1]) ? call[1][1] : undefined))
      .filter((command): command is string => typeof command === "string");
    expect(bashCommands).toEqual([
      "semgrep scan --config auto --error .",
      "pnpm build",
      "pnpm build",
    ]);
  });

  it("defaults to goal-level semgrep when config has no semgrep override", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    plan.buildGate = {
      commands: ["pnpm build"],
      runBetweenSteps: true,
      postExecutionReview: false,
    };
    const session = makeSession(plan);

    mockBuildDefaultSastCommand.mockReturnValue("semgrep scan --config auto --error .");
    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "Done",
      turnsUsed: 1,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-semgrep-default",
      workingDir: "/tmp/moltbot-goal-test",
      config: {},
    });

    expect(outcome.status).toBe("done");
    expect(mockBuildDefaultSastCommand).toHaveBeenCalledTimes(1);
    expect(mockBuildDefaultSastCommand).toHaveBeenCalledWith({
      workingDir: "/tmp/moltbot-goal-test",
    });
    const bashCommands = mockSpawnSync.mock.calls
      .filter((call) => call[0] === "bash")
      .map((call) => (Array.isArray(call[1]) ? call[1][1] : undefined))
      .filter((command): command is string => typeof command === "string");
    expect(bashCommands).toEqual([
      "pnpm build",
      "semgrep scan --config auto --error .",
      "pnpm build",
    ]);
  });

  it("runs semgrep only in the final gate when goal.semgrep is goal", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    plan.buildGate = {
      commands: ["pnpm build"],
      runBetweenSteps: true,
      postExecutionReview: false,
    };
    const session = makeSession(plan);

    mockBuildDefaultSastCommand.mockReturnValue("semgrep scan --config auto --error .");
    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "Done",
      turnsUsed: 1,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-semgrep-mode-goal",
      workingDir: "/tmp/moltbot-goal-test",
      config: { goal: { semgrep: "goal" } },
    });

    expect(outcome.status).toBe("done");
    expect(mockBuildDefaultSastCommand).toHaveBeenCalledTimes(1);
    expect(mockBuildDefaultSastCommand).toHaveBeenCalledWith({
      workingDir: "/tmp/moltbot-goal-test",
    });
    const bashCommands = mockSpawnSync.mock.calls
      .filter((call) => call[0] === "bash")
      .map((call) => (Array.isArray(call[1]) ? call[1][1] : undefined))
      .filter((command): command is string => typeof command === "string");
    expect(bashCommands).toEqual([
      "pnpm build",
      "semgrep scan --config auto --error .",
      "pnpm build",
    ]);
  });

  it("blocks on final build gate failure without mutating done step status", async () => {
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
      config: { goal: { semgrep: "off" } },
    });

    expect(outcome.status).toBe("blocked");
    expect(step.status).toBe("done");
    expect(step.blockedReason).toBeUndefined();
    expect(step.blockedQuestion).toBeUndefined();
    expect(outcome.question).toContain("Final build gate failed.");
    expect(session.lastError).toContain("Final build gate failed on pnpm build.");
    expect(session.buildGateResults?.__final__?.passed).toBe(false);
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });

  it("does not spawn the LLM post-execution review after a completed goal", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    const session = makeSession(plan);
    session.taskCheckpoints = { "1": { baseSha: "base-sha-review" } };

    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "Done",
      turnsUsed: 1,
    });
    // If the removed review still ran it would consume this error_max_turns
    // envelope and leak it into the summary; assert it never does.
    mockRunCliProcess.mockResolvedValue({
      stdout: JSON.stringify({
        type: "result",
        is_error: true,
        stop_reason: "tool_use",
        num_turns: 2,
        result: "error_max_turns",
      }),
      stderr: "",
      timedOut: false,
      exitCode: 1,
      signal: null,
      durationMs: 20,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-post-review-removed",
      workingDir: "/tmp/moltbot-goal-test",
    });

    expect(outcome.status).toBe("done");
    // The review's backend spawn (runCliProcess) must never be invoked.
    expect(mockRunCliProcess).not.toHaveBeenCalled();
    if (outcome.status === "done") {
      expect(outcome.summary).not.toContain("Post-Execution Review");
      expect(outcome.summary).not.toContain("Post-execution review skipped");
      expect(outcome.summary).not.toContain("Approved.");
    }
  });

  it("never injects a system-polish step now that the review is removed", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    const session = makeSession(plan);
    session.taskCheckpoints = { "1": { baseSha: "base-sha-polish" } };

    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "Primary implementation done",
      turnsUsed: 1,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-no-polish",
      workingDir: "/tmp/moltbot-goal-test",
    });

    expect(outcome.status).toBe("done");
    // Only the primary task runs; no review-driven second worker pass.
    expect(mockCliExecute).toHaveBeenCalledTimes(1);
    expect(plan.steps.find((item) => item.id === "system-polish")).toBeUndefined();
  });

  it("still generates manual tests after a completed goal", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    const session = makeSession(plan);

    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "Done",
      turnsUsed: 1,
    });

    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        tests: [
          {
            description: "Verify the thing works end to end",
            criticality: 8,
            detail: "Run the flow and confirm the expected output appears.",
          },
        ],
      }),
    });
    const manualTestsClient: GoalLlmClient = { complete };
    const onStatusChange = vi.fn();

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-manual-tests-still-run",
      workingDir: "/tmp/moltbot-goal-test",
      manualTestsClient,
      onStatusChange,
    });

    expect(outcome.status).toBe("done");
    // The manual-tests phase still runs after completion.
    expect(complete).toHaveBeenCalled();
    const allDone = onStatusChange.mock.calls
      .map((call) => call[0] as { type: string; manualTestsStatus?: string })
      .find((event) => event.type === "all_done");
    expect(allDone).toBeDefined();
    expect(allDone?.manualTestsStatus).toBe("generated");
  });

  it("mirrors goal runtime after lessons and manual-tests completion artifacts are produced", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    const session = makeSession(plan);

    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "Done",
      turnsUsed: 1,
    });
    mockExtractRunLessons.mockResolvedValueOnce([
      {
        id: "lesson-1",
        workingDir: "/tmp/moltbot-goal-test",
        pattern: "completion-mirror",
        lesson: "Mirror after completion artifacts are written.",
        source: "autocheck",
        scope: "project",
        runId: "run-post-completion-mirror",
        createdAt: "2026-05-24T00:00:00.000Z",
      },
    ]);
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        tests: [
          {
            description: "Verify completion artifacts",
            criticality: 7,
            detail: "Complete a goal and inspect the redacted runtime mirror.",
          },
        ],
      }),
    });
    const onStatusChange = vi.fn();
    mockRunStore.set("run-post-completion-mirror", {
      runId: "run-post-completion-mirror",
      state: "executing",
    });
    const onRunStatePersist = vi.fn(() => {
      mockRunStore.set("run-post-completion-mirror", {
        runId: "run-post-completion-mirror",
        state: session.state,
      });
    });
    let stateAtMirror: unknown;
    mockMirrorGoalRuntimeToAgentHistory.mockImplementationOnce(() => {
      stateAtMirror = mockRunStore.get("run-post-completion-mirror")?.state;
      return {
        generatedAt: "2026-05-24T00:00:00.000Z",
        sourceKind: "goal-runtime",
        entries: [],
      };
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-post-completion-mirror",
      workingDir: "/tmp/moltbot-goal-test",
      manualTestsClient: { complete },
      onStatusChange,
      onRunStatePersist,
    });

    expect(outcome.status).toBe("done");
    expect(mockExtractRunLessons).toHaveBeenCalled();
    expect(complete).toHaveBeenCalled();
    expect(onRunStatePersist).toHaveBeenCalledOnce();
    expect(stateAtMirror).toBe("done");
    expect(mockMirrorGoalRuntimeToAgentHistory).toHaveBeenCalledWith({
      workspaceName: "moltbot-goal-test",
      goalId: "run-post-completion-mirror",
      sourceDir: "/tmp/moltbot-goal-test/runs/run-post-completion-mirror",
    });
    expect(mockExtractRunLessons.mock.invocationCallOrder[0]).toBeLessThan(
      onRunStatePersist.mock.invocationCallOrder[0]!,
    );
    expect(complete.mock.invocationCallOrder[0]).toBeLessThan(
      onRunStatePersist.mock.invocationCallOrder[0]!,
    );
    expect(onRunStatePersist.mock.invocationCallOrder[0]).toBeLessThan(
      mockMirrorGoalRuntimeToAgentHistory.mock.invocationCallOrder[0]!,
    );
    expect(onStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ type: "all_done", manualTestsStatus: "generated" }),
    );
  });

  it("keeps completion fail-open when the post-completion runtime mirror fails", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    const session = makeSession(plan);
    const progress: string[] = [];
    const onRunStatePersist = vi.fn();

    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "Done",
      turnsUsed: 1,
    });
    mockMirrorGoalRuntimeToAgentHistory.mockImplementationOnce(() => {
      throw new Error("mirror disk unavailable");
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-post-completion-mirror-fail-open",
      workingDir: "/tmp/moltbot-goal-test",
      onRunStatePersist,
      onProgress: (line) => progress.push(line),
    });

    expect(outcome.status).toBe("done");
    expect(onRunStatePersist).toHaveBeenCalledOnce();
    expect(onRunStatePersist.mock.invocationCallOrder[0]).toBeLessThan(
      mockMirrorGoalRuntimeToAgentHistory.mock.invocationCallOrder[0]!,
    );
    expect(progress).toContain(
      "  [warn] Runtime mirror after completion failed: mirror disk unavailable",
    );
  });

  it("never collects a review diff for the removed phase even with a base SHA", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    const session = makeSession(plan);
    session.taskCheckpoints = { "1": { baseSha: "base-sha-api-error" } };

    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "Done",
      turnsUsed: 1,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-no-review-diff",
      workingDir: "/tmp/moltbot-goal-test",
    });

    expect(outcome.status).toBe("done");
    // No `git diff <base>...HEAD` collection for a post-exec review remains.
    const reviewDiffCalls = mockExecFileSync.mock.calls.filter((call) => {
      const argv = call[1];
      return (
        Array.isArray(argv) &&
        argv.includes("diff") &&
        argv.some((arg: unknown) => typeof arg === "string" && arg.includes("...HEAD"))
      );
    });
    expect(reviewDiffCalls).toHaveLength(0);
    expect(mockRunCliProcess).not.toHaveBeenCalled();
  });

  it("still runs lessons extraction after a completed goal", async () => {
    const step = makeStep({ backend: "codex" });
    const plan = makePlan([step]);
    const session = makeSession(plan);

    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "Done",
      turnsUsed: 1,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-lessons-still-run",
      workingDir: "/tmp/moltbot-goal-test",
    });

    expect(outcome.status).toBe("done");
    expect(mockExtractRunLessons).toHaveBeenCalled();
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

  it("consumes empty-string direct answers", async () => {
    const { hasAnswerForTask, getAnswerForTask, consumeAnswerForTask } =
      await import("./agent-executor.js");
    const answers = { "task:1:input": "" };

    expect(hasAnswerForTask("1", answers)).toBe(true);
    expect(getAnswerForTask("1", answers)).toBe("");

    consumeAnswerForTask("1", answers);

    expect(hasAnswerForTask("1", answers)).toBe(false);
    expect(getAnswerForTask("1", answers)).toBeUndefined();
    expect(answers).toEqual({});
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

  it("does not rewrite degraded planner backends to codex when codex is disabled", async () => {
    availability = [
      { id: "pi", available: true },
      { id: "codex", available: false, reason: "codex intentionally disabled" },
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
      summary: "Recovered with claude",
      turnsUsed: 1,
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-degraded-claude-only",
      workingDir: "/tmp/moltbot-goal-test",
      enabledWorkers: ["claude_code"],
      serializedRun: { plannerDegradedReason: "anthropic_usage_limit" } as unknown as SerializedRun,
    });

    expect(outcome.status).toBe("done");
    expect(step.backend).toBe("claude_code");
    expect(step.executedBackend).toBe("claude_code");
    expect(executedCliBackends).toEqual(["claude_code"]);
    expect(constructedCliBackends).toEqual(["claude_code"]);
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

  describe("usage-limit fallback and drain (executor-fallback-and-drain)", () => {
    it("(a) Codex out_of_credits falls back to Claude and an independent Claude task still runs", async () => {
      const step1 = makeStep({ id: "1", backend: "codex", description: "Codex work" });
      const step2 = makeStep({
        id: "2",
        backend: "claude_code",
        description: "Independent Claude",
      });
      const plan = makePlan([step1, step2]);
      const session = makeSession(plan);

      mockCliExecute
        .mockResolvedValueOnce({
          status: "blocked",
          question: "Codex is out of credits",
          blockedReason: "out_of_credits",
          turnsUsed: 1,
        })
        .mockResolvedValueOnce({
          status: "complete",
          summary: "Claude recovered step 1",
          turnsUsed: 1,
        })
        .mockResolvedValueOnce({
          status: "complete",
          summary: "Independent Claude task done",
          turnsUsed: 1,
        });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const outcome = await executeGoalWithAgent({
        session,
        runId: "run-fallback-drain-a",
        workingDir: "/tmp/moltbot-goal-test",
        enabledWorkers: ["codex", "claude_code"],
        retryConfig: { maxAttempts: 2, retryDelayMs: 1 },
      });

      expect(outcome.status).toBe("done");
      expect(step1.status).toBe("done");
      expect(step1.executedBackend).toBe("claude_code");
      expect(step2.status).toBe("done");
      expect(executedCliBackends).toEqual(["codex", "claude_code", "claude_code"]);
    });

    it("(b) Codex out_of_credits falls back to Claude on the same task and completes", async () => {
      const step = makeStep({ backend: "codex" });
      const plan = makePlan([step]);
      const session = makeSession(plan);
      const progress: string[] = [];

      mockCliExecute
        .mockResolvedValueOnce({
          status: "blocked",
          question: "Codex out of credits",
          blockedReason: "out_of_credits",
          turnsUsed: 1,
        })
        .mockResolvedValueOnce({
          status: "complete",
          summary: "Recovered with Claude Code",
          turnsUsed: 1,
        });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const outcome = await executeGoalWithAgent({
        session,
        runId: "run-fallback-drain-b",
        workingDir: "/tmp/moltbot-goal-test",
        enabledWorkers: ["codex", "claude_code"],
        retryConfig: { maxAttempts: 2, retryDelayMs: 1 },
        onProgress: (message) => progress.push(message),
      });

      expect(outcome.status).toBe("done");
      expect(step.status).toBe("done");
      expect(step.executedBackend).toBe("claude_code");
      expect(executedCliBackends).toEqual(["codex", "claude_code"]);
      expect(progress).toContain(
        "  [usage-limit] Codex hit a usage limit. Falling back to Claude Code.",
      );
    });

    it("(c) Codex out_of_credits with fallback unavailable becomes usage-limit blocked while an unrelated task runs", async () => {
      availability = [
        { id: "pi", available: true },
        { id: "codex", available: true },
        { id: "claude_code", available: false, reason: "claude_code not found on PATH" },
      ];

      const step1 = makeStep({ id: "1", backend: "codex", description: "Exhausted Codex work" });
      const step2 = makeStep({ id: "2", backend: "codex", description: "Unrelated Codex work" });
      const plan = makePlan([step1, step2]);
      const session = makeSession(plan);

      mockCliExecute.mockImplementation(async (context) => {
        if (context.task.id === "1") {
          return {
            status: "blocked",
            question: "Codex out of credits",
            blockedReason: "out_of_credits",
            turnsUsed: 1,
          };
        }
        return { status: "complete", summary: "Unrelated work done", turnsUsed: 1 };
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const outcome = await executeGoalWithAgent({
        session,
        runId: "run-fallback-drain-c",
        workingDir: "/tmp/moltbot-goal-test",
        enabledWorkers: ["codex", "claude_code"],
        retryConfig: { maxAttempts: 2, retryDelayMs: 1 },
      });

      expect(outcome.status).toBe("blocked");
      expect(step1.status).toBe("blocked");
      // Non-fatal, retryable usage-limit block — not fatal out_of_credits/error.
      expect(step1.blockedReason).toBe("usage_limit");
      expect(step1.blockedQuestion).toContain("claude_code not found on PATH");
      // The unrelated runnable task still ran and completed.
      expect(step2.status).toBe("done");
      expect(executedCliBackends).toEqual(["codex", "codex"]);
    });

    it("(d) the goal blocks only after every runnable task is drained", async () => {
      availability = [
        { id: "pi", available: true },
        { id: "codex", available: true },
        { id: "claude_code", available: false, reason: "claude_code not found on PATH" },
      ];

      const step1 = makeStep({ id: "1", backend: "codex" });
      const step2 = makeStep({ id: "2", backend: "codex" });
      const plan = makePlan([step1, step2]);
      const session = makeSession(plan);

      mockCliExecute.mockResolvedValue({
        status: "blocked",
        question: "Codex out of credits",
        blockedReason: "out_of_credits",
        turnsUsed: 1,
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const outcome = await executeGoalWithAgent({
        session,
        runId: "run-fallback-drain-d",
        workingDir: "/tmp/moltbot-goal-test",
        enabledWorkers: ["codex", "claude_code"],
        retryConfig: { maxAttempts: 2, retryDelayMs: 1 },
      });

      expect(outcome.status).toBe("blocked");
      expect(step1.status).toBe("blocked");
      expect(step2.status).toBe("blocked");
      expect(step1.blockedReason).toBe("usage_limit");
      expect(step2.blockedReason).toBe("usage_limit");
      // Both independent tasks were attempted before the goal reported blocked —
      // the first usage-limit block did not short-circuit the runnable queue.
      expect(mockCliExecute).toHaveBeenCalledTimes(2);
    });

    it("(e) a mixed dependency graph is not prematurely interrupted by one usage-limited branch", async () => {
      const step1 = makeStep({ id: "1", backend: "codex", description: "Blocked branch root" });
      const step2 = makeStep({ id: "2", backend: "claude_code", description: "Runnable branch" });
      const step3 = makeStep({
        id: "3",
        backend: "claude_code",
        description: "Depends on runnable branch",
        dependsOn: ["2"],
      });
      const step4 = makeStep({
        id: "4",
        backend: "codex",
        description: "Depends on blocked branch",
        dependsOn: ["1"],
      });
      const plan = makePlan([step1, step2, step3, step4]);
      const session = makeSession(plan);

      mockCliExecute.mockImplementation(async (context) => {
        if (context.task.id === "1") {
          return {
            status: "blocked",
            question: "Codex out of credits",
            blockedReason: "out_of_credits",
            turnsUsed: 1,
          };
        }
        return { status: "complete", summary: `Done ${context.task.id}`, turnsUsed: 1 };
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const outcome = await executeGoalWithAgent({
        session,
        runId: "run-fallback-drain-e",
        workingDir: "/tmp/moltbot-goal-test",
        enabledWorkers: ["codex", "claude_code"],
        retryConfig: { maxAttempts: 2, retryDelayMs: 1 },
      });

      expect(outcome.status).toBe("blocked");
      // Blocked branch: step1 usage-limited (codex -> claude fallback both exhausted),
      // step4 waits because its dependency never completed.
      expect(step1.status).toBe("blocked");
      expect(step1.blockedReason).toBe("usage_limit");
      expect(step1.executedBackend).toBe("claude_code");
      expect(step4.status).toBe("pending");
      // Runnable branch drained to completion regardless of the blocked sibling.
      expect(step2.status).toBe("done");
      expect(step3.status).toBe("done");
    });

    it("(f) reproduces the 8cec60ca shape: Task8 runs, Codex falls back to Claude, no premature global block", async () => {
      const independentClaude = ["1", "2", "3", "4", "5", "6"].map((id) =>
        makeStep({ id, backend: "claude_code", description: `Prep ${id}` }),
      );
      const task7 = makeStep({ id: "7", backend: "codex", description: "Codex exhausted task" });
      const task8 = makeStep({
        id: "8",
        backend: "claude_code",
        description: "Independent Claude task",
      });
      const task9 = makeStep({
        id: "9",
        backend: "claude_code",
        description: "Depends on several prior tasks",
        dependsOn: ["1", "2", "3", "7", "8"],
      });
      const task10 = makeStep({
        id: "10",
        backend: "claude_code",
        description: "Depends on task 9",
        dependsOn: ["9"],
      });
      const plan = makePlan([...independentClaude, task7, task8, task9, task10]);
      const session = makeSession(plan);

      // Codex is exhausted; Task 7 hits out_of_credits on Codex and again on the
      // Claude fallback, leaving it usage-limit blocked. Every other task runs.
      mockCliExecute.mockImplementation(async (context) => {
        if (context.task.id === "7") {
          return {
            status: "blocked",
            question: "Codex out of credits",
            blockedReason: "out_of_credits",
            turnsUsed: 1,
          };
        }
        return { status: "complete", summary: `Done ${context.task.id}`, turnsUsed: 1 };
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const outcome = await executeGoalWithAgent({
        session,
        runId: "run-fallback-drain-8cec60ca",
        workingDir: "/tmp/moltbot-goal-test",
        enabledWorkers: ["codex", "claude_code"],
        retryConfig: { maxAttempts: 2, retryDelayMs: 1 },
      });

      // Task 8 (independent Claude) still runs even though Codex is exhausted.
      expect(task8.status).toBe("done");
      // Task 7 attempted Codex then fell back to Claude where compatible.
      expect(task7.executedBackend).toBe("claude_code");
      const sevenBackends = executedCliBackends;
      expect(sevenBackends).toContain("codex");
      expect(sevenBackends).toContain("claude_code");
      // Usage-limited task is visibly usage-limited, not fatal/needs-input.
      expect(task7.status).toBe("blocked");
      expect(task7.blockedReason).toBe("usage_limit");
      expect(task7.blockedQuestion).not.toContain("needs input");
      // Dependents of the blocked branch wait rather than globally interrupting.
      expect(task9.status).toBe("pending");
      expect(task10.status).toBe("pending");
      // Prep tasks all completed (no global cascade onto independent work).
      for (const prep of independentClaude) {
        expect(prep.status).toBe("done");
      }
      // Final global state after draining all runnable work: blocked (Task 7 + deps).
      expect(outcome.status).toBe("blocked");
    });
  });
});
