import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executePlan, topologicalSort } from "./executor.js";
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
    blockReason: null,
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

    // Step 2 should be skipped
    expect(plan.steps[1].status).toBe("skipped");
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

    // The step should fail (tool returns error for path traversal)
    expect(plan.steps[0].status).toBe("failed");
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
});

describe("topologicalSort", () => {
  it("sorts linear dependencies correctly", () => {
    const sorted = topologicalSort([
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

  it("handles independent steps", () => {
    const sorted = topologicalSort([
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
  });
});
