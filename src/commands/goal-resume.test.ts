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
  resolveApiKeyForProvider: () =>
    Promise.resolve({ apiKey: "test-key", source: "test", mode: "api-key" }),
}));

// Mock llm-client (not used in approval-flow tests but required by import)
const mockLlmComplete = vi.fn();
vi.mock("../goal/llm-client.js", () => ({
  createGoalLlmClient: () => ({
    complete: mockLlmComplete,
  }),
}));

// Mock planner
const mockGeneratePlan = vi.fn();
vi.mock("../goal/planner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../goal/planner.js")>();
  return {
    ...actual,
    generatePlan: mockGeneratePlan,
  };
});

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
    // Reset generatePlan mock to default (no-op)
    mockGeneratePlan.mockReset();
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
        blocked: {
          blockedAt: "execution",
          prompt: "Need database credentials",
          requiredInputKey: "db_password",
        },
      }),
    );
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("blocked-run", {}, rt);
    expect(result).toEqual({
      status: "blocked",
      question: "Need database credentials",
      requiredInputKey: "db_password",
      blockedAt: "execution",
    });
    expect(rt.logs.join("\n")).toContain("Need database credentials");
    expect(rt.logs.join("\n")).toContain("moltbot goal answer");
  });

  it("blocked run in JSON mode outputs strict JSON", async () => {
    saveRun(
      makeRun({
        runId: "blocked-json",
        state: "blocked",
        blocked: {
          blockedAt: "execution",
          prompt: "Missing config",
          requiredInputKey: "config_key",
        },
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
        blocked: {
          blockedAt: "execution",
          prompt: "Need creds",
          requiredInputKey: "creds_key",
        },
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

  it("cancelled run without a plan suggests --replan", async () => {
    saveRun(
      makeRun({
        runId: "cancelled-no-plan",
        state: "cancelled",
        plan: null,
        lastError: "Planning error",
      }),
    );
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("cancelled-no-plan", {}, rt);
    expect(result).toBeUndefined();
    expect(rt.errors.join("\n")).toContain("Run has no plan");
    expect(rt.errors.join("\n")).toContain("--replan");
  });

  it("refuses stale planning state without --replan", async () => {
    saveRun(makeRun({ runId: "planning-run", state: "planning" }));
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("planning-run", {}, rt);
    expect(result).toBeUndefined();
    expect(rt.errors.join("\n")).toContain("incomplete state");
    expect(rt.errors.join("\n")).toContain("--replan");
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

  it("resumes a cancelled run interactively — explicit No keeps cancelled", async () => {
    saveRun(
      makeRun({
        runId: "cancelled-reprompt",
        state: "cancelled",
        plan: samplePlan,
      }),
    );
    mockConfirm.mockResolvedValueOnce(false);
    const { goalResumeCommand } = await import("./goal-resume.js");
    const rt = mockRuntime();
    const result = await goalResumeCommand("cancelled-reprompt", {}, rt);
    expect(result).toEqual({ status: "cancelled" });
    expect(rt.logs.join("\n")).toContain("Plan rejected.");
    const persisted = loadRun("cancelled-reprompt", testGoalsDir);
    expect(persisted?.state).toBe("cancelled");
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
    expect(result).toEqual({ status: "cancelled" });
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
    expect(result).toEqual({ status: "cancelled" });
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
        blocked: { blockedAt: "execution", prompt: "Need input", requiredInputKey: "some_key" },
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

  // --- Replan functionality tests ---

  describe("--replan flag", () => {
    it("retries planning for a run in 'planning' state", async () => {
      // Mock generatePlan to succeed
      mockGeneratePlan.mockResolvedValueOnce({
        summary: "Replanned successfully",
        steps: [
          {
            id: "replanned-step",
            description: "A replanned task",
            dependsOn: [],
            durationMinutes: 30,
            status: "pending",
          },
        ],
        goal: "Original goal text",
      });

      saveRun(
        makeRun({
          runId: "planning-stuck",
          state: "planning",
          goal: "Original goal text",
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      const result = await goalResumeCommand("planning-stuck", { replan: true }, rt);

      // Should not auto-execute, just transition to awaiting_approval
      expect(result).toBeUndefined();
      const persisted = loadRun("planning-stuck", testGoalsDir);
      expect(persisted?.state).toBe("awaiting_approval");
      expect(persisted?.plan).toBeDefined();
      expect(persisted?.plan?.summary).toBe("Replanned successfully");
      expect(persisted?.plan?.steps).toHaveLength(1);
      expect(rt.logs.join("\n")).toContain("Replanned successfully");
    });

    it("retries planning for a cancelled run with no plan", async () => {
      mockGeneratePlan.mockResolvedValueOnce({
        summary: "Recovery plan",
        steps: [
          {
            id: "recovery-step",
            description: "Recovered from failure",
            dependsOn: [],
            durationMinutes: 20,
            status: "pending",
          },
        ],
        goal: "Goal that failed during planning",
      });

      saveRun(
        makeRun({
          runId: "failed-planning",
          state: "cancelled",
          goal: "Goal that failed during planning",
          lastError: "Rate limit hit during planning",
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      await goalResumeCommand("failed-planning", { replan: true }, rt);

      const persisted = loadRun("failed-planning", testGoalsDir);
      expect(persisted?.state).toBe("awaiting_approval");
      expect(persisted?.lastError).toBeUndefined();
      expect(persisted?.plan?.summary).toBe("Recovery plan");
    });

    it("suggests --replan when planning state encountered without flag", async () => {
      saveRun(
        makeRun({
          runId: "planning-no-replan",
          state: "planning",
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      const result = await goalResumeCommand("planning-no-replan", {}, rt);

      expect(result).toBeUndefined();
      expect(rt.errors.join("\n")).toContain("incomplete state");
      expect(rt.errors.join("\n")).toContain("--replan");
    });

    it("suggests --replan when cancelled run with no plan encountered without flag", async () => {
      saveRun(
        makeRun({
          runId: "failed-no-replan",
          state: "cancelled",
          lastError: "Network error during planning",
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      const result = await goalResumeCommand("failed-no-replan", {}, rt);

      expect(result).toBeUndefined();
      expect(rt.errors.join("\n")).toContain("Run has no plan");
      expect(rt.errors.join("\n")).toContain("--replan");
    });

    it("handles replanning that results in blocked", async () => {
      mockGeneratePlan.mockResolvedValueOnce({
        blocked: true,
        question: "Need more info about the database",
      });

      saveRun(
        makeRun({
          runId: "replan-blocked",
          state: "planning",
          goal: "Complex goal needing clarification",
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      const result = await goalResumeCommand("replan-blocked", { replan: true }, rt);

      expect(result).toBeDefined();
      expect(result?.status).toBe("blocked");
      expect(result?.question).toBe("Need more info about the database");

      const persisted = loadRun("replan-blocked", testGoalsDir);
      expect(persisted?.state).toBe("blocked");
      expect(persisted?.blocked?.prompt).toBe("Need more info about the database");
    });

    it("persists error when replanning fails again", async () => {
      mockGeneratePlan.mockRejectedValueOnce(new Error("Still rate limited"));

      saveRun(
        makeRun({
          runId: "replan-fails",
          state: "planning",
          goal: "Goal that keeps failing",
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      const result = await goalResumeCommand("replan-fails", { replan: true }, rt);

      expect(result).toBeUndefined();
      expect(rt.errors.join("\n")).toContain("Planning failed");

      const persisted = loadRun("replan-fails", testGoalsDir);
      expect(persisted?.state).toBe("planning");
      expect(persisted?.lastError).toContain("Still rate limited");
    });

    it("--replan works in JSON mode", async () => {
      mockGeneratePlan.mockResolvedValueOnce({
        summary: "JSON mode replan",
        steps: [
          {
            id: "json-step",
            description: "A step",
            dependsOn: [],
            durationMinutes: 15,
            status: "pending",
          },
        ],
        goal: "Goal for JSON mode test",
      });

      saveRun(
        makeRun({
          runId: "replan-json",
          state: "planning",
          goal: "Goal for JSON mode test",
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      await goalResumeCommand("replan-json", { replan: true, json: true }, rt);

      const raw = rt.logs.join("");
      expect(raw.trimStart()[0]).toBe("{");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed.status).toBe("awaiting_approval");
      expect(parsed.runId).toBe("replan-json");
      expect(parsed.stepCount).toBe(1);

      const persisted = loadRun("replan-json", testGoalsDir);
      expect(persisted?.state).toBe("awaiting_approval");
      expect(persisted?.plan?.summary).toBe("JSON mode replan");
    });

    it("--replan in quiet mode suppresses output", async () => {
      mockGeneratePlan.mockResolvedValueOnce({
        summary: "Quiet replan",
        steps: [
          {
            id: "quiet-step",
            description: "Silently replanned",
            dependsOn: [],
            durationMinutes: 10,
            status: "pending",
          },
        ],
        goal: "Quiet mode goal",
      });

      saveRun(
        makeRun({
          runId: "replan-quiet",
          state: "planning",
          goal: "Quiet mode goal",
          lastError: "Previous planning failure",
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      await goalResumeCommand("replan-quiet", { replan: true, quiet: true }, rt);

      // Quiet mode should suppress most output except critical info
      expect(rt.logs.length).toBeLessThan(3);

      const persisted = loadRun("replan-quiet", testGoalsDir);
      expect(persisted?.state).toBe("awaiting_approval");
      expect(persisted?.plan?.summary).toBe("Quiet replan");
    });

    it("calls generatePlan when replanning", async () => {
      const runId = "replan-check-call";

      mockGeneratePlan.mockResolvedValueOnce({
        summary: "Generated plan",
        steps: [
          {
            id: "generated-step",
            description: "A generated task",
            dependsOn: [],
            durationMinutes: 25,
            status: "pending",
          },
        ],
        goal: "Goal text",
      });

      saveRun(
        makeRun({
          runId,
          state: "planning",
          goal: "Goal text",
        }),
      );

      const { goalResumeCommand } = await import("./goal-resume.js");
      const rt = mockRuntime();
      await goalResumeCommand(runId, { replan: true }, rt);

      // Verify generatePlan was called
      expect(mockGeneratePlan).toHaveBeenCalled();
      const callArgs = mockGeneratePlan.mock.calls[0];
      // First arg is client, second is goal text, third is optional scoutData
      expect(callArgs?.[0]).toBeDefined(); // Client
      expect(callArgs?.[1]).toBe("Goal text"); // Goal

      const persisted = loadRun(runId, testGoalsDir);
      expect(persisted?.state).toBe("awaiting_approval");
      expect(persisted?.plan?.summary).toBe("Generated plan");
    });
  });
});
