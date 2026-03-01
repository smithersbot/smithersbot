import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonExitError, runCommandWithRuntime } from "../cli/cli-utils.js";
import { listRuns, loadRun, saveRun } from "../goal/run-store.js";
import type { SerializedRun } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";

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

// Mock CLI planner to control planning behavior
const mockRunCliPlanning = vi.fn();
const mockPersistRawPlanResponse = vi.fn();
class MockPlanParseError extends Error {
  readonly rawResponse: string;
  constructor(message: string, rawResponse: string) {
    super(message);
    this.name = "PlanParseError";
    this.rawResponse = rawResponse;
  }
}
vi.mock("../goal/planner.js", () => ({
  PlanParseError: MockPlanParseError,
  persistRawPlanResponse: (...args: unknown[]) => mockPersistRawPlanResponse(...args),
}));

vi.mock("../goal/cli-planner.js", () => ({
  runCliPlanning: (...args: unknown[]) => mockRunCliPlanning(...args),
}));

// Mock isGitRepo for resolveWorkingDir tests
const mockIsGitRepo = vi.fn();
const mockEnsureWorkingDir = vi.fn();
vi.mock("../goal/git-checkpoint.js", () => ({
  isGitRepo: (...args: unknown[]) => mockIsGitRepo(...args),
  ensureWorkingDir: (...args: unknown[]) => mockEnsureWorkingDir(...args),
}));

// Mock progress
vi.mock("../cli/progress.js", () => ({
  createCliProgress: () => ({
    setLabel: vi.fn(),
    setPercent: vi.fn(),
    tick: vi.fn(),
    done: vi.fn(),
  }),
}));

// Mock @clack/prompts
vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  isCancel: (value: unknown) => typeof value === "symbol",
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

describe("goal command — early failure persistence", () => {
  let savedExitCode: number | undefined;

  beforeEach(() => {
    testGoalsDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-cmd-test-"));
    vi.clearAllMocks();
    mockRunCliPlanning.mockResolvedValue({
      status: "success",
      plan: {
        goal: "Test goal",
        workingDir: "/tmp/planner-work",
        summary: "Test plan",
        steps: [{ id: "s1", description: "Step 1", dependsOn: [], status: "pending" }],
      },
      scoutStatus: "success",
    });
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
    fs.rmSync(testGoalsDir, { recursive: true, force: true });
  });

  it("persists run.json with lastError when unified CLI planning throws", async () => {
    mockRunCliPlanning.mockRejectedValue(new Error("Plan must contain at least one step"));

    const { goalCommand } = await import("./goal.js");
    const rt = mockRuntime();

    await expect(
      goalCommand(
        {
          goal: "Do something dangerous",
          workingDir: fs.mkdtempSync(path.join(os.tmpdir(), "goal-ws-")),
          yes: true,
        },
        rt,
      ),
    ).rejects.toThrow("Plan must contain at least one step");

    // Run should be persisted despite the error
    const runs = listRuns(testGoalsDir);
    expect(runs).toHaveLength(1);

    const run = loadRun(runs[0]!.runId, testGoalsDir);
    expect(run).toBeDefined();
    expect(run!.state).toBe("planning");
    expect(run!.lastError).toContain("Plan must contain at least one step");
  });

  it("persists raw planner output when CLI planning throws PlanParseError", async () => {
    mockRunCliPlanning.mockRejectedValue(
      new MockPlanParseError("Failed to parse plan JSON", "raw planner output"),
    );

    const { goalCommand } = await import("./goal.js");
    const rt = mockRuntime();

    await expect(
      goalCommand(
        {
          goal: "Build something",
          workingDir: fs.mkdtempSync(path.join(os.tmpdir(), "goal-ws-")),
          yes: true,
        },
        rt,
      ),
    ).rejects.toThrow("Failed to parse plan JSON");

    expect(mockPersistRawPlanResponse).toHaveBeenCalledWith(
      expect.any(String),
      "raw planner output",
    );
  });

  it("JSON mode throws JsonExitError after emitting error JSON", async () => {
    mockRunCliPlanning.mockRejectedValue(new Error("Planning failed unexpectedly"));

    const { goalCommand } = await import("./goal.js");
    const rt = mockRuntime();

    await expect(
      goalCommand(
        {
          goal: "Build something",
          workingDir: fs.mkdtempSync(path.join(os.tmpdir(), "goal-ws-")),
          yes: true,
          output: "json",
        },
        rt,
      ),
    ).rejects.toThrow(JsonExitError);

    // JSON was emitted before the throw
    const jsonOutput = rt.logs.find((l) => l.startsWith("{"));
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse(jsonOutput!) as Record<string, unknown>;
    expect(parsed.error).toBe("Planning failed unexpectedly");
    expect(parsed.runId).toBeDefined();
    expect(typeof parsed.runId).toBe("string");

    // The run should also be persisted
    const runs = listRuns(testGoalsDir);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.state).toBe("planning");
  });

  it("runCommandWithRuntime sets process.exitCode on JsonExitError", async () => {
    mockRunCliPlanning.mockRejectedValue(new Error("Allowlist rejection"));

    const { goalCommand } = await import("./goal.js");
    const rt = mockRuntime();

    await runCommandWithRuntime(rt, async () => {
      await goalCommand(
        {
          goal: "Build something",
          workingDir: fs.mkdtempSync(path.join(os.tmpdir(), "goal-ws-")),
          yes: true,
          json: true,
        },
        rt,
      );
    });

    // runCommandWithRuntime should have set exitCode via JsonExitError handler
    expect(process.exitCode).toBe(1);

    // Error JSON was written to logs (not stderr)
    const jsonOutput = rt.logs.find((l) => l.startsWith("{"));
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse(jsonOutput!) as Record<string, unknown>;
    expect(parsed.error).toBe("Allowlist rejection");
    expect(parsed.runId).toBeDefined();

    // No stderr output (JSON-only on stdout)
    expect(rt.errors).toHaveLength(0);
  });

  it("JSON mode sets non-zero exit code on planner auth failure", async () => {
    mockRunCliPlanning.mockRejectedValue(new Error("Authentication failed for planner CLI"));

    const { goalCommand } = await import("./goal.js");
    const rt = mockRuntime();

    await runCommandWithRuntime(rt, async () => {
      await goalCommand(
        {
          goal: "Build something",
          workingDir: fs.mkdtempSync(path.join(os.tmpdir(), "goal-ws-")),
          yes: true,
          json: true,
        },
        rt,
      );
    });

    expect(process.exitCode).toBe(1);

    const jsonOutput = rt.logs.find((l) => l.startsWith("{"));
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse(jsonOutput!) as Record<string, unknown>;
    expect(parsed.error).toContain("Authentication failed");
    expect(parsed.runId).toBeDefined();
  });

  it("handles blocked-at-planning from unified CLI planner", async () => {
    mockRunCliPlanning.mockResolvedValue({
      status: "blocked",
      question: "Which target environment should I use?",
      scoutStatus: "needs_clarification",
    });

    const { goalCommand } = await import("./goal.js");
    const rt = mockRuntime();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-ws-"));

    const outcome = await goalCommand(
      {
        goal: "Deploy this service",
        workingDir: workDir,
        yes: true,
      },
      rt,
    );

    expect(outcome).toEqual({
      status: "blocked",
      question: "Which target environment should I use?",
      requiredInputKey: "step:planning:input",
      blockedAt: "planning",
    });
    const runs = listRuns(testGoalsDir);
    expect(runs).toHaveLength(1);
    const run = loadRun(runs[0]!.runId, testGoalsDir);
    expect(run).toBeDefined();
    expect(run!.state).toBe("blocked");
    expect(run!.scoutStatus).toBe("needs_clarification");
    expect(run!.blocked?.blockedAt).toBe("planning");
    expect(mockRunCliPlanning).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: workDir,
      }),
    );
  });

  it("returns cancelled and does not persist plan when run is stopped during planning", async () => {
    const runId = "cancelled-during-planning";
    const plannedWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-ws-planner-selected-"));
    const planningWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-ws-planning-"));

    mockRunCliPlanning.mockImplementationOnce(
      async ({ runId: plannerRunId }: { runId: string }) => {
        const existingRun = loadRun(plannerRunId, testGoalsDir);
        expect(existingRun?.state).toBe("planning");
        saveRun({ ...existingRun!, state: "cancelled" }, testGoalsDir);
        return {
          status: "success",
          plan: {
            goal: "Should not persist",
            workingDir: plannedWorkDir,
            summary: "Plan generated after stop",
            steps: [{ id: "s1", description: "Step 1", dependsOn: [], status: "pending" }],
          },
          scoutStatus: "success",
        };
      },
    );

    const { goalCommand } = await import("./goal.js");
    const rt = mockRuntime();
    const outcome = await goalCommand(
      {
        runId,
        goal: "Stop me during planning",
        workingDir: planningWorkDir,
        yes: true,
        planOnly: true,
      },
      rt,
    );

    expect(outcome).toEqual({ status: "cancelled" });
    const run = loadRun(runId, testGoalsDir);
    expect(run).toBeDefined();
    expect(run?.state).toBe("cancelled");
    expect(run?.plan).toBeNull();
  });

  it("persists planner-selected workingDir instead of the pre-resolved planning cwd", async () => {
    const planningDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-ws-planning-"));
    const plannerWorkingDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-ws-planner-selected-"));
    mockRunCliPlanning.mockResolvedValue({
      status: "success",
      plan: {
        goal: "Build in another directory",
        workingDir: plannerWorkingDir,
        summary: "Use a different workspace",
        steps: [{ id: "s1", description: "Step 1", dependsOn: [], status: "pending" }],
      },
      scoutStatus: "success",
    });

    const { goalCommand } = await import("./goal.js");
    const rt = mockRuntime();
    const outcome = await goalCommand(
      {
        goal: "Build in another directory",
        workingDir: planningDir,
        yes: true,
        planOnly: true,
      },
      rt,
    );

    expect(outcome).toBeUndefined();
    expect(mockRunCliPlanning).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: planningDir,
      }),
    );

    const runs = listRuns(testGoalsDir);
    const run = loadRun(runs[0]!.runId, testGoalsDir);
    expect(run?.workingDir).toBe(plannerWorkingDir);
  });

  it("records skipped scout metadata from unified planning result", async () => {
    mockRunCliPlanning.mockResolvedValue({
      status: "success",
      plan: {
        goal: "Build a thing",
        workingDir: "/tmp/planner-work",
        summary: "Test plan",
        steps: [{ id: "s1", description: "Step 1", dependsOn: [], status: "pending" }],
      },
      scoutStatus: "skipped",
      scoutSkipReason: "--no-scout flag",
    });

    const { goalCommand } = await import("./goal.js");
    const rt = mockRuntime();

    const outcome = await goalCommand(
      {
        goal: "Build a thing",
        workingDir: fs.mkdtempSync(path.join(os.tmpdir(), "goal-ws-")),
        yes: true,
        planOnly: true,
        noScout: true,
      },
      rt,
    );

    expect(outcome).toBeUndefined();
    const runs = listRuns(testGoalsDir);
    const run = loadRun(runs[0]!.runId, testGoalsDir);
    expect(run!.state).toBe("planning");
    expect(run!.scoutStatus).toBe("skipped");
    expect(run!.scoutSkipReason).toBe("--no-scout flag");
    expect(rt.logs.some((line) => line.includes("Scout skipped: --no-scout flag"))).toBe(true);
  });

  it("logs planner fallback notice with reset hint and persists degraded metadata", async () => {
    mockRunCliPlanning.mockResolvedValueOnce({
      status: "success",
      plan: {
        goal: "Trigger degraded planner fallback",
        workingDir: "/tmp/planner-work",
        summary: "Degraded plan",
        steps: [
          {
            id: "s1",
            description: "Step 1",
            dependsOn: [],
            status: "pending",
            durationMinutes: 5,
          },
        ],
      },
      scoutStatus: "success",
      plannerBackendUsed: "codex",
      plannerDegradedReason: "anthropic_usage_limit",
      plannerDegradedResetHint: "resets 6pm (America/Toronto)",
    });

    const { goalCommand } = await import("./goal.js");
    const rt = mockRuntime();

    await goalCommand(
      {
        goal: "Trigger degraded planner fallback",
        workingDir: fs.mkdtempSync(path.join(os.tmpdir(), "goal-ws-")),
        planOnly: true,
        yes: true,
      },
      rt,
    );

    expect(
      rt.logs.some(
        (line) =>
          line.includes("Planner notice: Anthropic usage limit reached") &&
          line.includes("resets 6pm (America/Toronto)") &&
          line.includes("Falling back to Codex planning for this run."),
      ),
    ).toBe(true);

    const runs = listRuns(testGoalsDir);
    expect(runs).toHaveLength(1);
    const run = loadRun(runs[0]!.runId, testGoalsDir);
    expect(run?.plannerBackendUsed).toBe("codex");
    expect(run?.plannerDegradedReason).toBe("anthropic_usage_limit");
    expect(run?.plannerDegradedResetHint).toBe("resets 6pm (America/Toronto)");
  });

  it("warns once when planner degraded but execution is explicitly forced to claude_code", async () => {
    mockRunCliPlanning.mockResolvedValueOnce({
      status: "success",
      plan: {
        goal: "Force claude backend after degraded plan",
        workingDir: "/tmp/planner-work",
        summary: "Degraded plan",
        steps: [
          {
            id: "s1",
            description: "Step 1",
            dependsOn: [],
            status: "pending",
            durationMinutes: 5,
          },
        ],
      },
      scoutStatus: "success",
      plannerBackendUsed: "codex",
      plannerDegradedReason: "anthropic_usage_limit",
    });

    const { goalCommand } = await import("./goal.js");
    const rt = mockRuntime();

    await goalCommand(
      {
        goal: "Force claude backend after degraded plan",
        workingDir: fs.mkdtempSync(path.join(os.tmpdir(), "goal-ws-")),
        backend: "claude_code",
        planOnly: true,
        yes: true,
      },
      rt,
    );

    const warningLogs = rt.logs.filter((line) =>
      line.includes("--backend claude_code will override that safeguard for execution."),
    );
    expect(warningLogs).toHaveLength(1);
  });

  it("goal list finds incomplete runs", async () => {
    mockRunCliPlanning.mockRejectedValue(new Error("Allowlist rejection"));

    const { goalCommand } = await import("./goal.js");
    const rt = mockRuntime();

    await expect(
      goalCommand(
        {
          goal: "Dangerous goal",
          workingDir: fs.mkdtempSync(path.join(os.tmpdir(), "goal-ws-")),
          yes: true,
        },
        rt,
      ),
    ).rejects.toThrow("Allowlist rejection");

    // Verify goal list shows the failed run
    const runs = listRuns(testGoalsDir);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.state).toBe("planning");
    expect(runs[0]!.goal).toBe("Dangerous goal");
  });
});

describe("resolveWorkingDir — 4-level precedence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("explicit --working-dir wins over everything", async () => {
    const { resolveWorkingDir } = await import("./goal.js");
    mockIsGitRepo.mockReturnValue(true);
    const result = resolveWorkingDir(
      "/explicit/dir",
      { goal: { defaultWorkingDir: "/config/dir" } },
      "/cwd",
    );
    expect(result).toBe("/explicit/dir");
  });

  it("config.goal.defaultWorkingDir wins when no explicit flag", async () => {
    const { resolveWorkingDir } = await import("./goal.js");
    mockIsGitRepo.mockReturnValue(true);
    const result = resolveWorkingDir(
      undefined,
      { goal: { defaultWorkingDir: "/config/dir" } },
      "/cwd",
    );
    expect(result).toBe("/config/dir");
  });

  it("falls back to cwd when it is a git repo", async () => {
    const { resolveWorkingDir } = await import("./goal.js");
    mockIsGitRepo.mockReturnValue(true);
    const result = resolveWorkingDir(undefined, undefined, "/my/repo");
    expect(result).toBe("/my/repo");
  });

  it("falls back to .moltbot-goal-workspace when cwd is not a git repo", async () => {
    const { resolveWorkingDir } = await import("./goal.js");
    mockIsGitRepo.mockReturnValue(false);
    const result = resolveWorkingDir(undefined, undefined, "/some/dir");
    expect(result).toBe(path.resolve("/some/dir", ".moltbot-goal-workspace"));
  });

  it("resolves relative --working-dir to absolute", async () => {
    const { resolveWorkingDir } = await import("./goal.js");
    const result = resolveWorkingDir("relative/path", undefined, "/cwd");
    expect(path.isAbsolute(result)).toBe(true);
  });

  it("resolves relative config defaultWorkingDir to absolute", async () => {
    const { resolveWorkingDir } = await import("./goal.js");
    mockIsGitRepo.mockReturnValue(false);
    const result = resolveWorkingDir(
      undefined,
      { goal: { defaultWorkingDir: "~/projects/repo" } },
      "/cwd",
    );
    expect(path.isAbsolute(result)).toBe(true);
  });
});
