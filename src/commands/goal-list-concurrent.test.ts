import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SerializedRun } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";

let testGoalsDir: string;

// Mock the run-store module to use our test directory
vi.mock("../goal/run-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../goal/run-store.js")>();
  return {
    ...actual,
    resolveGoalsDir: () => testGoalsDir,
    listRuns: (dir?: string) => actual.listRuns(dir ?? testGoalsDir),
    saveRun: (run: SerializedRun, dir?: string) => actual.saveRun(run, dir ?? testGoalsDir),
  };
});

function mockRuntime(): RuntimeEnv & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    log: (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    },
    error: (...args: unknown[]) => {
      logs.push(`ERROR: ${args.map(String).join(" ")}`);
    },
    exit: (() => {
      throw new Error("exit called");
    }) as never,
  };
}

/**
 * Seed an active run lock (live pid) so a persisted "executing" run is treated
 * as genuinely executing. Without a lock, loadRun() correctly reconciles a
 * lock-less "executing" run to "blocked" for crash recovery (see run-store
 * migrateRun). This mirrors the createRunLock helper used in the other goal
 * command tests.
 */
function createRunLock(runId: string): void {
  const lockDir = path.join(testGoalsDir, ".locks", "runs");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, `${runId}.lock`), JSON.stringify({ pid: process.pid }));
}

const sampleRun: SerializedRun = {
  runId: "test-run-1111",
  goal: "Test concurrent access",
  state: "executing",
  plan: {
    goal: "Test concurrent access",
    summary: "Test plan",
    steps: [
      {
        id: "1",
        description: "Step 1",
        dependsOn: [],
        status: "in_progress",
      },
    ],
  },
  stepResults: {},
  blockReason: null,
  workingDir: "/tmp",
  model: undefined,
  dryRun: false,
  createdAt: "2026-01-30T00:00:00.000Z",
  updatedAt: "2026-01-30T00:01:00.000Z",
};

describe("goal-list concurrent access", () => {
  beforeEach(() => {
    testGoalsDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-concurrent-test-"));
  });

  afterEach(() => {
    fs.rmSync(testGoalsDir, { recursive: true, force: true });
  });

  it("can list goals while another process is writing (simulated)", async () => {
    const { saveRun, listRuns } = await import("../goal/run-store.js");
    const { goalListCommand } = await import("./goal-list.js");

    // Initial run saved
    saveRun(sampleRun);

    // Simulate concurrent writes while listing
    const results = await Promise.all([
      // Read operations (list)
      (async () => {
        const rt = mockRuntime();
        await goalListCommand({}, rt);
        return rt.logs.join("\n");
      })(),
      (async () => {
        const runs = listRuns();
        return runs.length;
      })(),
      // Write operations (save)
      (async () => {
        saveRun({ ...sampleRun, updatedAt: new Date().toISOString() });
        return "write1";
      })(),
      (async () => {
        saveRun({ ...sampleRun, updatedAt: new Date().toISOString() });
        return "write2";
      })(),
      // More read operations
      (async () => {
        const rt = mockRuntime();
        await goalListCommand({ json: true }, rt);
        return JSON.parse(rt.logs.join(""));
      })(),
    ]);

    // All operations should complete without errors
    expect(results[0]).toContain("test-run");
    expect(results[1]).toBeGreaterThan(0);
    expect(results[2]).toBe("write1");
    expect(results[3]).toBe("write2");
    expect(Array.isArray(results[4])).toBe(true);
  });

  it("listRuns does not block on file reads", async () => {
    const { saveRun, listRuns } = await import("../goal/run-store.js");

    // Create multiple runs
    const runs: SerializedRun[] = [];
    for (let i = 0; i < 10; i++) {
      runs.push({
        ...sampleRun,
        runId: `run-${i.toString().padStart(4, "0")}`,
        updatedAt: new Date(Date.now() + i * 1000).toISOString(),
      });
    }

    // Save all runs
    for (const run of runs) {
      saveRun(run);
    }

    // Concurrent list operations should all succeed
    const promises = Array.from({ length: 20 }, () => listRuns());
    const results = await Promise.all(promises);

    // All should return the same number of runs
    expect(results.every((r) => r.length === 10)).toBe(true);
  });

  it("goal_list command can be called multiple times concurrently", async () => {
    const { saveRun } = await import("../goal/run-store.js");
    const { goalListCommand } = await import("./goal-list.js");

    saveRun(sampleRun);

    // Simulate multiple Telegram users calling /goal_list simultaneously
    const runtimes = Array.from({ length: 10 }, () => mockRuntime());
    const promises = runtimes.map((rt) => goalListCommand({}, rt));

    await Promise.all(promises);

    // All should have produced output
    for (const rt of runtimes) {
      expect(rt.logs.join("\n")).toContain("test-run");
    }
  });

  it("can list goals during active execution (no lock file check)", async () => {
    const { saveRun } = await import("../goal/run-store.js");
    const { goalListCommand } = await import("./goal-list.js");

    // Save a run in "executing" state with a live run lock so it is genuinely
    // executing (a lock-less "executing" run is correctly reconciled to "blocked").
    const executingRun = { ...sampleRun, state: "executing" as const };
    saveRun(executingRun);
    createRunLock(executingRun.runId);

    // List should work without checking for any locks
    const rt = mockRuntime();
    await goalListCommand({}, rt);

    const output = rt.logs.join("\n");
    expect(output).toContain("executing");
    expect(output).toContain("test-run");
  });

  it("no lock file prevents concurrent reads", async () => {
    const { saveRun, listRuns } = await import("../goal/run-store.js");

    saveRun(sampleRun);

    // Check that no lock file exists
    const runDir = path.join(testGoalsDir, sampleRun.runId);
    const lockFile = path.join(runDir, ".lock");

    expect(fs.existsSync(lockFile)).toBe(false);

    // listRuns should work
    const runs = listRuns();
    expect(runs.length).toBe(1);

    // Still no lock file
    expect(fs.existsSync(lockFile)).toBe(false);
  });
});
