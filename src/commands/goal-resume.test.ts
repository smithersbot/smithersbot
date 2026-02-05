import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonExitError, runCommandWithRuntime } from "../cli/cli-utils.js";
import { saveRun, loadRun } from "../goal/run-store.js";
import type { Plan, SerializedRun } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";

/** Run an async fn, swallowing JsonExitError (expected in JSON-mode error tests). */
async function catchJsonExit(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof JsonExitError)) throw err;
  }
}

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

// Mock @clack/prompts so we can control confirm() behavior
const mockConfirm = vi.fn();
vi.mock("@clack/prompts", () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
  isCancel: (value: unknown) => typeof value === "symbol",
}));

// Mock model-auth so resume doesn't need a real API key
vi.mock("../agents/model-auth.js", () => ({
  resolveEnvApiKey: () => ({ apiKey: "test-key" }),
}));

// Mock llm-client (not used in approval-flow tests but required by import)
vi.mock("../goal/llm-client.js", () => ({
  createGoalLlmClient: () => ({
    complete: vi.fn(),
  }),
}));

// Mock the agent executor so resume tests don't need a real PI agent session
vi.mock("../goal/agent-executor.js", () => ({
  executeGoalWithAgent: vi.fn(
    async (params: {
      session: { plan: { steps: Array<{ status: string }> } | null; state: string };
    }) => {
      // Mark all pending/blocked steps as done
      if (params.session.plan) {
        for (const step of params.session.plan.steps) {
          if (step.status === "pending" || step.status === "blocked") {
            step.status = "done";
          }
        }
      }
      params.session.state = "done";
      return { status: "done", summary: "All tasks completed." };
    },
  ),
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

const samplePlan: Plan = {
  goal: "Test goal",
  summary: "A test plan",
  steps: [
    {
      id: "1",
      description: "Create dir",
      dependsOn: [],
      status: "pending",
      durationMinutes: 1,
    },
  ],
};

function makeRun(overrides: Partial<SerializedRun>): SerializedRun {
  return {
    runId: "test-run-aaa",
    goal: "Test goal",
    state: "done",
    plan: null,
    stepResults: {},
    blocked: null,
    answers: {},
    workingDir: "/tmp/ws",
    model: undefined,
    dryRun: false,
    createdAt: "2026-01-30T00:00:00.000Z",
    updatedAt: "2026-01-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("goal-resume command", () => {
  beforeEach(() => {
    testGoalsDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-resume-test-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(testGoalsDir, { recursive: true, force: true });
  });

  it("refuses to resume a completed run", async () => {
    saveRun(makeRun({ runId: "done-run", state: "done" }));
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("done-run", {}, rt);
    expect(result).toBeUndefined();
    expect(rt.errors).toContain("Run already completed.");
  });

  it("prints blocked details and exits without re-planning", async () => {
    saveRun(
      makeRun({
        runId: "blocked-run",
        state: "blocked",
        blocked: { prompt: "Need database credentials", requiredInputKey: "db_password" },
      }),
    );
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("blocked-run", {}, rt);
    expect(result).toEqual({
      status: "blocked",
      question: "Need database credentials",
      requiredInputKey: "db_password",
    });
    expect(rt.logs.join("\n")).toContain("Need database credentials");
    expect(rt.logs.join("\n")).toContain("moltbot goal answer");
  });

  it("blocked run in JSON mode outputs strict JSON", async () => {
    saveRun(
      makeRun({
        runId: "blocked-json",
        state: "blocked",
        blocked: { prompt: "Missing config", requiredInputKey: "config_key" },
      }),
    );
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    await goalResumeCommand("blocked-json", { json: true }, rt);
    const raw = rt.logs.join("");
    expect(raw.trimStart()[0]).toBe("{");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.status).toBe("blocked");
    expect(parsed.question).toBe("Missing config");
    expect(parsed.requiredInputKey).toBe("config_key");
  });

  it("--output json produces strict JSON for blocked run", async () => {
    saveRun(
      makeRun({
        runId: "blocked-output-json",
        state: "blocked",
        blocked: { prompt: "Need creds", requiredInputKey: "creds_key" },
      }),
    );
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    await goalResumeCommand("blocked-output-json", { output: "json" }, rt);
    const raw = rt.logs.join("");
    expect(raw.trimStart()[0]).toBe("{");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.status).toBe("blocked");
    expect(parsed.question).toBe("Need creds");
    expect(parsed.requiredInputKey).toBe("creds_key");
  });

  it("--output json produces strict JSON for done error", async () => {
    saveRun(makeRun({ runId: "done-output-json", state: "done" }));
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    await catchJsonExit(() => goalResumeCommand("done-output-json", { output: "json" }, rt));
    const raw = rt.logs.join("");
    expect(raw.trimStart()[0]).toBe("{");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.error).toBe("Run already completed.");
  });

  it("errors for unknown run ID", async () => {
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("nonexistent", {}, rt);
    expect(result).toBeUndefined();
    expect(rt.errors).toContain("Run not found: nonexistent");
  });

  it("resolves partial run IDs", async () => {
    saveRun(
      makeRun({
        runId: "abcdef12-3456-7890-abcd-ef1234567890",
        state: "done",
      }),
    );
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    await goalResumeCommand("abcdef12", {}, rt);
    expect(rt.errors).toContain("Run already completed.");
  });

  it("treats failed run with blocked steps as recoverable (blocked)", async () => {
    saveRun(
      makeRun({
        runId: "failed-run",
        state: "failed",
        lastError: "shell_exec command not in read-only allowlist",
        plan: {
          goal: "Test goal",
          summary: "A test plan",
          steps: [
            {
              id: "1",
              description: "Step one",
              dependsOn: [],
              status: "blocked",
              blockedQuestion: "Need creds",
            },
          ],
        },
      }),
    );
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("failed-run", {}, rt);
    expect(result?.status).toBe("blocked");
    expect(rt.logs.join("\n")).toContain("Blocked:");
    const run = loadRun("failed-run", testGoalsDir);
    expect(run?.state).toBe("blocked");
  });

  it("failed run without blocked details still errors", async () => {
    saveRun(
      makeRun({
        runId: "failed-json",
        state: "failed",
        lastError: "Planning error",
      }),
    );
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("failed-json", {}, rt);
    expect(result).toBeUndefined();
    expect(rt.errors.join("\n")).toContain("Run failed:");
    expect(rt.errors.join("\n")).toContain("Planning error");
  });

  it("refuses stale init state", async () => {
    saveRun(makeRun({ runId: "init-run", state: "init" }));
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("init-run", {}, rt);
    expect(result).toBeUndefined();
    expect(rt.errors).toContain("Run is in an incomplete state.");
  });

  it("refuses stale planning state", async () => {
    saveRun(makeRun({ runId: "planning-run", state: "planning" }));
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("planning-run", {}, rt);
    expect(result).toBeUndefined();
    expect(rt.errors).toContain("Run is in an incomplete state.");
  });

  it("done run in JSON mode outputs error JSON", async () => {
    saveRun(makeRun({ runId: "done-json", state: "done" }));
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    await catchJsonExit(() => goalResumeCommand("done-json", { json: true }, rt));
    const parsed = JSON.parse(rt.logs.join("")) as Record<string, unknown>;
    expect(parsed.error).toBe("Run already completed.");
  });

  // --- Cancel vs reject ---

  it("resumes a rejected run with --yes (re-approval, no re-plan)", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-rejected-ws-"));
    saveRun(
      makeRun({
        runId: "rejected-run",
        state: "rejected",
        plan: samplePlan,
        workingDir: workDir,
      }),
    );
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    // --yes skips the prompt entirely and proceeds to execution
    // executePlan will run the mkdir step; we just verify it reaches execution
    const result = await goalResumeCommand("rejected-run", { yes: true }, rt);
    // The run should execute (mkdir step) and return done
    expect(result).toBeDefined();
    expect(result!.status).toBe("done");
    // The persisted state should now be "done"
    const persisted = loadRun("rejected-run", testGoalsDir);
    expect(persisted?.state).toBe("done");
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("resumes a cancelled run with --yes (re-approval, no re-plan)", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-cancelled-ws-"));
    saveRun(
      makeRun({
        runId: "cancelled-run",
        state: "cancelled",
        plan: samplePlan,
        workingDir: workDir,
      }),
    );
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("cancelled-run", { yes: true }, rt);
    expect(result).toBeDefined();
    expect(result!.status).toBe("done");
    const persisted = loadRun("cancelled-run", testGoalsDir);
    expect(persisted?.state).toBe("done");
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("resumes a rejected run interactively — explicit No re-rejects", async () => {
    saveRun(
      makeRun({
        runId: "rejected-reprompt",
        state: "rejected",
        plan: samplePlan,
      }),
    );
    mockConfirm.mockResolvedValueOnce(false);
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("rejected-reprompt", {}, rt);
    expect(result).toEqual({ status: "rejected" });
    expect(rt.logs.join("\n")).toContain("Plan rejected.");
    const persisted = loadRun("rejected-reprompt", testGoalsDir);
    expect(persisted?.state).toBe("rejected");
  });

  it("confirm throw during resume persists cancelled state", async () => {
    saveRun(
      makeRun({
        runId: "cancel-throw",
        state: "awaiting_approval",
        plan: samplePlan,
      }),
    );
    mockConfirm.mockRejectedValueOnce(new Error("SIGINT"));
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("cancel-throw", {}, rt);
    expect(result).toEqual({ status: "rejected" });
    expect(rt.logs.join("\n")).toContain("Cancelled.");
    const persisted = loadRun("cancel-throw", testGoalsDir);
    expect(persisted?.state).toBe("cancelled");
  });

  it("isCancel symbol during resume persists cancelled state", async () => {
    saveRun(
      makeRun({
        runId: "cancel-symbol",
        state: "awaiting_approval",
        plan: samplePlan,
      }),
    );
    mockConfirm.mockResolvedValueOnce(Symbol("cancel"));
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("cancel-symbol", {}, rt);
    expect(result).toEqual({ status: "rejected" });
    expect(rt.logs.join("\n")).toContain("Cancelled.");
    const persisted = loadRun("cancel-symbol", testGoalsDir);
    expect(persisted?.state).toBe("cancelled");
  });

  it("JSON-mode error sets non-zero exit code via runCommandWithRuntime", async () => {
    const saved = process.exitCode;
    process.exitCode = undefined;
    try {
      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();

      await runCommandWithRuntime(rt, async () => {
        await goalResumeCommand("not-a-real-id", { json: true }, rt);
      });

      expect(process.exitCode).toBe(1);

      // stdout is strict JSON
      const raw = rt.logs.join("");
      expect(raw.trimStart()[0]).toBe("{");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed.error).toContain("Run not found");

      // No stderr output
      expect(rt.errors).toHaveLength(0);
    } finally {
      process.exitCode = saved;
    }
  });

  it("quiet mode suppresses progress output but preserves return value", async () => {
    // This test verifies quiet mode by using a run with all steps already done
    // (no agent executor needed — resumableSteps === 0)
    const donePlan: Plan = {
      goal: "Test goal",
      summary: "Already done plan",
      steps: [
        {
          id: "1",
          description: "Create dir",
          dependsOn: [],
          status: "done",
          durationMinutes: 1,
        },
      ],
    };

    saveRun(
      makeRun({
        runId: "quiet-run",
        state: "awaiting_approval",
        plan: donePlan,
        stepResults: {
          "1": { stepId: "1", success: true, output: "Created", durationMs: 1 },
        },
      }),
    );

    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("quiet-run", { yes: true, quiet: true }, rt);

    // Return value is still correct
    expect(result).toBeDefined();
    expect(result!.status).toBe("done");

    // No progress/transcript output printed — quiet suppresses everything
    expect(rt.logs).toHaveLength(0);

    // State still persisted
    const persisted = loadRun("quiet-run", testGoalsDir);
    expect(persisted?.state).toBe("done");
  });

  it("non-quiet mode prints plan and status output for same scenario", async () => {
    const donePlan: Plan = {
      goal: "Test goal",
      summary: "Already done plan",
      steps: [
        {
          id: "1",
          description: "Create dir",
          dependsOn: [],
          status: "done",
          durationMinutes: 1,
        },
      ],
    };

    saveRun(
      makeRun({
        runId: "loud-run",
        state: "awaiting_approval",
        plan: donePlan,
        stepResults: {
          "1": { stepId: "1", success: true, output: "Created", durationMs: 1 },
        },
      }),
    );

    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("loud-run", { yes: true }, rt);

    // Return value is the same
    expect(result).toBeDefined();
    expect(result!.status).toBe("done");

    // Non-quiet mode DOES print output
    const allLogs = rt.logs.join("\n");
    expect(allLogs).toContain("All steps already completed.");
  });

  it("resume after answering runs remaining steps", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-answered-ws-"));
    // Start with a blocked run that has a pending step
    saveRun(
      makeRun({
        runId: "answered-run",
        state: "blocked",
        plan: samplePlan,
        blocked: { prompt: "Need input", requiredInputKey: "some_key" },
        workingDir: workDir,
      }),
    );

    // Answer the question — auto-resumes blocked runs via goalResumeCommand
    const { goalAnswerCommand } = await import("./goal-answer.js");
    const answerRt = mockRuntime();
    const result = await goalAnswerCommand(
      "answered-run",
      { key: "some_key", value: "the_answer" },
      answerRt,
    );

    // Auto-resume should complete the run
    expect(result).toBeDefined();
    expect(result!.status).toBe("done");

    const finalRun = loadRun("answered-run", testGoalsDir);
    expect(finalRun?.state).toBe("done");
    expect(finalRun!.answers.some_key).toBe("the_answer");
    expect(finalRun!.blocked).toBeNull();
    fs.rmSync(workDir, { recursive: true, force: true });
  });
});
