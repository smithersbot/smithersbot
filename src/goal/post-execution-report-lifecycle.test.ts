import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliWorkerId } from "../config/types.goal.js";
import type { BackendAvailability } from "./backend-types.js";
import type { GoalSession, Plan, PlanStep, SerializedRun } from "./types.js";
import type { TaskRunnerContext, TaskRunnerResult } from "./task-runner.js";

const mockCliExecute = vi.fn<Promise<TaskRunnerResult>, [TaskRunnerContext]>();
const mockPiExecute = vi.fn<Promise<TaskRunnerResult>, [TaskRunnerContext]>();
const mockRunCliProcess = vi.fn();
const mockMirrorGoalRuntimeToAgentHistory = vi.fn();
const mockExtractRunLessons = vi.fn();
const mockAssertGoalWorkerWorkspace = vi.fn();
let availability: BackendAvailability[] = [
  { id: "pi", available: false, reason: "pi disabled for lifecycle tests" },
  { id: "codex", available: true },
  { id: "claude_code", available: true },
];

class MockCliTaskRunner {
  readonly backend: CliWorkerId;

  constructor(params: { backend: CliWorkerId }) {
    this.backend = params.backend;
  }

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

vi.mock("./cli-runner.js", () => ({
  CliTaskRunner: MockCliTaskRunner,
}));

vi.mock("./pi-runner.js", () => ({
  PiTaskRunner: MockPiTaskRunner,
}));

vi.mock("./cli-process.js", () => ({
  runCliProcess: (...args: unknown[]) => mockRunCliProcess(...args),
}));

vi.mock("./workspace-policy.js", () => ({
  assertGoalWorkerWorkspace: (...args: unknown[]) => mockAssertGoalWorkerWorkspace(...args),
}));

vi.mock("./backend-availability.js", async () => {
  const actual = await vi.importActual<typeof import("./backend-availability.js")>(
    "./backend-availability.js",
  );
  return {
    ...actual,
    detectBackendAvailability: () => availability,
  };
});

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

function makeStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: "1",
    description: "Implement native lifecycle reporting",
    shortSummary: "Lifecycle reporting",
    dependsOn: [],
    status: "pending",
    backend: "claude_code",
    ...overrides,
  };
}

function makePlan(steps: PlanStep[]): Plan {
  return {
    goal: "Build native post-execution reporting",
    workingDir: "/tmp/smithersbot-lifecycle",
    summary: "Wire native post-execution reporting",
    shortSummary: "Native reporting lifecycle",
    steps,
  };
}

function makeSession(plan: Plan, overrides: Partial<GoalSession> = {}): GoalSession {
  return {
    goal: plan.goal,
    state: "awaiting_approval",
    plan,
    stepResults: new Map(),
    blocked: null,
    answers: {},
    ...overrides,
  };
}

function reportPayload() {
  return {
    markdown: "# Post Execution Report\n\nNative report lifecycle completed.\n",
    report: {
      planCompleted: true,
      goalAchieved: false,
      summary: "Lifecycle reporting was wired into the executor.",
      filesChanged: ["src/goal/agent-executor.ts"],
      verificationCommands: ["pnpm vitest run src/goal/post-execution-report-lifecycle.test.ts"],
      manualTests: [
        {
          description: "Inspect the report artifacts",
          criticality: 7,
          reason: "The artifacts are shown in Telegram.",
          detail: "Complete a goal and open View Report.",
        },
      ],
      nextPlanRecommended: true,
      nextPlanSummary: "Render the Telegram report UI.",
      nextPlanPrompt: "Continue this goal by implementing the Telegram report UI.",
      decisionsNeeded: [
        {
          question: "Which UI surface should be prioritized?",
          options: ["Plan Done", "Continuation"],
          recommendedOption: "Plan Done",
          rationale: "Plan Done is the first operator-visible surface.",
          promptImpact: "Prioritize the Plan Done surface first.",
        },
      ],
      failureOrBlockedReason: null,
    },
  };
}

function manualDisplayPayload() {
  return {
    manualTests: [
      {
        description: "Run the report-derived manual smoke",
        criticality: 9,
        reason: "This comes from the manual-test display phase.",
        detail: "Complete a plan and confirm the report-derived manual test appears.",
      },
    ],
    displayMarkdown: "1. Run the report-derived manual smoke",
  };
}

function continuationPayload() {
  return {
    goalAchieved: false,
    nextPlanRecommended: true,
    nextPlanSummary: "Render the Telegram report UI.",
    nextPlanPrompt: "Continue this goal by implementing the Telegram report UI.",
    decisionsNeeded: reportPayload().report.decisionsNeeded,
    failureOrBlockedReason: null,
  };
}

function jsonlResult(value: unknown, sessionId: string) {
  return `${JSON.stringify({ type: "result", session_id: sessionId, result: value })}\n`;
}

function successfulReportCliResult(args: unknown) {
  const prompt = extractPrompt(args);
  let result: unknown;
  let sessionId = "report-session-generate";
  if (prompt.includes("post-execution report generation")) {
    result = reportPayload();
  } else if (prompt.includes("prepare manual-test display data")) {
    result = manualDisplayPayload();
    sessionId = "report-session-manual";
  } else if (prompt.includes("decide continuation")) {
    result = continuationPayload();
    sessionId = "report-session-continuation";
  } else {
    result = {};
  }
  return {
    stdout: jsonlResult(result, sessionId),
    stderr: "",
    timedOut: false,
    exitCode: 0,
    signal: null,
    durationMs: 10,
  };
}

function failedReportCliResult() {
  return {
    stdout: "",
    stderr: "backend unavailable",
    timedOut: false,
    exitCode: 1,
    signal: null,
    durationMs: 10,
  };
}

function extractRawPrompt(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const rawArgs = (args as { args?: unknown }).args;
  if (!Array.isArray(rawArgs)) return "";
  return String(rawArgs.at(-1) ?? "");
}

function extractPromptArtifactPath(args: unknown): string | undefined {
  const instruction = extractRawPrompt(args);
  const lines = instruction.split(/\r?\n/);
  const markerIndex = lines.indexOf(
    "Read the complete post-execution prompt from this agent-history artifact path:",
  );
  return markerIndex >= 0 ? lines[markerIndex + 1]?.trim() : undefined;
}

function extractPrompt(args: unknown): string {
  const artifactPath = extractPromptArtifactPath(args);
  if (artifactPath && fs.existsSync(artifactPath)) {
    return fs.readFileSync(artifactPath, "utf8");
  }
  return extractRawPrompt(args);
}

function extractArgs(args: unknown): string[] {
  if (typeof args !== "object" || args === null) return [];
  const rawArgs = (args as { args?: unknown }).args;
  return Array.isArray(rawArgs) ? rawArgs.map(String) : [];
}

function makeWorkingDir(root: string): string {
  const workingDir = path.join(root, "agent", "workspaces", "smithersbot-dev");
  fs.mkdirSync(workingDir, { recursive: true });
  return workingDir;
}

describe("post-execution reporting lifecycle", () => {
  let previousManagedRoot: string | undefined;
  let managedRoot: string;
  let workingDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    availability = [
      { id: "pi", available: false, reason: "pi disabled for lifecycle tests" },
      { id: "codex", available: true },
      { id: "claude_code", available: true },
    ];
    previousManagedRoot = process.env.SMITHERSBOT_GOALS_ROOT;
    managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "post-exec-lifecycle-"));
    process.env.SMITHERSBOT_GOALS_ROOT = managedRoot;
    workingDir = makeWorkingDir(managedRoot);
    mockExtractRunLessons.mockResolvedValue([]);
    mockMirrorGoalRuntimeToAgentHistory.mockReturnValue({
      generatedAt: "2026-06-03T00:00:00.000Z",
      sourceKind: "goal-runtime",
      entries: [],
    });
    mockRunCliProcess.mockImplementation((args) => successfulReportCliResult(args));
  });

  afterEach(() => {
    if (previousManagedRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
    else process.env.SMITHERSBOT_GOALS_ROOT = previousManagedRoot;
    fs.rmSync(managedRoot, { recursive: true, force: true });
  });

  it("runs native reporting after completion and persists report-derived manual tests and continuation", async () => {
    const step = makeStep();
    const plan = makePlan([step]);
    const session = makeSession(plan);
    const runId = "run-report-lifecycle-success";
    const statusEvents: unknown[] = [];

    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "Executor wiring completed",
      turnsUsed: 1,
      executionSessionId: "exec-session-1",
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const { loadRun, saveRun, sessionToSerialized } = await import("./run-store.js");

    const persistRun = () => {
      saveRun(
        sessionToSerialized({
          session,
          runId,
          workingDir,
          model: undefined,
          dryRun: false,
          createdAt: "2026-06-03T00:00:00.000Z",
          previousRun: loadRun(runId),
        }),
      );
    };

    const outcome = await executeGoalWithAgent({
      session,
      runId,
      workingDir,
      config: { goal: { semgrep: "off" } },
      serializedRun: {
        runId,
        goal: session.goal,
        state: "executing",
        plan,
        stepResults: {},
        blocked: null,
        answers: {},
        workingDir,
        model: undefined,
        dryRun: false,
        createdAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
        planNumber: 2,
        planRevision: 5,
        activePlanRevision: 5,
      } as SerializedRun,
      onRunStatePersist: persistRun,
      onStatusChange: (event) => statusEvents.push(event),
    });

    expect(outcome.status).toBe("done");
    expect(mockCliExecute).toHaveBeenCalledOnce();
    expect(mockRunCliProcess).toHaveBeenCalledTimes(3);
    const reportArgs = mockRunCliProcess.mock.calls.map((call) => extractArgs(call[0]));
    expect(reportArgs[0]).toEqual(expect.arrayContaining(["--resume", "exec-session-1"]));
    const prompts = mockRunCliProcess.mock.calls.map((call) => extractPrompt(call[0]));
    expect(prompts.every((prompt) => prompt.includes("Native lifecycle phase:"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("/new_goal"))).toBe(false);

    expect(session.state).toBe("done");
    expect(session.manualTests).toEqual([
      expect.objectContaining({ description: "Run the report-derived manual smoke" }),
    ]);
    expect(session.pendingContinuation).toMatchObject({
      fromPlanNumber: 2,
      fromRevision: 5,
      goalAchieved: false,
      proposedPrompt: "Continue this goal by implementing the Telegram report UI.",
      status: "pending",
    });
    expect(session.pendingContinuation?.decisions).toEqual([
      expect.objectContaining({
        question: "Which UI surface should be prioritized?",
        recommendedOption: "Plan Done",
      }),
    ]);
    expect(fs.existsSync(session.postExecutionReportArtifacts!.markdownPath)).toBe(true);
    expect(fs.existsSync(session.postExecutionReportArtifacts!.jsonPath)).toBe(true);

    const saved = loadRun(runId)!;
    expect(saved.state).toBe("done");
    expect(saved.postExecutionReport?.summary).toBe(
      "Lifecycle reporting was wired into the executor.",
    );
    expect(saved.manualTests).toEqual(session.manualTests);
    expect(saved.pendingContinuation).toMatchObject({
      fromPlanNumber: 2,
      fromRevision: 5,
      proposedPrompt: "Continue this goal by implementing the Telegram report UI.",
    });
    expect(saved.continuationDelivery).toBeUndefined();
    expect(statusEvents).toContainEqual(
      expect.objectContaining({
        type: "all_done",
        manualTests: session.manualTests,
        manualTestsStatus: "generated",
      }),
    );
  });

  it("keeps large lifecycle reporter context out of backend argv and stores prompt artifacts", async () => {
    const largeMarker = `x402-lifecycle-large-context-${"B".repeat(150_000)}`;
    const step = makeStep({
      taskSummary: `Implemented Stage 1 while preserving a large completion summary. ${largeMarker}`,
    });
    const plan = makePlan([step]);
    plan.goal = `Complete a large two-stage reporting goal. Stage 2 continues after this plan. ${largeMarker}`;
    plan.summary = `Finish only Stage 1 and leave Stage 2 as remaining original-goal work. ${largeMarker}`;
    const session = makeSession(plan);

    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: `Executor wiring completed. ${largeMarker}`,
      turnsUsed: 1,
      executionSessionId: "exec-session-large",
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-report-lifecycle-large",
      workingDir,
      config: { goal: { semgrep: "off" } },
      onRunStatePersist: vi.fn(),
      onStatusChange: vi.fn(),
    });

    expect(outcome.status).toBe("done");
    expect(mockRunCliProcess).toHaveBeenCalledTimes(3);
    const argvText = mockRunCliProcess.mock.calls
      .map((call) => extractArgs(call[0]).join("\n"))
      .join("\n");
    expect(argvText.length).toBeLessThan(10_000);
    expect(argvText).toContain(
      "Read the complete post-execution prompt from this agent-history artifact path:",
    );
    expect(argvText).not.toContain(largeMarker.slice(0, 120));

    const promptArtifacts = mockRunCliProcess.mock.calls.map((call) =>
      extractPromptArtifactPath(call[0]),
    );
    expect(
      promptArtifacts.every((artifactPath) => artifactPath && fs.existsSync(artifactPath)),
    ).toBe(true);
    const promptContents = promptArtifacts.map((artifactPath) =>
      fs.readFileSync(artifactPath!, "utf8"),
    );
    expect(promptContents[0]).toContain("post-execution report generation");
    expect(promptContents[0]).toContain(largeMarker.slice(0, 120));
    expect(promptContents[1]).toContain("prepare manual-test display data");
    expect(promptContents[1]).toContain("Saved post-execution report markdown:");
    expect(promptContents[2]).toContain("decide continuation");
    expect(promptContents[2]).toContain("Structured completion context:");
    expect(promptContents[2]).toContain(largeMarker.slice(0, 120));
    expect(session.pendingContinuation).toMatchObject({
      proposedPrompt: "Continue this goal by implementing the Telegram report UI.",
      status: "pending",
    });
  });

  it("links the stored Goal Brief path into the lifecycle reporter prompt without inlining its content", async () => {
    const step = makeStep();
    const plan = makePlan([step]);
    const session = makeSession(plan);
    const runId = "run-report-lifecycle-brief";

    const { resolveComputedGoalBriefPath } = await import("./goal-brief.js");
    const briefPath = resolveComputedGoalBriefPath(runId, workingDir);
    fs.mkdirSync(path.dirname(briefPath), { recursive: true });
    fs.writeFileSync(
      briefPath,
      ["# Goal Brief", "", "## Remaining Work", "Stage 2 still needs goal2.txt created."].join(
        "\n",
      ),
      "utf8",
    );

    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "Executor wiring completed",
      turnsUsed: 1,
      executionSessionId: "exec-session-1",
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId,
      workingDir,
      config: { goal: { semgrep: "off" } },
      serializedRun: {
        runId,
        goal: session.goal,
        state: "executing",
        plan,
        stepResults: {},
        blocked: null,
        answers: {},
        workingDir,
        goalBriefPath: briefPath,
        model: undefined,
        dryRun: false,
        createdAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
      } as SerializedRun,
      onRunStatePersist: vi.fn(),
      onStatusChange: vi.fn(),
    });

    expect(outcome.status).toBe("done");
    const generatePrompt = mockRunCliProcess.mock.calls
      .map((call) => extractPrompt(call[0]))
      .find((prompt) => prompt.includes("post-execution report generation"));
    expect(generatePrompt).toBeDefined();
    expect(generatePrompt).toContain(`Goal brief: ${briefPath}`);
    expect(generatePrompt).toContain("Open the Goal Brief path above if you need the full brief");
    // FIX 3: the Goal Brief is linked by path, not inlined — its full content must
    // not be embedded in the bounded completion context.
    expect(generatePrompt).not.toContain("Stage 2 still needs goal2.txt created.");
    expect(generatePrompt).not.toContain("Goal Brief is missing");
  });

  it("frames a missing Goal Brief without pushing the lifecycle reporter toward achieved", async () => {
    const step = makeStep();
    const plan = makePlan([step]);
    const session = makeSession(plan);

    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "Executor wiring completed",
      turnsUsed: 1,
      executionSessionId: "exec-session-1",
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-report-lifecycle-missing-brief",
      workingDir,
      config: { goal: { semgrep: "off" } },
      onRunStatePersist: vi.fn(),
      onStatusChange: vi.fn(),
    });

    expect(outcome.status).toBe("done");
    const generatePrompt = mockRunCliProcess.mock.calls
      .map((call) => extractPrompt(call[0]))
      .find((prompt) => prompt.includes("post-execution report generation"));
    expect(generatePrompt).toBeDefined();
    expect(generatePrompt).toContain(
      "Goal Brief is missing — do not infer goal achievement from its absence.",
    );
    expect(generatePrompt).not.toContain("Goal Brief content (read from the stored brief path):");
  });

  it("keeps completed runs done when report generation fails and writes a degraded report", async () => {
    const step = makeStep();
    const plan = makePlan([step]);
    const session = makeSession(plan);
    const statusEvents: unknown[] = [];

    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "Executor wiring completed",
      turnsUsed: 1,
      executionSessionId: "exec-session-1",
    });
    mockRunCliProcess.mockImplementation(() => failedReportCliResult());

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-report-lifecycle-failed",
      workingDir,
      config: { goal: { semgrep: "off" } },
      enabledWorkers: ["claude_code", "codex"],
      onRunStatePersist: vi.fn(),
      onStatusChange: (event) => statusEvents.push(event),
    });

    expect(outcome.status).toBe("done");
    expect(mockCliExecute).toHaveBeenCalledOnce();
    expect(mockRunCliProcess).toHaveBeenCalled();
    expect(session.state).toBe("done");
    expect(session.postExecutionReport?.failureOrBlockedReason).toContain(
      "Post-execution reporting could not generate a full report during generateReport",
    );
    expect(session.postExecutionReportingFailureReason).toBeUndefined();
    // FIX 5: the degraded path synthesizes deterministic fallback manual tests from
    // completed steps instead of returning an empty array.
    expect((session.manualTests ?? []).length).toBeGreaterThan(0);
    expect(session.manualTests?.[0]?.description).toBe("Test native lifecycle reporting");
    expect(fs.existsSync(session.postExecutionReportArtifacts!.markdownPath)).toBe(true);
    expect(fs.existsSync(session.postExecutionReportArtifacts!.jsonPath)).toBe(true);
    expect(statusEvents).toContainEqual(expect.objectContaining({ type: "all_done" }));
    expect(statusEvents).not.toContainEqual(
      expect.objectContaining({ type: "post_execution_reporting_failed" }),
    );
  });

  it("keeps degraded fallback continuation actionable when remaining work is evident", async () => {
    const step = makeStep({
      taskSummary: "Stage 1 was completed; Stage 2 was intentionally left for the next plan.",
    });
    const plan = makePlan([step]);
    plan.goal =
      "This goal has two stages. Stage 1 wires reporting. Stage 2 continues this same goal with the Telegram UI.";
    plan.summary = "Complete Stage 1 only and leave Stage 2 as remaining original-goal work.";
    const session = makeSession(plan);
    const runId = "run-report-lifecycle-degraded-continuation";
    const statusEvents: unknown[] = [];

    const { resolveComputedGoalBriefPath } = await import("./goal-brief.js");
    const briefPath = resolveComputedGoalBriefPath(runId, workingDir);
    fs.mkdirSync(path.dirname(briefPath), { recursive: true });
    fs.writeFileSync(
      briefPath,
      [
        "# Goal Brief",
        "",
        "## Remaining Work",
        "Stage 2 still needs the Telegram report UI implemented and verified.",
        "",
        "## Observation Point",
        "Stop after Stage 1 so the operator can approve Stage 2.",
      ].join("\n"),
      "utf8",
    );

    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "Stage 1 completed.",
      turnsUsed: 1,
      executionSessionId: "exec-session-1",
    });
    mockRunCliProcess.mockImplementation(() => failedReportCliResult());

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId,
      workingDir,
      config: { goal: { semgrep: "off" } },
      enabledWorkers: ["claude_code"],
      onRunStatePersist: vi.fn(),
      onStatusChange: (event) => statusEvents.push(event),
    });

    expect(outcome.status).toBe("done");
    expect(session.state).toBe("done");
    expect(session.postExecutionReport).toMatchObject({
      goalAchieved: false,
      nextPlanRecommended: true,
    });
    expect(session.postExecutionReport?.nextPlanSummary).toContain("Stage 2");
    expect(session.postExecutionReport?.nextPlanPrompt).toContain("Goal ID");
    expect(session.postExecutionReport?.nextPlanSummary?.trim()).not.toBe("");
    expect(session.postExecutionReport?.nextPlanPrompt?.trim()).not.toBe("");
    expect(session.postExecutionContinuation).toMatchObject({
      goalAchieved: false,
      nextPlanRecommended: true,
    });
    expect(session.postExecutionContinuation?.nextPlanSummary).toContain("Stage 2");
    expect(session.postExecutionContinuation?.nextPlanPrompt).toContain("Telegram report UI");
    expect(session.pendingContinuation).toMatchObject({
      goalAchieved: false,
      proposedPrompt: expect.stringContaining("Telegram report UI"),
      status: "pending",
    });
    expect(statusEvents).toContainEqual(expect.objectContaining({ type: "all_done" }));
    expect(statusEvents).not.toContainEqual(
      expect.objectContaining({ type: "post_execution_reporting_failed" }),
    );
  });

  it("sets reporting_failed when report generation and degraded fallback both fail", async () => {
    const step = makeStep();
    const plan = makePlan([step]);
    const session = makeSession(plan);
    const statusEvents: unknown[] = [];
    const blockedManagedRoot = path.join(managedRoot, "not-a-directory");

    fs.writeFileSync(blockedManagedRoot, "file blocks fallback artifact directory", "utf8");
    process.env.SMITHERSBOT_GOALS_ROOT = blockedManagedRoot;
    mockCliExecute.mockResolvedValueOnce({
      status: "complete",
      summary: "Executor wiring completed",
      turnsUsed: 1,
      executionSessionId: "exec-session-1",
    });
    mockRunCliProcess.mockImplementation(() => failedReportCliResult());
    const persistState = vi.fn(() => {
      if (session.state === "reporting_failed") {
        throw new Error("post-completion state store is unavailable");
      }
    });

    const { executeGoalWithAgent } = await import("./agent-executor.js");
    const outcome = await executeGoalWithAgent({
      session,
      runId: "run-report-lifecycle-fallback-failed",
      workingDir,
      config: { goal: { semgrep: "off" } },
      enabledWorkers: ["claude_code", "codex"],
      onRunStatePersist: persistState,
      onStatusChange: (event) => statusEvents.push(event),
    });

    expect(outcome.status).toBe("done");
    expect(mockCliExecute).toHaveBeenCalledOnce();
    expect(mockRunCliProcess).not.toHaveBeenCalled();
    expect(persistState).toHaveBeenCalled();
    expect(session.state).toBe("reporting_failed");
    expect(session.postExecutionReportingFailureReason).toContain(
      "degraded report fallback failed",
    );
    expect(session.pendingContinuation).toBeUndefined();
    expect(statusEvents).toContainEqual(
      expect.objectContaining({
        type: "post_execution_reporting_failed",
        phase: "generateReport",
      }),
    );
    expect(statusEvents).not.toContainEqual(expect.objectContaining({ type: "all_done" }));
  });

  it("resumePostExecutionReporting retries reporting only without re-executing completed steps", async () => {
    const step = makeStep({
      status: "done",
      taskSummary: "Executor wiring completed",
      executedBackend: "claude_code",
    });
    const plan = makePlan([step]);
    const session = makeSession(plan, {
      state: "reporting_failed",
      completionSummary: "Initial completion summary",
      executionSessionId: "exec-session-resume",
      executionSessionBackend: "claude_code",
      postExecutionReportingFailureReason: "Previous report failure.",
    });
    const statusEvents: unknown[] = [];

    const { resumePostExecutionReporting } = await import("./agent-executor.js");
    const outcome = await resumePostExecutionReporting({
      session,
      runId: "run-report-lifecycle-resume",
      workingDir,
      config: { goal: { semgrep: "off" } },
      serializedRun: {
        runId: "run-report-lifecycle-resume",
        goal: session.goal,
        state: "reporting_failed",
        plan,
        stepResults: {},
        blocked: null,
        answers: {},
        workingDir,
        model: undefined,
        dryRun: false,
        createdAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
        planNumber: 1,
        planRevision: 3,
        activePlanRevision: 3,
      } as SerializedRun,
      onRunStatePersist: vi.fn(),
      onStatusChange: (event) => statusEvents.push(event),
    });

    expect(outcome.status).toBe("done");
    expect(mockCliExecute).not.toHaveBeenCalled();
    expect(mockRunCliProcess).toHaveBeenCalledTimes(3);
    expect(extractArgs(mockRunCliProcess.mock.calls[0]![0])).toContain("exec-session-resume");
    expect(session.state).toBe("done");
    expect(session.postExecutionReportingFailureReason).toBeUndefined();
    expect(session.manualTests).toEqual([
      expect.objectContaining({ description: "Run the report-derived manual smoke" }),
    ]);
    expect(session.pendingContinuation).toMatchObject({
      fromPlanNumber: 1,
      fromRevision: 3,
      proposedPrompt: "Continue this goal by implementing the Telegram report UI.",
    });
    expect(statusEvents).toContainEqual(expect.objectContaining({ type: "all_done" }));
  });
});
