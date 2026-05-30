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

// Spy on the direct pre-planning mkdirSync so guard-ordering tests can prove no
// directory is created for a rejected working dir. Other fs calls stay real.
const mockMkdirSync = vi.fn();
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  };
});

// Route the shared goal-execution guard through a controllable mock. Default is a
// no-op (existing tests keep their fixture working dirs); guard-ordering tests
// delegate to the REAL helper to prove the actual hard-deny fires before any
// mkdirSync / ensureWorkingDir / planning.
const mockAssertGoalWorkerWorkspace = vi.fn();
let actualAssertGoalWorkerWorkspace:
  | (typeof import("../goal/workspace-policy.js"))["assertGoalWorkerWorkspace"]
  | undefined;
vi.mock("../goal/workspace-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../goal/workspace-policy.js")>();
  actualAssertGoalWorkerWorkspace = actual.assertGoalWorkerWorkspace;
  return {
    ...actual,
    assertGoalWorkerWorkspace: (...args: unknown[]) => mockAssertGoalWorkerWorkspace(...args),
  };
});

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

  it("initializes the workspace before planning runs", async () => {
    const { goalCommand } = await import("./goal.js");
    const rt = mockRuntime();
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-ws-"));

    await goalCommand({ goal: "Do something", workingDir, yes: true, planOnly: true }, rt);

    expect(mockEnsureWorkingDir).toHaveBeenCalledWith(workingDir);
    expect(mockEnsureWorkingDir.mock.invocationCallOrder[0]!).toBeLessThan(
      mockRunCliPlanning.mock.invocationCallOrder[0]!,
    );
  });

  it("surfaces an actionable init failure before planning instead of a raw git error", async () => {
    mockEnsureWorkingDir.mockImplementationOnce(() => {
      throw new Error(
        "SmithersBot needs a git repository at /x to manage checkpoints, branches, and rollback, " +
          "but it is not a git repository and is outside the managed workspaces root (/root). " +
          "Move this folder under the managed workspaces root so SmithersBot can initialize it " +
          "automatically, or run `git init` in it yourself before starting a goal.",
      );
    });

    const { goalCommand } = await import("./goal.js");
    const rt = mockRuntime();
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-ws-"));

    await expect(goalCommand({ goal: "Do something", workingDir, yes: true }, rt)).rejects.toThrow(
      /managed workspaces root/,
    );

    // Planning never ran because init failed first.
    expect(mockRunCliPlanning).not.toHaveBeenCalled();
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

describe("goalCommand — current-instance workspace guard", () => {
  let managedRoot: string;
  const previousManagedRoot = process.env.SMITHERSBOT_GOALS_ROOT;
  const previousInstance = process.env.SMITHERSBOT_INSTANCE;

  function delegateGuardToReal(): void {
    mockAssertGoalWorkerWorkspace.mockImplementation((...args: unknown[]) => {
      if (!actualAssertGoalWorkerWorkspace) throw new Error("guard not initialized");
      return (actualAssertGoalWorkerWorkspace as (...a: unknown[]) => void)(...args);
    });
  }

  function validWorkingDir(): string {
    const dir = path.join(managedRoot, "agent", "workspaces", "smithersbot-dev");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  beforeEach(() => {
    testGoalsDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-guard-test-"));
    vi.clearAllMocks();
    managedRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "goal-guard-managed-")));
    process.env.SMITHERSBOT_GOALS_ROOT = managedRoot;
    delete process.env.SMITHERSBOT_INSTANCE; // default (stable) instance
    delegateGuardToReal();
    mockRunCliPlanning.mockResolvedValue({
      status: "success",
      plan: {
        goal: "Test goal",
        workingDir: validWorkingDir(),
        summary: "Test plan",
        steps: [{ id: "s1", description: "Step 1", dependsOn: [], status: "pending" }],
      },
      scoutStatus: "success",
    });
  });

  afterEach(() => {
    if (previousManagedRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
    else process.env.SMITHERSBOT_GOALS_ROOT = previousManagedRoot;
    if (previousInstance === undefined) delete process.env.SMITHERSBOT_INSTANCE;
    else process.env.SMITHERSBOT_INSTANCE = previousInstance;
    fs.rmSync(testGoalsDir, { recursive: true, force: true });
    fs.rmSync(managedRoot, { recursive: true, force: true });
  });

  it.each([
    ["dev-home observed path", "/home/matt/smithersbot-dev-home/agent/workspaces/smithersbot-dev"],
    ["arbitrary /tmp path", "/tmp/whatever-not-a-workspace-xyz"],
  ])(
    "rejects an invalid explicit pre-planning workingDir (%s) before mkdirSync/ensureWorkingDir/planning",
    async (_label, badDir) => {
      const { goalCommand } = await import("./goal.js");
      const rt = mockRuntime();

      await expect(
        goalCommand({ goal: "Do something", workingDir: badDir, yes: true, planOnly: true }, rt),
      ).rejects.toThrow(/outside the current stable instance's own agent\/workspaces tree/);

      expect(mockAssertGoalWorkerWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ workingDir: path.resolve(badDir) }),
      );
      // No filesystem preparation or planning happened for the rejected path.
      expect(mockMkdirSync).not.toHaveBeenCalledWith(path.resolve(badDir), expect.anything());
      expect(mockEnsureWorkingDir).not.toHaveBeenCalledWith(path.resolve(badDir));
      expect(mockRunCliPlanning).not.toHaveBeenCalled();
    },
  );

  it("proceeds for a valid stable explicit pre-planning workingDir", async () => {
    const good = validWorkingDir();
    const { goalCommand } = await import("./goal.js");
    const rt = mockRuntime();

    await goalCommand({ goal: "Do something", workingDir: good, yes: true, planOnly: true }, rt);

    expect(mockAssertGoalWorkerWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ workingDir: good }),
    );
    expect(mockEnsureWorkingDir).toHaveBeenCalledWith(good);
    expect(mockRunCliPlanning).toHaveBeenCalled();
  });

  it.each([
    ["dev-home observed path", "/home/matt/smithersbot-dev-home/agent/workspaces/smithersbot-dev"],
    ["arbitrary /tmp path", "/tmp/planner-picked-not-a-workspace-xyz"],
  ])(
    "rejects an invalid planResult.workingDir (%s) before any post-plan ensureWorkingDir/execution",
    async (_label, badPlanDir) => {
      const good = validWorkingDir();
      mockRunCliPlanning.mockResolvedValue({
        status: "success",
        plan: {
          goal: "Test goal",
          workingDir: badPlanDir,
          summary: "Test plan",
          steps: [{ id: "s1", description: "Step 1", dependsOn: [], status: "pending" }],
        },
        scoutStatus: "success",
      });

      const { goalCommand } = await import("./goal.js");
      const rt = mockRuntime();

      await expect(
        goalCommand({ goal: "Do something", workingDir: good, yes: true, planOnly: true }, rt),
      ).rejects.toThrow(/outside the current stable instance's own agent\/workspaces tree/);

      // Planning ran (valid pre-planning dir), but the planner-picked path is
      // rejected before any post-plan ensureWorkingDir for it.
      expect(mockRunCliPlanning).toHaveBeenCalled();
      expect(mockEnsureWorkingDir).not.toHaveBeenCalledWith(badPlanDir);
    },
  );
});

describe("resolveWorkingDir — 4-level precedence", () => {
  const previousManagedRoot = process.env.SMITHERSBOT_GOALS_ROOT;
  const previousInstance = process.env.SMITHERSBOT_INSTANCE;
  let managedRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "smithersbot-goals-test-"));
    process.env.SMITHERSBOT_GOALS_ROOT = managedRoot;
  });

  afterEach(() => {
    if (previousManagedRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
    else process.env.SMITHERSBOT_GOALS_ROOT = previousManagedRoot;
    if (previousInstance === undefined) delete process.env.SMITHERSBOT_INSTANCE;
    else process.env.SMITHERSBOT_INSTANCE = previousInstance;
    fs.rmSync(managedRoot, { recursive: true, force: true });
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

  it("falls back to managed workspace project named after git toplevel", async () => {
    const { resolveWorkingDir } = await import("./goal.js");
    mockIsGitRepo.mockReturnValue(true);
    const result = resolveWorkingDir(undefined, undefined, "/my/repo");
    expect(result).toBe(path.join(managedRoot, "agent", "workspaces", "repo"));
  });

  it("falls back to managed default workspace when cwd is not a git repo", async () => {
    const { resolveWorkingDir } = await import("./goal.js");
    mockIsGitRepo.mockReturnValue(false);
    const result = resolveWorkingDir(undefined, undefined, "/some/dir");
    expect(result).toBe(path.join(managedRoot, "agent", "workspaces", "default"));
  });

  it("uses config.goal.defaultWorkspaceName for managed default workspace", async () => {
    const { resolveWorkingDir } = await import("./goal.js");
    mockIsGitRepo.mockReturnValue(true);
    const result = resolveWorkingDir(
      undefined,
      { goal: { defaultWorkspaceName: "smithersbot" } },
      "/my/repo",
    );
    expect(result).toBe(path.join(managedRoot, "agent", "workspaces", "smithersbot"));
  });

  it("keeps a smithersbot-dev workspace name under the stable instance root by default", async () => {
    const { resolveWorkingDir } = await import("./goal.js");
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue("/home/matt");
    delete process.env.SMITHERSBOT_GOALS_ROOT;
    process.env.SMITHERSBOT_INSTANCE = "stable";
    mockIsGitRepo.mockReturnValue(true);

    try {
      const result = resolveWorkingDir(
        undefined,
        { goal: { defaultWorkspaceName: "smithersbot-dev" } },
        "/home/matt/smithersbot-home/agent/workspaces/smithersbot-dev",
      );

      expect(result).toBe("/home/matt/smithersbot-home/agent/workspaces/smithersbot-dev");
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it("uses the dev instance root only from explicit instance env, not the workspace name", async () => {
    const { resolveWorkingDir } = await import("./goal.js");
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue("/home/matt");
    delete process.env.SMITHERSBOT_GOALS_ROOT;
    process.env.SMITHERSBOT_INSTANCE = "dev";
    mockIsGitRepo.mockReturnValue(true);

    try {
      const result = resolveWorkingDir(
        undefined,
        { goal: { defaultWorkspaceName: "smithersbot-dev" } },
        "/home/matt/smithersbot-home/agent/workspaces/smithersbot-dev",
      );

      expect(result).toBe("/home/matt/smithersbot-dev-home/agent/workspaces/smithersbot-dev");
    } finally {
      homedirSpy.mockRestore();
    }
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
