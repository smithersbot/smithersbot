import { describe, expect, it, vi, beforeEach } from "vitest";
import type { GoalSession, Plan, PlanStep } from "./types.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock getModel
vi.mock("@mariozechner/pi-ai", () => ({
  getModel: vi.fn(() => ({ id: "mock-model" })),
}));

// Mock agent paths + config
vi.mock("../agents/agent-paths.js", () => ({
  resolveMoltbotAgentDir: vi.fn(() => "/tmp/mock-agent-dir"),
}));
vi.mock("../agents/models-config.js", () => ({
  ensureMoltbotModelsJson: vi.fn(async () => {}),
}));
vi.mock("../agents/model-auth.js", () => ({
  resolveEnvApiKey: vi.fn(() => ({ apiKey: "sk-test", source: "env" })),
}));

// Mock run-store
vi.mock("./run-store.js", () => ({
  resolveAgentSessionFile: vi.fn(() => "/tmp/mock-session.jsonl"),
}));

// Mock createGoalTools — dual-signal tracking mirrors the real implementation
let mockBlockedSignal: { question: string; context?: string } | null = null;
let mockCompleteSignal: { summary: string } | null = null;
const mockReset = vi.fn(() => {
  mockBlockedSignal = null;
  mockCompleteSignal = null;
});
function getMockSignal(): { type: string; summary?: string; question?: string } | null {
  if (mockBlockedSignal) return { type: "user_input_needed", question: mockBlockedSignal.question };
  if (mockCompleteSignal) return { type: "task_complete", summary: mockCompleteSignal.summary };
  return null;
}
vi.mock("./goal-tools.js", () => ({
  createGoalTools: vi.fn(() => ({
    tools: [],
    getSignal: () => getMockSignal(),
    reset: () => mockReset(),
  })),
}));

// Mock the PI coding agent SDK
const mockPrompt = vi.fn();
const mockAbort = vi.fn();
const mockDispose = vi.fn();
const mockSubscribe = vi.fn(() => () => {});

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: vi.fn(async () => ({
    session: {
      prompt: (...args: unknown[]) => mockPrompt(...args),
      abort: () => mockAbort(),
      dispose: () => mockDispose(),
      subscribe: (...args: unknown[]) => mockSubscribe(...args),
    },
  })),
  createCodingTools: vi.fn(() => []),
  discoverAuthStorage: vi.fn(() => ({
    setRuntimeApiKey: vi.fn(),
  })),
  discoverModels: vi.fn(() => ({})),
  SessionManager: { open: vi.fn(() => ({})) },
  SettingsManager: { inMemory: vi.fn(() => ({})) },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: "1",
    description: "Create file",
    dependsOn: [],
    tool: { name: "file_write", args: { path: "test.txt", content: "hello" } },
    status: "pending",
    ...overrides,
  };
}

function makePlan(steps: PlanStep[]): Plan {
  return { goal: "Test goal", steps, summary: "Test plan" };
}

function makeSession(plan: Plan): GoalSession {
  return {
    goal: plan.goal,
    state: "awaiting_approval",
    plan,
    stepResults: new Map(),
    blocked: null,
    answers: {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agent-executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBlockedSignal = null;
    mockCompleteSignal = null;
  });

  describe("executeGoalWithAgent", () => {
    it("completes a single task in 1 turn via mark_task_complete", async () => {
      const step = makeStep();
      const plan = makePlan([step]);
      const session = makeSession(plan);

      // After first prompt, signal task_complete
      mockPrompt.mockImplementation(async () => {
        mockCompleteSignal = { summary: "File created" };
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const result = await executeGoalWithAgent({
        session,
        runId: "test-run-1",
        workingDir: "/tmp/ws",
      });

      expect(result.status).toBe("done");
      expect(result).toHaveProperty("summary");
      expect(step.status).toBe("done");
      expect(step.taskSummary).toBe("File created");
      expect(mockPrompt).toHaveBeenCalledOnce();
    });

    it("completes a task after multiple turns", async () => {
      const step = makeStep();
      const plan = makePlan([step]);
      const session = makeSession(plan);

      let callCount = 0;
      mockPrompt.mockImplementation(async () => {
        callCount++;
        if (callCount === 3) {
          mockCompleteSignal = { summary: "Done after 3 turns" };
        }
        // Turns 1-2: no signal (agent responds naturally)
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const result = await executeGoalWithAgent({
        session,
        runId: "test-run-2",
        workingDir: "/tmp/ws",
      });

      expect(result.status).toBe("done");
      expect(mockPrompt).toHaveBeenCalledTimes(3);
      expect(step.turnsUsed).toBe(3);
    });

    it("blocks task when turn limit is hit", async () => {
      const step = makeStep();
      const plan = makePlan([step]);
      const session = makeSession(plan);

      // Never signal completion
      mockPrompt.mockResolvedValue(undefined);

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const result = await executeGoalWithAgent({
        session,
        runId: "test-run-3",
        workingDir: "/tmp/ws",
        maxTurnsPerTask: 3,
      });

      expect(result.status).toBe("blocked");
      expect(step.status).toBe("blocked");
      expect(step.blockedReason).toBe("turn_limit");
      expect(mockPrompt).toHaveBeenCalledTimes(3);
    });

    it("parks task on request_user_input and moves to next", async () => {
      const step1 = makeStep({ id: "1", description: "Step 1" });
      const step2 = makeStep({ id: "2", description: "Step 2" });
      const plan = makePlan([step1, step2]);
      const session = makeSession(plan);

      let promptIdx = 0;
      mockPrompt.mockImplementation(async () => {
        promptIdx++;
        if (promptIdx === 1) {
          // First task: request user input
          mockBlockedSignal = { question: "What DB?" };
        } else if (promptIdx === 2) {
          // Second task: complete
          mockCompleteSignal = { summary: "Step 2 done" };
        }
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const result = await executeGoalWithAgent({
        session,
        runId: "test-run-4",
        workingDir: "/tmp/ws",
      });

      expect(step1.status).toBe("blocked");
      expect(step1.blockedReason).toBe("user_input");
      expect(step1.blockedQuestion).toBe("What DB?");
      expect(step2.status).toBe("done");
      // Goal is blocked because task 1 is still blocked
      expect(result.status).toBe("blocked");
    });

    it("handles dependency ordering", async () => {
      const step1 = makeStep({ id: "1", description: "Create dir" });
      const step2 = makeStep({ id: "2", description: "Create file", dependsOn: ["1"] });
      const plan = makePlan([step2, step1]); // Deliberately out of order
      const session = makeSession(plan);

      const promptOrder: string[] = [];
      let promptIdx = 0;
      mockPrompt.mockImplementation(async (prompt: string) => {
        promptIdx++;
        // Extract task info from prompt
        const taskMatch = /task (\d+)/i.exec(prompt);
        if (taskMatch) promptOrder.push(taskMatch[1]!);
        mockCompleteSignal = { summary: `Task ${promptIdx} done` };
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const result = await executeGoalWithAgent({
        session,
        runId: "test-run-5",
        workingDir: "/tmp/ws",
      });

      expect(result.status).toBe("done");
      // Step 1 should execute before step 2 (dependency order)
      expect(promptOrder).toEqual(["1", "2"]);
    });

    it("skips tasks whose dependencies are blocked", async () => {
      const step1 = makeStep({ id: "1", description: "Step 1" });
      const step2 = makeStep({ id: "2", description: "Step 2", dependsOn: ["1"] });
      const plan = makePlan([step1, step2]);
      const session = makeSession(plan);

      mockPrompt.mockImplementation(async () => {
        mockBlockedSignal = { question: "Blocked" };
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const result = await executeGoalWithAgent({
        session,
        runId: "test-run-6",
        workingDir: "/tmp/ws",
      });

      expect(step1.status).toBe("blocked");
      expect(step2.status).toBe("skipped");
      expect(result.status).toBe("blocked");
      // Only step 1 should have been prompted (step 2 is unreachable)
      expect(mockPrompt).toHaveBeenCalledOnce();
    });

    it("handles prompt timeout error", async () => {
      const step = makeStep();
      const plan = makePlan([step]);
      const session = makeSession(plan);

      mockPrompt.mockRejectedValue(new Error("The operation was aborted"));

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const result = await executeGoalWithAgent({
        session,
        runId: "test-run-7",
        workingDir: "/tmp/ws",
      });

      expect(result.status).toBe("blocked");
      expect(step.status).toBe("blocked");
      expect(step.blockedReason).toBe("timeout");
    });

    it("handles prompt non-abort error", async () => {
      const step = makeStep();
      const plan = makePlan([step]);
      const session = makeSession(plan);

      mockPrompt.mockRejectedValue(new Error("Rate limit exceeded"));

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const result = await executeGoalWithAgent({
        session,
        runId: "test-run-8",
        workingDir: "/tmp/ws",
      });

      expect(result.status).toBe("blocked");
      expect(step.status).toBe("blocked");
      expect(step.blockedReason).toBe("error");
      expect(step.blockedQuestion).toContain("Rate limit exceeded");
    });

    it("calls onTaskUpdate for each task", async () => {
      const step1 = makeStep({ id: "1" });
      const step2 = makeStep({ id: "2" });
      const plan = makePlan([step1, step2]);
      const session = makeSession(plan);

      mockPrompt.mockImplementation(async () => {
        mockCompleteSignal = { summary: "done" };
      });

      const updates: string[] = [];
      const { executeGoalWithAgent } = await import("./agent-executor.js");
      await executeGoalWithAgent({
        session,
        runId: "test-run-9",
        workingDir: "/tmp/ws",
        onTaskUpdate: (result) => updates.push(result.taskId),
      });

      expect(updates).toEqual(["1", "2"]);
    });

    it("calls onProgress with status messages", async () => {
      const step = makeStep();
      const plan = makePlan([step]);
      const session = makeSession(plan);

      mockPrompt.mockImplementation(async () => {
        mockCompleteSignal = { summary: "done" };
      });

      const progress: string[] = [];
      const { executeGoalWithAgent } = await import("./agent-executor.js");
      await executeGoalWithAgent({
        session,
        runId: "test-run-10",
        workingDir: "/tmp/ws",
        onProgress: (text) => progress.push(text),
      });

      expect(progress.some((p) => p.includes("Creating agent session"))).toBe(true);
      expect(progress.some((p) => p.includes("Task 1"))).toBe(true);
      expect(progress.some((p) => p.includes("[done]"))).toBe(true);
    });

    it("throws if no plan exists", async () => {
      const session: GoalSession = {
        goal: "Test",
        state: "awaiting_approval",
        plan: null,
        stepResults: new Map(),
        blocked: null,
        answers: {},
      };

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      await expect(
        executeGoalWithAgent({
          session,
          runId: "test-run-11",
          workingDir: "/tmp/ws",
        }),
      ).rejects.toThrow("No plan to execute");
    });

    it("disposes PI session on completion", async () => {
      const step = makeStep();
      const plan = makePlan([step]);
      const session = makeSession(plan);

      mockPrompt.mockImplementation(async () => {
        mockCompleteSignal = { summary: "done" };
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      await executeGoalWithAgent({
        session,
        runId: "test-run-12",
        workingDir: "/tmp/ws",
      });

      expect(mockDispose).toHaveBeenCalledOnce();
    });

    it("disposes PI session even on error", async () => {
      const step = makeStep();
      const plan = makePlan([step]);
      const session = makeSession(plan);

      mockPrompt.mockRejectedValue(new Error("abort"));

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      await executeGoalWithAgent({
        session,
        runId: "test-run-13",
        workingDir: "/tmp/ws",
      });

      expect(mockDispose).toHaveBeenCalledOnce();
    });

    it("resets goal tools between tasks", async () => {
      const step1 = makeStep({ id: "1" });
      const step2 = makeStep({ id: "2" });
      const plan = makePlan([step1, step2]);
      const session = makeSession(plan);

      mockPrompt.mockImplementation(async () => {
        mockCompleteSignal = { summary: "done" };
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      await executeGoalWithAgent({
        session,
        runId: "test-run-14",
        workingDir: "/tmp/ws",
      });

      // Reset should be called once before each task (2 tasks)
      expect(mockReset).toHaveBeenCalledTimes(2);
    });

    it("aggregates multiple blocked tasks into one outcome", async () => {
      const step1 = makeStep({ id: "1", description: "Step 1" });
      const step2 = makeStep({ id: "2", description: "Step 2" });
      const plan = makePlan([step1, step2]);
      const session = makeSession(plan);

      mockPrompt.mockImplementation(async () => {
        mockBlockedSignal = { question: "Need info" };
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const result = await executeGoalWithAgent({
        session,
        runId: "test-run-15",
        workingDir: "/tmp/ws",
      });

      expect(result.status).toBe("blocked");
      if (result.status === "blocked") {
        expect(result.question).toContain("Multiple tasks need attention");
        expect(result.question).toContain("Step 1");
        expect(result.question).toContain("Step 2");
      }
    });

    it("blocked wins over complete when both signals fire in same prompt", async () => {
      const step = makeStep({ id: "1", description: "Check file" });
      const plan = makePlan([step]);
      const session = makeSession(plan);

      // Simulate the agent calling request_user_input then mark_task_complete
      // in the same session.prompt() cycle
      mockPrompt.mockImplementation(async () => {
        mockBlockedSignal = { question: "File not found — which path?" };
        mockCompleteSignal = { summary: "Checked the file" };
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const result = await executeGoalWithAgent({
        session,
        runId: "test-run-16",
        workingDir: "/tmp/ws",
      });

      expect(step.status).toBe("blocked");
      expect(step.blockedReason).toBe("user_input");
      expect(step.blockedQuestion).toBe("File not found — which path?");
      expect(step.taskSummary).toBeUndefined();
      expect(result.status).toBe("blocked");
      expect(session.state).toBe("blocked");
    });

    it("stops prompting a task immediately after it becomes blocked", async () => {
      const step = makeStep({ id: "1" });
      const plan = makePlan([step]);
      const session = makeSession(plan);

      mockPrompt.mockImplementation(async () => {
        // Both signals in one prompt
        mockBlockedSignal = { question: "Need info" };
        mockCompleteSignal = { summary: "Done anyway" };
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      await executeGoalWithAgent({
        session,
        runId: "test-run-17",
        workingDir: "/tmp/ws",
        maxTurnsPerTask: 5,
      });

      // Must stop after 1 prompt — not continue for remaining 4 turns
      expect(mockPrompt).toHaveBeenCalledTimes(1);
      expect(step.turnsUsed).toBe(1);
    });

    it("goal does not report DONE when any task is blocked", async () => {
      const step1 = makeStep({ id: "1", description: "Step 1" });
      const step2 = makeStep({ id: "2", description: "Step 2" });
      const plan = makePlan([step1, step2]);
      const session = makeSession(plan);

      let promptIdx = 0;
      mockPrompt.mockImplementation(async () => {
        promptIdx++;
        if (promptIdx === 1) {
          // Step 1: both signals — blocked wins
          mockBlockedSignal = { question: "Missing config" };
          mockCompleteSignal = { summary: "Done" };
        } else {
          // Step 2: clean complete
          mockCompleteSignal = { summary: "Step 2 done" };
        }
      });

      const progress: string[] = [];
      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const result = await executeGoalWithAgent({
        session,
        runId: "test-run-18",
        workingDir: "/tmp/ws",
        onProgress: (text) => progress.push(text),
      });

      expect(result.status).toBe("blocked");
      expect(step1.status).toBe("blocked");
      expect(step2.status).toBe("done");
      // "DONE" must not appear in progress
      expect(progress.every((p) => !p.startsWith("DONE"))).toBe(true);
    });
  });
});
