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

const mockGoalAnswerCommand = vi.fn();
vi.mock("../commands/goal-answer.js", () => ({
  goalAnswerCommand: (...args: unknown[]) => mockGoalAnswerCommand(...args),
}));

// goal-list.js no longer imported by goal-commands (Telegram uses listRuns directly)

// Mocks for plan revision (handleGoalEdit)
const mockResolveApiKeyForProvider = vi.fn();
vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProvider: (...args: unknown[]) => mockResolveApiKeyForProvider(...args),
}));

const mockCreateGoalLlmClient = vi.fn();
vi.mock("../goal/llm-client.js", () => ({
  createGoalLlmClient: (...args: unknown[]) => mockCreateGoalLlmClient(...args),
}));

const mockGeneratePlan = vi.fn();
const mockGeneratePlanRevision = vi.fn();
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
  generatePlanRevision: (...args: unknown[]) => mockGeneratePlanRevision(...args),
  PlanParseError: MockPlanParseError,
  persistRawPlanResponse: vi.fn(),
}));

const mockFormatPlanOutput = vi.fn();
vi.mock("../goal/format-output.js", () => ({
  formatPlanOutput: (...args: unknown[]) => mockFormatPlanOutput(...args),
}));

const mockRenderMermaidToPng = vi.fn(() => Buffer.from("png"));
vi.mock("../goal/mermaid-png.js", () => ({
  renderMermaidToPng: (...args: unknown[]) => mockRenderMermaidToPng(...args),
}));

function makeRun(overrides: Partial<SerializedRun> = {}): SerializedRun {
  return {
    runId: "test-run-id-1234",
    goal: "Test goal",
    state: "awaiting_approval",
    plan: {
      goal: "Test goal",
      summary: "A test plan",
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

describe("goal-commands telegram adapter", () => {
  beforeEach(() => {
    testGoalsDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-tg-test-"));
    vi.clearAllMocks();
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
      saveRun(makeRun());
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
      saveRun(makeRun());
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
      saveRun(makeRun({ state: "done" }));

      const { handleGoalApprove } = await import("./goal-commands.js");
      const result = await handleGoalApprove("test-run");
      expect(result).toContain("already executing or complete");
      expect(mockGoalResumeCommand).not.toHaveBeenCalled();
    });

    it("returns no-op for already executing run", async () => {
      saveRun(makeRun({ state: "executing" }));

      const { handleGoalApprove } = await import("./goal-commands.js");
      const result = await handleGoalApprove("test-run");
      expect(result).toContain("already executing or complete");
      expect(mockGoalResumeCommand).not.toHaveBeenCalled();
    });

    it("returns undefined when onStatusChange is provided (no stray message)", async () => {
      saveRun(makeRun());
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
      saveRun(makeRun());
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
      saveRun(makeRun());
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
      saveRun(makeRun());
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
      saveRun(makeRun({ state: "awaiting_approval" }));

      const { handleGoalReject } = await import("./goal-commands.js");
      const result = await handleGoalReject("test-run");

      expect(result).toContain("rejected");
      const run = loadRun("test-run-id-1234", testGoalsDir);
      expect(run).toBeDefined();
      expect(run!.state).toBe("cancelled");
    });

    it("refuses to reject a non-awaiting_approval run", async () => {
      saveRun(makeRun({ state: "done" }));

      const { handleGoalReject } = await import("./goal-commands.js");
      const result = await handleGoalReject("test-run");
      expect(result).toContain("Cannot reject");
      expect(result).toContain("done");
    });

    it("returns no-op for already cancelled run", async () => {
      saveRun(makeRun({ state: "cancelled" }));

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
    });
  });

  describe("sendGoalStatusResponse", () => {
    it("sends status as a DAG PNG when the run has a plan", async () => {
      saveRun(makeRun());
      mockGoalStatusCommand.mockImplementation(
        async (_id: unknown, _opts: unknown, runtime: { log: (...args: unknown[]) => void }) => {
          runtime.log("Run: test-run-id-1234");
          runtime.log("State: awaiting_approval");
        },
      );
      mockRenderMermaidToPng.mockReturnValue(Buffer.from("png"));

      const sendPhoto = vi.fn().mockResolvedValue({ message_id: 10 });
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 11 });
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
          caption: expect.stringContaining("Run: test-run-id-1234"),
        }),
      );
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("falls back to text when the run has no plan", async () => {
      saveRun(makeRun({ plan: null }));
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
      });

      expect(sendPhoto).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalled();
    });
  });

  describe("handleGoalAnswer", () => {
    it("returns usage on empty input", async () => {
      const { handleGoalAnswer } = await import("./goal-commands.js");
      const result = await handleGoalAnswer("", "");
      expect(result).toContain("Usage:");
    });

    it("auto-resolves key, passes quiet:true, and returns short ack", async () => {
      saveRun(
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
      saveRun(makeRun({ state: "done", blocked: null }));

      const { handleGoalAnswer } = await import("./goal-commands.js");
      const result = await handleGoalAnswer("test-run", "val");
      expect(result).toContain("not awaiting input");
    });

    it("treats non-blocked 'resume' answers as an explicit resume request", async () => {
      saveRun(makeRun({ state: "cancelled", blocked: null }));
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
      saveRun(
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
      saveRun(
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
      saveRun(
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
      saveRun(
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
      saveRun(makeRun({ state: "executing" }));
      mockGoalResumeCommand.mockImplementation(async (_id: unknown, opts: unknown) => {
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
      expect(statusCb).toHaveBeenCalledWith(expect.objectContaining({ type: "fully_blocked" }));
    });

    it("returns blocked reply when resume blocks before status callback emits", async () => {
      saveRun(makeRun({ state: "executing" }));
      mockGoalResumeCommand.mockResolvedValue({
        status: "blocked",
        question: "Need credentials",
        requiredInputKey: "task:1:input",
        blockedAt: "execution",
      });

      const { handleGoalAnswer } = await import("./goal-commands.js");
      const statusCb = vi.fn();
      const result = await handleGoalAnswer("test-run", "resume", statusCb);

      expect(result).toContain("Run blocked: Need credentials");
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
      saveRun(
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

  describe("handleGoalEdit", () => {
    it("returns usage on empty input", async () => {
      const { handleGoalEdit } = await import("./goal-commands.js");
      const result = await handleGoalEdit("", "");
      expect(result.text).toContain("Usage:");
    });

    it("creates a revision", async () => {
      saveRun(makeRun());

      mockResolveApiKeyForProvider.mockResolvedValue({
        apiKey: "test-key",
        source: "env",
        mode: "api-key",
      });
      mockCreateGoalLlmClient.mockReturnValue({});

      const revisedPlan = {
        goal: "Test goal",
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
      mockGeneratePlanRevision.mockResolvedValue(revisedPlan);
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

      // Verify generatePlanRevision was called with run.goal
      expect(mockGeneratePlanRevision).toHaveBeenCalledOnce();
      expect(mockGeneratePlanRevision.mock.calls[0][1]).toBe("Test goal");
    });

    it("refuses non-awaiting_approval run", async () => {
      saveRun(makeRun({ state: "done" }));

      const { handleGoalEdit } = await import("./goal-commands.js");
      const result = await handleGoalEdit("test-run", "change it");
      expect(result.text).toContain("Cannot edit");
      expect(result.text).toContain("done");
    });

    it("refuses run without plan", async () => {
      saveRun(makeRun({ plan: null }));

      const { handleGoalEdit } = await import("./goal-commands.js");
      const result = await handleGoalEdit("test-run", "change it");
      expect(result.text).toContain("no plan");
    });

    it("returns error when no API key available", async () => {
      saveRun(makeRun());
      mockResolveApiKeyForProvider.mockRejectedValue(
        new Error('No API key found for provider "anthropic".'),
      );

      const { handleGoalEdit } = await import("./goal-commands.js");
      const result = await handleGoalEdit("test-run", "change it");
      expect(result.text).toContain("API key");
    });

    it("returns error for unknown run", async () => {
      const { handleGoalEdit } = await import("./goal-commands.js");
      const result = await handleGoalEdit("nonexistent", "change it");
      expect(result.text).toContain("Run not found");
    });

    it("handles blocked revision", async () => {
      saveRun(makeRun());
      mockResolveApiKeyForProvider.mockResolvedValue({
        apiKey: "test-key",
        source: "env",
        mode: "api-key",
      });
      mockCreateGoalLlmClient.mockReturnValue({});
      mockGeneratePlanRevision.mockResolvedValue({
        blocked: true,
        question: "What framework?",
      });

      const { handleGoalEdit } = await import("./goal-commands.js");
      const result = await handleGoalEdit("test-run", "use a framework");
      expect(result.text).toContain("Revision blocked");
      expect(result.text).toContain("What framework?");
      expect(result.blocked).toBe(true);
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
      saveRun(
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
      saveRun(
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
      saveRun(
        makeRun({
          telegramPlanMessage: { chatId: 123, messageId: 456 },
        }),
      );

      const { findRunByPlanMessageId } = await import("./goal-commands.js");
      expect(findRunByPlanMessageId(123, 999)).toBeUndefined();
      expect(findRunByPlanMessageId(999, 456)).toBeUndefined();
    });

    it("returns undefined when no runs have telegramPlanMessage", async () => {
      saveRun(makeRun());

      const { findRunByPlanMessageId } = await import("./goal-commands.js");
      expect(findRunByPlanMessageId(123, 456)).toBeUndefined();
    });
  });
});
