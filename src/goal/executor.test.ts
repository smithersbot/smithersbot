import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executePlan } from "./executor.js";
import { orderStepsCriticalPathFirst } from "./plan-order.js";
import type { GoalLlmClient, GoalSession, Plan } from "./types.js";

const mockRuntime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn() as never,
};

const noopProgress = {
  setLabel: vi.fn(),
  setPercent: vi.fn(),
  tick: vi.fn(),
  done: vi.fn(),
};

function mockClient(assessResponse?: string): GoalLlmClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text: assessResponse ?? '{ "blocked": false }',
    }),
  };
}

function createSession(plan: Plan): GoalSession {
  return {
    goal: plan.goal,
    state: "executing",
    plan,
    stepResults: new Map(),
    blocked: null,
    answers: {},
  };
}

describe("executor", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-exec-test-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("executes mkdir + file_write steps in order", async () => {
    const plan: Plan = {
      goal: "test",
      summary: "Test plan",
      steps: [
        {
          id: "1",
          description: "Create dir",
          dependsOn: [],
          tool: { name: "mkdir", args: { path: "sub" } },
          status: "pending",
        },
        {
          id: "2",
          description: "Write file",
          dependsOn: ["1"],
          tool: {
            name: "file_write",
            args: { path: "sub/hello.txt", content: "world" },
          },
          status: "pending",
        },
      ],
    };

    const result = await executePlan({
      session: createSession(plan),
      client: mockClient(),
      workingDir: tmpDir,
      runtime: mockRuntime,
      progress: noopProgress,
    });

    expect(result.status).toBe("done");
    expect(fs.existsSync(path.join(tmpDir, "sub", "hello.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "sub", "hello.txt"), "utf8")).toBe("world");
  });

  it("skips steps whose dependencies failed", async () => {
    const plan: Plan = {
      goal: "test",
      summary: "Dep failure",
      steps: [
        {
          id: "1",
          description: "Read missing file",
          dependsOn: [],
          tool: { name: "file_read", args: { path: "nonexistent.txt" } },
          status: "pending",
        },
        {
          id: "2",
          description: "Write dependent file",
          dependsOn: ["1"],
          tool: {
            name: "file_write",
            args: { path: "output.txt", content: "should not exist" },
          },
          status: "pending",
        },
      ],
    };

    const client = mockClient('{ "blocked": false }');
    const session = createSession(plan);

    const result = await executePlan({
      session,
      client,
      workingDir: tmpDir,
      runtime: mockRuntime,
      progress: noopProgress,
    });

    // Step 2 should be blocked (dependency failed)
    expect(plan.steps[1].status).toBe("blocked");
    expect(plan.steps[1].blockedQuestion).toBe("Dependency failed — replan or resume needed.");
    expect(fs.existsSync(path.join(tmpDir, "output.txt"))).toBe(false);
    // Overall should still be "done" since LLM said not blocked
    expect(result.status).toBe("done");
  });

  it("returns blocked when LLM assessment says so", async () => {
    const plan: Plan = {
      goal: "test",
      summary: "Block test",
      steps: [
        {
          id: "1",
          description: "Read missing file",
          dependsOn: [],
          tool: { name: "file_read", args: { path: "missing.txt" } },
          status: "pending",
        },
      ],
    };

    const client = mockClient(
      JSON.stringify({
        blocked: true,
        question: "What file should I read?",
        requiredInputKey: "missing_file",
      }),
    );

    const result = await executePlan({
      session: createSession(plan),
      client,
      workingDir: tmpDir,
      runtime: mockRuntime,
      progress: noopProgress,
    });

    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.question).toBe("What file should I read?");
      expect(result.requiredInputKey).toBe("missing_file");
    }
  });

  it("rejects path traversal attempts", async () => {
    const plan: Plan = {
      goal: "test",
      summary: "Path traversal",
      steps: [
        {
          id: "1",
          description: "Escape sandbox",
          dependsOn: [],
          tool: {
            name: "file_write",
            args: { path: "../../etc/passwd", content: "hacked" },
          },
          status: "pending",
        },
      ],
    };

    const client = mockClient(
      JSON.stringify({
        blocked: true,
        question: "Path traversal detected",
      }),
    );

    await executePlan({
      session: createSession(plan),
      client,
      workingDir: tmpDir,
      runtime: mockRuntime,
      progress: noopProgress,
    });

    // The step should be blocked (tool returns error for path traversal)
    expect(plan.steps[0].status).toBe("blocked");
    expect(plan.steps[0].blockedReason).toBe("error");
    // File should NOT exist outside sandbox
    expect(fs.existsSync("/etc/passwd_hacked")).toBe(false);
  });

  it("executes file_modify correctly", async () => {
    // Pre-create a file to modify
    fs.writeFileSync(path.join(tmpDir, "readme.md"), "Hello World");

    const plan: Plan = {
      goal: "test",
      summary: "Modify file",
      steps: [
        {
          id: "1",
          description: "Update readme",
          dependsOn: [],
          tool: {
            name: "file_modify",
            args: {
              path: "readme.md",
              search: "World",
              replace: "Moltbot",
            },
          },
          status: "pending",
        },
      ],
    };

    const result = await executePlan({
      session: createSession(plan),
      client: mockClient(),
      workingDir: tmpDir,
      runtime: mockRuntime,
      progress: noopProgress,
    });

    expect(result.status).toBe("done");
    expect(fs.readFileSync(path.join(tmpDir, "readme.md"), "utf8")).toBe("Hello Moltbot");
  });

  it("marks request_user_input step as blocked immediately", async () => {
    const plan: Plan = {
      goal: "test",
      summary: "User input test",
      steps: [
        {
          id: "1",
          description: "Write a.txt",
          dependsOn: [],
          tool: { name: "file_write", args: { path: "a.txt", content: "A" } },
          status: "pending",
        },
        {
          id: "2",
          description: "Ask user for confirmation",
          dependsOn: ["1"],
          tool: {
            name: "request_user_input",
            args: { question: "Should we create b.txt? (yes/no)" },
          },
          status: "pending",
        },
        {
          id: "3",
          description: "Write b.txt",
          dependsOn: ["2"],
          tool: { name: "file_write", args: { path: "b.txt", content: "B" } },
          status: "pending",
        },
      ],
    };

    const session = createSession(plan);
    const result = await executePlan({
      session,
      client: mockClient(),
      workingDir: tmpDir,
      runtime: mockRuntime,
      progress: noopProgress,
    });

    // Step 1 should be done
    expect(plan.steps[0].status).toBe("done");
    expect(fs.existsSync(path.join(tmpDir, "a.txt"))).toBe(true);

    // Step 2 should be blocked with the question
    expect(plan.steps[1].status).toBe("blocked");
    expect(plan.steps[1].blockedReason).toBe("user_input");
    expect(plan.steps[1].blockedQuestion).toBe("Should we create b.txt? (yes/no)");

    // Step 3 should still be pending (never reached)
    expect(plan.steps[2].status).toBe("pending");
    expect(fs.existsSync(path.join(tmpDir, "b.txt"))).toBe(false);

    // Overall outcome should be blocked
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.question).toBe("Should we create b.txt? (yes/no)");
      expect(result.requiredInputKey).toBe("step:2:input");
    }
  });

  it("falls back to step ID for requiredInputKey when LLM omits it", async () => {
    const failedId = "s001";
    const plan: Plan = {
      goal: "test",
      summary: "Fallback key test",
      steps: [
        {
          id: failedId,
          description: "Read missing file",
          dependsOn: [],
          tool: { name: "file_read", args: { path: "nonexistent.txt" } },
          status: "pending",
        },
      ],
    };

    const client = mockClient(JSON.stringify({ blocked: true, question: "Need input" }));

    const result = await executePlan({
      session: createSession(plan),
      client,
      workingDir: tmpDir,
      runtime: mockRuntime,
      progress: noopProgress,
    });

    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.requiredInputKey).toBe(`step:${failedId}:input`);
    }
  });
});

describe("orderStepsCriticalPathFirst", () => {
  it("orders linear dependencies correctly", () => {
    const sorted = orderStepsCriticalPathFirst([
      {
        id: "3",
        description: "C",
        dependsOn: ["2"],
        tool: { name: "mkdir", args: {} },
        status: "pending",
      },
      {
        id: "1",
        description: "A",
        dependsOn: [],
        tool: { name: "mkdir", args: {} },
        status: "pending",
      },
      {
        id: "2",
        description: "B",
        dependsOn: ["1"],
        tool: { name: "mkdir", args: {} },
        status: "pending",
      },
    ]);

    const ids = sorted.map((s) => s.id);
    expect(ids.indexOf("1")).toBeLessThan(ids.indexOf("2"));
    expect(ids.indexOf("2")).toBeLessThan(ids.indexOf("3"));
  });

  it("handles independent steps in plan order", () => {
    const sorted = orderStepsCriticalPathFirst([
      {
        id: "a",
        description: "A",
        dependsOn: [],
        tool: { name: "mkdir", args: {} },
        status: "pending",
      },
      {
        id: "b",
        description: "B",
        dependsOn: [],
        tool: { name: "mkdir", args: {} },
        status: "pending",
      },
    ]);

    expect(sorted).toHaveLength(2);
    expect(sorted.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("prioritizes longer downstream paths over plan order", () => {
    const sorted = orderStepsCriticalPathFirst([
      {
        id: "B",
        description: "Short",
        dependsOn: [],
        tool: { name: "mkdir", args: {} },
        status: "pending",
      },
      {
        id: "A",
        description: "Long root",
        dependsOn: [],
        tool: { name: "mkdir", args: {} },
        status: "pending",
      },
      {
        id: "C",
        description: "Child of A",
        dependsOn: ["A"],
        tool: { name: "mkdir", args: {} },
        status: "pending",
      },
    ]);

    const ids = sorted.map((s) => s.id);
    expect(ids).toEqual(["A", "C", "B"]);
  });
});
