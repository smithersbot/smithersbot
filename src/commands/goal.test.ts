import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonExitError, runCommandWithRuntime } from "../cli/cli-utils.js";
import { listRuns, loadRun } from "../goal/run-store.js";
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

// Mock generatePlan to control planning behavior
const mockGeneratePlan = vi.fn();
class MockPlanParseError extends Error {
  readonly rawResponse: string;
  constructor(message: string, rawResponse: string) {
    super(message);
    this.name = "PlanParseError";
    this.rawResponse = rawResponse;
  }
}
vi.mock("../goal/planner.js", () => ({
  generatePlan: (...args: unknown[]) => mockGeneratePlan(...args),
  PlanParseError: MockPlanParseError,
  persistRawPlanResponse: vi.fn(),
}));

// Mock model-auth to provide a test API key
const mockResolveEnvApiKey = vi.fn();
vi.mock("../agents/model-auth.js", () => ({
  resolveEnvApiKey: (...args: unknown[]) => mockResolveEnvApiKey(...args),
}));

// Mock llm-client
vi.mock("../goal/llm-client.js", () => ({
  createGoalLlmClient: () => ({
    complete: vi.fn(),
  }),
}));

// Mock scout to skip real claude -p execution in unit tests
const mockRunScoutWithRetry = vi.fn();
vi.mock("../goal/scout.js", () => ({
  runScoutWithRetry: (...args: unknown[]) => mockRunScoutWithRetry(...args),
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
    mockResolveEnvApiKey.mockReturnValue({ apiKey: "test-key" });
    mockRunScoutWithRetry.mockResolvedValue({ status: "skipped", reason: "mocked in test" });
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
    fs.rmSync(testGoalsDir, { recursive: true, force: true });
  });

  it("persists run.json with lastError when generatePlan throws", async () => {
    mockGeneratePlan.mockRejectedValue(new Error("Plan must contain at least one step"));

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
    expect(run!.state).toBe("failed");
    expect(run!.lastError).toContain("Plan must contain at least one step");
  });

  it("persists run.json with lastError when API key is missing", async () => {
    mockResolveEnvApiKey.mockReturnValue(null);

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
    ).rejects.toThrow("No Anthropic API key found");

    const runs = listRuns(testGoalsDir);
    expect(runs).toHaveLength(1);

    const run = loadRun(runs[0]!.runId, testGoalsDir);
    expect(run).toBeDefined();
    expect(run!.state).toBe("failed");
    expect(run!.lastError).toContain("No Anthropic API key found");
  });

  it("JSON mode throws JsonExitError after emitting error JSON", async () => {
    mockGeneratePlan.mockRejectedValue(new Error("Planning failed unexpectedly"));

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
    expect(runs[0]!.state).toBe("failed");
  });

  it("runCommandWithRuntime sets process.exitCode on JsonExitError", async () => {
    mockGeneratePlan.mockRejectedValue(new Error("Allowlist rejection"));

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

  it("JSON mode sets non-zero exit code on API key failure", async () => {
    mockResolveEnvApiKey.mockReturnValue(null);

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
    expect(parsed.error).toContain("No Anthropic API key found");
    expect(parsed.runId).toBeDefined();
  });

  it("goal list finds failed runs", async () => {
    mockGeneratePlan.mockRejectedValue(new Error("Allowlist rejection"));

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
    expect(runs[0]!.state).toBe("failed");
    expect(runs[0]!.goal).toBe("Dangerous goal");
  });
});
