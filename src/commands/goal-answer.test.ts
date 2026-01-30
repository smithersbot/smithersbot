import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonExitError } from "../cli/cli-utils.js";
import { loadRun, saveRun } from "../goal/run-store.js";
import type { SerializedRun } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";

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

function makeBlockedRun(overrides: Partial<SerializedRun> = {}): SerializedRun {
  return {
    runId: "answer-test-run",
    goal: "Test goal",
    state: "blocked",
    plan: {
      goal: "Test goal",
      summary: "A test plan",
      steps: [
        {
          id: "1",
          description: "Create dir",
          dependsOn: [],
          tool: { name: "mkdir", args: { path: "out" } },
          status: "pending",
        },
      ],
    },
    stepResults: {},
    blocked: { prompt: "What is the database password?", requiredInputKey: "db_password" },
    answers: {},
    workingDir: "/tmp/ws",
    model: undefined,
    dryRun: false,
    createdAt: "2026-01-30T00:00:00.000Z",
    updatedAt: "2026-01-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("goal-answer command", () => {
  beforeEach(() => {
    testGoalsDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-answer-test-"));
  });

  afterEach(() => {
    fs.rmSync(testGoalsDir, { recursive: true, force: true });
  });

  it("persists answer and clears blocked state", async () => {
    saveRun(makeBlockedRun());
    const { goalAnswerCommand } = await import("./goal-answer.js");
    const rt = mockRuntime();
    await goalAnswerCommand("answer-test-run", { key: "db_password", value: "s3cret" }, rt);

    const run = loadRun("answer-test-run", testGoalsDir);
    expect(run).toBeDefined();
    expect(run!.answers.db_password).toBe("s3cret");
    expect(run!.blocked).toBeNull();
    expect(run!.state).toBe("executing");
    expect(rt.logs.join("\n")).toContain('Answer saved for key "db_password"');
    expect(rt.logs.join("\n")).toContain("Warning:");
    expect(rt.logs.join("\n")).toContain("Resume:");
  });

  it("rejects mismatched key", async () => {
    saveRun(makeBlockedRun());
    const { goalAnswerCommand } = await import("./goal-answer.js");
    const rt = mockRuntime();
    await goalAnswerCommand("answer-test-run", { key: "wrong_key", value: "val" }, rt);

    expect(rt.errors.join("\n")).toContain('Key mismatch: expected "db_password", got "wrong_key"');
    // State should be unchanged
    const run = loadRun("answer-test-run", testGoalsDir);
    expect(run!.state).toBe("blocked");
  });

  it("rejects non-blocked run", async () => {
    saveRun(makeBlockedRun({ state: "done", blocked: null }));
    const { goalAnswerCommand } = await import("./goal-answer.js");
    const rt = mockRuntime();
    await goalAnswerCommand("answer-test-run", { key: "db_password", value: "val" }, rt);

    expect(rt.errors.join("\n")).toContain("Run is not blocked");
  });

  it("JSON mode outputs strict JSON with answered status", async () => {
    saveRun(makeBlockedRun());
    const { goalAnswerCommand } = await import("./goal-answer.js");
    const rt = mockRuntime();
    await goalAnswerCommand(
      "answer-test-run",
      { key: "db_password", value: "s3cret", json: true },
      rt,
    );

    const raw = rt.logs.join("");
    expect(raw.trimStart()[0]).toBe("{");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.status).toBe("answered");
    expect(parsed.key).toBe("db_password");
    expect(parsed.warning).toBeDefined();
  });

  it("JSON error for non-blocked run", async () => {
    saveRun(makeBlockedRun({ state: "done", blocked: null }));
    const { goalAnswerCommand } = await import("./goal-answer.js");
    const rt = mockRuntime();
    await catchJsonExit(() =>
      goalAnswerCommand("answer-test-run", { key: "db_password", value: "val", json: true }, rt),
    );

    const raw = rt.logs.join("");
    expect(raw.trimStart()[0]).toBe("{");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.error).toContain("not blocked");
  });

  it("unknown run ID returns error", async () => {
    const { goalAnswerCommand } = await import("./goal-answer.js");
    const rt = mockRuntime();
    await goalAnswerCommand("nonexistent", { key: "k", value: "v" }, rt);
    expect(rt.errors.join("\n")).toContain("Run not found: nonexistent");
  });
});
