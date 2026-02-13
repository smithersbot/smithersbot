import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonExitError } from "../cli/cli-utils.js";
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
      id: "task-1",
      description: "Create dir",
      dependsOn: [],
      status: "pending",
      durationMinutes: 1,
    },
    {
      id: "task-2",
      description: "Write file",
      dependsOn: ["task-1"],
      status: "pending",
      durationMinutes: 2,
    },
  ],
};

function makeRun(overrides: Partial<SerializedRun>): SerializedRun {
  return {
    runId: "test-run-aaa",
    goal: "Test goal",
    state: "executing",
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

describe("goal-stop command", () => {
  beforeEach(() => {
    testGoalsDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-stop-test-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(testGoalsDir, { recursive: true, force: true });
  });

  it("stops a running goal", async () => {
    const run = makeRun({
      runId: "exec-run",
      state: "executing",
      plan: samplePlan,
    });
    saveRun(run);

    const { goalStopCommand } = await import("./goal-stop.js");
    const rt = mockRuntime();
    await goalStopCommand("exec-run", {}, rt);

    const updated = loadRun("exec-run");
    expect(updated?.state).toBe("cancelled");
    expect(rt.logs.join("\n")).toContain("Goal exec-run stopped");
  });

  it("successfully stops a goal with mixed step statuses", async () => {
    // Note: in_progress steps will be migrated to pending when loadRun is called
    // (this is a crash recovery feature). The real scenario where in_progress steps
    // are marked as blocked happens during live execution, not after reload.
    // This test verifies the command runs successfully with various step states.

    const planWithMixedStates: Plan = {
      goal: "Test goal",
      summary: "A test plan",
      steps: [
        {
          id: "task-1",
          description: "Create dir",
          dependsOn: [],
          status: "done",
          durationMinutes: 1,
        },
        {
          id: "task-2",
          description: "Write file",
          dependsOn: ["task-1"],
          status: "pending", // Would be in_progress during live execution
          durationMinutes: 2,
        },
        {
          id: "task-3",
          description: "Deploy",
          dependsOn: ["task-2"],
          status: "pending",
          durationMinutes: 3,
        },
      ],
    };

    saveRun(
      makeRun({
        runId: "mixed-run",
        state: "executing",
        plan: planWithMixedStates,
      }),
    );

    const { goalStopCommand } = await import("./goal-stop.js");
    const rt = mockRuntime();
    await goalStopCommand("mixed-run", {}, rt);

    const updated = loadRun("mixed-run");
    expect(updated?.state).toBe("cancelled");
    expect(rt.logs.join("\n")).toContain("Goal mixed-ru stopped"); // Uses 8-char prefix

    // Verify done tasks remain done
    const doneStep = updated?.plan?.steps.find((s) => s.id === "task-1");
    expect(doneStep?.status).toBe("done");
  });

  it("is idempotent: already cancelled is a no-op", async () => {
    saveRun(makeRun({ runId: "cancelled-run", state: "cancelled" }));

    const { goalStopCommand } = await import("./goal-stop.js");
    const rt = mockRuntime();
    await goalStopCommand("cancelled-run", {}, rt);

    expect(rt.logs.join("\n")).toContain("already cancelled");
  });

  it("refuses to stop a completed goal", async () => {
    saveRun(makeRun({ runId: "done-run", state: "done" }));

    const { goalStopCommand } = await import("./goal-stop.js");
    const rt = mockRuntime();
    await goalStopCommand("done-run", {}, rt);

    expect(rt.errors.join("\n")).toContain("Cannot stop: goal already completed");
  });

  it("refuses to stop awaiting_approval without --force", async () => {
    saveRun(
      makeRun({
        runId: "approval-run",
        state: "awaiting_approval",
        plan: samplePlan,
      }),
    );

    const { goalStopCommand } = await import("./goal-stop.js");
    const rt = mockRuntime();
    await goalStopCommand("approval-run", {}, rt);

    expect(rt.errors.join("\n")).toContain('Cannot stop: goal is in "awaiting_approval" state');
    expect(rt.logs.join("\n")).toContain("Use --force to cancel anyway");
    const updated = loadRun("approval-run");
    expect(updated?.state).toBe("awaiting_approval");
  });

  it("allows force-stop of awaiting_approval state", async () => {
    saveRun(
      makeRun({
        runId: "approval-run",
        state: "awaiting_approval",
        plan: samplePlan,
      }),
    );

    const { goalStopCommand } = await import("./goal-stop.js");
    const rt = mockRuntime();
    await goalStopCommand("approval-run", { force: true }, rt);

    const updated = loadRun("approval-run");
    expect(updated?.state).toBe("cancelled");
    expect(rt.logs.join("\n")).toContain("Goal approval stopped");
  });

  it("allows force-stop of blocked state", async () => {
    saveRun(
      makeRun({
        runId: "blocked-run",
        state: "blocked",
        plan: samplePlan,
        blocked: {
          blockedAt: "execution",
          prompt: "Need input",
          requiredInputKey: "task:task-1:input",
        },
      }),
    );

    const { goalStopCommand } = await import("./goal-stop.js");
    const rt = mockRuntime();
    await goalStopCommand("blocked-run", { force: true }, rt);

    const updated = loadRun("blocked-run");
    expect(updated?.state).toBe("cancelled");
    expect(updated?.blocked).toBeNull();
  });

  it("reports run not found", async () => {
    const { goalStopCommand } = await import("./goal-stop.js");
    const rt = mockRuntime();
    await goalStopCommand("nonexistent", {}, rt);

    expect(rt.errors.join("\n")).toContain("Run not found: nonexistent");
  });

  it("reports progress summary in markdown mode", async () => {
    const planWithProgress: Plan = {
      ...samplePlan,
      steps: [
        { ...samplePlan.steps[0]!, status: "done" },
        { ...samplePlan.steps[1]!, status: "pending" },
      ],
    };

    saveRun(
      makeRun({
        runId: "partial-run",
        state: "executing",
        plan: planWithProgress,
      }),
    );

    const { goalStopCommand } = await import("./goal-stop.js");
    const rt = mockRuntime();
    await goalStopCommand("partial-run", {}, rt);

    expect(rt.logs.join("\n")).toContain("Progress: 1/2 tasks completed");
    expect(rt.logs.join("\n")).toContain("**Goal ID:** partial-");
  });

  it("outputs JSON when --json is passed", async () => {
    saveRun(
      makeRun({
        runId: "json-run",
        state: "executing",
        plan: samplePlan,
      }),
    );

    const { goalStopCommand } = await import("./goal-stop.js");
    const rt = mockRuntime();
    await catchJsonExit(() => goalStopCommand("json-run", { json: true }, rt));

    const output = rt.logs.join("\n");
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe("stopped");
    expect(parsed.runId).toBe("json-run");
    expect(parsed.previousState).toBe("executing");
  });

  it("resolves run by short prefix", async () => {
    const fullId = "abcd1234-5678-90ab-cdef-1234567890ab";
    saveRun(
      makeRun({
        runId: fullId,
        state: "executing",
      }),
    );

    const { goalStopCommand } = await import("./goal-stop.js");
    const rt = mockRuntime();
    await goalStopCommand("abcd1234", {}, rt);

    const updated = loadRun(fullId);
    expect(updated?.state).toBe("cancelled");
  });

  it("clears blocked state when stopping", async () => {
    saveRun(
      makeRun({
        runId: "blocked-exec-run",
        state: "executing",
        plan: samplePlan,
        blocked: {
          blockedAt: "execution",
          prompt: "Need input",
          requiredInputKey: "task:task-1:input",
        },
      }),
    );

    const { goalStopCommand } = await import("./goal-stop.js");
    const rt = mockRuntime();
    await goalStopCommand("blocked-exec-run", {}, rt);

    const updated = loadRun("blocked-exec-run");
    expect(updated?.state).toBe("cancelled");
    expect(updated?.blocked).toBeNull();
  });
});
