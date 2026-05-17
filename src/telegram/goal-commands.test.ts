import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRun, saveRun } from "../goal/run-store.js";
import { resetMessageIndex } from "./goal-message-index.js";
import type { SerializedRun } from "../goal/types.js";

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

// Mock goal command to avoid needing real API keys / LLM calls
const mockGoalCommand = vi.fn();
vi.mock("../commands/goal.js", () => ({
  goalCommand: (...args: unknown[]) => mockGoalCommand(...args),
}));

const mockGoalResumeCommand = vi.fn();
vi.mock("../commands/goal-resume.js", () => ({
  goalResumeCommand: (...args: unknown[]) => mockGoalResumeCommand(...args),
}));

const mockGoalStatusCommand = vi.fn();
vi.mock("../commands/goal-status.js", () => ({
  goalStatusCommand: (...args: unknown[]) => mockGoalStatusCommand(...args),
}));

const mockGoalDetailCommand = vi.fn();
vi.mock("../commands/goal-detail.js", () => ({
  goalDetailCommand: (...args: unknown[]) => mockGoalDetailCommand(...args),
}));

const mockGoalAnswerCommand = vi.fn();
vi.mock("../commands/goal-answer.js", () => ({
  goalAnswerCommand: (...args: unknown[]) => mockGoalAnswerCommand(...args),
}));

const mockGoalStopCommand = vi.fn();
vi.mock("../commands/goal-stop.js", () => ({
  goalStopCommand: (...args: unknown[]) => mockGoalStopCommand(...args),
}));

// goal-list.js no longer imported by goal-commands (Telegram uses listRuns directly)

const mockRunCliPlanRevision = vi.fn();
vi.mock("../goal/cli-planner.js", () => ({
  runCliPlanRevision: (...args: unknown[]) => mockRunCliPlanRevision(...args),
}));

const mockRunPlanAutocheck = vi.fn();
vi.mock("../goal/plan-autocheck.js", () => ({
  runPlanAutocheck: (...args: unknown[]) => mockRunPlanAutocheck(...args),
}));

const mockEnsureWorkingDir = vi.fn();
vi.mock("../goal/git-checkpoint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../goal/git-checkpoint.js")>();
  return {
    ...actual,
    ensureWorkingDir: (...args: unknown[]) => mockEnsureWorkingDir(...args),
  };
});

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
  persistRawPlanResponse: vi.fn(),
}));

const mockFormatPlanOutput = vi.fn();
vi.mock("../goal/format-output.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../goal/format-output.js")>();
  return {
    ...actual,
    formatPlanOutput: (...args: unknown[]) => mockFormatPlanOutput(...args),
  };
});

const mockRenderMermaidToPng = vi.fn(() => ({ buffer: Buffer.from("png") }));
const mockRepairMermaidDiagram = vi.fn(async () => null);
vi.mock("../goal/mermaid-png.js", () => ({
  renderMermaidToPng: (...args: unknown[]) => mockRenderMermaidToPng(...args),
  repairMermaidDiagram: (...args: unknown[]) => mockRepairMermaidDiagram(...args),
}));

const mockRunCliProcess = vi.fn();
vi.mock("../goal/cli-process.js", () => ({
  runCliProcess: (...args: unknown[]) => mockRunCliProcess(...args),
}));

const mockResolveClaudeBinary = vi.fn(() => "claude");
vi.mock("../goal/scout.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../goal/scout.js")>();
  return {
    ...actual,
    resolveClaudeBinary: () => mockResolveClaudeBinary(),
  };
});

const mockBuildClaudeCodeEnv = vi.fn(() => ({ CLAUDE_CODE_ENTRYPOINT: "mock" }));
vi.mock("../goal/claude-code-env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../goal/claude-code-env.js")>();
  return {
    ...actual,
    buildClaudeCodeEnv: (...args: unknown[]) => mockBuildClaudeCodeEnv(...args),
  };
});

const mockGetCodexAskForApprovalPlacement = vi.fn(() => "before_exec");
vi.mock("../goal/backend-availability.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../goal/backend-availability.js")>();
  return {
    ...actual,
    getCodexAskForApprovalPlacement: (...args: unknown[]) =>
      mockGetCodexAskForApprovalPlacement(...args),
  };
});

const mockResolveChannelConfigWrites = vi.fn(() => true);
vi.mock("../channels/plugins/config-writes.js", () => ({
  resolveChannelConfigWrites: (...args: unknown[]) => mockResolveChannelConfigWrites(...args),
}));

const mockLoadConfig = vi.fn(() => ({}));
vi.mock("../config/config.js", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

const mockWriteConfigFile = vi.fn(async () => undefined);
vi.mock("../config/io.js", () => ({
  writeConfigFile: (...args: unknown[]) => mockWriteConfigFile(...args),
}));

const mockResolveTelegramCommandAuth = vi.fn();
vi.mock("./telegram-auth.js", () => ({
  resolveTelegramCommandAuth: (...args: unknown[]) => mockResolveTelegramCommandAuth(...args),
}));

function normalizeRunShortSummaries(run: SerializedRun): SerializedRun {
  if (!run.plan) return run;
  return {
    ...run,
    plan: {
      ...run.plan,
      shortSummary: run.plan.shortSummary || run.plan.summary || run.goal,
      steps: run.plan.steps.map((step) => ({
        ...step,
        shortSummary: step.shortSummary || step.description || step.id,
      })),
    },
  };
}

function saveRunFixture(run: SerializedRun): void {
  saveRun(normalizeRunShortSummaries(run));
}

function makeRun(overrides: Partial<SerializedRun> = {}): SerializedRun {
  return normalizeRunShortSummaries({
    runId: "test-run-id-1234",
    goal: "Test goal",
    state: "awaiting_approval",
    plan: {
      goal: "Test goal",
      workingDir: "/tmp/ws",
      summary: "A test plan",
      shortSummary: "A test plan",
      steps: [
        {
          id: "1",
          description: "Step one",
          shortSummary: "Step one",
          dependsOn: [],
          status: "pending",
          durationMinutes: 1,
        },
      ],
    },
    stepResults: {},
    blocked: null,
    answers: {},
    workingDir: "/tmp/ws",
    model: undefined,
    dryRun: false,
    createdAt: "2026-01-30T00:00:00.000Z",
    updatedAt: "2026-01-30T00:00:00.000Z",
    telegramDoneMessage: overrides.telegramDoneMessage,
    telegramFeedbackPromptMessages: overrides.telegramFeedbackPromptMessages,
    ...overrides,
  });
}

describe("goal-commands telegram adapter", () => {
  beforeEach(() => {
    testGoalsDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-tg-test-"));
    vi.clearAllMocks();
    mockRenderMermaidToPng.mockReturnValue({ buffer: Buffer.from("png") });
    mockRepairMermaidDiagram.mockResolvedValue(null);
    mockRunCliProcess.mockResolvedValue({
      stdout: "",
      stderr: "",
      timedOut: false,
      exitCode: 0,
      signal: null,
      durationMs: 1,
    });
    mockResolveClaudeBinary.mockReturnValue("claude");
    mockBuildClaudeCodeEnv.mockReturnValue({ CLAUDE_CODE_ENTRYPOINT: "mock" });
    mockGetCodexAskForApprovalPlacement.mockReturnValue("before_exec");
    mockResolveChannelConfigWrites.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({});
    mockWriteConfigFile.mockResolvedValue(undefined);
    mockResolveTelegramCommandAuth.mockResolvedValue({
      chatId: 42,
      isGroup: false,
      isForum: false,
      senderId: "42",
      senderUsername: "tester",
      commandAuthorized: true,
    });
  });

  afterEach(() => {
    resetMessageIndex();
    fs.rmSync(testGoalsDir, { recursive: true, force: true });
  });

  describe("createCaptureRuntime", () => {
    it("captures log and error output", async () => {
      const { createCaptureRuntime } = await import("./goal-commands.js");
      const cap = createCaptureRuntime();
      cap.runtime.log("hello", "world");
      cap.runtime.error("oops");
      expect(cap.getLogs()).toBe("hello world");
      expect(cap.getErrors()).toBe("oops");
    });

    it("exit throws RuntimeExitError", async () => {
      const { createCaptureRuntime } = await import("./goal-commands.js");
      const cap = createCaptureRuntime();
      expect(() => cap.runtime.exit(1)).toThrow("exit 1");
    });
  });

  describe("handleGoal", () => {
    it("returns usage on empty text", async () => {
      const { handleGoal } = await import("./goal-commands.js");
      const result = await handleGoal("");
      expect(result.text).toContain("Usage:");
    });

    it("creates a plan-only run and returns GoalPlanResult", async () => {
      mockGoalCommand.mockImplementation(
        async (_opts: unknown, runtime: { log: (...args: unknown[]) => void }) => {
          runtime.log("## Plan\n1. Do something");
          return undefined; // planOnly returns undefined on success
        },
      );

      const { handleGoal } = await import("./goal-commands.js");
      const result = await handleGoal("Build a website");

      expect(mockGoalCommand).toHaveBeenCalledOnce();
      const callArgs = mockGoalCommand.mock.calls[0][0];
      expect(callArgs.goal).toBe("Build a website");
      expect(callArgs.planOnly).toBe(true);
      expect(callArgs.diagram).toBe("none");
      expect(callArgs.runId).toBeDefined();

      expect(result.text).toContain("## Plan");
      expect(result.text).toContain("Run ID:");
      expect(result.runId).toBeDefined();
      expect(result.revision).toBe(1);
      expect(result.blocked).toBeUndefined();
    });

    it("runs autocheck in handleGoal when enabled and persists autocheck session metadata", async () => {
      let createdRunId = "";
      const autocheckPlan = {
        goal: "Test goal",
        workingDir: "/tmp/ws",
        summary: "Autochecked plan",
        steps: [
          {
            id: "1",
            description: "Autochecked step",
            dependsOn: [],
            status: "pending",
            durationMinutes: 1,
            backend: "codex",
          },
        ],
      } as const;

      mockGoalCommand.mockImplementation(
        async (opts: { runId: string }, runtime: { log: (...args: unknown[]) => void }) => {
          createdRunId = opts.runId;
          saveRunFixture(makeRun({ runId: opts.runId, state: "planning" }));
          runtime.log("## Plan\n1. Do something");
          return undefined;
        },
      );
      mockRunPlanAutocheck.mockImplementation(async () => {
        expect(loadRun(createdRunId, testGoalsDir)?.state).toBe("planning");
        return {
          plan: autocheckPlan,
          autocheckRounds: 1,
          autocheckMaxRounds: 3,
          approved: true,
          exhausted: false,
          sessionId: "autocheck-session-1",
          backend: "codex",
        };
      });

      const { handleGoal } = await import("./goal-commands.js");
      const result = await handleGoal("Build a website", {
        goal: { planAutocheck: "codex" },
      } as never);

      expect(mockGoalCommand).toHaveBeenCalledOnce();
      expect(mockRunPlanAutocheck).toHaveBeenCalledOnce();
      expect(mockGoalCommand.mock.invocationCallOrder[0]).toBeLessThan(
        mockRunPlanAutocheck.mock.invocationCallOrder[0],
      );
      const goalCommandOpts = mockGoalCommand.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(goalCommandOpts).not.toHaveProperty("planAutocheck");

      expect(mockRunPlanAutocheck).toHaveBeenCalledWith(
        expect.objectContaining({
          existingSessionId: undefined,
          existingBackend: undefined,
          mode: "codex",
        }),
      );

      const persisted = loadRun(result.runId!, testGoalsDir);
      expect(persisted?.autocheckRounds).toBe(1);
      expect(persisted?.autocheckMaxRounds).toBe(3);
      expect(persisted?.autocheckBackend).toBe("codex");
      expect(persisted?.autocheckSessionId).toBe("autocheck-session-1");
      expect(persisted?.state).toBe("awaiting_approval");
    });

    it("marks autocheck as skipped in handleGoal when autocheck throws", async () => {
      mockGoalCommand.mockImplementation(
        async (opts: { runId: string }, runtime: { log: (...args: unknown[]) => void }) => {
          saveRunFixture(makeRun({ runId: opts.runId, state: "planning" }));
          runtime.log("## Plan\n1. Do something");
          return undefined;
        },
      );
      mockRunPlanAutocheck.mockRejectedValue(new Error("autocheck failed"));

      const { handleGoal } = await import("./goal-commands.js");
      const result = await handleGoal("Build a website", {
        goal: { planAutocheck: "codex" },
      } as never);

      expect(mockRunPlanAutocheck).toHaveBeenCalledOnce();
      expect(result.autocheckSkipped).toBe(true);
      const persisted = loadRun(result.runId!, testGoalsDir);
      expect(persisted?.state).toBe("awaiting_approval");
    });

    it("skips autocheck in handleGoal when planAutocheck is off", async () => {
      mockGoalCommand.mockImplementation(
        async (opts: { runId: string }, runtime: { log: (...args: unknown[]) => void }) => {
          saveRunFixture(makeRun({ runId: opts.runId, state: "planning" }));
          runtime.log("## Plan\n1. Do something");
          return undefined;
        },
      );

      const { handleGoal } = await import("./goal-commands.js");
      const result = await handleGoal("Build a website", {
        goal: { planAutocheck: "off" },
      } as never);

      expect(result.runId).toBeDefined();
      expect(mockRunPlanAutocheck).not.toHaveBeenCalled();
      const persisted = loadRun(result.runId!, testGoalsDir);
      expect(persisted?.state).toBe("awaiting_approval");
    });

    it("handles blocked-at-planning outcome", async () => {
      mockGoalCommand.mockImplementation(
        async (_opts: unknown, runtime: { log: (...args: unknown[]) => void }) => {
          runtime.log("BLOCKED: What database?");
          return { status: "blocked", question: "What database?", requiredInputKey: "db_type" };
        },
      );

      const { handleGoal } = await import("./goal-commands.js");
      const result = await handleGoal("Setup database");

      expect(result.text).toContain("BLOCKED");
      expect(result.text).toContain("/goal_answer");
      expect(result.blocked).toBe(true);
      expect(result.runId).toBeDefined();
    });

    it("returns stopped message when planning run is externally cancelled", async () => {
      let createdRunId = "";
      const runStoreModule = await import("../goal/run-store.js");
      const saveRunSpy = vi.spyOn(runStoreModule, "saveRun");
      mockGoalCommand.mockImplementation(
        async (opts: { runId: string }, runtime: { log: (...args: unknown[]) => void }) => {
          createdRunId = opts.runId;
          saveRunFixture(makeRun({ runId: opts.runId, state: "planning" }));
          saveRunFixture(makeRun({ runId: opts.runId, state: "cancelled" }));
          runtime.log("## Plan\n1. Do something");
          return { status: "cancelled" };
        },
      );

      const { handleGoal } = await import("./goal-commands.js");
      const result = await handleGoal("Build a website", {
        goal: { planAutocheck: "codex" },
      } as never);

      expect(result.text).toBe("Goal was stopped.");
      expect(result.runId).toBe(createdRunId);
      expect(result.plan).toBeUndefined();
      expect(result.stepResults).toBeUndefined();
      expect(mockRunPlanAutocheck).not.toHaveBeenCalled();
      const persistedWrites = saveRunSpy.mock.calls.map(([run]) => run as SerializedRun);
      expect(
        persistedWrites.some(
          (run) => run.runId === createdRunId && run.state === "awaiting_approval",
        ),
      ).toBe(false);
      const persisted = loadRun(createdRunId, testGoalsDir);
      expect(persisted?.state).toBe("cancelled");
      saveRunSpy.mockRestore();
    });

    it("handles error from goalCommand", async () => {
      mockGoalCommand.mockRejectedValue(new Error("API key missing"));

      const { handleGoal } = await import("./goal-commands.js");
      const result = await handleGoal("Do something");

      expect(result.text).toMatch(/Planning failed:/);
      expect(result.text).toContain("API key missing");
      expect(result.runId).toBeUndefined();
    });
  });

  describe("handleGoalApprove", () => {
    it("returns usage on empty input", async () => {
      const { handleGoalApprove } = await import("./goal-commands.js");
      const result = await handleGoalApprove("");
      expect(result).toContain("Usage:");
    });

    it("returns error for unknown run", async () => {
      const { handleGoalApprove } = await import("./goal-commands.js");
      const result = await handleGoalApprove("nonexistent");
      expect(result).toContain("Run not found");
    });

    it("executes an approved run and returns short ack (quiet mode)", async () => {
      saveRunFixture(makeRun());
      mockGoalResumeCommand.mockImplementation(
        async (_id: unknown, _opts: unknown, _runtime: unknown) => {
          return { status: "done", summary: "All steps completed." };
        },
      );

      const { handleGoalApprove } = await import("./goal-commands.js");
      const result = await handleGoalApprove("test-run");

      expect(mockGoalResumeCommand).toHaveBeenCalledOnce();
      const opts = mockGoalResumeCommand.mock.calls[0][1] as Record<string, unknown>;
      expect(opts.yes).toBe(true);
      expect(opts.quiet).toBe(true);
      // Returns short ack, not transcript
      expect(result).toContain("Executing:");
      expect(result).toContain("test-run");
    });

    it("surfaces blocked outcome to user instead of swallowing it", async () => {
      saveRunFixture(makeRun());
      mockGoalResumeCommand.mockImplementation(
        async (_id: unknown, _opts: unknown, _runtime: unknown) => {
          return { status: "blocked", question: "Need credentials", requiredInputKey: "creds" };
        },
      );

      const { handleGoalApprove } = await import("./goal-commands.js");
      const result = await handleGoalApprove("test-run");
      expect(typeof result).toBe("string");
      expect(result).toContain("Run blocked:");
      expect(result).toContain("Need credentials");
    });

    it("returns no-op for already done run", async () => {
      saveRunFixture(makeRun({ state: "done" }));

      const { handleGoalApprove } = await import("./goal-commands.js");
      const result = await handleGoalApprove("test-run");
      expect(result).toContain("already complete");
      expect(mockGoalResumeCommand).not.toHaveBeenCalled();
    });

    it("attempts resume for executing runs", async () => {
      saveRunFixture(makeRun({ state: "executing" }));
      mockGoalResumeCommand.mockResolvedValue({
        status: "blocked",
        question: "Need credentials",
        requiredInputKey: "task:1:input",
      });

      const { handleGoalApprove } = await import("./goal-commands.js");
      const result = await handleGoalApprove("test-run");
      expect(result).toContain("Run blocked:");
      expect(mockGoalResumeCommand).toHaveBeenCalledOnce();
    });

    it("returns undefined when onStatusChange is provided (no stray message)", async () => {
      saveRunFixture(makeRun());
      mockGoalResumeCommand.mockResolvedValue({ status: "done", summary: "Done." });

      const { handleGoalApprove } = await import("./goal-commands.js");
      const statusCb = vi.fn();
      const result = await handleGoalApprove("test-run", statusCb);

      expect(result).toBeUndefined();
      expect(mockGoalResumeCommand).toHaveBeenCalledOnce();
      const opts = mockGoalResumeCommand.mock.calls[0][1] as Record<string, unknown>;
      expect(typeof opts.onStatusChange).toBe("function");
    });

    it("returns undefined when blocked update was already sent via onStatusChange", async () => {
      saveRunFixture(makeRun());
      mockGoalResumeCommand.mockImplementation(async (_id: unknown, opts: unknown) => {
        const onStatusChange = (opts as { onStatusChange?: (event: unknown) => Promise<void> })
          .onStatusChange;
        await onStatusChange?.({
          type: "fully_blocked",
          steps: makeRun().plan?.steps ?? [],
        });
        return {
          status: "blocked",
          question: "Out of credits",
          requiredInputKey: "billing",
          blockedAt: "execution",
        };
      });

      const { handleGoalApprove } = await import("./goal-commands.js");
      const statusCb = vi.fn();
      const result = await handleGoalApprove("test-run", statusCb);

      expect(result).toBeUndefined();
      expect(statusCb).toHaveBeenCalledWith(expect.objectContaining({ type: "fully_blocked" }));
    });

    it("returns blocked message when no blocked status update was sent", async () => {
      saveRunFixture(makeRun());
      mockGoalResumeCommand.mockResolvedValue({
        status: "blocked",
        question: "Out of credits",
        requiredInputKey: "billing",
        blockedAt: "execution",
      });

      const { handleGoalApprove } = await import("./goal-commands.js");
      const statusCb = vi.fn();
      const result = await handleGoalApprove("test-run", statusCb);

      expect(result).toContain("Run blocked:");
      expect(result).toContain("Out of credits");
    });

    it("returns cancelled message when onStatusChange is provided", async () => {
      saveRunFixture(makeRun());
      mockGoalResumeCommand.mockResolvedValue({ status: "cancelled" });

      const { handleGoalApprove } = await import("./goal-commands.js");
      const statusCb = vi.fn();
      const result = await handleGoalApprove("test-run", statusCb);

      expect(result).toContain("Run cancelled.");
    });

    it("still returns error strings even when onStatusChange is provided", async () => {
      const { handleGoalApprove } = await import("./goal-commands.js");
      const statusCb = vi.fn();
      const result = await handleGoalApprove("nonexistent", statusCb);
      expect(result).toContain("Run not found");
    });
  });

  describe("handleGoalReject", () => {
    it("returns usage on empty input", async () => {
      const { handleGoalReject } = await import("./goal-commands.js");
      const result = await handleGoalReject("");
      expect(result).toContain("Usage:");
    });

    it("cancels an awaiting_approval run", async () => {
      saveRunFixture(makeRun({ state: "awaiting_approval" }));

      const { handleGoalReject } = await import("./goal-commands.js");
      const result = await handleGoalReject("test-run");

      expect(result).toContain("rejected");
      const run = loadRun("test-run-id-1234", testGoalsDir);
      expect(run).toBeDefined();
      expect(run!.state).toBe("cancelled");
    });

    it("refuses to reject a non-awaiting_approval run", async () => {
      saveRunFixture(makeRun({ state: "done" }));

      const { handleGoalReject } = await import("./goal-commands.js");
      const result = await handleGoalReject("test-run");
      expect(result).toContain("Cannot reject");
      expect(result).toContain("done");
    });

    it("returns no-op for already cancelled run", async () => {
      saveRunFixture(makeRun({ state: "cancelled" }));

      const { handleGoalReject } = await import("./goal-commands.js");
      const result = await handleGoalReject("test-run");
      expect(result).toContain("already cancelled");
    });

    it("returns error for unknown run", async () => {
      const { handleGoalReject } = await import("./goal-commands.js");
      const result = await handleGoalReject("nonexistent");
      expect(result).toContain("Run not found");
    });
  });

  describe("handleGoalStatus", () => {
    it("returns usage on empty input", async () => {
      const { handleGoalStatus } = await import("./goal-commands.js");
      const result = await handleGoalStatus("");
      expect(result).toContain("Usage:");
    });

    it("returns status output", async () => {
      mockGoalStatusCommand.mockImplementation(
        async (_id: unknown, _opts: unknown, runtime: { log: (...args: unknown[]) => void }) => {
          runtime.log("Run: abc12345");
          runtime.log("State: done");
        },
      );

      const { handleGoalStatus } = await import("./goal-commands.js");
      const result = await handleGoalStatus("abc12345");
      expect(result).toContain("Run: abc12345");
      expect(result).toContain("State: done");
      expect(mockGoalStatusCommand).toHaveBeenCalledWith(
        "abc12345",
        expect.objectContaining({ diagram: "none", channel: "telegram" }),
        expect.any(Object),
      );
    });
  });

  describe("handleGoalDetail", () => {
    it("returns usage on empty input", async () => {
      const { handleGoalDetail } = await import("./goal-commands.js");
      const result = await handleGoalDetail("");
      expect(result).toContain("Usage:");
    });

    it("returns detail output", async () => {
      mockGoalDetailCommand.mockImplementation(
        async (_id: unknown, _opts: unknown, runtime: { log: (...args: unknown[]) => void }) => {
          runtime.log("Run: abc12345");
          runtime.log("**Steps**");
          runtime.log("- 1. done Build widget");
        },
      );

      const { handleGoalDetail } = await import("./goal-commands.js");
      const result = await handleGoalDetail("abc12345");
      expect(result).toContain("Run: abc12345");
      expect(result).toContain("**Steps**");
      expect(mockGoalDetailCommand).toHaveBeenCalledWith(
        "abc12345",
        expect.objectContaining({ diagram: "none", channel: "telegram" }),
        expect.any(Object),
      );
    });

    it("appends structured task detail sections using short summaries", async () => {
      saveRunFixture(
        makeRun({
          runId: "abc12345-0000-0000-0000-000000000000",
          plan: {
            goal: "Test goal",
            shortSummary: "Ship checkout improvements",
            workingDir: "/tmp/ws",
            summary: "Plan summary",
            steps: [
              {
                id: "step-login",
                shortSummary: "Harden login",
                description: "Validate credential checks. Prevent blank passwords.",
                dependsOn: [],
                status: "pending",
              },
              {
                id: "step-release",
                description: "Ship release candidate",
                dependsOn: ["step-login"],
                status: "pending",
              },
            ],
          },
        }),
      );
      mockGoalDetailCommand.mockImplementation(
        async (_id: unknown, _opts: unknown, runtime: { log: (...args: unknown[]) => void }) => {
          runtime.log("Run: abc12345");
          runtime.log("State: awaiting_approval");
        },
      );

      const { handleGoalDetail } = await import("./goal-commands.js");
      const result = await handleGoalDetail("abc12345");
      expect(result).toContain("**Task 1: Harden login**");
      expect(result).toContain("• Validate credential checks. Prevent blank passwords.");
      expect(result).toContain("**Task 2: Ship release candidate**");
      expect(result).toContain("• Depends on: step-login");
    });
  });

  describe("sendGoalStatusResponse", () => {
    it("sends status as a DAG PNG when the run has a plan", async () => {
      saveRunFixture(makeRun());
      mockGoalStatusCommand.mockImplementation(
        async (_id: unknown, _opts: unknown, runtime: { log: (...args: unknown[]) => void }) => {
          runtime.log("Run: test-run-id-1234");
          runtime.log("State: awaiting_approval");
        },
      );
      mockRenderMermaidToPng.mockReturnValue({ buffer: Buffer.from("png") });

      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 10 });
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 11 });
      const bot = { api: { sendPhoto, sendMessage } } as unknown as import("grammy").Bot;
      const { createCaptureRuntime, sendGoalStatusResponse } = await import("./goal-commands.js");

      await sendGoalStatusResponse({
        bot,
        chatId: 42,
        rawId: "test-run",
        runtime: createCaptureRuntime().runtime,
        replyToMessageId: 77,
      });

      expect(sendPhoto).toHaveBeenCalledOnce();
      expect(sendPhoto).toHaveBeenCalledWith(
        42,
        expect.anything(),
        expect.objectContaining({
          caption: expect.stringContaining("Run: test-run-id-1234"),
          parse_mode: "HTML",
          reply_parameters: { message_id: 77 },
        }),
      );
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("uses blocked notification delivery for blocked runs and persists reply tracking", async () => {
      saveRunFixture(
        makeRun({
          state: "blocked",
          blocked: {
            blockedAt: "execution",
            prompt: "Need a value",
            requiredInputKey: "task:1:input",
            stepId: "1",
          },
          plan: {
            goal: "Test goal",
            workingDir: "/tmp/ws",
            summary: "A test plan",
            shortSummary: "A test plan",
            steps: [
              {
                id: "1",
                description: "Step one",
                shortSummary: "Step one",
                dependsOn: [],
                status: "blocked",
                blockedQuestion: "Need a value",
              },
            ],
          },
        }),
      );
      mockGoalStatusCommand.mockImplementation(
        async (_id: unknown, _opts: unknown, runtime: { log: (...args: unknown[]) => void }) => {
          runtime.log("Run: test-run-id-1234");
          runtime.log("State: blocked");
        },
      );
      mockRenderMermaidToPng.mockReturnValue({ buffer: Buffer.from("png") });

      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 12 });
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 13 });
      const bot = { api: { sendPhoto, sendMessage } } as unknown as import("grammy").Bot;
      const { createCaptureRuntime, sendGoalStatusResponse } = await import("./goal-commands.js");

      await sendGoalStatusResponse({
        bot,
        chatId: 42,
        rawId: "test-run",
        runtime: createCaptureRuntime().runtime,
      });

      expect(sendPhoto).toHaveBeenCalledOnce();
      expect(sendPhoto).toHaveBeenCalledWith(
        42,
        expect.anything(),
        expect.objectContaining({
          caption: expect.stringContaining("<b>TASK BLOCKED</b> (test-run): Step 1 needs input"),
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "✏️ Add Details", callback_data: "gAD:test-run" }],
              [{ text: "⏹️ Stop Goal", callback_data: "gStop:test-run" }],
            ],
          },
        }),
      );
      expect(sendMessage).not.toHaveBeenCalled();
      const run = loadRun("test-run-id-1234", testGoalsDir);
      expect(run?.telegramQuestionMessages?.[0]).toMatchObject({
        chatId: 42,
        messageId: 12,
        requiredInputKey: "task:1:input",
      });
    });

    it("falls back to text when the run has no plan", async () => {
      saveRunFixture(makeRun({ plan: null }));
      mockGoalStatusCommand.mockImplementation(
        async (_id: unknown, _opts: unknown, runtime: { log: (...args: unknown[]) => void }) => {
          runtime.log("Run: test-run-id-1234");
          runtime.log("State: awaiting_approval");
        },
      );

      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 10 });
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 11 });
      const bot = { api: { sendPhoto, sendMessage } } as unknown as import("grammy").Bot;
      const { createCaptureRuntime, sendGoalStatusResponse } = await import("./goal-commands.js");

      await sendGoalStatusResponse({
        bot,
        chatId: 42,
        rawId: "test-run",
        runtime: createCaptureRuntime().runtime,
        replyToMessageId: 78,
      });

      expect(sendPhoto).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledWith(
        42,
        expect.any(String),
        expect.objectContaining({ reply_parameters: { message_id: 78 } }),
      );
    });
  });

  describe("sendGoalDetailResponse", () => {
    it("sends detail as a DAG PNG when the run has a plan", async () => {
      saveRunFixture(makeRun());
      mockGoalDetailCommand.mockImplementation(
        async (_id: unknown, _opts: unknown, runtime: { log: (...args: unknown[]) => void }) => {
          runtime.log("Run: test-run-id-1234");
          runtime.log("**Steps**");
          runtime.log("- 1. pending Step one");
        },
      );
      mockRenderMermaidToPng.mockReturnValue({ buffer: Buffer.from("png") });

      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 10 });
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 11 });
      const bot = { api: { sendPhoto, sendMessage } } as unknown as import("grammy").Bot;
      const { createCaptureRuntime, sendGoalDetailResponse } = await import("./goal-commands.js");

      await sendGoalDetailResponse({
        bot,
        chatId: 42,
        rawId: "test-run",
        runtime: createCaptureRuntime().runtime,
        replyToMessageId: 79,
      });

      expect(sendPhoto).toHaveBeenCalledOnce();
      expect(sendPhoto).toHaveBeenCalledWith(
        42,
        expect.anything(),
        expect.objectContaining({
          caption: expect.stringContaining("<b>Steps</b>"),
          parse_mode: "HTML",
          reply_parameters: { message_id: 79 },
        }),
      );
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("falls back to text when the run has no plan", async () => {
      saveRunFixture(makeRun({ plan: null }));
      mockGoalDetailCommand.mockImplementation(
        async (_id: unknown, _opts: unknown, runtime: { log: (...args: unknown[]) => void }) => {
          runtime.log("Run: test-run-id-1234");
          runtime.log("**Steps**");
          runtime.log("- 1. pending Step one");
        },
      );

      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 10 });
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 11 });
      const bot = { api: { sendPhoto, sendMessage } } as unknown as import("grammy").Bot;
      const { createCaptureRuntime, sendGoalDetailResponse } = await import("./goal-commands.js");

      await sendGoalDetailResponse({
        bot,
        chatId: 42,
        rawId: "test-run",
        runtime: createCaptureRuntime().runtime,
        replyToMessageId: 80,
      });

      expect(sendPhoto).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledWith(
        42,
        expect.any(String),
        expect.objectContaining({ reply_parameters: { message_id: 80 } }),
      );
    });
  });

  describe("buildOnStatusChange", () => {
    it("sends compact all_done captions without redundant DONE prefix", async () => {
      saveRunFixture(
        makeRun({
          state: "done",
          plan: {
            goal: "Test goal",
            workingDir: "/tmp/ws",
            summary: "Done plan",
            steps: [
              {
                id: "1",
                description: "Step one",
                dependsOn: [],
                status: "done",
              },
            ],
          },
        }),
      );

      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 10 });
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 11 });
      const bot = { api: { sendPhoto, sendMessage } } as unknown as import("grammy").Bot;
      const { buildOnStatusChange, createCaptureRuntime } = await import("./goal-commands.js");
      const onStatusChange = buildOnStatusChange({
        bot,
        chatId: 42,
        runtime: createCaptureRuntime().runtime,
        runId: "test-run-id-1234",
      });

      await onStatusChange({
        type: "all_done",
        steps: [
          {
            id: "1",
            description: "Step one",
            dependsOn: [],
            status: "done",
          },
        ],
        summary: "✅ Done: Test goal\n**Progress** 1/1\n**Retries** 0 retries",
      });

      expect(sendPhoto).toHaveBeenCalledOnce();
      const options = sendPhoto.mock.calls[0]?.[2] as {
        caption?: string;
        reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> };
      };
      expect(options.caption).toContain("✅ Done: Test goal");
      expect(options.caption).not.toContain("DONE (test-run)");
      expect(options.reply_markup?.inline_keyboard).toEqual([
        [{ text: "🔍 Test Detail", callback_data: "gTD:test-run" }],
        [{ text: "🔄 Incorporate Feedback", callback_data: "gIF:test-run" }],
      ]);
      const updatedRun = loadRun("test-run-id-1234", testGoalsDir);
      expect(updatedRun?.telegramDoneMessage).toEqual({
        chatId: 42,
        messageId: 10,
        threadId: undefined,
      });
    });

    it("builds done-message inline keyboard callbacks", async () => {
      const { buildGoalDoneInlineKeyboard } = await import("./goal-commands.js");
      expect(buildGoalDoneInlineKeyboard("abc12345")).toEqual({
        inline_keyboard: [
          [{ text: "🔍 Test Detail", callback_data: "gTD:abc12345" }],
          [{ text: "🔄 Incorporate Feedback", callback_data: "gIF:abc12345" }],
        ],
      });
    });

    it("persists manual tests when all_done includes suggestions", async () => {
      saveRunFixture(
        makeRun({
          state: "done",
          plan: {
            goal: "Test goal",
            workingDir: "/tmp/ws",
            summary: "Done plan",
            steps: [
              {
                id: "1",
                description: "Step one",
                dependsOn: [],
                status: "done",
              },
            ],
          },
        }),
      );
      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 21 });
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 22 });
      const bot = { api: { sendPhoto, sendMessage } } as unknown as import("grammy").Bot;
      const { buildOnStatusChange, createCaptureRuntime } = await import("./goal-commands.js");
      const onStatusChange = buildOnStatusChange({
        bot,
        chatId: 42,
        runtime: createCaptureRuntime().runtime,
        runId: "test-run-id-1234",
      });

      await onStatusChange({
        type: "all_done",
        steps: [
          {
            id: "1",
            description: "Step one",
            dependsOn: [],
            status: "done",
          },
        ],
        summary: "✅ Done: Test goal",
        manualTests: [
          {
            description: "Run smoke test",
            criticality: 8,
            detail: "Confirm main flow succeeds.",
          },
        ],
      });

      const run = loadRun("test-run-id-1234", testGoalsDir);
      expect(run?.manualTests?.[0]?.description).toBe("Run smoke test");
      expect(run?.telegramDoneMessage?.messageId).toBe(21);
    });

    it("persists an empty manual test array when all_done includes manualTests: []", async () => {
      saveRunFixture(
        makeRun({
          state: "done",
          manualTestsError: "old auth error",
          plan: {
            goal: "Test goal",
            workingDir: "/tmp/ws",
            summary: "Done plan",
            steps: [
              {
                id: "1",
                description: "Step one",
                dependsOn: [],
                status: "done",
              },
            ],
          },
        }),
      );
      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 31 });
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 32 });
      const bot = { api: { sendPhoto, sendMessage } } as unknown as import("grammy").Bot;
      const { buildOnStatusChange, createCaptureRuntime } = await import("./goal-commands.js");
      const onStatusChange = buildOnStatusChange({
        bot,
        chatId: 42,
        runtime: createCaptureRuntime().runtime,
        runId: "test-run-id-1234",
      });

      await onStatusChange({
        type: "all_done",
        steps: [
          {
            id: "1",
            description: "Step one",
            dependsOn: [],
            status: "done",
          },
        ],
        summary: "✅ Done: Test goal",
        manualTests: [],
      });

      const run = loadRun("test-run-id-1234", testGoalsDir);
      expect(run?.manualTests).toEqual([]);
      expect(run?.manualTestsError).toBeUndefined();
      expect(run?.telegramDoneMessage?.messageId).toBe(31);
    });

    it("persists manual-test generation errors when suggestions are unavailable", async () => {
      saveRunFixture(
        makeRun({
          state: "done",
          plan: {
            goal: "Test goal",
            workingDir: "/tmp/ws",
            summary: "Done plan",
            steps: [
              {
                id: "1",
                description: "Step one",
                dependsOn: [],
                status: "done",
              },
            ],
          },
        }),
      );
      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 23 });
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 24 });
      const bot = { api: { sendPhoto, sendMessage } } as unknown as import("grammy").Bot;
      const { buildOnStatusChange, createCaptureRuntime } = await import("./goal-commands.js");
      const onStatusChange = buildOnStatusChange({
        bot,
        chatId: 42,
        runtime: createCaptureRuntime().runtime,
        runId: "test-run-id-1234",
      });

      await onStatusChange({
        type: "all_done",
        steps: [
          {
            id: "1",
            description: "Step one",
            dependsOn: [],
            status: "done",
          },
        ],
        summary: "✅ Done: Test goal",
        manualTestsError: "HTTP 401: invalid x-api-key",
      });

      const run = loadRun("test-run-id-1234", testGoalsDir);
      expect(run?.manualTests).toBeUndefined();
      expect(run?.manualTestsError).toBe("HTTP 401: invalid x-api-key");
      expect(run?.telegramDoneMessage?.messageId).toBe(23);
      const options = sendPhoto.mock.calls[0]?.[2] as { caption?: string };
      expect(options.caption).toContain("Note: Manual test generation failed.");
    });

    it("sends step_blocked updates with bold caption and add-details+stop keyboard", async () => {
      saveRunFixture(makeRun());

      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 40 });
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 41 });
      const bot = { api: { sendPhoto, sendMessage } } as unknown as import("grammy").Bot;
      const { buildOnStatusChange, createCaptureRuntime } = await import("./goal-commands.js");
      const onStatusChange = buildOnStatusChange({
        bot,
        chatId: 42,
        runtime: createCaptureRuntime().runtime,
        runId: "test-run-id-1234",
      });

      await onStatusChange({
        type: "step_blocked",
        stepId: "1",
        question: [
          "Task 1 reached the ralph limit (2/2).",
          "",
          "**Ralph 1 (attempt 1):**",
          "• **Approach tried:** First attempt",
          "• **Errors:** Controlled failure",
          "• **Key insight:** Need another attempt",
          "• **Suggested approach:** Retry once more",
          "",
          "**Ralph 2 (attempt 2):**",
          "• **Approach tried:** Second attempt",
          "• **Errors:** Controlled second failure",
          "• **Key insight:** Limit reached",
          "• **Suggested approach:** Resume with guidance",
        ].join("\n"),
        steps: [
          {
            id: "1",
            description: "Step one",
            dependsOn: [],
            status: "blocked",
            blockedQuestion: "Need a value",
          },
        ],
      });

      expect(sendPhoto).toHaveBeenCalledOnce();
      const options = sendPhoto.mock.calls[0]?.[2] as {
        caption?: string;
        reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> };
      };
      expect(options.caption).toContain("<b>TASK BLOCKED</b> (test-run): Step 1 needs input");
      expect(options.caption).toContain("• Step 1: Need a value");
      expect(options.reply_markup?.inline_keyboard).toEqual([
        [{ text: "✏️ Add Details", callback_data: "gAD:test-run" }],
        [{ text: "⏹️ Stop Goal", callback_data: "gStop:test-run" }],
      ]);
      expect(options.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data).toMatch(/^gAD:/);
      const buttonTexts =
        options.reply_markup?.inline_keyboard?.flat().map((button) => button.text) ?? [];
      expect(buttonTexts).not.toContain("▶️ Resume Goal");
    });

    it("sends fully_blocked updates with bold caption and add-details+resume+stop keyboard", async () => {
      saveRunFixture(makeRun());

      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 42 });
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 43 });
      const bot = { api: { sendPhoto, sendMessage } } as unknown as import("grammy").Bot;
      const { buildOnStatusChange, createCaptureRuntime } = await import("./goal-commands.js");
      const onStatusChange = buildOnStatusChange({
        bot,
        chatId: 42,
        runtime: createCaptureRuntime().runtime,
        runId: "test-run-id-1234",
      });

      await onStatusChange({
        type: "fully_blocked",
        steps: [
          {
            id: "1",
            description: "Step one",
            dependsOn: [],
            status: "blocked",
            blockedQuestion: "Need a value",
          },
        ],
      });

      expect(sendPhoto).toHaveBeenCalledOnce();
      const options = sendPhoto.mock.calls[0]?.[2] as {
        caption?: string;
        reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> };
      };
      expect(options.caption).toContain("<b>GOAL BLOCKED</b> (test-run): no runnable steps");
      expect(options.caption).not.toContain("Next:");
      expect(options.reply_markup?.inline_keyboard).toEqual([
        [{ text: "✏️ Add Details", callback_data: "gAD:test-run" }],
        [
          { text: "▶️ Resume Goal", callback_data: "gResume:test-run" },
          { text: "⏹️ Stop Goal", callback_data: "gStop:test-run" },
        ],
      ]);
      expect(options.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data).toMatch(/^gAD:/);
    });

    it.each([
      {
        eventType: "step_blocked",
        expectedFallbackText: "<b>TASK BLOCKED</b> (test-run): Step 1 needs input",
        event: {
          type: "step_blocked",
          stepId: "1",
          question: "Need a value",
          steps: [
            {
              id: "1",
              description: "Step one",
              dependsOn: [],
              status: "blocked",
              blockedQuestion: "Need a value",
            },
          ],
        },
      },
      {
        eventType: "fully_blocked",
        expectedFallbackText: "<b>GOAL BLOCKED</b> (test-run): no runnable steps",
        event: {
          type: "fully_blocked",
          steps: [
            {
              id: "1",
              description: "Step one",
              dependsOn: [],
              status: "blocked",
              blockedQuestion: "Need a value",
            },
          ],
        },
      },
      {
        eventType: "plan_revised",
        expectedFallbackText: "plan_revised",
        event: {
          type: "plan_revised",
          revision: 2,
          summary: "Plan revised summary",
          steps: [
            {
              id: "1",
              description: "Step one",
              dependsOn: [],
              status: "pending",
            },
          ],
        },
      },
      {
        eventType: "all_done",
        expectedFallbackText: "all_done",
        event: {
          type: "all_done",
          summary: "Done summary",
          steps: [
            {
              id: "1",
              description: "Step one",
              dependsOn: [],
              status: "done",
            },
          ],
        },
      },
    ])(
      "swallows DAG exceptions and posts fallback text for $eventType status updates",
      async ({ event, expectedFallbackText }) => {
        saveRunFixture(makeRun());
        mockRenderMermaidToPng.mockImplementationOnce(() => {
          throw new Error("render failed");
        });

        const sendPhoto = vi.fn().mockResolvedValue({ message_id: 30 });
        const sendMessage = vi.fn().mockResolvedValue({ message_id: 31 });
        const bot = { api: { sendPhoto, sendMessage } } as unknown as import("grammy").Bot;
        const { buildOnStatusChange, createCaptureRuntime } = await import("./goal-commands.js");
        const onStatusChange = buildOnStatusChange({
          bot,
          chatId: 42,
          runtime: createCaptureRuntime().runtime,
          runId: "test-run-id-1234",
        });

        await expect(onStatusChange(event as never)).resolves.toBeUndefined();

        expect(sendPhoto).not.toHaveBeenCalled();
        expect(sendMessage).toHaveBeenCalledTimes(1);
        const fallbackText = sendMessage.mock.calls[0]?.[1];
        expect(typeof fallbackText).toBe("string");
        expect(fallbackText).toContain(expectedFallbackText);
        expect(fallbackText).toContain("test-run");
      },
    );
  });

  describe("sendGoalPlanResult", () => {
    it("uses bold caption labels and plan short summary when available", async () => {
      const plan = {
        goal: "Test goal",
        shortSummary: "Ship secure checkout",
        workingDir: "/tmp/ws",
        summary: "Long plan summary that should not be preferred in captions",
        steps: [
          {
            id: "1",
            description: "Step one",
            dependsOn: [],
            status: "pending",
            durationMinutes: 1,
            backend: "claude_code",
          },
        ],
      } as const;

      saveRunFixture(makeRun({ plan }));

      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 88 });
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 89 });
      const bot = { api: { sendPhoto, sendMessage } } as unknown as import("grammy").Bot;
      const { createCaptureRuntime, sendGoalPlanResult } = await import("./goal-commands.js");

      await sendGoalPlanResult({
        bot,
        chatId: 42,
        runtime: createCaptureRuntime().runtime,
        result: {
          text: "ignored when PNG send succeeds",
          runId: "test-run-id-1234",
          revision: 1,
          plan,
          stepResults: new Map(),
        },
      });

      expect(sendPhoto).toHaveBeenCalledOnce();
      const options = sendPhoto.mock.calls[0]?.[2] as { caption?: string };
      expect(options.caption).toContain("<b>Goal ID:</b> test-run");
      expect(options.caption).toContain("<b>Working dir:</b> /tmp/ws");
      expect(options.caption).toContain("<b>Workers:</b> Claude Code");
      expect(options.caption).toContain("<b>Plan:</b> Ship secure checkout");
      expect(options.caption).not.toContain("Long plan summary");
    });

    it("includes planner fallback notice with reset hint in plan caption", async () => {
      const degradedPlan = {
        goal: "Test goal",
        workingDir: "/tmp/ws",
        summary: "A degraded test plan",
        steps: [
          {
            id: "1",
            description: "Step one",
            dependsOn: [],
            status: "pending",
            durationMinutes: 1,
            backend: "codex",
          },
        ],
      } as const;

      saveRunFixture(
        makeRun({
          plan: degradedPlan,
          plannerBackendUsed: "codex",
          plannerDegradedReason: "anthropic_usage_limit",
          plannerDegradedResetHint: "resets 6pm (America/Toronto)",
        }),
      );

      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 101 });
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 102 });
      const bot = { api: { sendPhoto, sendMessage } } as unknown as import("grammy").Bot;
      const { createCaptureRuntime, sendGoalPlanResult } = await import("./goal-commands.js");

      await sendGoalPlanResult({
        bot,
        chatId: 42,
        runtime: createCaptureRuntime().runtime,
        result: {
          text: "ignored when PNG send succeeds",
          runId: "test-run-id-1234",
          revision: 1,
          plan: degradedPlan,
          stepResults: new Map(),
        },
      });

      expect(sendPhoto).toHaveBeenCalledOnce();
      const options = sendPhoto.mock.calls[0]?.[2] as { caption?: string };
      expect(options.caption).toContain("<b>Planner notice:</b> Anthropic usage limit");
      expect(options.caption).toContain("resets 6pm (America/Toronto)");
      expect(options.caption).toContain("Codex");
    });

    it("shows replanned count and max-round warning in plan caption", async () => {
      const plan = {
        goal: "Test goal",
        workingDir: "/tmp/ws",
        summary: "Plan with autocheck loops",
        steps: [
          {
            id: "1",
            description: "Step one",
            dependsOn: [],
            status: "pending",
            durationMinutes: 1,
            backend: "claude_code",
          },
        ],
      } as const;

      saveRunFixture(makeRun({ plan }));

      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 201 });
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 202 });
      const bot = { api: { sendPhoto, sendMessage } } as unknown as import("grammy").Bot;
      const { createCaptureRuntime, sendGoalPlanResult } = await import("./goal-commands.js");

      await sendGoalPlanResult({
        bot,
        chatId: 42,
        runtime: createCaptureRuntime().runtime,
        result: {
          text: "ignored when PNG send succeeds",
          runId: "test-run-id-1234",
          revision: 3,
          plan,
          stepResults: new Map(),
          autocheckRounds: 3,
          autocheckMaxRounds: 3,
          autocheckExhausted: true,
        },
      });

      expect(sendPhoto).toHaveBeenCalledOnce();
      const options = sendPhoto.mock.calls[0]?.[2] as { caption?: string };
      expect(options.caption).toContain("<b>Replanned:</b> 3/3");
      expect(options.caption).toContain("<b>Autocheck warning:</b> hit max rounds (3/3)");
    });

    it("shows a notice in the plan caption when autocheck was skipped", async () => {
      const plan = {
        goal: "Test goal",
        workingDir: "/tmp/ws",
        summary: "Plan where autocheck failed",
        steps: [
          {
            id: "1",
            description: "Step one",
            dependsOn: [],
            status: "pending",
            durationMinutes: 1,
            backend: "codex",
          },
        ],
      } as const;

      saveRunFixture(makeRun({ plan }));

      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 211 });
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 212 });
      const bot = { api: { sendPhoto, sendMessage } } as unknown as import("grammy").Bot;
      const { createCaptureRuntime, sendGoalPlanResult } = await import("./goal-commands.js");

      await sendGoalPlanResult({
        bot,
        chatId: 42,
        runtime: createCaptureRuntime().runtime,
        result: {
          text: "ignored when PNG send succeeds",
          runId: "test-run-id-1234",
          revision: 1,
          plan,
          stepResults: new Map(),
          autocheckSkipped: true,
        },
      });

      expect(sendPhoto).toHaveBeenCalledOnce();
      const options = sendPhoto.mock.calls[0]?.[2] as { caption?: string };
      expect(options.caption).toContain("Note: Plan autocheck was skipped due to an error.");
    });

    it("threads reply parameters when PNG plan delivery succeeds", async () => {
      const plan = makeRun().plan!;
      saveRunFixture(makeRun({ plan }));

      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 301 });
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 302 });
      const bot = { api: { sendPhoto, sendMessage } } as unknown as import("grammy").Bot;
      const { createCaptureRuntime, sendGoalPlanResult } = await import("./goal-commands.js");

      await sendGoalPlanResult({
        bot,
        chatId: 42,
        runtime: createCaptureRuntime().runtime,
        replyToMessageId: 77,
        result: {
          text: "ignored when PNG send succeeds",
          runId: "test-run-id-1234",
          revision: 1,
          plan,
          stepResults: new Map(),
        },
      });

      expect(sendPhoto).toHaveBeenCalledOnce();
      const options = sendPhoto.mock.calls[0]?.[2] as {
        reply_parameters?: { message_id: number };
      };
      expect(options.reply_parameters).toEqual({ message_id: 77 });
    });

    it("threads reply parameters when DAG send falls back to text", async () => {
      const plan = makeRun().plan!;
      saveRunFixture(makeRun({ plan }));
      mockRenderMermaidToPng.mockReturnValueOnce(null);

      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 401 });
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 402 });
      const bot = { api: { sendPhoto, sendMessage } } as unknown as import("grammy").Bot;
      const { createCaptureRuntime, sendGoalPlanResult } = await import("./goal-commands.js");

      await sendGoalPlanResult({
        bot,
        chatId: 42,
        runtime: createCaptureRuntime().runtime,
        replyToMessageId: 78,
        result: {
          text: "ignored when text fallback succeeds",
          runId: "test-run-id-1234",
          revision: 1,
          plan,
          stepResults: new Map(),
        },
      });

      expect(sendPhoto).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalled();
      const options = sendMessage.mock.calls[0]?.[2] as {
        reply_parameters?: { message_id: number };
      };
      expect(options.reply_parameters).toEqual({ message_id: 78 });
      expect(mockRepairMermaidDiagram).not.toHaveBeenCalled();
    });

    it("repairs Mermaid render errors with the run's codex planner backend", async () => {
      const plan = makeRun().plan!;
      saveRunFixture(makeRun({ plan, plannerBackendUsed: "codex" }));
      mockRenderMermaidToPng.mockReturnValueOnce({ error: "Parse error" });
      mockRepairMermaidDiagram.mockImplementationOnce(async (args: unknown) => {
        const { askFn } = args as { askFn: (prompt: string) => Promise<string> };
        await askFn("repair prompt");
        return Buffer.from("repaired-png");
      });
      mockRunCliProcess.mockResolvedValueOnce({
        stdout: "```mermaid\nflowchart TD\nA-->B\n```",
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 1,
      });

      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 451 });
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 452 });
      const bot = { api: { sendPhoto, sendMessage } } as unknown as import("grammy").Bot;
      const { createCaptureRuntime, sendGoalPlanResult } = await import("./goal-commands.js");

      await sendGoalPlanResult({
        bot,
        chatId: 42,
        runtime: createCaptureRuntime().runtime,
        result: {
          text: "ignored when repair succeeds",
          runId: "test-run-id-1234",
          revision: 1,
          plan,
          stepResults: new Map(),
        },
      });

      expect(mockRepairMermaidDiagram).toHaveBeenCalledOnce();
      expect(mockRunCliProcess).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "codex",
          cwd: "/tmp/ws",
          args: expect.arrayContaining(["exec", "repair prompt"]),
        }),
      );
      expect(sendPhoto).toHaveBeenCalledOnce();
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("uses claude planner backend for Mermaid repair prompts", async () => {
      const plan = makeRun().plan!;
      saveRunFixture(makeRun({ plan, plannerBackendUsed: "claude_code" }));
      mockRenderMermaidToPng.mockReturnValueOnce({ error: "Render failed" });
      mockResolveClaudeBinary.mockReturnValueOnce("/usr/local/bin/claude");
      mockBuildClaudeCodeEnv.mockReturnValueOnce({ CLAUDE_CODE_ENTRYPOINT: "from-test" });
      mockRepairMermaidDiagram.mockImplementationOnce(async (args: unknown) => {
        const { askFn } = args as { askFn: (prompt: string) => Promise<string> };
        await askFn("repair prompt");
        return Buffer.from("repaired-png");
      });
      mockRunCliProcess.mockResolvedValueOnce({
        stdout: "```mermaid\nflowchart TD\nA-->B\n```",
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 1,
      });

      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 461 });
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 462 });
      const bot = { api: { sendPhoto, sendMessage } } as unknown as import("grammy").Bot;
      const { createCaptureRuntime, sendGoalPlanResult } = await import("./goal-commands.js");

      await sendGoalPlanResult({
        bot,
        chatId: 42,
        runtime: createCaptureRuntime().runtime,
        result: {
          text: "ignored when repair succeeds",
          runId: "test-run-id-1234",
          revision: 1,
          plan,
          stepResults: new Map(),
        },
      });

      expect(mockBuildClaudeCodeEnv).toHaveBeenCalledWith("subscription");
      expect(mockRunCliProcess).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "/usr/local/bin/claude",
          cwd: "/tmp/ws",
          stdin: "repair prompt",
          args: expect.arrayContaining(["-p", "--allowedTools", "Read,Glob,Grep,Bash"]),
          env: { CLAUDE_CODE_ENTRYPOINT: "from-test" },
        }),
      );
      expect(sendPhoto).toHaveBeenCalledOnce();
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("falls through to keyboarded text when Mermaid repair fails", async () => {
      const plan = makeRun().plan!;
      saveRunFixture(makeRun({ plan, plannerBackendUsed: "codex" }));
      mockRenderMermaidToPng.mockReturnValueOnce({ error: "Parse error" });
      mockRepairMermaidDiagram.mockResolvedValueOnce(null);

      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 471 });
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 472 });
      const bot = { api: { sendPhoto, sendMessage } } as unknown as import("grammy").Bot;
      const { createCaptureRuntime, sendGoalPlanResult } = await import("./goal-commands.js");

      await sendGoalPlanResult({
        bot,
        chatId: 42,
        runtime: createCaptureRuntime().runtime,
        result: {
          text: "ignored when text fallback succeeds",
          runId: "test-run-id-1234",
          revision: 1,
          plan,
          stepResults: new Map(),
        },
      });

      expect(sendPhoto).not.toHaveBeenCalled();
      const sendMessageOptions = sendMessage.mock.calls[0]?.[2] as {
        reply_markup?: unknown;
      };
      expect(sendMessageOptions.reply_markup).toBeDefined();
    });

    it("threads reply parameters when sendGoalPlanMessage fallback is used", async () => {
      const plan = makeRun().plan!;
      saveRunFixture(makeRun({ plan }));

      const sendPhoto = vi.fn().mockRejectedValue(new Error("photo failed"));
      const sendMessage = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ message_id: 502 });
      const bot = { api: { sendPhoto, sendMessage } } as unknown as import("grammy").Bot;
      const { createCaptureRuntime, sendGoalPlanResult } = await import("./goal-commands.js");

      await sendGoalPlanResult({
        bot,
        chatId: 42,
        runtime: createCaptureRuntime().runtime,
        replyToMessageId: 79,
        result: {
          text: "ignored when sendGoalPlanMessage fallback succeeds",
          runId: "test-run-id-1234",
          revision: 1,
          plan,
          stepResults: new Map(),
        },
      });

      expect(sendPhoto).toHaveBeenCalledOnce();
      expect(sendMessage).toHaveBeenCalledTimes(2);
      const options = sendMessage.mock.calls[1]?.[2] as {
        reply_parameters?: { message_id: number };
      };
      expect(options.reply_parameters).toEqual({ message_id: 79 });
    });

    it("threads reply parameters when plan delivery reaches minimal fallback", async () => {
      const plan = makeRun().plan!;
      saveRunFixture(makeRun({ plan }));

      const sendPhoto = vi.fn().mockRejectedValue(new Error("photo failed"));
      const sendMessage = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("html failed"))
        .mockRejectedValueOnce(new Error("text failed"))
        .mockResolvedValueOnce({ message_id: 603 });
      const bot = { api: { sendPhoto, sendMessage } } as unknown as import("grammy").Bot;
      const { createCaptureRuntime, sendGoalPlanResult } = await import("./goal-commands.js");

      await sendGoalPlanResult({
        bot,
        chatId: 42,
        runtime: createCaptureRuntime().runtime,
        replyToMessageId: 80,
        result: {
          text: "ignored when minimal fallback is used",
          runId: "test-run-id-1234",
          revision: 1,
          plan,
          stepResults: new Map(),
        },
      });

      expect(sendPhoto).toHaveBeenCalledOnce();
      const finalCall = sendMessage.mock.calls.at(-1);
      expect(finalCall?.[1]).toContain("Plan ready for review");
      const options = finalCall?.[2] as {
        reply_parameters?: { message_id: number };
        reply_markup?: unknown;
      };
      expect(options.reply_parameters).toEqual({ message_id: 80 });
      expect(options.reply_markup).toBeDefined();
    });
  });

  describe("sendGoalBackgroundResult", () => {
    it("forwards replyToMessageId on string replies", async () => {
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 901 });
      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 902 });
      const bot = { api: { sendMessage, sendPhoto } } as unknown as import("grammy").Bot;
      const { createCaptureRuntime, sendGoalBackgroundResult } = await import("./goal-commands.js");

      await sendGoalBackgroundResult(
        {
          bot,
          chatId: 42,
          runtime: createCaptureRuntime().runtime,
          replyToMessageId: 77,
        },
        "Background status",
      );

      expect(sendPhoto).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledWith(
        42,
        "Background status",
        expect.objectContaining({ reply_parameters: { message_id: 77 } }),
      );
    });

    it("forwards replyToMessageId on GoalPlanResult replies", async () => {
      const runId = "abcdef12-3456-7890-abcd-ef1234567890";
      const plan = makeRun({ runId }).plan!;
      saveRunFixture(makeRun({ runId, plan }));

      const sendMessage = vi.fn().mockResolvedValue({ message_id: 903 });
      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 904 });
      const bot = { api: { sendMessage, sendPhoto } } as unknown as import("grammy").Bot;
      const { createCaptureRuntime, sendGoalBackgroundResult } = await import("./goal-commands.js");

      await sendGoalBackgroundResult(
        {
          bot,
          chatId: 42,
          runtime: createCaptureRuntime().runtime,
          replyToMessageId: 78,
        },
        {
          text: "ignored when plan renders",
          runId,
          revision: 1,
          plan,
          stepResults: new Map(),
        },
      );

      expect(sendPhoto).toHaveBeenCalledOnce();
      const sendPhotoOpts = sendPhoto.mock.calls[0]?.[2] as {
        reply_parameters?: { message_id: number };
      };
      expect(sendPhotoOpts.reply_parameters).toEqual({ message_id: 78 });
    });

    it("skips delivery when reply is undefined or null", async () => {
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 905 });
      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 906 });
      const bot = { api: { sendMessage, sendPhoto } } as unknown as import("grammy").Bot;
      const { createCaptureRuntime, sendGoalBackgroundResult } = await import("./goal-commands.js");
      const params = {
        bot,
        chatId: 42,
        runtime: createCaptureRuntime().runtime,
        replyToMessageId: 79,
      };

      await sendGoalBackgroundResult(params, undefined);
      await sendGoalBackgroundResult(params, null as unknown as string);

      expect(sendPhoto).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
    });
  });

  describe("handleGoalAnswer", () => {
    it("returns usage on empty input", async () => {
      const { handleGoalAnswer } = await import("./goal-commands.js");
      const result = await handleGoalAnswer("", "");
      expect(result).toContain("Usage:");
    });

    it("auto-resolves key, passes quiet:true, and returns short ack", async () => {
      saveRunFixture(
        makeRun({
          state: "blocked",
          blocked: {
            blockedAt: "execution",
            prompt: "What password?",
            requiredInputKey: "db_password",
          },
        }),
      );

      mockGoalAnswerCommand.mockImplementation(
        async (_id: unknown, _opts: unknown, _runtime: unknown) => {
          return { status: "done", summary: "All steps completed." };
        },
      );

      const { handleGoalAnswer } = await import("./goal-commands.js");
      const result = await handleGoalAnswer("test-run", "s3cret");

      expect(mockGoalAnswerCommand).toHaveBeenCalledOnce();
      const [id, opts] = mockGoalAnswerCommand.mock.calls[0];
      expect(id).toBe("test-run-id-1234");
      expect(opts.key).toBe("db_password");
      expect(opts.value).toBe("s3cret");
      expect(opts.quiet).toBe(true);
      // Returns short ack, not captured logs
      const text = typeof result === "string" ? result : (result as { text: string }).text;
      expect(text).toContain("Resuming:");
    });

    it("returns error for non-blocked run", async () => {
      saveRunFixture(makeRun({ state: "done", blocked: null }));

      const { handleGoalAnswer } = await import("./goal-commands.js");
      const result = await handleGoalAnswer("test-run", "val");
      expect(result).toContain("not awaiting input");
    });

    it("treats non-blocked 'resume' answers as an explicit resume request", async () => {
      saveRunFixture(makeRun({ state: "cancelled", blocked: null }));
      mockGoalResumeCommand.mockResolvedValue({ status: "done", summary: "All steps completed." });

      const { handleGoalAnswer } = await import("./goal-commands.js");
      const result = await handleGoalAnswer("test-run", "resume");

      expect(mockGoalResumeCommand).toHaveBeenCalledOnce();
      expect(typeof result).toBe("string");
      expect(result).toContain("Executing:");
    });

    it("returns error for unknown run", async () => {
      const { handleGoalAnswer } = await import("./goal-commands.js");
      const result = await handleGoalAnswer("nonexistent", "val");
      expect(result).toContain("Run not found");
    });

    it("auto-resumes execution after answering a blocked run (short ack)", async () => {
      saveRunFixture(
        makeRun({
          state: "blocked",
          blocked: {
            blockedAt: "execution",
            prompt: "What password?",
            requiredInputKey: "task:1:input",
          },
        }),
      );

      mockGoalAnswerCommand.mockImplementation(
        async (_id: unknown, _opts: unknown, _runtime: unknown) => {
          return { status: "done", summary: "All steps completed." };
        },
      );

      const { handleGoalAnswer } = await import("./goal-commands.js");
      const result = await handleGoalAnswer("test-run", "s3cret");

      expect(mockGoalAnswerCommand).toHaveBeenCalledOnce();
      const text = typeof result === "string" ? result : (result as { text: string }).text;
      expect(text).toContain("Resuming:");
      expect(text).not.toContain("/goal_approve");
    });

    it("returns short ack when auto-resume results in blocked again", async () => {
      saveRunFixture(
        makeRun({
          state: "blocked",
          blocked: {
            blockedAt: "execution",
            prompt: "What password?",
            requiredInputKey: "task:1:input",
          },
        }),
      );

      mockGoalAnswerCommand.mockImplementation(
        async (_id: unknown, _opts: unknown, _runtime: unknown) => {
          return {
            status: "blocked",
            question: "Need more info",
            requiredInputKey: "task:1:input",
          };
        },
      );

      const { handleGoalAnswer } = await import("./goal-commands.js");
      const result = await handleGoalAnswer("test-run", "s3cret");

      // Surfaces the blocked question so the user can answer
      expect(typeof result).toBe("string");
      expect(result).toContain("Still blocked: Need more info");
      expect(result).toContain("/goal_answer");
    });

    it("returns GoalPlanResult with runId and blocked when replanning still needs info", async () => {
      saveRunFixture(
        makeRun({
          state: "blocked",
          blocked: {
            blockedAt: "planning",
            prompt: "Which DB?",
            requiredInputKey: "step:planning:input",
          },
        }),
      );

      mockGoalAnswerCommand.mockResolvedValue(undefined);
      mockGoalResumeCommand.mockResolvedValue({
        status: "blocked",
        question: "PostgreSQL or MySQL?",
        requiredInputKey: "step:planning:input",
        blockedAt: "planning",
      });

      const { handleGoalAnswer } = await import("./goal-commands.js");
      const result = await handleGoalAnswer("test-run", "postgres");

      expect(mockGoalAnswerCommand).toHaveBeenCalledOnce();
      expect(mockGoalResumeCommand).toHaveBeenCalledOnce();
      expect(typeof result).not.toBe("string");
      expect(result).toHaveProperty("runId", "test-run-id-1234");
      expect(result).toHaveProperty("blocked", true);
      expect((result as { text: string }).text).toContain("Still need more info");
      expect((result as { text: string }).text).toContain("PostgreSQL or MySQL?");
    });

    it("returns undefined when onStatusChange is provided (blocked path, no stray message)", async () => {
      saveRunFixture(
        makeRun({
          state: "blocked",
          blocked: {
            blockedAt: "execution",
            prompt: "What password?",
            requiredInputKey: "task:1:input",
          },
        }),
      );
      mockGoalAnswerCommand.mockResolvedValue({ status: "done", summary: "All done." });

      const { handleGoalAnswer } = await import("./goal-commands.js");
      const statusCb = vi.fn();
      const result = await handleGoalAnswer("test-run", "s3cret", statusCb);

      expect(result).toBeUndefined();
      expect(mockGoalAnswerCommand).toHaveBeenCalledOnce();
      const opts = mockGoalAnswerCommand.mock.calls[0][1] as Record<string, unknown>;
      expect(typeof opts.onStatusChange).toBe("function");
    });

    it("suppresses duplicate blocked reply when resume emitted fully_blocked event", async () => {
      saveRunFixture(
        makeRun({
          state: "blocked",
          blocked: {
            blockedAt: "execution",
            prompt:
              "Run was interrupted (gateway restart or process exit). Use goal resume to continue.",
            requiredInputKey: "resume_execution",
          },
        }),
      );
      mockGoalAnswerCommand.mockImplementation(async (_id: unknown, opts: unknown) => {
        const onStatusChange = (opts as { onStatusChange?: (event: unknown) => Promise<void> })
          .onStatusChange;
        await onStatusChange?.({
          type: "fully_blocked",
          steps: makeRun().plan?.steps ?? [],
        });
        return {
          status: "blocked",
          question: "Need credentials",
          requiredInputKey: "task:1:input",
          blockedAt: "execution",
        };
      });

      const { handleGoalAnswer } = await import("./goal-commands.js");
      const statusCb = vi.fn();
      const result = await handleGoalAnswer("test-run", "resume", statusCb);

      expect(result).toBeUndefined();
      expect(mockGoalAnswerCommand).toHaveBeenCalledOnce();
      expect(statusCb).toHaveBeenCalledWith(expect.objectContaining({ type: "fully_blocked" }));
    });

    it("returns blocked reply when resume blocks before status callback emits", async () => {
      saveRunFixture(
        makeRun({
          state: "blocked",
          blocked: {
            blockedAt: "execution",
            prompt:
              "Run was interrupted (gateway restart or process exit). Use goal resume to continue.",
            requiredInputKey: "resume_execution",
          },
        }),
      );
      mockGoalAnswerCommand.mockResolvedValue({
        status: "blocked",
        question: "Need credentials",
        requiredInputKey: "task:1:input",
        blockedAt: "execution",
      });

      const { handleGoalAnswer } = await import("./goal-commands.js");
      const statusCb = vi.fn();
      const result = await handleGoalAnswer("test-run", "resume", statusCb);

      expect(mockGoalAnswerCommand).toHaveBeenCalledOnce();
      expect(result).toContain("Still blocked: Need credentials");
    });

    it("still returns error strings even when onStatusChange is provided (answer path)", async () => {
      const { handleGoalAnswer } = await import("./goal-commands.js");
      const statusCb = vi.fn();
      const result = await handleGoalAnswer("nonexistent", "val", statusCb);
      expect(result).toContain("Run not found");
    });
  });

  describe("handleGoalList", () => {
    it("returns formatted code block with runs", async () => {
      saveRunFixture(
        makeRun({
          runId: "abc12345-dead-beef-0000-000000000000",
          goal: "Build website",
          state: "done",
        }),
      );

      const { handleGoalList } = await import("./goal-commands.js");
      const result = await handleGoalList();
      expect(result).toContain("```");
      expect(result).toContain("abc12345");
      expect(result).toContain("done");
      expect(result).toContain("Build website");
    });

    it("returns no runs message when empty", async () => {
      const { handleGoalList } = await import("./goal-commands.js");
      const result = await handleGoalList();
      expect(result).toContain("No goal runs found.");
    });
  });

  describe("handleGoalFeedback", () => {
    it("replans a done run, preserves completed steps, transitions to executing, and auto-resumes", async () => {
      saveRunFixture(
        makeRun({
          state: "done",
          plan: {
            goal: "Test goal",
            workingDir: "/tmp/ws",
            summary: "Completed plan",
            steps: [
              {
                id: "1",
                description: "Initial implementation",
                dependsOn: [],
                status: "done",
              },
              {
                id: "2",
                description: "Ship release",
                dependsOn: ["1"],
                status: "done",
              },
            ],
          },
          stepResults: {
            "1": { stepId: "1", success: true, output: "done", durationMs: 1000 },
            "2": { stepId: "2", success: true, output: "done", durationMs: 2000 },
          },
        }),
      );

      mockRunCliPlanRevision.mockResolvedValue({
        plan: {
          goal: "Test goal",
          workingDir: "/tmp/ws",
          summary: "Feedback revised plan",
          steps: [
            {
              id: "1",
              description: "Planner changed description",
              dependsOn: [],
              status: "pending",
            },
            {
              id: "3",
              description: "Fix regression from manual test",
              dependsOn: ["2", "missing"],
              status: "pending",
            },
          ],
        },
      });

      mockGoalResumeCommand.mockImplementation(
        async (runId: string, opts: Record<string, unknown>) => {
          const runAtResume = loadRun(runId, testGoalsDir);
          expect(runAtResume?.state).toBe("executing");
          expect(runAtResume?.plan?.steps.map((step) => step.id)).toEqual(["1", "2", "3"]);
          expect(runAtResume?.plan?.steps.find((step) => step.id === "1")?.description).toBe(
            "Initial implementation",
          );
          expect(runAtResume?.plan?.steps.find((step) => step.id === "3")?.dependsOn).toEqual([
            "2",
          ]);
          expect(runAtResume?.stepResults["1"]?.success).toBe(true);
          expect(runAtResume?.stepResults["2"]?.success).toBe(true);
          expect(opts.allowDoneStateResume).toBe(true);
          expect(typeof opts.onStatusChange).toBe("function");
          return { status: "done", summary: "Done after feedback" };
        },
      );

      const { handleGoalFeedback } = await import("./goal-commands.js");
      const statusCb = vi.fn(async () => undefined);
      const result = await handleGoalFeedback(
        "test-run",
        "Manual test failed on release build",
        {},
        statusCb,
      );

      expect(result).toBeUndefined();
      expect(mockRunCliPlanRevision).toHaveBeenCalledOnce();
      expect(mockRunCliPlanRevision.mock.calls[0]?.[0]).toMatchObject({
        runId: "test-run-id-1234",
        goalText: "Test goal",
        cwd: "/tmp/ws",
      });
      expect(String(mockRunCliPlanRevision.mock.calls[0]?.[0]?.editInstructions ?? "")).toContain(
        "Manual test failed on release build",
      );
      expect(statusCb).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "plan_revised",
        }),
      );
      const updated = loadRun("test-run-id-1234", testGoalsDir);
      expect(updated?.planRevision).toBe(2);
      expect(updated?.activePlanRevision).toBe(2);
      expect(updated?.planHistory).toHaveLength(1);
    });

    it("retries feedback replanning with subscription auth after api_key auth failure", async () => {
      saveRunFixture(
        makeRun({
          state: "done",
          plan: {
            goal: "Test goal",
            workingDir: "/tmp/ws",
            summary: "Completed plan",
            steps: [
              {
                id: "1",
                description: "Initial implementation",
                dependsOn: [],
                status: "done",
              },
            ],
          },
          stepResults: {
            "1": { stepId: "1", success: true, output: "done", durationMs: 1000 },
          },
        }),
      );

      mockRunCliPlanRevision
        .mockRejectedValueOnce(new Error("HTTP 401: authentication_error: invalid x-api-key"))
        .mockResolvedValueOnce({
          plan: {
            goal: "Test goal",
            workingDir: "/tmp/ws",
            summary: "Feedback revised plan",
            steps: [
              {
                id: "1",
                description: "Planner changed description",
                dependsOn: [],
                status: "pending",
              },
            ],
          },
        });

      const { handleGoalFeedback } = await import("./goal-commands.js");
      const result = await handleGoalFeedback("test-run", "Fix the manual test failure", {
        goal: { claudeCodeAuth: "api_key" },
      } as never);

      expect(result).toBe("No new execution steps were required for test-run.");
      expect(mockRunCliPlanRevision).toHaveBeenCalledTimes(2);
      expect(mockRunCliPlanRevision.mock.calls[0]?.[0]).toMatchObject({
        claudeCodeAuth: "api_key",
      });
      expect(mockRunCliPlanRevision.mock.calls[1]?.[0]).toMatchObject({
        claudeCodeAuth: "subscription",
      });
    });

    it("emits all_done summary with short headline and Goal ID footer when no new steps are needed", async () => {
      saveRunFixture(
        makeRun({
          goal: "Very long goal that should not be used as the compact done headline",
          state: "done",
          plan: {
            goal: "Very long goal that should not be used as the compact done headline",
            shortSummary: "Ship login reliability fixes",
            workingDir: "/tmp/ws",
            summary: "Completed plan",
            steps: [
              {
                id: "1",
                shortSummary: "Harden login checks",
                description: "Initial implementation",
                dependsOn: [],
                status: "done",
              },
            ],
          },
          stepResults: {
            "1": { stepId: "1", success: true, output: "done", durationMs: 1000 },
          },
        }),
      );

      mockRunCliPlanRevision.mockResolvedValue({
        plan: {
          goal: "Very long goal that should not be used as the compact done headline",
          shortSummary: "Ship login reliability fixes",
          workingDir: "/tmp/ws",
          summary: "Feedback revised plan",
          steps: [
            {
              id: "1",
              shortSummary: "Harden login checks",
              description: "Planner changed description",
              dependsOn: [],
              status: "pending",
            },
          ],
        },
      });

      const { handleGoalFeedback } = await import("./goal-commands.js");
      const statusCb = vi.fn(async () => undefined);
      const result = await handleGoalFeedback("test-run", "No further fixes needed", {}, statusCb);

      expect(result).toBeUndefined();
      const allDoneCall = statusCb.mock.calls.find(
        ([event]) => (event as { type?: string }).type === "all_done",
      );
      expect(allDoneCall).toBeDefined();
      const allDoneEvent = allDoneCall?.[0] as { summary: string };
      expect(allDoneEvent.summary).toContain("✅ Done: Ship login reliability fixes");
      expect(allDoneEvent.summary).not.toContain(
        "✅ Done: Very long goal that should not be used as the compact done headline",
      );
      expect(allDoneEvent.summary).toContain("Note: Manual test generation failed.");
      const summaryLines = allDoneEvent.summary.trim().split("\n");
      expect(summaryLines.at(-1)).toBe("**Goal ID:** test-run");
    });

    it("syncs workingDir from feedback revisions and ensures new directories", async () => {
      const originalWorkingDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-feedback-wd-old-"));
      const revisedWorkingDir = path.join(
        os.tmpdir(),
        `goal-feedback-wd-new-${Date.now().toString(36)}`,
      );
      fs.rmSync(revisedWorkingDir, { recursive: true, force: true });
      saveRunFixture(
        makeRun({
          state: "done",
          workingDir: originalWorkingDir,
          plan: {
            goal: "Test goal",
            workingDir: originalWorkingDir,
            summary: "Completed plan",
            steps: [
              {
                id: "1",
                description: "Initial implementation",
                dependsOn: [],
                status: "done",
              },
            ],
          },
          stepResults: {
            "1": { stepId: "1", success: true, output: "done", durationMs: 1000 },
          },
        }),
      );

      mockRunCliPlanRevision.mockResolvedValue({
        plan: {
          goal: "Test goal",
          workingDir: revisedWorkingDir,
          summary: "Feedback revised plan",
          steps: [
            {
              id: "1",
              description: "Initial implementation",
              dependsOn: [],
              status: "pending",
            },
            {
              id: "2",
              description: "Fix reported issue",
              dependsOn: ["1"],
              status: "pending",
            },
          ],
        },
      });
      mockGoalResumeCommand.mockResolvedValue({
        status: "done",
        summary: "Done after feedback",
      });

      const { handleGoalFeedback } = await import("./goal-commands.js");
      const result = await handleGoalFeedback("test-run", "Address manual test feedback");

      expect(result).toContain("Incorporating feedback:");
      expect(mockEnsureWorkingDir).toHaveBeenCalledWith(revisedWorkingDir);
      const updated = loadRun("test-run-id-1234", testGoalsDir);
      expect(updated?.workingDir).toBe(revisedWorkingDir);
      expect(updated?.plan?.workingDir).toBe(revisedWorkingDir);
    });
  });

  describe("handleGoalEdit", () => {
    it("returns usage on empty input", async () => {
      const { handleGoalEdit } = await import("./goal-commands.js");
      const result = await handleGoalEdit("", "");
      expect(result.text).toContain("Usage:");
    });

    it("creates a revision", async () => {
      saveRunFixture(makeRun());

      const revisedPlan = {
        goal: "Test goal",
        workingDir: "/tmp/ws",
        summary: "Revised plan",
        steps: [
          {
            id: "1",
            description: "Step one",
            dependsOn: [],
            status: "pending",
            durationMinutes: 1,
          },
          {
            id: "2",
            description: "Add README",
            dependsOn: ["1"],
            status: "pending",
            durationMinutes: 1,
          },
        ],
      };
      mockRunCliPlanRevision.mockResolvedValue({ plan: revisedPlan });
      mockFormatPlanOutput.mockReturnValue("## Revised Plan\n1. Step one\n2. Add README");

      const { handleGoalEdit } = await import("./goal-commands.js");
      const result = await handleGoalEdit("test-run", "add a README step");

      expect(result.text).toContain("Revision 2");
      expect(result.text).toContain("Revised Plan");
      expect(result.runId).toBe("test-run-id-1234");
      expect(result.revision).toBe(2);

      // Verify run was updated
      const run = loadRun("test-run-id-1234", testGoalsDir);
      expect(run).toBeDefined();
      expect(run!.planRevision).toBe(2);
      expect(run!.activePlanRevision).toBe(2);
      expect(run!.planHistory).toHaveLength(1);
      expect(run!.planHistory![0].revision).toBe(1);
      expect(run!.planHistory![0].editInstructions).toBe("add a README step");

      // Verify CLI revision was called with run.goal
      expect(mockRunCliPlanRevision).toHaveBeenCalledOnce();
      expect(mockRunCliPlanRevision.mock.calls[0]?.[0]).toMatchObject({
        runId: "test-run-id-1234",
        goalText: "Test goal",
        cwd: "/tmp/ws",
      });
    });

    it("syncs run workingDir when revised plan changes it", async () => {
      const originalWorkingDir = "/tmp/original-working-dir";
      const revisedWorkingDir = "/tmp/revised-working-dir";
      saveRunFixture(makeRun({ workingDir: originalWorkingDir }));

      mockRunCliPlanRevision.mockResolvedValue({
        plan: {
          goal: "Test goal",
          workingDir: revisedWorkingDir,
          summary: "Revised plan",
          steps: [
            {
              id: "1",
              description: "Step one",
              dependsOn: [],
              status: "pending",
              durationMinutes: 1,
            },
          ],
        },
      });
      mockFormatPlanOutput.mockReturnValue("## Revised Plan\n1. Step one");

      const { handleGoalEdit } = await import("./goal-commands.js");
      await handleGoalEdit("test-run", "adjust scope");

      expect(mockRunCliPlanRevision).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: originalWorkingDir,
        }),
      );
      expect(mockEnsureWorkingDir).toHaveBeenCalledWith(revisedWorkingDir);
      const updatedRun = loadRun("test-run-id-1234", testGoalsDir);
      expect(updatedRun?.workingDir).toBe(revisedWorkingDir);
      expect(updatedRun?.plan?.workingDir).toBe(revisedWorkingDir);
    });

    it("runs autocheck in handleGoalEdit and persists updated session metadata", async () => {
      saveRunFixture(
        makeRun({
          autocheckSessionId: "session-old",
          autocheckBackend: "codex",
        }),
      );

      const revisedPlan = {
        goal: "Test goal",
        workingDir: "/tmp/ws",
        summary: "Revised plan",
        steps: [
          {
            id: "1",
            description: "Step one",
            dependsOn: [],
            status: "pending",
            durationMinutes: 1,
            backend: "claude_code",
          },
        ],
      };
      mockRunCliPlanRevision.mockResolvedValue({ plan: revisedPlan });
      mockRunPlanAutocheck.mockImplementation(async () => {
        expect(loadRun("test-run-id-1234", testGoalsDir)?.state).toBe("planning");
        return {
          plan: revisedPlan,
          autocheckRounds: 2,
          autocheckMaxRounds: 3,
          approved: true,
          exhausted: false,
          sessionId: "session-new",
          backend: "claude_code",
        };
      });
      mockFormatPlanOutput.mockReturnValue("## Revised Plan\n1. Step one");

      const { handleGoalEdit } = await import("./goal-commands.js");
      const result = await handleGoalEdit("test-run", "tighten dependencies", {
        goal: { planAutocheck: "claude_code" },
      } as never);

      expect(result.revision).toBe(2);
      expect(mockRunPlanAutocheck).toHaveBeenCalledOnce();
      expect(mockRunPlanAutocheck).toHaveBeenCalledWith(
        expect.objectContaining({
          existingSessionId: "session-old",
          existingBackend: "codex",
          mode: "claude_code",
        }),
      );

      const run = loadRun("test-run-id-1234", testGoalsDir);
      expect(run?.autocheckRounds).toBe(2);
      expect(run?.autocheckMaxRounds).toBe(3);
      expect(run?.autocheckBackend).toBe("claude_code");
      expect(run?.autocheckSessionId).toBe("session-new");
      expect(run?.state).toBe("awaiting_approval");
    });

    it("marks autocheck as skipped in handleGoalEdit when autocheck throws", async () => {
      saveRunFixture(makeRun());

      mockRunCliPlanRevision.mockResolvedValue({
        plan: {
          goal: "Test goal",
          workingDir: "/tmp/ws",
          summary: "Revised plan",
          steps: [
            {
              id: "1",
              description: "Step one",
              dependsOn: [],
              status: "pending",
              durationMinutes: 1,
            },
          ],
        },
      });
      mockRunPlanAutocheck.mockRejectedValue(new Error("autocheck failed"));
      mockFormatPlanOutput.mockReturnValue("## Revised Plan\n1. Step one");

      const { handleGoalEdit } = await import("./goal-commands.js");
      const result = await handleGoalEdit("test-run", "change it", {
        goal: { planAutocheck: "codex" },
      } as never);

      expect(mockRunPlanAutocheck).toHaveBeenCalledOnce();
      expect(result.autocheckSkipped).toBe(true);
      const run = loadRun("test-run-id-1234", testGoalsDir);
      expect(run?.state).toBe("awaiting_approval");
    });

    it("skips autocheck in handleGoalEdit when planAutocheck is off", async () => {
      saveRunFixture(makeRun());

      mockRunCliPlanRevision.mockResolvedValue({
        plan: {
          goal: "Test goal",
          workingDir: "/tmp/ws",
          summary: "Revised plan",
          steps: [
            {
              id: "1",
              description: "Step one",
              dependsOn: [],
              status: "pending",
              durationMinutes: 1,
            },
          ],
        },
      });
      mockFormatPlanOutput.mockReturnValue("## Revised Plan\n1. Step one");

      const { handleGoalEdit } = await import("./goal-commands.js");
      await handleGoalEdit("test-run", "change it", {
        goal: { planAutocheck: "off" },
      } as never);

      expect(mockRunPlanAutocheck).not.toHaveBeenCalled();
      const run = loadRun("test-run-id-1234", testGoalsDir);
      expect(run?.state).toBe("awaiting_approval");
    });

    it("updates run working dir from explicit edit instructions", async () => {
      const originalDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-edit-wd-old-"));
      const newDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-edit-wd-new-"));
      saveRunFixture(makeRun({ workingDir: originalDir }));

      mockRunCliPlanRevision.mockResolvedValue({
        plan: {
          goal: "Test goal",
          workingDir: newDir,
          summary: "Revised plan",
          steps: [
            {
              id: "1",
              description: "Step one",
              dependsOn: [],
              status: "pending",
              durationMinutes: 1,
            },
          ],
        },
      });
      mockFormatPlanOutput.mockReturnValue("## Revised Plan\n1. Step one");

      const { handleGoalEdit } = await import("./goal-commands.js");
      const result = await handleGoalEdit("test-run", `working dir should be ${newDir}`);

      expect(result.text).toContain("Working dir:");
      expect(result.text).toContain(newDir.replace(os.homedir(), "~"));
      expect(mockRunCliPlanRevision).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: newDir,
        }),
      );
      expect(mockEnsureWorkingDir).toHaveBeenCalledWith(newDir);

      const updated = loadRun("test-run-id-1234", testGoalsDir);
      expect(updated?.workingDir).toBe(newDir);
    });

    it.each(["workingDir: string", "workingDirectory: string"])(
      "does not parse camelCase identifiers as working dir instructions: %s",
      async (instructionText) => {
        const originalDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-edit-wd-camel-"));
        saveRunFixture(makeRun({ workingDir: originalDir }));

        mockRunCliPlanRevision.mockResolvedValue({
          plan: {
            goal: "Test goal",
            workingDir: originalDir,
            summary: "Revised plan",
            steps: [
              {
                id: "1",
                description: "Step one",
                dependsOn: [],
                status: "pending",
                durationMinutes: 1,
              },
            ],
          },
        });
        mockFormatPlanOutput.mockReturnValue("## Revised Plan\n1. Step one");

        const { handleGoalEdit } = await import("./goal-commands.js");
        const result = await handleGoalEdit("test-run", instructionText);

        expect(result.text).not.toContain("Could not resolve working directory");
        expect(mockRunCliPlanRevision).toHaveBeenCalledWith(
          expect.objectContaining({
            cwd: originalDir,
          }),
        );
        expect(mockEnsureWorkingDir).not.toHaveBeenCalled();

        const updated = loadRun("test-run-id-1234", testGoalsDir);
        expect(updated?.workingDir).toBe(originalDir);
      },
    );

    it.each([
      {
        instructionText: "working dir should be /home/user/project",
        expectedDir: "/home/user/project",
      },
      {
        instructionText: "set working directory to /tmp/build",
        expectedDir: "/tmp/build",
      },
      {
        instructionText: "workdir: /opt/app",
        expectedDir: "/opt/app",
      },
      {
        instructionText: "Working Directory: /var/data",
        expectedDir: "/var/data",
      },
    ])("parses supported working dir instruction phrase: $instructionText", async (testCase) => {
      const originalDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-edit-wd-positive-"));
      saveRunFixture(makeRun({ workingDir: originalDir }));

      mockRunCliPlanRevision.mockResolvedValue({
        plan: {
          goal: "Test goal",
          workingDir: testCase.expectedDir,
          summary: "Revised plan",
          steps: [
            {
              id: "1",
              description: "Step one",
              dependsOn: [],
              status: "pending",
              durationMinutes: 1,
            },
          ],
        },
      });
      mockFormatPlanOutput.mockReturnValue("## Revised Plan\n1. Step one");

      const { handleGoalEdit } = await import("./goal-commands.js");
      const result = await handleGoalEdit("test-run", testCase.instructionText);

      expect(result.text).toContain("Working dir:");
      expect(mockRunCliPlanRevision).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: testCase.expectedDir,
        }),
      );
      expect(mockEnsureWorkingDir).toHaveBeenCalledWith(testCase.expectedDir);

      const updated = loadRun("test-run-id-1234", testGoalsDir);
      expect(updated?.workingDir).toBe(testCase.expectedDir);
    });

    async function expectWorkingDirInstructionResolves(
      instructionValue: string,
      resolvedPath: string,
    ): Promise<void> {
      const originalDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-edit-wd-home-old-"));
      fs.rmSync(resolvedPath, { recursive: true, force: true });
      saveRunFixture(makeRun({ workingDir: originalDir }));

      mockRunCliPlanRevision.mockResolvedValue({
        plan: {
          goal: "Test goal",
          workingDir: resolvedPath,
          summary: "Revised plan",
          steps: [
            {
              id: "1",
              description: "Step one",
              dependsOn: [],
              status: "pending",
              durationMinutes: 1,
            },
          ],
        },
      });
      mockFormatPlanOutput.mockReturnValue("## Revised Plan\n1. Step one");

      const { handleGoalEdit } = await import("./goal-commands.js");
      const result = await handleGoalEdit(
        "test-run",
        `working directory should be ${instructionValue}`,
      );

      expect(result.text).toContain("Working dir:");
      expect(mockRunCliPlanRevision).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: resolvedPath,
        }),
      );
      expect(mockEnsureWorkingDir).toHaveBeenCalledWith(resolvedPath);

      const updated = loadRun("test-run-id-1234", testGoalsDir);
      expect(updated?.workingDir).toBe(resolvedPath);
    }

    it("resolves working dir instructions using 'a new folder ~/...'", async () => {
      const projectName = `smithersbot-marketing-${Date.now().toString(36)}`;
      await expectWorkingDirInstructionResolves(
        `a new folder ~/${projectName}`,
        path.join(os.homedir(), projectName),
      );
    });

    it("resolves bare ~name working dir instructions as ~/name", async () => {
      const projectName = `smithersbot-marketing-${Date.now().toString(36)}`;
      await expectWorkingDirInstructionResolves(
        `~${projectName}`,
        path.join(os.homedir(), projectName),
      );
    });

    it("resolves conversational 'a new folder ~name' working dir instructions", async () => {
      const projectName = `smithersbot-marketing-${Date.now().toString(36)}`;
      await expectWorkingDirInstructionResolves(
        `a new folder ~${projectName}`,
        path.join(os.homedir(), projectName),
      );
    });

    it("resolves working dir instructions using 'the directory ~/...'", async () => {
      const projectName = `my-project-${Date.now().toString(36)}`;
      await expectWorkingDirInstructionResolves(
        `the directory ~/${projectName}`,
        path.join(os.homedir(), projectName),
      );
    });

    it("updates run working dir from conversational correction phrasing", async () => {
      const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goal-edit-wd-root-"));
      const originalDir = path.join(workspaceRoot, "moltbot");
      const newDir = path.join(workspaceRoot, "earnlayer-marketing");
      fs.mkdirSync(originalDir, { recursive: true });
      fs.mkdirSync(newDir, { recursive: true });
      saveRunFixture(makeRun({ workingDir: originalDir }));

      mockRunCliPlanRevision.mockResolvedValue({
        plan: {
          goal: "Test goal",
          workingDir: newDir,
          summary: "Revised plan",
          steps: [
            {
              id: "1",
              description: "Step one",
              dependsOn: [],
              status: "pending",
              durationMinutes: 1,
            },
          ],
        },
      });
      mockFormatPlanOutput.mockReturnValue("## Revised Plan\n1. Step one");

      const { handleGoalEdit } = await import("./goal-commands.js");
      const result = await handleGoalEdit(
        "test-run",
        `you still have the Working Dir as ${originalDir} when it should be ${newDir}`,
      );

      expect(result.text).toContain("Working dir:");
      expect(mockRunCliPlanRevision).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: newDir,
        }),
      );

      const updated = loadRun("test-run-id-1234", testGoalsDir);
      expect(updated?.workingDir).toBe(newDir);

      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    it("resolves hyphenless working dir hints to an existing sibling directory", async () => {
      const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goal-edit-wd-fuzzy-"));
      const originalDir = path.join(workspaceRoot, "moltbot");
      const newDir = path.join(workspaceRoot, "earnlayer-marketing");
      fs.mkdirSync(originalDir, { recursive: true });
      fs.mkdirSync(newDir, { recursive: true });
      saveRunFixture(makeRun({ workingDir: originalDir }));

      mockRunCliPlanRevision.mockResolvedValue({
        plan: {
          goal: "Test goal",
          workingDir: newDir,
          summary: "Revised plan",
          steps: [
            {
              id: "1",
              description: "Step one",
              dependsOn: [],
              status: "pending",
              durationMinutes: 1,
            },
          ],
        },
      });
      mockFormatPlanOutput.mockReturnValue("## Revised Plan\n1. Step one");

      const { handleGoalEdit } = await import("./goal-commands.js");
      await handleGoalEdit("test-run", "working dir should be earnlayermarketing");

      expect(mockRunCliPlanRevision).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: newDir,
        }),
      );

      const updated = loadRun("test-run-id-1234", testGoalsDir);
      expect(updated?.workingDir).toBe(newDir);

      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    it("rejects unresolvable relative directory", async () => {
      const existingDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-edit-wd-existing-"));
      saveRunFixture(makeRun({ workingDir: existingDir }));
      const missingRelativePath = `never/exists/${Date.now().toString(36)}`;

      const { handleGoalEdit } = await import("./goal-commands.js");
      const result = await handleGoalEdit(
        "test-run",
        `working directory should be ${missingRelativePath}`,
      );

      expect(result.text).toContain("Could not resolve working directory");
      expect(mockRunCliPlanRevision).not.toHaveBeenCalled();
    });

    it("refuses non-awaiting_approval run", async () => {
      saveRunFixture(makeRun({ state: "done" }));

      const { handleGoalEdit } = await import("./goal-commands.js");
      const result = await handleGoalEdit("test-run", "change it");
      expect(result.text).toContain("Cannot edit");
      expect(result.text).toContain("done");
    });

    it("refuses run without plan", async () => {
      saveRunFixture(makeRun({ plan: null }));

      const { handleGoalEdit } = await import("./goal-commands.js");
      const result = await handleGoalEdit("test-run", "change it");
      expect(result.text).toContain("no plan");
    });

    it("shows fallback notice and persists degraded planner metadata on revision fallback", async () => {
      saveRunFixture(makeRun());
      mockRunCliPlanRevision.mockResolvedValue({
        plan: {
          goal: "Test goal",
          workingDir: "/tmp/ws",
          summary: "Revised with fallback",
          steps: [
            {
              id: "1",
              description: "Step one",
              dependsOn: [],
              status: "pending",
              durationMinutes: 1,
              backend: "claude_code",
            },
          ],
        },
        plannerBackendUsed: "codex",
        plannerDegradedReason: "anthropic_usage_limit",
        plannerDegradedResetHint: "resets 6pm (America/Toronto)",
      });
      mockFormatPlanOutput.mockReturnValue("## Revised Plan\n1. Step one");

      const { handleGoalEdit } = await import("./goal-commands.js");
      const result = await handleGoalEdit("test-run", "change it");

      expect(result.text).toContain("Planner notice: Anthropic usage limit reached");
      expect(result.text).toContain("resets 6pm (America/Toronto)");
      expect(result.text).toContain("Falling back to Codex planning for this run.");

      const run = loadRun("test-run-id-1234", testGoalsDir);
      expect(run?.plannerBackendUsed).toBe("codex");
      expect(run?.plannerDegradedReason).toBe("anthropic_usage_limit");
      expect(run?.plannerDegradedResetHint).toBe("resets 6pm (America/Toronto)");
      expect(run?.plan?.steps[0]?.backend).toBe("claude_code");
    });

    it("returns auth error when revision CLI reports auth failure", async () => {
      saveRunFixture(makeRun());
      mockRunCliPlanRevision.mockRejectedValue(new Error("authentication failed"));

      const { handleGoalEdit } = await import("./goal-commands.js");
      const result = await handleGoalEdit("test-run", "change it");
      expect(result.text).toContain("Authentication failed");
      expect(result.text).not.toContain("API key");
    });

    it("returns error for unknown run", async () => {
      const { handleGoalEdit } = await import("./goal-commands.js");
      const result = await handleGoalEdit("nonexistent", "change it");
      expect(result.text).toContain("Run not found");
    });

    it("handles blocked revision", async () => {
      saveRunFixture(makeRun());
      mockRunCliPlanRevision.mockResolvedValue({
        plan: {
          blocked: true,
          question: "What framework?",
        },
      });

      const { handleGoalEdit } = await import("./goal-commands.js");
      const result = await handleGoalEdit("test-run", "use a framework");
      expect(result.text).toContain("Revision blocked");
      expect(result.text).toContain("What framework?");
      expect(result.blocked).toBe(true);
    });
  });

  describe("registerTelegramGoalCommands /new_goal", () => {
    function makeCommandHarness(
      cfg: Record<string, unknown> = {},
      options: {
        commandFragmentBuffer?: import("./command-fragments.js").CommandFragmentBuffer;
      } = {},
    ): {
      handlers: Record<string, (ctx: unknown) => Promise<void>>;
      sendMessage: ReturnType<typeof vi.fn>;
      sendPhoto: ReturnType<typeof vi.fn>;
      register: () => Promise<void>;
      commandFragmentBuffer?: import("./command-fragments.js").CommandFragmentBuffer;
    } {
      const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 99 });
      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 100 });
      const sendChatAction = vi.fn().mockResolvedValue(true);
      const commandFragmentBuffer = options.commandFragmentBuffer;
      const bot = {
        api: {
          sendMessage,
          sendPhoto,
          sendChatAction,
          answerCallbackQuery: vi.fn(),
          setMessageReaction: vi.fn(),
        },
        command: (name: string | string[], handler: (ctx: unknown) => Promise<void>) => {
          if (Array.isArray(name)) {
            for (const entry of name) handlers[entry] = handler;
            return;
          }
          handlers[name] = handler;
        },
        on: vi.fn(),
      } as unknown as import("grammy").Bot;

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: ((_: number) => {
          throw new Error("exit called");
        }) as never,
      };

      const register = async () => {
        const { registerTelegramGoalCommands } = await import("./goal-commands.js");
        registerTelegramGoalCommands({
          bot,
          cfg: cfg as never,
          runtime,
          accountId: "default",
          telegramCfg: {} as never,
          allowFrom: ["42"],
          groupAllowFrom: [],
          useAccessGroups: false,
          resolveGroupPolicy: () =>
            ({
              allowlistEnabled: false,
              allowed: true,
            }) as never,
          resolveTelegramGroupConfig: () => ({
            groupConfig: undefined,
            topicConfig: undefined,
          }),
          shouldSkipUpdate: () => false,
          textLimit: 4000,
          commandFragmentBuffer,
        });
      };

      return { handlers, sendMessage, sendPhoto, register, commandFragmentBuffer };
    }

    function makeCommandCtx(match: string, messageId: number): Record<string, unknown> {
      return {
        match,
        message: {
          chat: { id: 42, type: "private" },
          from: { id: 42, username: "tester" },
          message_id: messageId,
          date: 123_456,
        },
      };
    }

    async function waitForAssertion(assertion: () => void, timeoutMs = 1500): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        try {
          assertion();
          return;
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    }

    it("allows concurrent planning requests in the same chat", async () => {
      const pendingResolvers: Array<() => void> = [];
      const planningPreface = "Right away, sir.";
      const alreadyPlanningMessage =
        "Already planning a goal in this chat. Please wait for it to finish.";

      mockGoalCommand.mockImplementation(
        async (opts: { runId: string }, runtime: { log: (...args: unknown[]) => void }) => {
          await new Promise<void>((resolve) => {
            pendingResolvers.push(() => {
              saveRunFixture(makeRun({ runId: opts.runId, state: "planning" }));
              runtime.log("## Plan\n1. Do something");
              resolve();
            });
          });
        },
      );

      const harness = makeCommandHarness();
      await harness.register();

      const newGoalHandler = harness.handlers.new_goal;
      expect(newGoalHandler).toBeDefined();

      await Promise.all([
        newGoalHandler!(makeCommandCtx("first goal", 1001)),
        newGoalHandler!(makeCommandCtx("second goal", 1002)),
      ]);

      await waitForAssertion(() => {
        expect(mockGoalCommand).toHaveBeenCalledTimes(2);
      });
      await waitForAssertion(() => {
        const prefaceCalls = harness.sendMessage.mock.calls.filter(
          (call) => call[1] === planningPreface,
        );
        expect(prefaceCalls).toHaveLength(2);
      });
      expect(
        harness.sendMessage.mock.calls.some((call) => call[1] === alreadyPlanningMessage),
      ).toBe(false);

      await waitForAssertion(() => {
        expect(pendingResolvers).toHaveLength(2);
      });
      pendingResolvers.forEach((resolve) => resolve());
      await waitForAssertion(() => {
        expect(harness.sendPhoto).toHaveBeenCalledTimes(2);
      });
    });

    it("sets a new_goal anchor after a buffered command flush", async () => {
      const { CommandFragmentBuffer, buildCommandFragmentKey } =
        await import("./command-fragments.js");
      const commandFragmentBuffer = new CommandFragmentBuffer(undefined, 3000, 60000);
      const setAnchor = vi.spyOn(commandFragmentBuffer, "setAnchor");
      mockGoalCommand.mockImplementation(
        async (opts: { runId: string }, runtime: { log: (...args: unknown[]) => void }) => {
          saveRunFixture(makeRun({ runId: opts.runId, state: "planning" }));
          runtime.log("## Plan\n1. Do something");
        },
      );

      const harness = makeCommandHarness({}, { commandFragmentBuffer });
      await harness.register();

      await harness.handlers.new_goal!(makeCommandCtx("first part", 2001));
      const key = buildCommandFragmentKey({
        accountId: "default",
        chatId: 42,
        resolvedThreadId: undefined,
        senderId: "42",
      });
      await commandFragmentBuffer.cancelAndFlush(key);

      expect(setAnchor).toHaveBeenCalledTimes(1);
      expect(setAnchor.mock.calls[0]?.[0]).toBe(key);
      expect(setAnchor.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({
          commandName: "new_goal",
          sourceMessageId: 2001,
        }),
      );
      expect(commandFragmentBuffer.getAnchor(key)?.commandName).toBe("new_goal");
    });

    it("routes appended anchor text through the same planner dispatch helper", async () => {
      const { CommandFragmentBuffer, buildCommandFragmentKey } =
        await import("./command-fragments.js");
      const commandFragmentBuffer = new CommandFragmentBuffer(undefined, 3000, 60000);
      mockGoalCommand.mockImplementation(
        async (opts: { runId: string }, runtime: { log: (...args: unknown[]) => void }) => {
          saveRunFixture(makeRun({ runId: opts.runId, state: "planning" }));
          runtime.log("## Plan\n1. Do something");
        },
      );

      const harness = makeCommandHarness({}, { commandFragmentBuffer });
      await harness.register();

      await harness.handlers.new_goal!(makeCommandCtx("first part", 2101));
      const key = buildCommandFragmentKey({
        accountId: "default",
        chatId: 42,
        resolvedThreadId: undefined,
        senderId: "42",
      });
      await commandFragmentBuffer.cancelAndFlush(key);

      const anchor = commandFragmentBuffer.getAnchor(key);
      expect(anchor).toBeDefined();
      await anchor!.appendHandler("appended part");

      await waitForAssertion(() => {
        expect(mockGoalCommand).toHaveBeenCalledTimes(2);
      });
      expect(mockGoalCommand.mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({ goal: "appended part" }),
      );
    });
  });

  describe("registerTelegramGoalCommands /goal_plan_autocheck", () => {
    function makeCommandHarness(cfg: Record<string, unknown> = {}): {
      handlers: Record<string, (ctx: unknown) => Promise<void>>;
      sendMessage: ReturnType<typeof vi.fn>;
      register: () => Promise<void>;
      config: Record<string, unknown>;
    } {
      const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 99 });
      const bot = {
        api: {
          sendMessage,
          sendPhoto: vi.fn(),
          answerCallbackQuery: vi.fn(),
          setMessageReaction: vi.fn(),
        },
        command: (name: string | string[], handler: (ctx: unknown) => Promise<void>) => {
          if (Array.isArray(name)) {
            for (const entry of name) handlers[entry] = handler;
            return;
          }
          handlers[name] = handler;
        },
        on: vi.fn(),
      } as unknown as import("grammy").Bot;

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: ((_: number) => {
          throw new Error("exit called");
        }) as never,
      };

      const register = async () => {
        const { registerTelegramGoalCommands } = await import("./goal-commands.js");
        registerTelegramGoalCommands({
          bot,
          cfg: cfg as never,
          runtime,
          accountId: "default",
          telegramCfg: {} as never,
          allowFrom: ["42"],
          groupAllowFrom: [],
          useAccessGroups: false,
          resolveGroupPolicy: () =>
            ({
              allowlistEnabled: false,
              allowed: true,
            }) as never,
          resolveTelegramGroupConfig: () => ({
            groupConfig: undefined,
            topicConfig: undefined,
          }),
          shouldSkipUpdate: () => false,
          textLimit: 4000,
        });
      };

      return { handlers, sendMessage, register, config: cfg };
    }

    function makeCommandCtx(match = ""): Record<string, unknown> {
      return {
        match,
        message: {
          chat: { id: 42, type: "private" },
          from: { id: 42, username: "tester" },
          message_id: 11,
          date: 123_456,
        },
      };
    }

    function lastReplyMessageId(sendMessage: ReturnType<typeof vi.fn>): number | undefined {
      const options = sendMessage.mock.calls.at(-1)?.[2] as
        | { reply_parameters?: { message_id?: number } }
        | undefined;
      return options?.reply_parameters?.message_id;
    }

    it("shows current autocheck mode when no argument is provided", async () => {
      const harness = makeCommandHarness({ goal: { planAutocheck: "codex" } });
      await harness.register();

      await harness.handlers.goal_plan_autocheck?.(makeCommandCtx());

      expect(harness.sendMessage).toHaveBeenCalled();
      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain("Goal plan autocheck mode:");
      expect(sentText).toContain("codex");
      expect(lastReplyMessageId(harness.sendMessage)).toBe(11);
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
    });

    it("persists a valid autocheck mode and updates in-memory config", async () => {
      const cfg = { goal: { planAutocheck: "off" } };
      mockLoadConfig.mockReturnValue({ goal: {} });
      const harness = makeCommandHarness(cfg);
      await harness.register();

      await harness.handlers.goal_plan_autocheck?.(makeCommandCtx("claude_code"));

      expect(mockResolveChannelConfigWrites).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: "telegram", accountId: "default" }),
      );
      expect(mockLoadConfig).toHaveBeenCalledOnce();
      expect(mockWriteConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          goal: expect.objectContaining({ planAutocheck: "claude_code" }),
        }),
      );
      expect((cfg.goal as { planAutocheck: string }).planAutocheck).toBe("claude_code");
      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain("Goal plan autocheck set to");
      expect(sentText).toContain("claude_code");
      expect(lastReplyMessageId(harness.sendMessage)).toBe(11);
    });

    it("keeps in-memory autocheck mode unchanged when config write fails", async () => {
      const cfg = { goal: { planAutocheck: "off" } };
      mockLoadConfig.mockReturnValue({ goal: { planAutocheck: "off" } });
      mockWriteConfigFile.mockRejectedValueOnce(new Error("disk full"));
      const harness = makeCommandHarness(cfg);
      await harness.register();

      await harness.handlers.goal_plan_autocheck?.(makeCommandCtx("claude_code"));

      expect((cfg.goal as { planAutocheck: string }).planAutocheck).toBe("off");
      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain("Could not save goal plan autocheck mode");
      expect(lastReplyMessageId(harness.sendMessage)).toBe(11);
    });

    it("rejects invalid autocheck mode input", async () => {
      const harness = makeCommandHarness({ goal: { planAutocheck: "off" } });
      await harness.register();

      await harness.handlers.goal_plan_autocheck?.(makeCommandCtx("bad-mode"));

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain("Invalid mode");
      expect(sentText).toContain("goal_plan_autocheck");
      expect(lastReplyMessageId(harness.sendMessage)).toBe(11);
    });

    it("blocks mode changes when config writes are disabled", async () => {
      mockResolveChannelConfigWrites.mockReturnValue(false);
      const harness = makeCommandHarness({ goal: { planAutocheck: "off" } });
      await harness.register();

      await harness.handlers.goal_plan_autocheck?.(makeCommandCtx("codex"));

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain("Config writes are disabled");
      expect(lastReplyMessageId(harness.sendMessage)).toBe(11);
    });
  });

  describe("registerTelegramGoalCommands /goal_lessons", () => {
    function makeCommandHarness(cfg: Record<string, unknown> = {}): {
      handlers: Record<string, (ctx: unknown) => Promise<void>>;
      sendMessage: ReturnType<typeof vi.fn>;
      register: () => Promise<void>;
      config: Record<string, unknown>;
    } {
      const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 99 });
      const bot = {
        api: {
          sendMessage,
          sendPhoto: vi.fn(),
          answerCallbackQuery: vi.fn(),
          setMessageReaction: vi.fn(),
        },
        command: (name: string | string[], handler: (ctx: unknown) => Promise<void>) => {
          if (Array.isArray(name)) {
            for (const entry of name) handlers[entry] = handler;
            return;
          }
          handlers[name] = handler;
        },
        on: vi.fn(),
      } as unknown as import("grammy").Bot;

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: ((_: number) => {
          throw new Error("exit called");
        }) as never,
      };

      const register = async () => {
        const { registerTelegramGoalCommands } = await import("./goal-commands.js");
        registerTelegramGoalCommands({
          bot,
          cfg: cfg as never,
          runtime,
          accountId: "default",
          telegramCfg: {} as never,
          allowFrom: ["42"],
          groupAllowFrom: [],
          useAccessGroups: false,
          resolveGroupPolicy: () =>
            ({
              allowlistEnabled: false,
              allowed: true,
            }) as never,
          resolveTelegramGroupConfig: () => ({
            groupConfig: undefined,
            topicConfig: undefined,
          }),
          shouldSkipUpdate: () => false,
          textLimit: 4000,
        });
      };

      return { handlers, sendMessage, register, config: cfg };
    }

    function makeCommandCtx(match = ""): Record<string, unknown> {
      return {
        match,
        message: {
          chat: { id: 42, type: "private" },
          from: { id: 42, username: "tester" },
          message_id: 11,
          date: 123_456,
        },
      };
    }

    function lastReplyMessageId(sendMessage: ReturnType<typeof vi.fn>): number | undefined {
      const options = sendMessage.mock.calls.at(-1)?.[2] as
        | { reply_parameters?: { message_id?: number } }
        | undefined;
      return options?.reply_parameters?.message_id;
    }

    it("blocks lessons clear when config writes are disabled", async () => {
      mockResolveChannelConfigWrites.mockReturnValue(false);
      const harness = makeCommandHarness();
      await harness.register();

      await harness.handlers.goal_lessons?.(makeCommandCtx("clear"));

      expect(mockResolveChannelConfigWrites).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: "telegram", accountId: "default" }),
      );
      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain("Config writes are disabled for this Telegram account.");
      expect(lastReplyMessageId(harness.sendMessage)).toBe(11);
    });

    it("does not gate read-only lessons listing when config writes are disabled", async () => {
      mockResolveChannelConfigWrites.mockReturnValue(false);
      const harness = makeCommandHarness();
      await harness.register();

      await harness.handlers.goal_lessons?.(makeCommandCtx(""));

      expect(mockResolveChannelConfigWrites).not.toHaveBeenCalled();
      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).not.toContain("Config writes are disabled");
      expect(lastReplyMessageId(harness.sendMessage)).toBe(11);
    });
  });

  describe("registerTelegramGoalCommands /goal_semgrep", () => {
    function makeCommandHarness(cfg: Record<string, unknown> = {}): {
      handlers: Record<string, (ctx: unknown) => Promise<void>>;
      sendMessage: ReturnType<typeof vi.fn>;
      register: () => Promise<void>;
      config: Record<string, unknown>;
    } {
      const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 99 });
      const bot = {
        api: {
          sendMessage,
          sendPhoto: vi.fn(),
          answerCallbackQuery: vi.fn(),
          setMessageReaction: vi.fn(),
        },
        command: (name: string | string[], handler: (ctx: unknown) => Promise<void>) => {
          if (Array.isArray(name)) {
            for (const entry of name) handlers[entry] = handler;
            return;
          }
          handlers[name] = handler;
        },
        on: vi.fn(),
      } as unknown as import("grammy").Bot;

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: ((_: number) => {
          throw new Error("exit called");
        }) as never,
      };

      const register = async () => {
        const { registerTelegramGoalCommands } = await import("./goal-commands.js");
        registerTelegramGoalCommands({
          bot,
          cfg: cfg as never,
          runtime,
          accountId: "default",
          telegramCfg: {} as never,
          allowFrom: ["42"],
          groupAllowFrom: [],
          useAccessGroups: false,
          resolveGroupPolicy: () =>
            ({
              allowlistEnabled: false,
              allowed: true,
            }) as never,
          resolveTelegramGroupConfig: () => ({
            groupConfig: undefined,
            topicConfig: undefined,
          }),
          shouldSkipUpdate: () => false,
          textLimit: 4000,
        });
      };

      return { handlers, sendMessage, register, config: cfg };
    }

    function makeCommandCtx(match = ""): Record<string, unknown> {
      return {
        match,
        message: {
          chat: { id: 42, type: "private" },
          from: { id: 42, username: "tester" },
          message_id: 11,
          date: 123_456,
        },
      };
    }

    function lastReplyMessageId(sendMessage: ReturnType<typeof vi.fn>): number | undefined {
      const options = sendMessage.mock.calls.at(-1)?.[2] as
        | { reply_parameters?: { message_id?: number } }
        | undefined;
      return options?.reply_parameters?.message_id;
    }

    it("shows current semgrep mode and defaults to step when unset", async () => {
      const harness = makeCommandHarness();
      await harness.register();

      await harness.handlers.goal_semgrep?.(makeCommandCtx());

      expect(harness.sendMessage).toHaveBeenCalled();
      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain("Goal semgrep mode:");
      expect(sentText).toContain("step");
      expect(lastReplyMessageId(harness.sendMessage)).toBe(11);
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
    });

    it("persists a valid semgrep mode and updates in-memory config", async () => {
      const cfg = { goal: { semgrep: "off" } };
      mockLoadConfig.mockReturnValue({ goal: {} });
      const harness = makeCommandHarness(cfg);
      await harness.register();

      await harness.handlers.goal_semgrep?.(makeCommandCtx("goal"));

      expect(mockResolveChannelConfigWrites).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: "telegram", accountId: "default" }),
      );
      expect(mockLoadConfig).toHaveBeenCalledOnce();
      expect(mockWriteConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          goal: expect.objectContaining({ semgrep: "goal" }),
        }),
      );
      expect((cfg.goal as { semgrep: string }).semgrep).toBe("goal");
      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain("Semgrep will run only after the last step completes.");
      expect(lastReplyMessageId(harness.sendMessage)).toBe(11);
    });

    it("keeps in-memory semgrep mode unchanged when config write fails", async () => {
      const cfg = { goal: { semgrep: "off" } };
      mockLoadConfig.mockReturnValue({ goal: { semgrep: "off" } });
      mockWriteConfigFile.mockRejectedValueOnce(new Error("disk full"));
      const harness = makeCommandHarness(cfg);
      await harness.register();

      await harness.handlers.goal_semgrep?.(makeCommandCtx("goal"));

      expect((cfg.goal as { semgrep: string }).semgrep).toBe("off");
      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain("Could not save goal semgrep mode");
      expect(lastReplyMessageId(harness.sendMessage)).toBe(11);
    });

    it("rejects invalid semgrep mode input", async () => {
      const harness = makeCommandHarness({ goal: { semgrep: "step" } });
      await harness.register();

      await harness.handlers.goal_semgrep?.(makeCommandCtx("bad-mode"));

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain("Invalid mode");
      expect(sentText).toContain("goal_semgrep");
      expect(lastReplyMessageId(harness.sendMessage)).toBe(11);
    });
  });

  describe("registerTelegramGoalCommands /goal_workers", () => {
    function makeCommandHarness(cfg: Record<string, unknown> = {}): {
      handlers: Record<string, (ctx: unknown) => Promise<void>>;
      sendMessage: ReturnType<typeof vi.fn>;
      register: () => Promise<void>;
      config: Record<string, unknown>;
    } {
      const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 99 });
      const bot = {
        api: {
          sendMessage,
          sendPhoto: vi.fn(),
          answerCallbackQuery: vi.fn(),
          setMessageReaction: vi.fn(),
        },
        command: (name: string | string[], handler: (ctx: unknown) => Promise<void>) => {
          if (Array.isArray(name)) {
            for (const entry of name) handlers[entry] = handler;
            return;
          }
          handlers[name] = handler;
        },
        on: vi.fn(),
      } as unknown as import("grammy").Bot;

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: ((_: number) => {
          throw new Error("exit called");
        }) as never,
      };

      const register = async () => {
        const { registerTelegramGoalCommands } = await import("./goal-commands.js");
        registerTelegramGoalCommands({
          bot,
          cfg: cfg as never,
          runtime,
          accountId: "default",
          telegramCfg: {} as never,
          allowFrom: ["42"],
          groupAllowFrom: [],
          useAccessGroups: false,
          resolveGroupPolicy: () =>
            ({
              allowlistEnabled: false,
              allowed: true,
            }) as never,
          resolveTelegramGroupConfig: () => ({
            groupConfig: undefined,
            topicConfig: undefined,
          }),
          shouldSkipUpdate: () => false,
          textLimit: 4000,
        });
      };

      return { handlers, sendMessage, register, config: cfg };
    }

    function makeCommandCtx(match = ""): Record<string, unknown> {
      return {
        match,
        message: {
          chat: { id: 42, type: "private" },
          from: { id: 42, username: "tester" },
          message_id: 11,
          date: 123_456,
        },
      };
    }

    function lastReplyMessageId(sendMessage: ReturnType<typeof vi.fn>): number | undefined {
      const options = sendMessage.mock.calls.at(-1)?.[2] as
        | { reply_parameters?: { message_id?: number } }
        | undefined;
      return options?.reply_parameters?.message_id;
    }

    it("shows current workers when no argument is provided", async () => {
      const harness = makeCommandHarness();
      await harness.register();

      await harness.handlers.goal_workers?.(makeCommandCtx());

      expect(harness.sendMessage).toHaveBeenCalled();
      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain("Enabled goal workers:");
      expect(sentText).toContain("codex, claude_code");
      expect(lastReplyMessageId(harness.sendMessage)).toBe(11);
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
    });

    it("persists codex-only workers", async () => {
      const cfg = { goal: { enabledWorkers: ["claude_code"] } };
      mockLoadConfig.mockReturnValue({ goal: {} });
      const harness = makeCommandHarness(cfg);
      await harness.register();

      await harness.handlers.goal_workers?.(makeCommandCtx("codex"));

      expect(mockResolveChannelConfigWrites).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: "telegram", accountId: "default" }),
      );
      expect(mockLoadConfig).toHaveBeenCalledOnce();
      expect(mockWriteConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          goal: expect.objectContaining({ enabledWorkers: ["codex"] }),
        }),
      );
      expect((cfg.goal as { enabledWorkers: string[] }).enabledWorkers).toEqual(["codex"]);
      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain("Enabled goal workers set to");
      expect(sentText).toContain("codex");
      expect(lastReplyMessageId(harness.sendMessage)).toBe(11);
    });

    it("persists claude_code-only workers", async () => {
      const cfg = { goal: { enabledWorkers: ["codex"] } };
      mockLoadConfig.mockReturnValue({ goal: {} });
      const harness = makeCommandHarness(cfg);
      await harness.register();

      await harness.handlers.goal_workers?.(makeCommandCtx("claude_code"));

      expect(mockWriteConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          goal: expect.objectContaining({ enabledWorkers: ["claude_code"] }),
        }),
      );
      expect((cfg.goal as { enabledWorkers: string[] }).enabledWorkers).toEqual(["claude_code"]);
      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain("claude_code");
      expect(lastReplyMessageId(harness.sendMessage)).toBe(11);
    });

    it("persists both workers", async () => {
      const cfg = { goal: { enabledWorkers: ["codex"] } };
      mockLoadConfig.mockReturnValue({ goal: {} });
      const harness = makeCommandHarness(cfg);
      await harness.register();

      await harness.handlers.goal_workers?.(makeCommandCtx("both"));

      expect(mockWriteConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          goal: expect.objectContaining({ enabledWorkers: ["codex", "claude_code"] }),
        }),
      );
      expect((cfg.goal as { enabledWorkers: string[] }).enabledWorkers).toEqual([
        "codex",
        "claude_code",
      ]);
      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain("codex, claude_code");
      expect(lastReplyMessageId(harness.sendMessage)).toBe(11);
    });

    it("keeps in-memory workers unchanged when config write fails", async () => {
      const cfg = { goal: { enabledWorkers: ["codex"] } };
      mockLoadConfig.mockReturnValue({ goal: { enabledWorkers: ["codex"] } });
      mockWriteConfigFile.mockRejectedValueOnce(new Error("disk full"));
      const harness = makeCommandHarness(cfg);
      await harness.register();

      await harness.handlers.goal_workers?.(makeCommandCtx("claude_code"));

      expect((cfg.goal as { enabledWorkers: string[] }).enabledWorkers).toEqual(["codex"]);
      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain("Could not save goal workers setting");
      expect(lastReplyMessageId(harness.sendMessage)).toBe(11);
    });

    it("rejects invalid worker input", async () => {
      const harness = makeCommandHarness({ goal: { enabledWorkers: ["codex"] } });
      await harness.register();

      await harness.handlers.goal_workers?.(makeCommandCtx("bad-workers"));

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain("Invalid workers");
      expect(sentText).toContain("goal_workers");
      expect(sentText).toContain("Current:");
      expect(lastReplyMessageId(harness.sendMessage)).toBe(11);
    });

    it("blocks worker changes when config writes are disabled", async () => {
      mockResolveChannelConfigWrites.mockReturnValue(false);
      const harness = makeCommandHarness({ goal: { enabledWorkers: ["codex"] } });
      await harness.register();

      await harness.handlers.goal_workers?.(makeCommandCtx("all"));

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain("Config writes are disabled");
      expect(lastReplyMessageId(harness.sendMessage)).toBe(11);
    });
  });

  describe("registerTelegramGoalCommands /goal_github_push", () => {
    function makeCommandHarness(cfg: Record<string, unknown> = {}): {
      handlers: Record<string, (ctx: unknown) => Promise<void>>;
      sendMessage: ReturnType<typeof vi.fn>;
      register: () => Promise<void>;
      config: Record<string, unknown>;
    } {
      const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 99 });
      const bot = {
        api: {
          sendMessage,
          sendPhoto: vi.fn(),
          answerCallbackQuery: vi.fn(),
          setMessageReaction: vi.fn(),
        },
        command: (name: string | string[], handler: (ctx: unknown) => Promise<void>) => {
          if (Array.isArray(name)) {
            for (const entry of name) handlers[entry] = handler;
            return;
          }
          handlers[name] = handler;
        },
        on: vi.fn(),
      } as unknown as import("grammy").Bot;

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: ((_: number) => {
          throw new Error("exit called");
        }) as never,
      };

      const register = async () => {
        const { registerTelegramGoalCommands } = await import("./goal-commands.js");
        registerTelegramGoalCommands({
          bot,
          cfg: cfg as never,
          runtime,
          accountId: "default",
          telegramCfg: {} as never,
          allowFrom: ["42"],
          groupAllowFrom: [],
          useAccessGroups: false,
          resolveGroupPolicy: () =>
            ({
              allowlistEnabled: false,
              allowed: true,
            }) as never,
          resolveTelegramGroupConfig: () => ({
            groupConfig: undefined,
            topicConfig: undefined,
          }),
          shouldSkipUpdate: () => false,
          textLimit: 4000,
        });
      };

      return { handlers, sendMessage, register, config: cfg };
    }

    function makeCommandCtx(match = ""): Record<string, unknown> {
      return {
        match,
        message: {
          chat: { id: 42, type: "private" },
          from: { id: 42, username: "tester" },
          message_id: 11,
          date: 123_456,
        },
      };
    }

    function lastReplyMessageId(sendMessage: ReturnType<typeof vi.fn>): number | undefined {
      const options = sendMessage.mock.calls.at(-1)?.[2] as
        | { reply_parameters?: { message_id?: number } }
        | undefined;
      return options?.reply_parameters?.message_id;
    }

    it("shows current GitHub push mode when no argument is provided", async () => {
      const harness = makeCommandHarness({ goal: { githubPush: { enabled: true } } });
      await harness.register();

      await harness.handlers.goal_github_push?.(makeCommandCtx());

      expect(harness.sendMessage).toHaveBeenCalled();
      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain("GitHub push is currently");
      expect(sentText).toContain("on");
      expect(lastReplyMessageId(harness.sendMessage)).toBe(11);
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
    });

    it("persists GitHub push mode and updates in-memory config", async () => {
      const cfg = { goal: { githubPush: { enabled: false } } };
      mockLoadConfig.mockReturnValue({ goal: {} });
      const harness = makeCommandHarness(cfg);
      await harness.register();

      await harness.handlers.goal_github_push?.(makeCommandCtx("on"));

      expect(mockResolveChannelConfigWrites).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: "telegram", accountId: "default" }),
      );
      expect(mockLoadConfig).toHaveBeenCalledOnce();
      expect(mockWriteConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          goal: expect.objectContaining({ githubPush: expect.objectContaining({ enabled: true }) }),
        }),
      );
      expect((cfg.goal as { githubPush: { enabled: boolean } }).githubPush.enabled).toBe(true);
      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain("GitHub push enabled");
      expect(lastReplyMessageId(harness.sendMessage)).toBe(11);
    });

    it("keeps in-memory GitHub push mode unchanged when config write fails", async () => {
      const cfg = { goal: { githubPush: { enabled: false } } };
      mockLoadConfig.mockReturnValue({ goal: { githubPush: { enabled: false } } });
      mockWriteConfigFile.mockRejectedValueOnce(new Error("disk full"));
      const harness = makeCommandHarness(cfg);
      await harness.register();

      await harness.handlers.goal_github_push?.(makeCommandCtx("on"));

      expect((cfg.goal as { githubPush: { enabled: boolean } }).githubPush.enabled).toBe(false);
      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain("Could not save GitHub push setting");
      expect(lastReplyMessageId(harness.sendMessage)).toBe(11);
    });

    it("rejects invalid GitHub push input", async () => {
      const harness = makeCommandHarness({ goal: { githubPush: { enabled: false } } });
      await harness.register();

      await harness.handlers.goal_github_push?.(makeCommandCtx("maybe"));

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain("Invalid argument");
      expect(sentText).toContain("goal_github_push");
      expect(lastReplyMessageId(harness.sendMessage)).toBe(11);
    });

    it("blocks GitHub push changes when config writes are disabled", async () => {
      mockResolveChannelConfigWrites.mockReturnValue(false);
      const harness = makeCommandHarness({ goal: { githubPush: { enabled: false } } });
      await harness.register();

      await harness.handlers.goal_github_push?.(makeCommandCtx("on"));

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain("Config writes are disabled");
      expect(lastReplyMessageId(harness.sendMessage)).toBe(11);
    });
  });

  describe("registerTelegramGoalCommands done callbacks", () => {
    function makeCallbackHarness(): {
      callbackHandler: (ctx: unknown, next?: () => Promise<void>) => Promise<void>;
      sendMessage: ReturnType<typeof vi.fn>;
      answerCallbackQuery: ReturnType<typeof vi.fn>;
      setMessageReaction: ReturnType<typeof vi.fn>;
      register: () => Promise<void>;
    } {
      let callbackHandler:
        | ((ctx: unknown, next?: () => Promise<void>) => Promise<void>)
        | undefined;
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 700 });
      const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
      const setMessageReaction = vi.fn().mockResolvedValue(true);
      const bot = {
        api: {
          sendMessage,
          sendPhoto: vi.fn().mockResolvedValue({ message_id: 701 }),
          sendChatAction: vi.fn().mockResolvedValue(true),
          answerCallbackQuery,
          setMessageReaction,
        },
        command: vi.fn(),
        on: (
          event: string,
          handler: (ctx: unknown, next?: () => Promise<void>) => Promise<void>,
        ) => {
          if (event === "callback_query:data") callbackHandler = handler;
        },
      } as unknown as import("grammy").Bot;
      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: ((_: number) => {
          throw new Error("exit called");
        }) as never,
      };
      const register = async () => {
        const { registerTelegramGoalCommands } = await import("./goal-commands.js");
        registerTelegramGoalCommands({
          bot,
          cfg: {} as never,
          runtime,
          accountId: "default",
          telegramCfg: {} as never,
          allowFrom: ["42"],
          groupAllowFrom: [],
          useAccessGroups: false,
          resolveGroupPolicy: () =>
            ({
              allowlistEnabled: false,
              allowed: true,
            }) as never,
          resolveTelegramGroupConfig: () => ({
            groupConfig: undefined,
            topicConfig: undefined,
          }),
          shouldSkipUpdate: () => false,
          textLimit: 4000,
        });
      };
      return {
        get callbackHandler() {
          if (!callbackHandler) throw new Error("callback handler not registered");
          return callbackHandler;
        },
        sendMessage,
        answerCallbackQuery,
        setMessageReaction,
        register,
      };
    }

    function makeCallbackCtx(
      data: string,
      messageId: number | null = 500,
    ): Record<string, unknown> {
      return {
        callbackQuery: {
          id: "cb-1",
          data,
          message: {
            chat: { id: 42, type: "private" },
            ...(messageId != null ? { message_id: messageId } : {}),
          },
        },
      };
    }

    it("routes gTD callback to manual test detail message", async () => {
      const runId = "abcdef12-3456-7890-abcd-ef1234567890";
      saveRunFixture(
        makeRun({
          runId,
          state: "done",
          manualTests: [
            {
              description: "Check login flow",
              criticality: 8,
              reason: "Requires real user interaction in Telegram",
              detail: "Run login with valid + invalid credentials.",
            },
          ],
        }),
      );
      const harness = makeCallbackHarness();
      await harness.register();

      await harness.callbackHandler(makeCallbackCtx("gTD:abcdef12"));

      expect(harness.answerCallbackQuery).toHaveBeenCalledWith("cb-1");
      expect(harness.setMessageReaction).toHaveBeenCalledWith(42, 500, [
        { type: "emoji", emoji: "\uD83D\uDC40" },
      ]);
      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain("Manual test details for abcdef12");
      expect(sentText).toContain("<b>Test 1: Check login flow [8/10 Critical]</b>");
      expect(sentText).toContain("<i>Reason: Requires real user interaction in Telegram</i>");
      expect(sentText).toContain("Run login with valid + invalid credentials.");
    });

    it("routes gTD callback to fallback manual test details when available", async () => {
      const runId = "abcdef12-3456-7890-abcd-ef1234567890";
      saveRunFixture(
        makeRun({
          runId,
          state: "done",
          manualTests: [
            {
              description: "Test signup flow",
              criticality: 6,
              detail:
                "Step 1. Open signup\nStep 2. Submit invalid email\nStep 3. Confirm inline error",
            },
          ],
        }),
      );
      const harness = makeCallbackHarness();
      await harness.register();

      await harness.callbackHandler(makeCallbackCtx("gTD:abcdef12"));

      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain("Manual test details for abcdef12");
      expect(sentText).toContain("<b>Test 1: Test signup flow [6/10 Critical]</b>");
      expect(sentText).toContain("<b>Step 1.</b> Open signup");
      expect(sentText).toContain("<b>Step 2.</b> Submit invalid email");
      expect(sentText).toContain("<b>Step 3.</b> Confirm inline error");
      expect(sentText).not.toContain("unavailable");
      expect(sentText).not.toContain("<i>Reason:");
    });

    it("routes gTD callback to a useful fallback when manual tests are unavailable", async () => {
      const runId = "abcdef12-3456-7890-abcd-ef1234567890";
      saveRunFixture(
        makeRun({
          runId,
          state: "done",
          manualTestsError: "HTTP 401: invalid x-api-key",
        }),
      );
      const harness = makeCallbackHarness();
      await harness.register();

      await harness.callbackHandler(makeCallbackCtx("gTD:abcdef12"));

      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain("Manual test details are unavailable for run abcdef12.");
      expect(sentText).toContain("Reason: HTTP 401: invalid x-api-key");
      expect(sentText).toContain("Incorporate Feedback");
    });

    it("routes gTD callback to no-tests-needed details when manualTests is an empty array", async () => {
      const runId = "abcdef12-3456-7890-abcd-ef1234567890";
      saveRunFixture(
        makeRun({
          runId,
          state: "done",
          manualTests: [],
        }),
      );
      const harness = makeCallbackHarness();
      await harness.register();

      await harness.callbackHandler(makeCallbackCtx("gTD:abcdef12"));

      const sentText = String(harness.sendMessage.mock.calls.at(-1)?.[1] ?? "");
      expect(sentText).toContain(
        "No manual tests needed — all functionality was verified automatically.",
      );
      expect(sentText).toContain('Use "Incorporate Feedback" if you notice any issues.');
    });

    it("routes gIF callback to force-reply prompt and persists prompt tracking", async () => {
      const runId = "abcdef12-3456-7890-abcd-ef1234567890";
      saveRunFixture(makeRun({ runId, state: "done" }));
      const harness = makeCallbackHarness();
      harness.sendMessage.mockResolvedValue({ message_id: 777 });
      await harness.register();

      await harness.callbackHandler(makeCallbackCtx("gIF:abcdef12", 501));

      expect(harness.answerCallbackQuery).toHaveBeenCalledWith("cb-1");
      expect(harness.setMessageReaction).toHaveBeenCalledWith(42, 501, [
        { type: "emoji", emoji: "\u270D" },
      ]);
      expect(harness.sendMessage).toHaveBeenCalledWith(
        42,
        "Reply with feedback from your manual tests.",
        expect.objectContaining({
          reply_parameters: { message_id: 501 },
          reply_markup: expect.objectContaining({ force_reply: true }),
        }),
      );
      const run = loadRun(runId, testGoalsDir);
      expect(run?.telegramFeedbackPromptMessages?.[0]).toEqual({
        chatId: 42,
        messageId: 777,
        threadId: undefined,
      });
    });

    it("sends fallback message when ge force-reply prompt fails", async () => {
      const harness = makeCallbackHarness();
      harness.sendMessage.mockImplementation(
        async (
          _chatId: number,
          _text: string,
          options?: { reply_markup?: { force_reply?: boolean } },
        ) => {
          if (options?.reply_markup?.force_reply) {
            throw new Error("force reply failed");
          }
          return { message_id: 780 };
        },
      );
      await harness.register();

      await harness.callbackHandler(makeCallbackCtx("ge:abcdef12:1", 551));

      expect(
        harness.sendMessage.mock.calls.some(
          (call) =>
            String(call[1]).includes("Could not open the edit reply prompt.") &&
            (call[2] as { reply_parameters?: { message_id?: number } } | undefined)
              ?.reply_parameters?.message_id === 551,
        ),
      ).toBe(true);
    });

    it("sends fallback message when gIF force-reply prompt fails", async () => {
      const runId = "abcdef12-3456-7890-abcd-ef1234567890";
      saveRunFixture(makeRun({ runId, state: "done" }));
      const harness = makeCallbackHarness();
      harness.sendMessage.mockImplementation(
        async (
          _chatId: number,
          _text: string,
          options?: { reply_markup?: { force_reply?: boolean } },
        ) => {
          if (options?.reply_markup?.force_reply) {
            throw new Error("force reply failed");
          }
          return { message_id: 781 };
        },
      );
      await harness.register();

      await harness.callbackHandler(makeCallbackCtx("gIF:abcdef12", 552));

      expect(
        harness.sendMessage.mock.calls.some(
          (call) =>
            String(call[1]).includes("Could not open the feedback reply prompt.") &&
            (call[2] as { reply_parameters?: { message_id?: number } } | undefined)
              ?.reply_parameters?.message_id === 552,
        ),
      ).toBe(true);
    });

    it("routes gAD callback to force-reply prompt and persists question tracking", async () => {
      const runId = "abcdef12-3456-7890-abcd-ef1234567890";
      saveRunFixture(
        makeRun({
          runId,
          state: "blocked",
          blocked: {
            blockedAt: "execution",
            prompt: "Need credentials",
            requiredInputKey: "task:1:input",
          },
          plan: {
            goal: "Test goal",
            workingDir: "/tmp/ws",
            summary: "A test plan",
            shortSummary: "A test plan",
            steps: [
              {
                id: "1",
                description: "Step one",
                shortSummary: "Step one",
                dependsOn: [],
                status: "blocked",
                blockedQuestion: "Need a value",
              },
            ],
          },
        }),
      );
      const harness = makeCallbackHarness();
      harness.sendMessage.mockResolvedValue({ message_id: 779 });
      await harness.register();

      await harness.callbackHandler(makeCallbackCtx("gAD:abcdef12", 502));

      expect(harness.answerCallbackQuery).toHaveBeenCalledWith("cb-1");
      expect(harness.setMessageReaction).toHaveBeenCalledWith(42, 502, [
        { type: "emoji", emoji: "\u270D" },
      ]);
      expect(harness.sendMessage).toHaveBeenCalledWith(
        42,
        "Reply to the blocked message with unblocking details.",
        expect.objectContaining({
          reply_parameters: { message_id: 502 },
          reply_markup: expect.objectContaining({
            force_reply: true,
            input_field_placeholder: "Describe your answer...",
          }),
        }),
      );
      const run = loadRun(runId, testGoalsDir);
      expect(run?.telegramQuestionMessages?.[0]).toEqual({
        chatId: 42,
        messageId: 779,
        threadId: undefined,
        requiredInputKey: "task:1:input",
      });
    });

    it("sends fallback message when gAD force-reply prompt fails", async () => {
      const runId = "abcdef12-3456-7890-abcd-ef1234567890";
      saveRunFixture(
        makeRun({
          runId,
          state: "blocked",
          blocked: {
            blockedAt: "execution",
            prompt: "Need credentials",
            requiredInputKey: "task:1:input",
          },
        }),
      );
      const harness = makeCallbackHarness();
      harness.sendMessage.mockImplementation(
        async (
          _chatId: number,
          _text: string,
          options?: { reply_markup?: { force_reply?: boolean } },
        ) => {
          if (options?.reply_markup?.force_reply) {
            throw new Error("force reply failed");
          }
          return { message_id: 782 };
        },
      );
      await harness.register();

      await harness.callbackHandler(makeCallbackCtx("gAD:abcdef12", 553));

      expect(
        harness.sendMessage.mock.calls.some(
          (call) =>
            String(call[1]).includes("Could not open the answer reply prompt.") &&
            (call[2] as { reply_parameters?: { message_id?: number } } | undefined)
              ?.reply_parameters?.message_id === 553,
        ),
      ).toBe(true);
    });

    it("falls back to persisted done-message id when callback message_id is missing", async () => {
      const runId = "abcdef12-3456-7890-abcd-ef1234567890";
      saveRunFixture(
        makeRun({
          runId,
          state: "done",
          telegramDoneMessage: { chatId: 42, messageId: 612 },
        }),
      );
      const harness = makeCallbackHarness();
      harness.sendMessage.mockResolvedValue({ message_id: 778 });
      await harness.register();

      await harness.callbackHandler(makeCallbackCtx("gIF:abcdef12", null));

      expect(harness.sendMessage).toHaveBeenCalledWith(
        42,
        "Reply with feedback from your manual tests.",
        expect.objectContaining({
          reply_parameters: { message_id: 612 },
          reply_markup: expect.objectContaining({ force_reply: true }),
        }),
      );
    });
  });

  describe("registerTelegramGoalCommands approve/resume reply threading", () => {
    function makeHarness(): {
      commandHandlers: Record<string, (ctx: unknown) => Promise<void>>;
      callbackHandler: (ctx: unknown, next?: () => Promise<void>) => Promise<void>;
      reactionHandler: (ctx: unknown, next?: () => Promise<void>) => Promise<void>;
      sendMessage: ReturnType<typeof vi.fn>;
      sendPhoto: ReturnType<typeof vi.fn>;
      setMessageReaction: ReturnType<typeof vi.fn>;
      register: () => Promise<void>;
    } {
      const commandHandlers: Record<string, (ctx: unknown) => Promise<void>> = {};
      let callbackHandler:
        | ((ctx: unknown, next?: () => Promise<void>) => Promise<void>)
        | undefined;
      let reactionHandler:
        | ((ctx: unknown, next?: () => Promise<void>) => Promise<void>)
        | undefined;
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 600 });
      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 601 });
      const setMessageReaction = vi.fn().mockResolvedValue(true);
      const bot = {
        api: {
          sendMessage,
          sendPhoto,
          sendChatAction: vi.fn().mockResolvedValue(true),
          answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
          setMessageReaction,
        },
        command: (name: string | string[], handler: (ctx: unknown) => Promise<void>) => {
          if (Array.isArray(name)) {
            for (const entry of name) commandHandlers[entry] = handler;
            return;
          }
          commandHandlers[name] = handler;
        },
        on: (
          event: string,
          handler: (ctx: unknown, next?: () => Promise<void>) => Promise<void>,
        ) => {
          if (event === "callback_query:data") {
            callbackHandler = handler;
            return;
          }
          if (event === "message_reaction") reactionHandler = handler;
        },
      } as unknown as import("grammy").Bot;
      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: ((_: number) => {
          throw new Error("exit called");
        }) as never,
      };

      const register = async () => {
        const { registerTelegramGoalCommands } = await import("./goal-commands.js");
        registerTelegramGoalCommands({
          bot,
          cfg: {} as never,
          runtime,
          accountId: "default",
          telegramCfg: {} as never,
          allowFrom: ["42"],
          groupAllowFrom: [],
          useAccessGroups: false,
          resolveGroupPolicy: () =>
            ({
              allowlistEnabled: false,
              allowed: true,
            }) as never,
          resolveTelegramGroupConfig: () => ({
            groupConfig: undefined,
            topicConfig: undefined,
          }),
          shouldSkipUpdate: () => false,
          textLimit: 4000,
        });
      };

      return {
        commandHandlers,
        get callbackHandler() {
          if (!callbackHandler) throw new Error("callback handler not registered");
          return callbackHandler;
        },
        get reactionHandler() {
          if (!reactionHandler) throw new Error("reaction handler not registered");
          return reactionHandler;
        },
        sendMessage,
        sendPhoto,
        setMessageReaction,
        register,
      };
    }

    function makeCommandCtx(match: string, messageId: number): Record<string, unknown> {
      return {
        match,
        message: {
          chat: { id: 42, type: "private" },
          from: { id: 42, username: "tester" },
          message_id: messageId,
          date: 123_456,
        },
      };
    }

    function makeCallbackCtx(data: string, messageId: number): Record<string, unknown> {
      return {
        callbackQuery: {
          id: "cb-42",
          data,
          message: {
            chat: { id: 42, type: "private" },
            message_id: messageId,
          },
        },
      };
    }

    function makeReactionCtx(messageId: number, emoji: string): Record<string, unknown> {
      return {
        update: {
          message_reaction: {
            chat: { id: 42 },
            message_id: messageId,
            old_reaction: [],
            new_reaction: [{ type: "emoji", emoji }],
          },
        },
      };
    }

    function hasReplyMessageId(call: unknown[], messageId: number): boolean {
      const options = call[2] as { reply_parameters?: { message_id?: number } } | undefined;
      return options?.reply_parameters?.message_id === messageId;
    }

    async function waitForAssertion(assertion: () => void, timeoutMs = 1500): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        try {
          assertion();
          return;
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    }

    it("threads replies for ga callback preface and run-not-found errors", async () => {
      const runId = "abcdef12-3456-7890-abcd-ef1234567890";
      saveRunFixture(makeRun({ runId, state: "awaiting_approval" }));
      mockGoalResumeCommand.mockResolvedValue({ status: "done", summary: "Done." });

      const harness = makeHarness();
      await harness.register();
      const { START_PREFACE } = await import("./goal-commands.js");

      await harness.callbackHandler(makeCallbackCtx("ga:abcdef12:1", 501));

      await waitForAssertion(() => {
        expect(
          harness.sendMessage.mock.calls.some(
            (call) => call[1] === START_PREFACE && hasReplyMessageId(call, 501),
          ),
        ).toBe(true);
      });

      await harness.callbackHandler(makeCallbackCtx("ga:deadbeef:1", 502));

      expect(
        harness.sendMessage.mock.calls.some(
          (call) =>
            String(call[1]).includes("Run not found: deadbeef") && hasReplyMessageId(call, 502),
        ),
      ).toBe(true);
    });

    it("threads replies for gr callback responses", async () => {
      const runId = "abcdef12-3456-7890-abcd-ef1234567890";
      saveRunFixture(makeRun({ runId, state: "awaiting_approval" }));

      const harness = makeHarness();
      await harness.register();

      await harness.callbackHandler(makeCallbackCtx("gr:abcdef12:1", 503));

      expect(
        harness.sendMessage.mock.calls.some(
          (call) => String(call[1]).includes("Plan rejected") && hasReplyMessageId(call, 503),
        ),
      ).toBe(true);
    });

    it("threads replies for gResume callback preface and run-not-found errors", async () => {
      const runId = "abcdef12-3456-7890-abcd-ef1234567890";
      saveRunFixture(makeRun({ runId, state: "blocked" }));
      mockGoalResumeCommand.mockResolvedValue({ status: "done", summary: "Done." });

      const harness = makeHarness();
      await harness.register();
      const { RESUME_PREFACE } = await import("./goal-commands.js");

      await harness.callbackHandler(makeCallbackCtx("gResume:abcdef12", 601));

      await waitForAssertion(() => {
        expect(
          harness.sendMessage.mock.calls.some(
            (call) => call[1] === RESUME_PREFACE && hasReplyMessageId(call, 601),
          ),
        ).toBe(true);
      });

      await harness.callbackHandler(makeCallbackCtx("gResume:feedface", 602));

      expect(
        harness.sendMessage.mock.calls.some(
          (call) =>
            String(call[1]).includes("Run not found: feedface") && hasReplyMessageId(call, 602),
        ),
      ).toBe(true);
    });

    it("threads replies for /goal_approve preface and run-not-found errors", async () => {
      saveRunFixture(makeRun({ state: "awaiting_approval" }));
      mockGoalResumeCommand.mockResolvedValue({ status: "done", summary: "Done." });

      const harness = makeHarness();
      await harness.register();
      const { START_PREFACE } = await import("./goal-commands.js");

      await harness.commandHandlers.goal_approve?.(makeCommandCtx("test-run", 701));

      await waitForAssertion(() => {
        expect(
          harness.sendMessage.mock.calls.some(
            (call) => call[1] === START_PREFACE && hasReplyMessageId(call, 701),
          ),
        ).toBe(true);
      });

      await harness.commandHandlers.goal_approve?.(makeCommandCtx("missing-run", 702));

      expect(
        harness.sendMessage.mock.calls.some(
          (call) =>
            String(call[1]).includes("Run not found: missing-run") && hasReplyMessageId(call, 702),
        ),
      ).toBe(true);
    });

    it("threads replies for /goal_resume preface and run-not-found errors", async () => {
      saveRunFixture(makeRun({ state: "blocked" }));
      mockGoalResumeCommand.mockResolvedValue({ status: "done", summary: "Done." });

      const harness = makeHarness();
      await harness.register();
      const { RESUME_PREFACE } = await import("./goal-commands.js");

      await harness.commandHandlers.goal_resume?.(makeCommandCtx("test-run", 801));

      await waitForAssertion(() => {
        expect(
          harness.sendMessage.mock.calls.some(
            (call) => call[1] === RESUME_PREFACE && hasReplyMessageId(call, 801),
          ),
        ).toBe(true);
      });

      await harness.commandHandlers.goal_resume?.(makeCommandCtx("missing-resume", 802));

      expect(
        harness.sendMessage.mock.calls.some(
          (call) =>
            String(call[1]).includes("Run not found: missing-resume") &&
            hasReplyMessageId(call, 802),
        ),
      ).toBe(true);
    });

    it("threads replies for /goal_approve usage responses", async () => {
      const harness = makeHarness();
      await harness.register();

      await harness.commandHandlers.goal_approve?.(makeCommandCtx("", 803));

      expect(
        harness.sendMessage.mock.calls.some(
          (call) =>
            String(call[1]).includes("Usage: /goal_approve") && hasReplyMessageId(call, 803),
        ),
      ).toBe(true);
    });

    it("threads replies for /goal_resume usage responses", async () => {
      const harness = makeHarness();
      await harness.register();

      await harness.commandHandlers.goal_resume?.(makeCommandCtx("", 804));

      expect(
        harness.sendMessage.mock.calls.some(
          (call) => String(call[1]).includes("Usage: /goal_resume") && hasReplyMessageId(call, 804),
        ),
      ).toBe(true);
    });

    it("threads replies for /goal_status and /goal_detail responses", async () => {
      saveRunFixture(makeRun({ plan: null }));
      mockGoalStatusCommand.mockImplementation(
        async (_id: unknown, _opts: unknown, runtime: { log: (...args: unknown[]) => void }) => {
          runtime.log("Run: test-run-id-1234");
          runtime.log("State: awaiting_approval");
        },
      );
      mockGoalDetailCommand.mockImplementation(
        async (_id: unknown, _opts: unknown, runtime: { log: (...args: unknown[]) => void }) => {
          runtime.log("Run: test-run-id-1234");
          runtime.log("**Steps**");
          runtime.log("- 1. pending Step one");
        },
      );

      const harness = makeHarness();
      await harness.register();

      await harness.commandHandlers.goal_status?.(makeCommandCtx("test-run", 901));
      expect(
        harness.sendMessage.mock.calls.some(
          (call) =>
            String(call[1]).includes("Run: test-run-id-1234") && hasReplyMessageId(call, 901),
        ),
      ).toBe(true);

      await harness.commandHandlers.goal_detail?.(makeCommandCtx("test-run", 902));
      expect(
        harness.sendMessage.mock.calls.some(
          (call) => String(call[1]).includes("Steps") && hasReplyMessageId(call, 902),
        ),
      ).toBe(true);
    });

    it("threads replies for /goal_reject responses", async () => {
      saveRunFixture(makeRun({ state: "awaiting_approval" }));
      const harness = makeHarness();
      await harness.register();

      await harness.commandHandlers.goal_reject?.(makeCommandCtx("test-run", 903));
      expect(
        harness.sendMessage.mock.calls.some(
          (call) => String(call[1]).includes("Plan rejected") && hasReplyMessageId(call, 903),
        ),
      ).toBe(true);
    });

    it("threads replies for reject emoji reactions", async () => {
      saveRunFixture(
        makeRun({
          state: "awaiting_approval",
          telegramPlanMessage: {
            chatId: 42,
            messageId: 904,
            threadId: 12,
          },
        }),
      );
      const harness = makeHarness();
      await harness.register();

      await harness.reactionHandler(makeReactionCtx(904, "👎"));

      expect(
        harness.sendMessage.mock.calls.some(
          (call) => String(call[1]).includes("Plan rejected") && hasReplyMessageId(call, 904),
        ),
      ).toBe(true);
    });

    it("threads replies for gD callback detail responses", async () => {
      const runId = "abcdef12-3456-7890-abcd-ef1234567890";
      saveRunFixture(makeRun({ runId, state: "awaiting_approval" }));
      mockGoalDetailCommand.mockImplementation(
        async (_id: unknown, _opts: unknown, runtime: { log: (...args: unknown[]) => void }) => {
          runtime.log("Run detail");
        },
      );

      const harness = makeHarness();
      await harness.register();

      await harness.callbackHandler(makeCallbackCtx("gD:abcdef12:1", 904));

      expect(harness.setMessageReaction).toHaveBeenCalledWith(42, 904, [
        { type: "emoji", emoji: "👀" },
      ]);
      const hasPhotoReply = harness.sendPhoto.mock.calls.some((call) => {
        const options = call[2] as { reply_parameters?: { message_id?: number } } | undefined;
        return options?.reply_parameters?.message_id === 904;
      });
      expect(hasPhotoReply).toBe(true);
    });

    it("threads replies for gStop callback responses", async () => {
      const runId = "abcdef12-3456-7890-abcd-ef1234567890";
      saveRunFixture(makeRun({ runId, state: "blocked" }));
      mockGoalStopCommand.mockImplementation(
        async (_id: unknown, _opts: unknown, runtime: { log: (...args: unknown[]) => void }) => {
          runtime.log("Goal stopped.");
        },
      );

      const harness = makeHarness();
      await harness.register();

      await harness.callbackHandler(makeCallbackCtx("gStop:abcdef12", 905));

      expect(
        harness.sendMessage.mock.calls.some(
          (call) => String(call[1]).includes("Goal stopped.") && hasReplyMessageId(call, 905),
        ),
      ).toBe(true);
    });

    it("threads replies for /goal_list responses", async () => {
      saveRunFixture(makeRun({ runId: "abcdef12-3456-7890-abcd-ef1234567890" }));
      const harness = makeHarness();
      await harness.register();

      await harness.commandHandlers.goal_list?.(makeCommandCtx("", 906));

      expect(harness.sendMessage.mock.calls.some((call) => hasReplyMessageId(call, 906))).toBe(
        true,
      );
    });

    it("threads replies for /goal_stop usage responses", async () => {
      const harness = makeHarness();
      await harness.register();

      await harness.commandHandlers.goal_stop?.(makeCommandCtx("", 907));

      expect(
        harness.sendMessage.mock.calls.some(
          (call) => String(call[1]).includes("Usage: /goal_stop") && hasReplyMessageId(call, 907),
        ),
      ).toBe(true);
    });

    it("threads replies for /goal_edit usage responses", async () => {
      const harness = makeHarness();
      await harness.register();

      await harness.commandHandlers.goal_edit?.(makeCommandCtx("abcdef12", 908));

      expect(
        harness.sendMessage.mock.calls.some(
          (call) => String(call[1]).includes("Usage: /goal_edit") && hasReplyMessageId(call, 908),
        ),
      ).toBe(true);
    });

    it("threads replies for /goal_answer usage, run-not-found, and lock responses", async () => {
      saveRunFixture(
        makeRun({
          state: "blocked",
          blocked: {
            blockedAt: "execution",
            prompt: "Need details",
            requiredInputKey: "task:1:input",
          },
        }),
      );
      let resolveAnswer: ((value: unknown) => void) | undefined;
      mockGoalAnswerCommand.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveAnswer = resolve;
          }),
      );

      const harness = makeHarness();
      await harness.register();

      await harness.commandHandlers.goal_answer?.(makeCommandCtx("test-run", 912));
      expect(
        harness.sendMessage.mock.calls.some(
          (call) => String(call[1]).includes("Usage: /goal_answer") && hasReplyMessageId(call, 912),
        ),
      ).toBe(true);

      await harness.commandHandlers.goal_answer?.(makeCommandCtx("missing-answer value", 913));
      expect(
        harness.sendMessage.mock.calls.some(
          (call) =>
            String(call[1]).includes("Run not found: missing-answer") &&
            hasReplyMessageId(call, 913),
        ),
      ).toBe(true);

      await harness.commandHandlers.goal_answer?.(makeCommandCtx("test-run value", 914));
      await harness.commandHandlers.goal_answer?.(makeCommandCtx("test-run other", 915));

      expect(
        harness.sendMessage.mock.calls.some(
          (call) =>
            String(call[1]).includes("already being processed") && hasReplyMessageId(call, 915),
        ),
      ).toBe(true);

      resolveAnswer?.({ status: "blocked", question: "Need details" });
      await waitForAssertion(() => {
        expect(mockGoalAnswerCommand).toHaveBeenCalledTimes(1);
      });
    });

    it("threads replies for /goal_feedback usage, run-not-found, and lock responses", async () => {
      saveRunFixture(makeRun({ state: "done" }));
      let resolveRevision: ((value: unknown) => void) | undefined;
      mockRunCliPlanRevision.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRevision = resolve;
          }),
      );

      const harness = makeHarness();
      await harness.register();

      await harness.commandHandlers.goal_feedback?.(makeCommandCtx("test-run", 916));
      expect(
        harness.sendMessage.mock.calls.some(
          (call) =>
            String(call[1]).includes("Usage: /goal_feedback") && hasReplyMessageId(call, 916),
        ),
      ).toBe(true);

      await harness.commandHandlers.goal_feedback?.(
        makeCommandCtx("missing-feedback details", 917),
      );
      expect(
        harness.sendMessage.mock.calls.some(
          (call) =>
            String(call[1]).includes("Run not found: missing-feedback") &&
            hasReplyMessageId(call, 917),
        ),
      ).toBe(true);

      await harness.commandHandlers.goal_feedback?.(makeCommandCtx("test-run looks wrong", 918));
      await harness.commandHandlers.goal_feedback?.(makeCommandCtx("test-run still wrong", 919));

      expect(
        harness.sendMessage.mock.calls.some(
          (call) =>
            String(call[1]).includes("already being processed") && hasReplyMessageId(call, 919),
        ),
      ).toBe(true);

      resolveRevision?.({
        plan: {
          blocked: true,
          question: "Need more details",
        },
      });
      await waitForAssertion(() => {
        expect(mockRunCliPlanRevision).toHaveBeenCalledTimes(1);
      });
    });

    it("threads replies for /goal_answer background string results", async () => {
      saveRunFixture(makeRun({ state: "awaiting_approval" }));
      const harness = makeHarness();
      await harness.register();

      await harness.commandHandlers.goal_answer?.(makeCommandCtx("test-run continue", 909));

      await waitForAssertion(() => {
        expect(
          harness.sendMessage.mock.calls.some(
            (call) =>
              String(call[1]).includes("Run is not awaiting input") && hasReplyMessageId(call, 909),
          ),
        ).toBe(true);
      });
    });

    it("threads replies for /goal_answer background plan results", async () => {
      saveRunFixture(
        makeRun({
          state: "blocked",
          blocked: {
            blockedAt: "planning",
            prompt: "Need a value",
            requiredInputKey: "db_type",
          },
        }),
      );
      mockGoalAnswerCommand.mockResolvedValue({ status: "done" });
      mockGoalResumeCommand.mockResolvedValue({ status: "done" });
      const harness = makeHarness();
      await harness.register();

      await harness.commandHandlers.goal_answer?.(makeCommandCtx("test-run postgres", 910));

      await waitForAssertion(() => {
        const hasPhotoReply = harness.sendPhoto.mock.calls.some((call) => {
          const options = call[2] as { reply_parameters?: { message_id?: number } } | undefined;
          return options?.reply_parameters?.message_id === 910;
        });
        expect(hasPhotoReply).toBe(true);
      });
    });

    it("threads replies for /goal_feedback background string results", async () => {
      saveRunFixture(makeRun({ state: "done" }));
      mockRunCliPlanRevision.mockResolvedValue({
        plan: {
          blocked: true,
          question: "Need reproduction steps",
        },
      });
      const harness = makeHarness();
      await harness.register();

      await harness.commandHandlers.goal_feedback?.(makeCommandCtx("test-run user feedback", 911));

      await waitForAssertion(() => {
        expect(
          harness.sendMessage.mock.calls.some(
            (call) =>
              String(call[1]).includes("Feedback replan blocked: Need reproduction steps") &&
              hasReplyMessageId(call, 911),
          ),
        ).toBe(true);
      });
    });

    it("threads replies for /goal_edit background preface and result", async () => {
      const runId = "abcdef12-3456-7890-abcd-ef1234567890";
      saveRunFixture(makeRun({ runId, state: "done" }));
      const harness = makeHarness();
      await harness.register();
      const { PLANNING_PREFACE } = await import("./goal-commands.js");

      await harness.commandHandlers.goal_edit?.(makeCommandCtx("abcdef12 revise plan", 909));

      await waitForAssertion(() => {
        expect(
          harness.sendMessage.mock.calls.some(
            (call) => call[1] === PLANNING_PREFACE && hasReplyMessageId(call, 909),
          ),
        ).toBe(true);
      });

      await waitForAssertion(() => {
        expect(
          harness.sendMessage.mock.calls.some(
            (call) =>
              String(call[1]).includes("Cannot edit: run is in") && hasReplyMessageId(call, 909),
          ),
        ).toBe(true);
      });
    });
  });

  describe("withChatAction", () => {
    it("calls sendChatAction before and during fn execution", async () => {
      const sendChatAction = vi.fn().mockResolvedValue(true);
      const mockBot = { api: { sendChatAction } } as unknown as import("grammy").Bot;

      const { withChatAction } = await import("./goal-commands.js");
      const result = await withChatAction({
        bot: mockBot,
        chatId: 42,
        action: "typing",
        label: "test",
        fn: async () => {
          // sendChatAction should have been called once before fn runs
          expect(sendChatAction).toHaveBeenCalledTimes(1);
          expect(sendChatAction).toHaveBeenCalledWith(42, "typing");
          return "done";
        },
      });

      expect(result).toBe("done");
      // At least the initial call
      expect(sendChatAction).toHaveBeenCalledWith(42, "typing");
    });

    it("passes message_thread_id when threadId is provided", async () => {
      const sendChatAction = vi.fn().mockResolvedValue(true);
      const raw = { sendChatAction: vi.fn().mockResolvedValue(true) };
      const mockBot = { api: { sendChatAction, raw } } as unknown as import("grammy").Bot;

      const { withChatAction } = await import("./goal-commands.js");
      await withChatAction({
        bot: mockBot,
        chatId: 42,
        action: "typing",
        threadId: 7,
        fn: async () => "ok",
      });

      expect(raw.sendChatAction).toHaveBeenCalledWith({
        chat_id: 42,
        action: "typing",
        message_thread_id: 7,
      });
      // Standard sendChatAction should NOT be called when using raw API for threads
      expect(sendChatAction).not.toHaveBeenCalled();
    });

    it("clears interval even if fn throws", async () => {
      const sendChatAction = vi.fn().mockResolvedValue(true);
      const mockBot = { api: { sendChatAction } } as unknown as import("grammy").Bot;

      const { withChatAction } = await import("./goal-commands.js");
      await expect(
        withChatAction({
          bot: mockBot,
          chatId: 42,
          action: "typing",
          fn: async () => {
            throw new Error("boom");
          },
        }),
      ).rejects.toThrow("boom");

      // sendChatAction should still have been called (the initial fire)
      expect(sendChatAction).toHaveBeenCalled();
    });

    it("does not throw when sendChatAction rejects", async () => {
      const sendChatAction = vi.fn().mockRejectedValue(new Error("API error"));
      const mockBot = { api: { sendChatAction } } as unknown as import("grammy").Bot;

      const { withChatAction } = await import("./goal-commands.js");
      const result = await withChatAction({
        bot: mockBot,
        chatId: 42,
        action: "typing",
        fn: async () => "still works",
      });

      expect(result).toBe("still works");
    });
  });

  describe("withPlanningFeedback", () => {
    it("sends preface message before fn runs", async () => {
      const callOrder: string[] = [];
      const sendMessage = vi.fn().mockImplementation(async () => {
        callOrder.push("sendMessage");
        return { message_id: 1 };
      });
      const sendChatAction = vi.fn().mockResolvedValue(true);
      const mockBot = {
        api: { sendMessage, sendChatAction },
      } as unknown as import("grammy").Bot;

      const { withPlanningFeedback, PLANNING_PREFACE } = await import("./goal-commands.js");
      const result = await withPlanningFeedback({
        bot: mockBot,
        chatId: 42,
        label: "test",
        fn: async () => {
          callOrder.push("fn");
          return "planned";
        },
      });

      expect(result).toBe("planned");
      expect(callOrder).toEqual(["sendMessage", "fn"]);
      expect(sendMessage).toHaveBeenCalledWith(42, PLANNING_PREFACE, {});
    });

    it("passes message_thread_id for preface in forum topics", async () => {
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
      const sendChatAction = vi.fn().mockResolvedValue(true);
      const raw = { sendChatAction: vi.fn().mockResolvedValue(true) };
      const mockBot = {
        api: { sendMessage, sendChatAction, raw },
      } as unknown as import("grammy").Bot;

      const { withPlanningFeedback, PLANNING_PREFACE } = await import("./goal-commands.js");
      await withPlanningFeedback({
        bot: mockBot,
        chatId: 42,
        threadId: 7,
        fn: async () => "ok",
      });

      expect(sendMessage).toHaveBeenCalledWith(42, PLANNING_PREFACE, { message_thread_id: 7 });
      // Typing uses raw API for thread-scoped chat action
      expect(raw.sendChatAction).toHaveBeenCalledWith({
        chat_id: 42,
        action: "typing",
        message_thread_id: 7,
      });
    });

    it("starts typing immediately even for fast operations", async () => {
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
      const sendChatAction = vi.fn().mockResolvedValue(true);
      const mockBot = {
        api: { sendMessage, sendChatAction },
      } as unknown as import("grammy").Bot;

      const { withPlanningFeedback } = await import("./goal-commands.js");
      await withPlanningFeedback({
        bot: mockBot,
        chatId: 42,
        fn: async () => "fast",
      });

      // Typing now starts immediately (no 2s delay)
      expect(sendChatAction).toHaveBeenCalledWith(42, "typing");
    });

    it("still runs fn if preface message fails", async () => {
      const sendMessage = vi.fn().mockRejectedValue(new Error("send failed"));
      const sendChatAction = vi.fn().mockResolvedValue(true);
      const mockBot = {
        api: { sendMessage, sendChatAction },
      } as unknown as import("grammy").Bot;

      const { withPlanningFeedback } = await import("./goal-commands.js");
      const result = await withPlanningFeedback({
        bot: mockBot,
        chatId: 42,
        fn: async () => "still planned",
      });

      expect(result).toBe("still planned");
    });

    it("clears timers even if fn throws", async () => {
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
      const sendChatAction = vi.fn().mockResolvedValue(true);
      const mockBot = {
        api: { sendMessage, sendChatAction },
      } as unknown as import("grammy").Bot;

      const { withPlanningFeedback } = await import("./goal-commands.js");
      await expect(
        withPlanningFeedback({
          bot: mockBot,
          chatId: 42,
          fn: async () => {
            throw new Error("boom");
          },
        }),
      ).rejects.toThrow("boom");

      expect(sendMessage).toHaveBeenCalled();
    });
  });

  describe("runGoalInBackground", () => {
    it("sends start preface before background work starts", async () => {
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
      const sendChatAction = vi.fn().mockResolvedValue(true);
      const mockBot = {
        api: { sendMessage, sendChatAction },
      } as unknown as import("grammy").Bot;

      const fn = vi.fn(async () => "ok");
      let resolveDone: (() => void) | undefined;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const onResult = vi.fn(async () => {
        resolveDone?.();
      });

      const { runGoalInBackground, START_PREFACE } = await import("./goal-commands.js");
      runGoalInBackground({
        bot: mockBot,
        chatId: 42,
        runtime: {
          log: vi.fn(),
          error: vi.fn(),
          exit: ((_: number) => {
            throw new Error("exit called");
          }) as never,
        },
        label: "start-test",
        preface: START_PREFACE,
        fn,
        onResult,
      });

      await done;
      expect(sendMessage).toHaveBeenCalledWith(42, START_PREFACE, {});
      expect(sendMessage.mock.invocationCallOrder[0]).toBeLessThan(fn.mock.invocationCallOrder[0]);
    });

    it("sends resume preface before background work starts", async () => {
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
      const sendChatAction = vi.fn().mockResolvedValue(true);
      const mockBot = {
        api: { sendMessage, sendChatAction },
      } as unknown as import("grammy").Bot;

      const fn = vi.fn(async () => "ok");
      let resolveDone: (() => void) | undefined;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const onResult = vi.fn(async () => {
        resolveDone?.();
      });

      const { runGoalInBackground, RESUME_PREFACE } = await import("./goal-commands.js");
      runGoalInBackground({
        bot: mockBot,
        chatId: 42,
        runtime: {
          log: vi.fn(),
          error: vi.fn(),
          exit: ((_: number) => {
            throw new Error("exit called");
          }) as never,
        },
        label: "resume-test",
        preface: RESUME_PREFACE,
        fn,
        onResult,
      });

      await done;
      expect(sendMessage).toHaveBeenCalledWith(42, RESUME_PREFACE, {});
      expect(sendMessage.mock.invocationCallOrder[0]).toBeLessThan(fn.mock.invocationCallOrder[0]);
    });

    it("threads reply parameters into the preface acknowledgement", async () => {
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
      const sendChatAction = vi.fn().mockResolvedValue(true);
      const mockBot = {
        api: { sendMessage, sendChatAction },
      } as unknown as import("grammy").Bot;

      const fn = vi.fn(async () => "ok");
      let resolveDone: (() => void) | undefined;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const onResult = vi.fn(async () => {
        resolveDone?.();
      });

      const { runGoalInBackground, START_PREFACE } = await import("./goal-commands.js");
      runGoalInBackground({
        bot: mockBot,
        chatId: 42,
        runtime: {
          log: vi.fn(),
          error: vi.fn(),
          exit: ((_: number) => {
            throw new Error("exit called");
          }) as never,
        },
        label: "reply-param-test",
        preface: START_PREFACE,
        replyToMessageId: 55,
        fn,
        onResult,
      });

      await done;
      expect(sendMessage).toHaveBeenCalledWith(42, START_PREFACE, {
        reply_parameters: { message_id: 55 },
      });
    });
  });

  describe("getGoalExecutionPreface", () => {
    it("uses start preface for awaiting approval runs", async () => {
      const { getGoalExecutionPreface, START_PREFACE } = await import("./goal-commands.js");
      expect(getGoalExecutionPreface("awaiting_approval")).toBe(START_PREFACE);
    });

    it("uses start preface for cancelled runs pending re-approval", async () => {
      const { getGoalExecutionPreface, START_PREFACE } = await import("./goal-commands.js");
      expect(getGoalExecutionPreface("cancelled")).toBe(START_PREFACE);
    });

    it("uses resume preface for resumable non-approval states", async () => {
      const { getGoalExecutionPreface, RESUME_PREFACE } = await import("./goal-commands.js");
      expect(getGoalExecutionPreface("blocked")).toBe(RESUME_PREFACE);
      expect(getGoalExecutionPreface("executing")).toBe(RESUME_PREFACE);
      expect(getGoalExecutionPreface("planning")).toBe(RESUME_PREFACE);
      expect(getGoalExecutionPreface("done")).toBe(RESUME_PREFACE);
    });
  });

  describe("startTypingLoop", () => {
    it("sends typing action immediately on start", async () => {
      const sendChatAction = vi.fn().mockResolvedValue(true);
      const mockBot = { api: { sendChatAction } } as unknown as import("grammy").Bot;

      const { startTypingLoop } = await import("./typing-loop.js");
      const loop = startTypingLoop({ bot: mockBot, chatId: 42, label: "test" });

      expect(sendChatAction).toHaveBeenCalledTimes(1);
      expect(sendChatAction).toHaveBeenCalledWith(42, "typing");
      loop.stop();
    });

    it("stops cleanly via stop() — no more calls after stop", async () => {
      vi.useFakeTimers();
      const sendChatAction = vi.fn().mockResolvedValue(true);
      const mockBot = { api: { sendChatAction } } as unknown as import("grammy").Bot;

      const { startTypingLoop } = await import("./typing-loop.js");
      const loop = startTypingLoop({ bot: mockBot, chatId: 42 });
      expect(sendChatAction).toHaveBeenCalledTimes(1);

      loop.stop();
      vi.advanceTimersByTime(8000);
      // No additional calls after stop
      expect(sendChatAction).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it("prevents per-chat overlap (stops previous loop)", async () => {
      vi.useFakeTimers();
      const sendChatAction = vi.fn().mockResolvedValue(true);
      const mockBot = { api: { sendChatAction } } as unknown as import("grammy").Bot;

      const { startTypingLoop } = await import("./typing-loop.js");
      const loop1 = startTypingLoop({ bot: mockBot, chatId: 42, label: "first" });
      expect(sendChatAction).toHaveBeenCalledTimes(1);

      // Second loop for same chat should stop the first
      const loop2 = startTypingLoop({ bot: mockBot, chatId: 42, label: "second" });
      expect(sendChatAction).toHaveBeenCalledTimes(2);

      // Advance time — only loop2's interval should fire
      vi.advanceTimersByTime(4000);
      expect(sendChatAction).toHaveBeenCalledTimes(3);

      loop2.stop();
      vi.useRealTimers();
      // loop1.stop() is safe to call (idempotent, already stopped by overlap)
      loop1.stop();
    });

    it("keeps independent loops for different threadIds", async () => {
      const sendChatAction = vi.fn().mockResolvedValue(true);
      const raw = { sendChatAction: vi.fn().mockResolvedValue(true) };
      const mockBot = {
        api: { sendChatAction, raw },
      } as unknown as import("grammy").Bot;

      const { startTypingLoop } = await import("./typing-loop.js");
      const loop1 = startTypingLoop({ bot: mockBot, chatId: 42, threadId: 1 });
      const loop2 = startTypingLoop({ bot: mockBot, chatId: 42, threadId: 2 });

      // Both should be active (different threads) — each fires once
      expect(raw.sendChatAction).toHaveBeenCalledTimes(2);
      loop1.stop();
      loop2.stop();
    });

    it("does not throw when sendChatAction rejects", async () => {
      const sendChatAction = vi.fn().mockRejectedValue(new Error("API error"));
      const mockBot = { api: { sendChatAction } } as unknown as import("grammy").Bot;

      const { startTypingLoop } = await import("./typing-loop.js");
      const loop = startTypingLoop({ bot: mockBot, chatId: 42 });

      // Should not throw; error is caught internally
      expect(sendChatAction).toHaveBeenCalled();
      loop.stop();
    });

    it("stop() is idempotent", async () => {
      const sendChatAction = vi.fn().mockResolvedValue(true);
      const mockBot = { api: { sendChatAction } } as unknown as import("grammy").Bot;

      const { startTypingLoop } = await import("./typing-loop.js");
      const loop = startTypingLoop({ bot: mockBot, chatId: 42 });

      loop.stop();
      loop.stop(); // second call should not throw
    });

    it("uses raw API when threadId is provided", async () => {
      const sendChatAction = vi.fn().mockResolvedValue(true);
      const raw = { sendChatAction: vi.fn().mockResolvedValue(true) };
      const mockBot = {
        api: { sendChatAction, raw },
      } as unknown as import("grammy").Bot;

      const { startTypingLoop } = await import("./typing-loop.js");
      const loop = startTypingLoop({ bot: mockBot, chatId: 42, threadId: 7 });

      // Should use raw API for thread-scoped typing
      expect(raw.sendChatAction).toHaveBeenCalledWith({
        chat_id: 42,
        action: "typing",
        message_thread_id: 7,
      });
      expect(sendChatAction).not.toHaveBeenCalled();
      loop.stop();
    });
  });

  describe("findRunByPlanMessageId", () => {
    it("matches latest messageId", async () => {
      saveRunFixture(
        makeRun({
          telegramPlanMessage: { chatId: 123, messageId: 456 },
        }),
      );

      const { findRunByPlanMessageId } = await import("./goal-commands.js");
      const run = findRunByPlanMessageId(123, 456);
      expect(run).toBeDefined();
      expect(run!.runId).toBe("test-run-id-1234");
    });

    it("matches history messageId", async () => {
      saveRunFixture(
        makeRun({
          telegramPlanMessage: { chatId: 123, messageId: 789, messageHistory: [456] },
        }),
      );

      const { findRunByPlanMessageId } = await import("./goal-commands.js");
      const run = findRunByPlanMessageId(123, 456);
      expect(run).toBeDefined();
      expect(run!.runId).toBe("test-run-id-1234");
    });

    it("returns undefined for non-goal messages", async () => {
      saveRunFixture(
        makeRun({
          telegramPlanMessage: { chatId: 123, messageId: 456 },
        }),
      );

      const { findRunByPlanMessageId } = await import("./goal-commands.js");
      expect(findRunByPlanMessageId(123, 999)).toBeUndefined();
      expect(findRunByPlanMessageId(999, 456)).toBeUndefined();
    });

    it("returns undefined when no runs have telegramPlanMessage", async () => {
      saveRunFixture(makeRun());

      const { findRunByPlanMessageId } = await import("./goal-commands.js");
      expect(findRunByPlanMessageId(123, 456)).toBeUndefined();
    });
  });
});
