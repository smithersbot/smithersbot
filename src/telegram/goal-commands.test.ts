import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRun, saveRun } from "../goal/run-store.js";
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

const mockGoalListCommand = vi.fn();
vi.mock("../commands/goal-list.js", () => ({
  goalListCommand: (...args: unknown[]) => mockGoalListCommand(...args),
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
          tool: { name: "mkdir", args: { path: "out" } },
          status: "pending",
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
      expect(result).toContain("Usage:");
    });

    it("creates a plan-only run and returns plan text with hints", async () => {
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
      expect(callArgs.diagram).toBe("mermaid");
      expect(callArgs.runId).toBeDefined();

      expect(result).toContain("## Plan");
      expect(result).toContain("/goal_approve");
      expect(result).toContain("/goal_reject");
      expect(result).toContain("Run ID:");
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

      expect(result).toContain("BLOCKED");
      expect(result).toContain("/goal_answer");
    });

    it("handles error from goalCommand", async () => {
      mockGoalCommand.mockRejectedValue(new Error("API key missing"));

      const { handleGoal } = await import("./goal-commands.js");
      const result = await handleGoal("Do something");

      expect(result).toContain("Error:");
      expect(result).toContain("API key missing");
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

    it("executes an approved run", async () => {
      saveRun(makeRun());
      mockGoalResumeCommand.mockImplementation(
        async (_id: unknown, _opts: unknown, runtime: { log: (...args: unknown[]) => void }) => {
          runtime.log("DONE: All steps completed.");
          return { status: "done", summary: "All steps completed." };
        },
      );

      const { handleGoalApprove } = await import("./goal-commands.js");
      const result = await handleGoalApprove("test-run");

      expect(mockGoalResumeCommand).toHaveBeenCalledOnce();
      expect(mockGoalResumeCommand.mock.calls[0][1]).toEqual({ yes: true });
      expect(result).toContain("DONE");
    });

    it("shows answer hint when execution is blocked", async () => {
      saveRun(makeRun());
      mockGoalResumeCommand.mockImplementation(
        async (_id: unknown, _opts: unknown, runtime: { log: (...args: unknown[]) => void }) => {
          runtime.log("BLOCKED: Need credentials");
          return { status: "blocked", question: "Need credentials", requiredInputKey: "creds" };
        },
      );

      const { handleGoalApprove } = await import("./goal-commands.js");
      const result = await handleGoalApprove("test-run");
      expect(result).toContain("/goal_answer");
    });
  });

  describe("handleGoalReject", () => {
    it("returns usage on empty input", async () => {
      const { handleGoalReject } = await import("./goal-commands.js");
      const result = await handleGoalReject("");
      expect(result).toContain("Usage:");
    });

    it("rejects an awaiting_approval run", async () => {
      saveRun(makeRun({ state: "awaiting_approval" }));

      const { handleGoalReject } = await import("./goal-commands.js");
      const result = await handleGoalReject("test-run");

      expect(result).toContain("rejected");
      const run = loadRun("test-run-id-1234", testGoalsDir);
      expect(run).toBeDefined();
      expect(run!.state).toBe("rejected");
    });

    it("refuses to reject a non-awaiting_approval run", async () => {
      saveRun(makeRun({ state: "done" }));

      const { handleGoalReject } = await import("./goal-commands.js");
      const result = await handleGoalReject("test-run");
      expect(result).toContain("Cannot reject");
      expect(result).toContain("done");
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

  describe("handleGoalAnswer", () => {
    it("returns usage on empty input", async () => {
      const { handleGoalAnswer } = await import("./goal-commands.js");
      const result = await handleGoalAnswer("", "");
      expect(result).toContain("Usage:");
    });

    it("auto-resolves key and calls goalAnswerCommand", async () => {
      saveRun(
        makeRun({
          state: "blocked",
          blocked: { prompt: "What password?", requiredInputKey: "db_password" },
        }),
      );

      mockGoalAnswerCommand.mockImplementation(
        async (_id: unknown, _opts: unknown, runtime: { log: (...args: unknown[]) => void }) => {
          runtime.log('Answer saved for key "db_password".');
        },
      );

      const { handleGoalAnswer } = await import("./goal-commands.js");
      const result = await handleGoalAnswer("test-run", "s3cret");

      expect(mockGoalAnswerCommand).toHaveBeenCalledOnce();
      const [id, opts] = mockGoalAnswerCommand.mock.calls[0];
      expect(id).toBe("test-run-id-1234");
      expect(opts.key).toBe("db_password");
      expect(opts.value).toBe("s3cret");
      expect(result).toContain("Answer saved");
      expect(result).toContain("/goal_approve");
    });

    it("returns error for non-blocked run", async () => {
      saveRun(makeRun({ state: "done", blocked: null }));

      const { handleGoalAnswer } = await import("./goal-commands.js");
      const result = await handleGoalAnswer("test-run", "val");
      expect(result).toContain("not blocked");
    });

    it("returns error for unknown run", async () => {
      const { handleGoalAnswer } = await import("./goal-commands.js");
      const result = await handleGoalAnswer("nonexistent", "val");
      expect(result).toContain("Run not found");
    });
  });

  describe("handleGoalList", () => {
    it("returns list output", async () => {
      mockGoalListCommand.mockImplementation(
        async (_opts: unknown, runtime: { log: (...args: unknown[]) => void }) => {
          runtime.log("Goal runs:");
          runtime.log("  abc12345  done                  1/1 steps    Build website");
        },
      );

      const { handleGoalList } = await import("./goal-commands.js");
      const result = await handleGoalList();
      expect(result).toContain("Goal runs:");
      expect(result).toContain("abc12345");
    });

    it("returns no runs message when empty", async () => {
      mockGoalListCommand.mockImplementation(
        async (_opts: unknown, runtime: { log: (...args: unknown[]) => void }) => {
          runtime.log("No goal runs found.");
        },
      );

      const { handleGoalList } = await import("./goal-commands.js");
      const result = await handleGoalList();
      expect(result).toContain("No goal runs found.");
    });
  });
});
