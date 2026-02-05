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
  resolveAgentTaskSessionFile: vi.fn(
    (_runId: string, taskId: string) => `/tmp/mock-sessions/${taskId}.jsonl`,
  ),
  resolveWorkingFile: vi.fn((_runId: string, stepId: string) => `/tmp/mock-working/${stepId}.md`),
  resolveGoalWorkingFile: vi.fn(() => "/tmp/mock-working/WORKING.md"),
}));

// Mock scout (resolveScoutDir is imported by agent-executor for node spec loading)
vi.mock("./scout.js", () => ({
  resolveScoutDir: vi.fn(() => "/tmp/mock-scout"),
}));

// Mock fs for directory creation, node spec loading, and working notes
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(() => {
        throw new Error("ENOENT");
      }),
      appendFileSync: vi.fn(),
    },
  };
});

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
    setActiveTask: vi.fn(),
  })),
}));

// Mock the PI coding agent SDK
const mockPrompt = vi.fn();
const mockAbort = vi.fn();
const mockDispose = vi.fn();
const mockSubscribe = vi.fn(() => () => {});
const mockMessages: Array<Record<string, unknown>> = [];

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: vi.fn(async () => ({
    session: {
      prompt: (...args: unknown[]) => mockPrompt(...args),
      abort: () => mockAbort(),
      dispose: () => mockDispose(),
      subscribe: (...args: unknown[]) => mockSubscribe(...args),
      messages: mockMessages,
    },
  })),
  createCodingTools: vi.fn(() => []),
  AuthStorage: class {
    setRuntimeApiKey = vi.fn();
  },
  ModelRegistry: class {},
  DefaultResourceLoader: class {
    async reload() {}
  },
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
    status: "pending",
    durationMinutes: 1,
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
    mockMessages.length = 0;
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

    it("leaves dependent tasks pending when their dep is blocked", async () => {
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
      // Step 2 stays pending (not skipped) — it can run once step 1 is answered
      expect(step2.status).toBe("pending");
      expect(result.status).toBe("blocked");
      // Only step 1 should have been prompted (step 2's dep not done)
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
      expect(step.blockedReason).toBe("rate_limit");
      expect(step.blockedQuestion).toContain("Rate limited by API");
    });

    it("returns failed status for out_of_credits error and stops immediately", async () => {
      const step1 = makeStep({ id: "1" });
      const step2 = makeStep({ id: "2" });
      const plan = makePlan([step1, step2]);
      const session = makeSession(plan);

      mockPrompt.mockRejectedValue(new Error("Your credit balance is too low"));

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const result = await executeGoalWithAgent({
        session,
        runId: "test-run-fatal",
        workingDir: "/tmp/ws",
      });

      // Should return failed status, not blocked
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.errorKind).toBe("out_of_credits");
        expect(result.error).toContain("Out of API credits");
      }
      // Session should be in failed state
      expect(session.state).toBe("failed");
      // First step blocked, second step never executed (still pending)
      expect(step1.status).toBe("blocked");
      expect(step2.status).toBe("pending");
    });

    it("detects assistant error messages when prompt resolves", async () => {
      const step1 = makeStep({ id: "1" });
      const step2 = makeStep({ id: "2" });
      const plan = makePlan([step1, step2]);
      const session = makeSession(plan);

      mockPrompt.mockImplementation(async () => {
        mockMessages.push({
          role: "assistant",
          stopReason: "error",
          errorMessage: "Your credit balance is too low",
        });
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const result = await executeGoalWithAgent({
        session,
        runId: "test-run-fatal-assistant",
        workingDir: "/tmp/ws",
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.errorKind).toBe("out_of_credits");
      }
      expect(session.state).toBe("failed");
      expect(step1.status).toBe("blocked");
      expect(step2.status).toBe("pending");
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

    it("resumes a blocked task when session has a matching answer", async () => {
      const step = makeStep({ id: "1", description: "Setup DB" });
      // Pre-set the step as blocked (simulating a previous run that parked it)
      step.status = "blocked";
      step.blockedReason = "user_input";
      step.blockedQuestion = "What database?";
      step.turnsUsed = 2;

      const plan = makePlan([step]);
      const session = makeSession(plan);
      // Provide the answer
      session.answers["task:1:input"] = "PostgreSQL";

      mockPrompt.mockImplementation(async () => {
        mockCompleteSignal = { summary: "DB set up with PostgreSQL" };
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const result = await executeGoalWithAgent({
        session,
        runId: "test-run-resume-1",
        workingDir: "/tmp/ws",
      });

      expect(result.status).toBe("done");
      expect(step.status).toBe("done");
      expect(step.taskSummary).toBe("DB set up with PostgreSQL");
      // turnsUsed should be reset (fresh turns for resumed task)
      expect(step.turnsUsed).toBe(1);
      expect(mockPrompt).toHaveBeenCalledOnce();
    });

    it("injects user answer into the prompt for a resumed blocked task", async () => {
      const step = makeStep({ id: "1", description: "Configure server" });
      step.status = "blocked";
      step.blockedReason = "user_input";
      step.blockedQuestion = "Which port?";

      const plan = makePlan([step]);
      const session = makeSession(plan);
      session.answers["task:1:input"] = "8080";

      let capturedPrompt = "";
      mockPrompt.mockImplementation(async (prompt: string) => {
        capturedPrompt = prompt;
        mockCompleteSignal = { summary: "Server configured on port 8080" };
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      await executeGoalWithAgent({
        session,
        runId: "test-run-resume-2",
        workingDir: "/tmp/ws",
      });

      expect(capturedPrompt).toContain("Which port?");
      expect(capturedPrompt).toContain("8080");
      expect(capturedPrompt).toContain("Continue working on this task");
    });

    it("resumes blocked task with aggregated multi-task answer key", async () => {
      const step1 = makeStep({ id: "1", description: "Step 1" });
      step1.status = "blocked";
      step1.blockedReason = "user_input";
      step1.blockedQuestion = "Need info for step 1";

      const step2 = makeStep({ id: "2", description: "Step 2" });
      step2.status = "blocked";
      step2.blockedReason = "user_input";
      step2.blockedQuestion = "Need info for step 2";

      const plan = makePlan([step1, step2]);
      const session = makeSession(plan);
      // Aggregated answer key for multiple blocked tasks
      session.answers["tasks:1,2:input"] = "Use defaults for both";

      mockPrompt.mockImplementation(async () => {
        mockCompleteSignal = { summary: "Done" };
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const result = await executeGoalWithAgent({
        session,
        runId: "test-run-resume-3",
        workingDir: "/tmp/ws",
      });

      expect(result.status).toBe("done");
      expect(step1.status).toBe("done");
      expect(step2.status).toBe("done");
      // Both tasks should have been prompted
      expect(mockPrompt).toHaveBeenCalledTimes(2);
    });

    it("does not resume blocked tasks without an answer", async () => {
      const step = makeStep({ id: "1", description: "Step 1" });
      step.status = "blocked";
      step.blockedReason = "user_input";
      step.blockedQuestion = "What DB?";

      const plan = makePlan([step]);
      const session = makeSession(plan);
      // No answer provided

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const result = await executeGoalWithAgent({
        session,
        runId: "test-run-resume-4",
        workingDir: "/tmp/ws",
      });

      // Should still be blocked — no answer means not runnable
      expect(result.status).toBe("blocked");
      expect(step.status).toBe("blocked");
      expect(mockPrompt).not.toHaveBeenCalled();
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

    // -----------------------------------------------------------------------
    // 4-step plan: step3 blocks, step4 depends on step3, user answer resumes
    // -----------------------------------------------------------------------

    it("4-step plan: answer 'yes' → all 4 tasks complete, no skipped", async () => {
      const step1 = makeStep({ id: "1", description: "Read config" });
      const step2 = makeStep({ id: "2", description: "Validate config" });
      const step3 = makeStep({
        id: "3",
        description: "Confirm delete",
        dependsOn: ["1", "2"],
      });
      const step4 = makeStep({
        id: "4",
        description: "Write artifact",
        dependsOn: ["3"],
      });
      const plan = makePlan([step1, step2, step3, step4]);
      const session = makeSession(plan);

      // Phase 1: steps 1 and 2 complete, step 3 blocks asking a question
      let promptIdx = 0;
      mockPrompt.mockImplementation(async () => {
        promptIdx++;
        if (promptIdx <= 2) {
          // Steps 1 and 2: complete
          mockCompleteSignal = { summary: `Step ${promptIdx} done` };
        } else if (promptIdx === 3) {
          // Step 3: blocks asking user
          mockBlockedSignal = { question: "Delete tmp_block_test? yes or no" };
        }
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const result1 = await executeGoalWithAgent({
        session,
        runId: "test-4step-yes",
        workingDir: "/tmp/ws",
      });

      // After phase 1: steps 1,2 done, step 3 blocked, step 4 pending (NOT skipped)
      expect(step1.status).toBe("done");
      expect(step2.status).toBe("done");
      expect(step3.status).toBe("blocked");
      expect(step4.status).toBe("pending");
      expect(result1.status).toBe("blocked");

      // Phase 2: user answers "yes", resume execution
      session.answers["task:3:input"] = "yes";

      promptIdx = 0;
      mockPrompt.mockImplementation(async (prompt: string) => {
        promptIdx++;
        if (promptIdx === 1) {
          // Step 3 resumed: completes with "deleted"
          expect(prompt).toContain("yes");
          mockCompleteSignal = { summary: "Confirmed deletion" };
        } else if (promptIdx === 2) {
          // Step 4: writes artifact based on the answer
          mockCompleteSignal = { summary: "Wrote: deleted" };
        }
      });

      const result2 = await executeGoalWithAgent({
        session,
        runId: "test-4step-yes",
        workingDir: "/tmp/ws",
      });

      expect(result2.status).toBe("done");
      expect(step3.status).toBe("done");
      expect(step4.status).toBe("done");
      // Verify summary shows 4/4, no "skipped"
      if (result2.status === "done") {
        expect(result2.summary).toContain("4/4");
        expect(result2.summary).not.toContain("skipped");
      }
    });

    it("4-step plan: answer 'no' → all 4 tasks complete, no skipped", async () => {
      const step1 = makeStep({ id: "1", description: "Read config" });
      const step2 = makeStep({ id: "2", description: "Validate config" });
      const step3 = makeStep({
        id: "3",
        description: "Confirm delete",
        dependsOn: ["1", "2"],
      });
      const step4 = makeStep({
        id: "4",
        description: "Write artifact",
        dependsOn: ["3"],
      });
      const plan = makePlan([step1, step2, step3, step4]);
      const session = makeSession(plan);

      // Phase 1: steps 1 and 2 complete, step 3 blocks
      let promptIdx = 0;
      mockPrompt.mockImplementation(async () => {
        promptIdx++;
        if (promptIdx <= 2) {
          mockCompleteSignal = { summary: `Step ${promptIdx} done` };
        } else if (promptIdx === 3) {
          mockBlockedSignal = { question: "Delete tmp_block_test? yes or no" };
        }
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const result1 = await executeGoalWithAgent({
        session,
        runId: "test-4step-no",
        workingDir: "/tmp/ws",
      });

      expect(step3.status).toBe("blocked");
      expect(step4.status).toBe("pending");
      expect(result1.status).toBe("blocked");

      // Phase 2: user answers "no", resume execution
      session.answers["task:3:input"] = "no";

      promptIdx = 0;
      mockPrompt.mockImplementation(async (prompt: string) => {
        promptIdx++;
        if (promptIdx === 1) {
          // Step 3 resumed with "no" answer
          expect(prompt).toContain("no");
          mockCompleteSignal = { summary: "Skipped deletion" };
        } else if (promptIdx === 2) {
          // Step 4: writes artifact based on "no" answer
          mockCompleteSignal = { summary: "Wrote: kept" };
        }
      });

      const result2 = await executeGoalWithAgent({
        session,
        runId: "test-4step-no",
        workingDir: "/tmp/ws",
      });

      expect(result2.status).toBe("done");
      expect(step3.status).toBe("done");
      expect(step4.status).toBe("done");
      // Verify summary shows 4/4, no "skipped"
      if (result2.status === "done") {
        expect(result2.summary).toContain("4/4");
        expect(result2.summary).not.toContain("skipped");
      }
    });

    // -----------------------------------------------------------------------
    // Critical-path-first task selection
    // -----------------------------------------------------------------------

    it("critical-path-first selection: prefers longer downstream path", async () => {
      // A has a downstream child; B is a standalone root.
      const stepA = makeStep({ id: "A", description: "Long root" });
      const stepB = makeStep({ id: "B", description: "Short root" });
      const stepC = makeStep({ id: "C", description: "Child of A", dependsOn: ["A"] });
      const plan = makePlan([stepB, stepA, stepC]); // deliberately B before A
      const session = makeSession(plan);

      const taskOrder: string[] = [];
      mockPrompt.mockImplementation(async (prompt: string) => {
        const m = /task (\S+)/i.exec(prompt);
        if (m) taskOrder.push(m[1]!);
        mockCompleteSignal = { summary: "done" };
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const result = await executeGoalWithAgent({
        session,
        runId: "test-cpm-1",
        workingDir: "/tmp/ws",
      });

      expect(result.status).toBe("done");
      // A should be picked first (longer remaining path), then its successor
      expect(taskOrder).toEqual(["A", "C", "B"]);
    });

    it("critical-path-first selection: tie-break by plan order", async () => {
      const stepA = makeStep({ id: "A", description: "Task A" });
      const stepB = makeStep({ id: "B", description: "Task B" });
      const plan = makePlan([stepB, stepA]); // deliberately B before A
      const session = makeSession(plan);

      const taskOrder: string[] = [];
      mockPrompt.mockImplementation(async (prompt: string) => {
        const m = /task (\S+)/i.exec(prompt);
        if (m) taskOrder.push(m[1]!);
        mockCompleteSignal = { summary: "done" };
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      await executeGoalWithAgent({
        session,
        runId: "test-cpm-2",
        workingDir: "/tmp/ws",
      });

      // Equal scores, tie-break by plan order: B before A
      expect(taskOrder).toEqual(["B", "A"]);
    });

    it("scheduler continues executing branch C after branch B blocks", async () => {
      // A -> B (blocks), A -> C (completes)
      const stepA = makeStep({ id: "A", description: "Root" });
      const stepB = makeStep({ id: "B", description: "Blocks", dependsOn: ["A"] });
      const stepC = makeStep({ id: "C", description: "Completes", dependsOn: ["A"] });
      const plan = makePlan([stepA, stepB, stepC]);
      const session = makeSession(plan);

      let promptIdx = 0;
      mockPrompt.mockImplementation(async () => {
        promptIdx++;
        if (promptIdx === 1) {
          // A completes
          mockCompleteSignal = { summary: "A done" };
        } else if (promptIdx === 2) {
          // B blocks (first runnable after A; score-based ordering picks B or C)
          mockBlockedSignal = { question: "Need info for B" };
        } else if (promptIdx === 3) {
          // C completes
          mockCompleteSignal = { summary: "C done" };
        }
      });

      const { executeGoalWithAgent } = await import("./agent-executor.js");
      const result = await executeGoalWithAgent({
        session,
        runId: "test-cpm-branch",
        workingDir: "/tmp/ws",
      });

      expect(stepA.status).toBe("done");
      expect(stepB.status).toBe("blocked");
      expect(stepC.status).toBe("done");
      expect(result.status).toBe("blocked");
      // 3 prompts: A, then B (blocks), then C
      expect(mockPrompt).toHaveBeenCalledTimes(3);
    });
  });
});
