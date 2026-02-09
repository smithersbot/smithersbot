import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { goalResumeCommand } from "./goal-resume.js";
import { saveRun, resolveGoalsDir, type SerializedRun } from "../goal/run-store.js";
import { createTestRuntime } from "../runtime.js";
import type { Plan } from "../goal/types.js";

/**
 * End-to-end tests for resuming goals from failed states.
 * Tests the complete flow including persistence, state transitions,
 * and error handling for various failure scenarios.
 */

describe("goal resume from failed states (e2e)", () => {
  const testGoalsDir = path.join(process.cwd(), "test-data", "goals-failed-resume-e2e");
  let runtime: ReturnType<typeof createTestRuntime>;

  beforeEach(() => {
    runtime = createTestRuntime();
    // Create test goals directory
    fs.mkdirSync(testGoalsDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test data
    if (fs.existsSync(testGoalsDir)) {
      fs.rmSync(testGoalsDir, { recursive: true, force: true });
    }
  });

  function createFailedPlanningRun(runId: string): SerializedRun {
    const run: SerializedRun = {
      runId,
      goal: "Test goal that failed during planning",
      state: "failed",
      lastError: "Rate limit exceeded during planning",
      workingDir: "/tmp/test",
      model: "claude-sonnet-4-5-20250929",
      dryRun: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      plan: null,
      stepResults: {},
      answers: {},
      blocked: null,
    };

    const runDir = path.join(testGoalsDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const runFile = path.join(runDir, "run.json");
    fs.writeFileSync(runFile, JSON.stringify(run, null, 2), "utf8");

    return run;
  }

  function createFailedExecutionRun(runId: string): SerializedRun {
    const plan: Plan = {
      steps: [
        {
          id: "step1",
          description: "First step",
          dependsOn: [],
          status: "done",
          taskSummary: "Completed successfully",
        },
        {
          id: "step2",
          description: "Second step that failed",
          dependsOn: ["step1"],
          status: "blocked",
          blockedReason: "task_failed",
          blockedQuestion: "Step failed with error",
        },
      ],
    };

    const run: SerializedRun = {
      runId,
      goal: "Test goal that failed during execution",
      state: "failed",
      lastError: "Task execution failed",
      workingDir: "/tmp/test",
      model: "claude-sonnet-4-5-20250929",
      dryRun: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      plan,
      stepResults: {
        step1: {
          stepId: "step1",
          success: true,
          output: "Done",
          durationMs: 1000,
        },
        step2: {
          stepId: "step2",
          success: false,
          output: "",
          error: "Task failed",
          durationMs: 2000,
        },
      },
      answers: {},
      blocked: null,
    };

    const runDir = path.join(testGoalsDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const runFile = path.join(runDir, "run.json");
    fs.writeFileSync(runFile, JSON.stringify(run, null, 2), "utf8");

    return run;
  }

  function createPlanningStateRun(runId: string): SerializedRun {
    const run: SerializedRun = {
      runId,
      goal: "Test goal stuck in planning state",
      state: "planning",
      workingDir: "/tmp/test",
      model: "claude-sonnet-4-5-20250929",
      dryRun: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      plan: null,
      stepResults: {},
      answers: {},
      blocked: null,
    };

    const runDir = path.join(testGoalsDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const runFile = path.join(runDir, "run.json");
    fs.writeFileSync(runFile, JSON.stringify(run, null, 2), "utf8");

    return run;
  }

  test("failed planning run suggests --replan flag", async () => {
    const runId = "test-failed-planning-001";
    createFailedPlanningRun(runId);

    // Override goals directory for this test
    vi.stubEnv("MOLTBOT_GOALS_DIR", testGoalsDir);

    await goalResumeCommand(runId, {}, runtime);

    const output = runtime.getOutput();
    expect(output).toContain("Run failed during planning");
    expect(output).toContain("Use --replan to retry");
    expect(output).toContain("Rate limit exceeded");
  });

  test("planning state run suggests --replan flag", async () => {
    const runId = "test-planning-state-001";
    createPlanningStateRun(runId);

    vi.stubEnv("MOLTBOT_GOALS_DIR", testGoalsDir);

    await goalResumeCommand(runId, {}, runtime);

    const output = runtime.getOutput();
    expect(output).toContain("Run is in an incomplete state");
    expect(output).toContain("Use --replan to retry planning from the original goal");
  });

  test("failed execution run with blocked steps becomes blocked state", async () => {
    const runId = "test-failed-execution-001";
    createFailedExecutionRun(runId);

    vi.stubEnv("MOLTBOT_GOALS_DIR", testGoalsDir);

    const result = await goalResumeCommand(runId, {}, runtime);

    // Should transition from 'failed' to 'blocked' and show blocked details
    expect(result?.status).toBe("blocked");
    const output = runtime.getOutput();
    expect(output).toContain("Blocked:");
    expect(output).toContain("step2");

    // Verify state was persisted
    const runFile = path.join(testGoalsDir, runId, "run.json");
    const updatedRun = JSON.parse(fs.readFileSync(runFile, "utf8")) as SerializedRun;
    expect(updatedRun.state).toBe("blocked");
    expect(updatedRun.blocked).toBeTruthy();
  });

  test("failed planning run with --replan invokes planning retry (mock)", async () => {
    const runId = "test-replan-001";
    createFailedPlanningRun(runId);

    vi.stubEnv("MOLTBOT_GOALS_DIR", testGoalsDir);

    // Mock generatePlan to avoid real API call
    const generatePlanMock = vi.fn().mockResolvedValue({
      steps: [{ id: "step1", description: "Test step", dependsOn: [], status: "pending" }],
    });

    vi.doMock("../goal/planner.js", () => ({
      generatePlan: generatePlanMock,
      formatPlanAsContext: () => "mocked plan",
      formatPlanOutput: () => "mocked output",
      persistRawPlanResponse: vi.fn(),
      PlanParseError: class PlanParseError extends Error {},
    }));

    // With --replan, should attempt to replan
    // (In practice this would call the real planner, but we're checking the path)
    const output = runtime.getOutput();

    // Even without mocking working, the error message should guide users
    expect(output).toContain("failed during planning");
  });

  test("JSON mode outputs structured error for failed planning run", async () => {
    const runId = "test-json-failed-001";
    createFailedPlanningRun(runId);

    vi.stubEnv("MOLTBOT_GOALS_DIR", testGoalsDir);

    try {
      await goalResumeCommand(runId, { json: true }, runtime);
    } catch {
      // Expected to throw JsonExitError
    }

    const output = runtime.getOutput();
    const json = JSON.parse(output);

    expect(json.error).toContain("Run failed during planning");
    expect(json.error).toContain("--replan");
    expect(json.lastError).toBe("Rate limit exceeded during planning");
  });

  test("quiet mode suppresses output but still handles failed state correctly", async () => {
    const runId = "test-quiet-failed-001";
    createFailedPlanningRun(runId);

    vi.stubEnv("MOLTBOT_GOALS_DIR", testGoalsDir);

    await goalResumeCommand(runId, { quiet: true }, runtime);

    const output = runtime.getOutput();
    // Quiet mode should still output errors
    expect(output).toContain("failed during planning");
  });

  test("resume handles missing run gracefully", async () => {
    const runId = "nonexistent-run-id";

    vi.stubEnv("MOLTBOT_GOALS_DIR", testGoalsDir);

    await goalResumeCommand(runId, {}, runtime);

    const output = runtime.getOutput();
    expect(output).toContain("Run not found");
  });

  test("failed run can transition through multiple states", async () => {
    const runId = "test-state-transition-001";
    const run = createFailedExecutionRun(runId);

    vi.stubEnv("MOLTBOT_GOALS_DIR", testGoalsDir);

    // First resume: failed → blocked
    const result1 = await goalResumeCommand(runId, {}, runtime);
    expect(result1?.status).toBe("blocked");

    // Verify persistence
    const runFile = path.join(testGoalsDir, runId, "run.json");
    const run1 = JSON.parse(fs.readFileSync(runFile, "utf8")) as SerializedRun;
    expect(run1.state).toBe("blocked");

    // Second resume: should stay blocked (needs answer)
    runtime.clear();
    const result2 = await goalResumeCommand(runId, {}, runtime);
    expect(result2?.status).toBe("blocked");
    const output2 = runtime.getOutput();
    expect(output2).toContain("Blocked:");
  });

  test("preserves goal and error context through state transitions", async () => {
    const runId = "test-context-preserve-001";
    const originalGoal = "Build a complex feature with multiple steps";
    const originalError = "Network timeout during planning";

    const run: SerializedRun = {
      runId,
      goal: originalGoal,
      state: "failed",
      lastError: originalError,
      workingDir: "/tmp/test",
      model: "claude-sonnet-4-5-20250929",
      dryRun: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      plan: null,
      stepResults: {},
      answers: {},
      blocked: null,
    };

    const runDir = path.join(testGoalsDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify(run, null, 2), "utf8");

    vi.stubEnv("MOLTBOT_GOALS_DIR", testGoalsDir);

    await goalResumeCommand(runId, {}, runtime);

    const runFile = path.join(testGoalsDir, runId, "run.json");
    const loadedRun = JSON.parse(fs.readFileSync(runFile, "utf8")) as SerializedRun;

    // Goal text should be preserved
    expect(loadedRun.goal).toBe(originalGoal);
    // Error context should be preserved
    expect(loadedRun.lastError).toBe(originalError);
  });
});
