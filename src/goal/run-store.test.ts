import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  saveRun,
  loadRun,
  listRuns,
  reconcileStaleRuns,
  deleteRun,
  resolveRunId,
  sessionToSerialized,
  serializedToSession,
} from "./run-store.js";
import { computeDisplayStatuses } from "./execution-status.js";
import type { GoalSession, SerializedRun } from "./types.js";

describe("run-store", () => {
  let tmpDir: string;
  let originalManagedRoot: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-store-test-"));
    originalManagedRoot = process.env.SMITHERSBOT_GOALS_ROOT;
    process.env.SMITHERSBOT_GOALS_ROOT = path.join(tmpDir, "managed");
  });

  afterEach(() => {
    if (originalManagedRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
    else process.env.SMITHERSBOT_GOALS_ROOT = originalManagedRoot;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const sampleRun: SerializedRun = {
    runId: "test-run-123",
    goal: "Build something",
    state: "done",
    plan: {
      goal: "Build something",
      workingDir: "/tmp/workspace",
      summary: "A test plan",
      steps: [
        {
          id: "1",
          description: "Create dir",
          dependsOn: [],
          status: "done",
        },
      ],
    },
    stepResults: {
      "1": {
        stepId: "1",
        success: true,
        output: "Created out",
        durationMs: 5,
      },
    },
    blockReason: null,
    workingDir: "/tmp/workspace",
    model: "claude-sonnet-4-20250514",
    dryRun: false,
    createdAt: "2026-01-30T10:00:00.000Z",
    updatedAt: "2026-01-30T10:01:00.000Z",
  };

  it("saveRun creates the run directory and file", () => {
    saveRun(sampleRun, tmpDir);
    const filePath = path.join(tmpDir, "test-run-123", "run.json");
    expect(fs.existsSync(filePath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(filePath, "utf8")) as SerializedRun;
    expect(content.runId).toBe("test-run-123");
    expect(content.goal).toBe("Build something");
  });

  it("mirrors terminal runs to sanitized agent history without raw worker transcripts", () => {
    const originalToken = process.env.SMITHERSBOT_GATEWAY_TOKEN;
    process.env.SMITHERSBOT_GATEWAY_TOKEN = "FAKE_HISTORY_SECRET_123";
    try {
      saveRun(
        {
          ...sampleRun,
          runId: "history-mirror-run",
          goal: "Use FAKE_HISTORY_SECRET_123 safely",
          workingDir: path.join(
            process.env.SMITHERSBOT_GOALS_ROOT!,
            "agent",
            "workspaces",
            "smithersbot",
            "repo",
          ),
          stepResults: {
            "1": {
              stepId: "1",
              success: true,
              output: "RAW_STDOUT_BLOB FAKE_HISTORY_SECRET_123",
              error: "RAW_STDERR_BLOB FAKE_HISTORY_SECRET_123",
              durationMs: 1,
            },
          },
          buildGateResults: {
            "1": {
              passed: false,
              failedCommand: "echo FAKE_HISTORY_SECRET_123",
              output: "build output FAKE_HISTORY_SECRET_123",
              timestamp: "2026-01-30T10:02:00.000Z",
            },
          },
        },
        tmpDir,
      );
    } finally {
      if (originalToken === undefined) delete process.env.SMITHERSBOT_GATEWAY_TOKEN;
      else process.env.SMITHERSBOT_GATEWAY_TOKEN = originalToken;
    }

    const summaryPath = path.join(
      process.env.SMITHERSBOT_GOALS_ROOT!,
      "agent",
      "history",
      "goals",
      "smithersbot",
      "history-mirror-run",
      "summary.json",
    );
    const indexPath = path.join(
      process.env.SMITHERSBOT_GOALS_ROOT!,
      "agent",
      "history",
      "index",
      "all-goals.jsonl",
    );

    const summaryRaw = fs.readFileSync(summaryPath, "utf8");
    expect(summaryRaw).toContain("[REDACTED]");
    expect(summaryRaw).not.toContain("FAKE_HISTORY_SECRET_123");
    expect(summaryRaw).not.toContain("RAW_STDOUT_BLOB");
    expect(summaryRaw).not.toContain("RAW_STDERR_BLOB");
    expect(JSON.parse(summaryRaw)).toMatchObject({
      kind: "goal-run-summary",
      runId: "history-mirror-run",
      workspace: "smithersbot",
      state: "done",
    });

    saveRun({ ...sampleRun, runId: "history-mirror-run" }, tmpDir);
    const indexLines = fs.readFileSync(indexPath, "utf8").trim().split("\n");
    expect(indexLines).toHaveLength(1);
    expect(indexLines[0]).toContain("history-mirror-run");
  });

  it("loadRun returns the run data", () => {
    saveRun(sampleRun, tmpDir);
    const loaded = loadRun("test-run-123", tmpDir);
    expect(loaded).toBeDefined();
    expect(loaded!.runId).toBe("test-run-123");
    expect(loaded!.state).toBe("done");
  });

  it("loadRun returns undefined for missing run", () => {
    const loaded = loadRun("nonexistent", tmpDir);
    expect(loaded).toBeUndefined();
  });

  it("listRuns returns sorted summaries (newest first)", () => {
    saveRun(sampleRun, tmpDir);
    saveRun(
      {
        ...sampleRun,
        runId: "test-run-456",
        goal: "Another goal",
        updatedAt: "2026-01-30T12:00:00.000Z",
      },
      tmpDir,
    );
    const runs = listRuns(tmpDir);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.runId).toBe("test-run-456");
    expect(runs[1]!.runId).toBe("test-run-123");
  });

  it("listRuns returns empty array for missing directory", () => {
    const runs = listRuns(path.join(tmpDir, "nonexistent"));
    expect(runs).toEqual([]);
  });

  it("listRuns includes stepCount and completedSteps", () => {
    saveRun(sampleRun, tmpDir);
    const runs = listRuns(tmpDir);
    expect(runs[0]!.stepCount).toBe(1);
    expect(runs[0]!.completedSteps).toBe(1);
  });

  it("listRuns computes completedSteps from step statuses (not stepResults)", () => {
    saveRun(
      {
        ...sampleRun,
        runId: "status-progress-run",
        plan: {
          goal: "Test",
          workingDir: "/tmp/workspace",
          summary: "Progress test",
          steps: [
            {
              id: "1",
              description: "Done step",
              dependsOn: [],
              status: "done",
            },
            {
              id: "2",
              description: "Also done",
              dependsOn: [],
              status: "done",
            },
            {
              id: "3",
              description: "Still pending",
              dependsOn: ["1", "2"],
              status: "pending",
            },
          ],
        },
        // Legacy/manual runs may have empty stepResults.
        stepResults: {},
      },
      tmpDir,
    );
    const runs = listRuns(tmpDir);
    const run = runs.find((r) => r.runId === "status-progress-run");
    expect(run).toBeDefined();
    expect(run!.stepCount).toBe(3);
    expect(run!.completedSteps).toBe(2);
  });

  it("reconcileStaleRuns persists stale executing runs and counts only changed runs", () => {
    const staleRunId = "stale-executing-run";
    const activeRunId = "active-executing-run";
    const staleRunDir = path.join(tmpDir, staleRunId);
    const activeRunDir = path.join(tmpDir, activeRunId);
    const lockDir = path.join(tmpDir, ".locks", "runs");
    fs.mkdirSync(staleRunDir, { recursive: true });
    fs.mkdirSync(activeRunDir, { recursive: true });
    fs.mkdirSync(lockDir, { recursive: true });

    fs.writeFileSync(
      path.join(staleRunDir, "run.json"),
      JSON.stringify({
        runId: staleRunId,
        goal: "Stale run",
        state: "executing",
        plan: {
          goal: "Stale run",
          workingDir: "/tmp",
          summary: "Plan",
          steps: [{ id: "1", description: "Step", dependsOn: [], status: "in_progress" }],
        },
        stepResults: {},
        blocked: null,
        answers: {},
        workingDir: "/tmp",
        model: undefined,
        dryRun: false,
        createdAt: "2026-01-30T00:00:00.000Z",
        updatedAt: "2026-01-30T00:00:00.000Z",
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(activeRunDir, "run.json"),
      JSON.stringify({
        runId: activeRunId,
        goal: "Active run",
        state: "executing",
        plan: {
          goal: "Active run",
          workingDir: "/tmp",
          summary: "Plan",
          steps: [{ id: "1", description: "Step", dependsOn: [], status: "in_progress" }],
        },
        stepResults: {},
        blocked: null,
        answers: {},
        workingDir: "/tmp",
        model: undefined,
        dryRun: false,
        createdAt: "2026-01-30T00:00:00.000Z",
        updatedAt: "2026-01-30T00:00:00.000Z",
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(lockDir, `${activeRunId}.lock`),
      JSON.stringify({ pid: process.pid, label: "execute", createdAt: new Date().toISOString() }),
      "utf8",
    );

    expect(reconcileStaleRuns(tmpDir)).toBe(1);
    expect(reconcileStaleRuns(tmpDir)).toBe(0);

    const stalePersisted = JSON.parse(
      fs.readFileSync(path.join(staleRunDir, "run.json"), "utf8"),
    ) as SerializedRun;
    const activePersisted = JSON.parse(
      fs.readFileSync(path.join(activeRunDir, "run.json"), "utf8"),
    ) as SerializedRun;

    expect(stalePersisted.state).toBe("blocked");
    expect(stalePersisted.plan?.steps[0]?.status).toBe("pending");
    expect(activePersisted.state).toBe("executing");
    expect(activePersisted.plan?.steps[0]?.status).toBe("in_progress");
  });

  it("listRuns reconciles stale executing runs before returning summaries", () => {
    const runId = "list-reconciles-stale-run";
    const runDir = path.join(tmpDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "run.json"),
      JSON.stringify({
        runId,
        goal: "List stale run",
        state: "executing",
        plan: {
          goal: "List stale run",
          workingDir: "/tmp",
          summary: "Plan",
          steps: [{ id: "1", description: "Step", dependsOn: [], status: "in_progress" }],
        },
        stepResults: {},
        blocked: null,
        answers: {},
        workingDir: "/tmp",
        model: undefined,
        dryRun: false,
        createdAt: "2026-01-30T00:00:00.000Z",
        updatedAt: "2026-01-30T00:00:00.000Z",
      }),
      "utf8",
    );

    const listed = listRuns(tmpDir).find((run) => run.runId === runId);
    const persisted = JSON.parse(
      fs.readFileSync(path.join(runDir, "run.json"), "utf8"),
    ) as SerializedRun;

    expect(listed?.state).toBe("blocked");
    expect(persisted?.state).toBe("blocked");
  });

  it("listRuns preserves executing summaries when an active run lock exists", () => {
    const runId = "list-preserves-active-run";
    const runDir = path.join(tmpDir, runId);
    const lockDir = path.join(tmpDir, ".locks", "runs");
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "run.json"),
      JSON.stringify({
        runId,
        goal: "List active run",
        state: "executing",
        plan: {
          goal: "List active run",
          workingDir: "/tmp",
          summary: "Plan",
          steps: [{ id: "1", description: "Step", dependsOn: [], status: "in_progress" }],
        },
        stepResults: {},
        blocked: null,
        answers: {},
        workingDir: "/tmp",
        model: undefined,
        dryRun: false,
        createdAt: "2026-01-30T00:00:00.000Z",
        updatedAt: "2026-01-30T00:00:00.000Z",
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(lockDir, `${runId}.lock`),
      JSON.stringify({ pid: process.pid, label: "execute", createdAt: new Date().toISOString() }),
      "utf8",
    );

    const listed = listRuns(tmpDir).find((run) => run.runId === runId);
    const persisted = JSON.parse(
      fs.readFileSync(path.join(runDir, "run.json"), "utf8"),
    ) as SerializedRun;

    expect(listed?.state).toBe("executing");
    expect(persisted?.state).toBe("executing");
    expect(persisted?.plan?.steps[0]?.status).toBe("in_progress");
  });

  it("deleteRun removes the run directory", () => {
    saveRun(sampleRun, tmpDir);
    expect(deleteRun("test-run-123", tmpDir)).toBe(true);
    expect(loadRun("test-run-123", tmpDir)).toBeUndefined();
    expect(fs.existsSync(path.join(tmpDir, "test-run-123"))).toBe(false);
  });

  it("deleteRun returns false for missing run", () => {
    expect(deleteRun("nonexistent", tmpDir)).toBe(false);
  });

  it("resolveRunId returns exact match", () => {
    saveRun(sampleRun, tmpDir);
    expect(resolveRunId("test-run-123", tmpDir)).toBe("test-run-123");
  });

  it("resolveRunId returns prefix match", () => {
    saveRun(sampleRun, tmpDir);
    expect(resolveRunId("test-run-1", tmpDir)).toBe("test-run-123");
  });

  it("resolveRunId returns undefined for ambiguous prefix", () => {
    saveRun(sampleRun, tmpDir);
    saveRun({ ...sampleRun, runId: "test-run-124" }, tmpDir);
    expect(resolveRunId("test-run-1", tmpDir)).toBeUndefined();
  });

  it("resolveRunId returns undefined for no match", () => {
    saveRun(sampleRun, tmpDir);
    expect(resolveRunId("zzz", tmpDir)).toBeUndefined();
  });

  it("preserves durationMs through save/load disk round-trip", () => {
    const run: SerializedRun = {
      runId: "disk-duration-rt",
      goal: "Disk round-trip",
      state: "done",
      plan: {
        goal: "Disk round-trip",
        workingDir: "/tmp",
        summary: "Single step",
        steps: [{ id: "s1", description: "Step", dependsOn: [], status: "done" }],
      },
      stepResults: {
        s1: { stepId: "s1", success: true, output: "ok", durationMs: 42_000 },
      },
      blockReason: null,
      workingDir: "/tmp",
      model: undefined,
      dryRun: false,
      createdAt: "2026-01-30T00:00:00.000Z",
      updatedAt: "2026-01-30T00:01:00.000Z",
    };

    saveRun(run, tmpDir);
    const loaded = loadRun("disk-duration-rt", tmpDir);
    expect(loaded).toBeDefined();
    expect(loaded!.stepResults.s1?.durationMs).toBe(42_000);
  });

  it("migrates in_progress to pending when no active run lock exists", () => {
    const runId = "crash-recovery-no-lock";
    const runDir = path.join(tmpDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "run.json"),
      JSON.stringify({
        runId,
        goal: "Recover crashed run",
        state: "executing",
        plan: {
          goal: "Recover crashed run",
          workingDir: "/tmp",
          summary: "Plan",
          steps: [{ id: "1", description: "Step", dependsOn: [], status: "in_progress" }],
        },
        stepResults: {},
        blocked: null,
        answers: {},
        workingDir: "/tmp",
        model: undefined,
        dryRun: false,
        createdAt: "2026-01-30T00:00:00.000Z",
        updatedAt: "2026-01-30T00:00:00.000Z",
      }),
      "utf8",
    );

    const loaded = loadRun(runId, tmpDir);
    expect(loaded?.plan?.steps[0]?.status).toBe("pending");
    expect(loaded?.state).toBe("blocked");
    expect(loaded?.blocked?.requiredInputKey).toBe("resume_execution");
  });

  it("persists reconciled state changes back to run.json", () => {
    const runId = "persisted-reconciliation";
    const runDir = path.join(tmpDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "run.json"),
      JSON.stringify({
        runId,
        goal: "Persist stale reconciliation",
        state: "executing",
        plan: {
          goal: "Persist stale reconciliation",
          workingDir: "/tmp",
          summary: "Plan",
          steps: [{ id: "1", description: "Step", dependsOn: [], status: "in_progress" }],
        },
        stepResults: {},
        blocked: null,
        workingDir: "/tmp",
        model: undefined,
        dryRun: false,
        createdAt: "2026-01-30T00:00:00.000Z",
        updatedAt: "2026-01-30T00:00:00.000Z",
      }),
      "utf8",
    );

    const loaded = loadRun(runId, tmpDir);
    const persisted = JSON.parse(
      fs.readFileSync(path.join(runDir, "run.json"), "utf8"),
    ) as SerializedRun;

    expect(loaded?.state).toBe("blocked");
    expect(loaded?.plan?.steps[0]?.status).toBe("pending");
    expect(persisted.state).toBe("blocked");
    expect(persisted.plan?.steps[0]?.status).toBe("pending");
    expect(persisted.blocked?.requiredInputKey).toBe("resume_execution");
  });

  it("preserves in_progress when an active run lock exists", () => {
    const runId = "active-run-lock";
    const runDir = path.join(tmpDir, runId);
    const lockDir = path.join(tmpDir, ".locks", "runs");
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "run.json"),
      JSON.stringify({
        runId,
        goal: "Running goal",
        state: "executing",
        plan: {
          goal: "Running goal",
          workingDir: "/tmp",
          summary: "Plan",
          steps: [{ id: "1", description: "Step", dependsOn: [], status: "in_progress" }],
        },
        stepResults: {},
        blocked: null,
        answers: {},
        workingDir: "/tmp",
        model: undefined,
        dryRun: false,
        createdAt: "2026-01-30T00:00:00.000Z",
        updatedAt: "2026-01-30T00:00:00.000Z",
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(lockDir, `${runId}.lock`),
      JSON.stringify({ pid: process.pid, label: "approve", createdAt: new Date().toISOString() }),
      "utf8",
    );

    const loaded = loadRun(runId, tmpDir);
    expect(loaded?.plan?.steps[0]?.status).toBe("in_progress");
    expect(loaded?.state).toBe("executing");
  });

  it("does not write active locked runs back to run.json", () => {
    const runId = "active-run-lock-no-write";
    const runDir = path.join(tmpDir, runId);
    const lockDir = path.join(tmpDir, ".locks", "runs");
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "run.json"),
      JSON.stringify({
        runId,
        goal: "Locked goal",
        state: "executing",
        plan: {
          goal: "Locked goal",
          workingDir: "/tmp",
          summary: "Plan",
          steps: [{ id: "1", description: "Step", dependsOn: [], status: "in_progress" }],
        },
        stepResults: {},
        blocked: null,
        workingDir: "/tmp",
        model: undefined,
        dryRun: false,
        createdAt: "2026-01-30T00:00:00.000Z",
        updatedAt: "2026-01-30T00:00:00.000Z",
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(lockDir, `${runId}.lock`),
      JSON.stringify({ pid: process.pid, label: "approve", createdAt: new Date().toISOString() }),
      "utf8",
    );

    const loaded = loadRun(runId, tmpDir);
    const persisted = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8")) as Record<
      string,
      unknown
    >;

    expect(loaded?.state).toBe("executing");
    expect(loaded?.answers).toEqual({});
    expect(persisted.state).toBe("executing");
    expect(persisted.plan).toEqual({
      goal: "Locked goal",
      workingDir: "/tmp",
      summary: "Plan",
      steps: [{ id: "1", description: "Step", dependsOn: [], status: "in_progress" }],
    });
    expect(persisted.answers).toBeUndefined();
  });

  it("migrates stale executing runs with all done steps to done", () => {
    const runId = "executing-all-done";
    const runDir = path.join(tmpDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "run.json"),
      JSON.stringify({
        runId,
        goal: "Finish run on crash",
        state: "executing",
        plan: {
          goal: "Finish run on crash",
          workingDir: "/tmp",
          summary: "Plan",
          steps: [{ id: "1", description: "Step", dependsOn: [], status: "done" }],
        },
        stepResults: {
          "1": { stepId: "1", success: true, output: "Done", durationMs: 1 },
        },
        blocked: null,
        answers: {},
        workingDir: "/tmp",
        model: undefined,
        dryRun: false,
        createdAt: "2026-01-30T00:00:00.000Z",
        updatedAt: "2026-01-30T00:00:00.000Z",
      }),
      "utf8",
    );

    const loaded = loadRun(runId, tmpDir);
    expect(loaded?.state).toBe("done");
    expect(loaded?.blocked).toBeNull();
  });

  it("blocks stale executing runs when no in_progress step exists and no lock is present", () => {
    const runId = "executing-pending-no-lock";
    const runDir = path.join(tmpDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "run.json"),
      JSON.stringify({
        runId,
        goal: "Pending run",
        state: "executing",
        plan: {
          goal: "Pending run",
          workingDir: "/tmp",
          summary: "Plan",
          steps: [{ id: "1", description: "Step", dependsOn: [], status: "pending" }],
        },
        stepResults: {},
        blocked: null,
        answers: {},
        workingDir: "/tmp",
        model: undefined,
        dryRun: false,
        createdAt: "2026-01-30T00:00:00.000Z",
        updatedAt: "2026-01-30T00:00:00.000Z",
      }),
      "utf8",
    );

    const loaded = loadRun(runId, tmpDir);
    expect(loaded?.state).toBe("blocked");
    expect(loaded?.blocked?.requiredInputKey).toBe("resume_execution");
  });
});

describe("run-store resume visual state (load → display)", () => {
  let tmpDir: string;
  let originalManagedRoot: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-store-vis-"));
    originalManagedRoot = process.env.SMITHERSBOT_GOALS_ROOT;
    process.env.SMITHERSBOT_GOALS_ROOT = path.join(tmpDir, "managed");
  });

  afterEach(() => {
    if (originalManagedRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
    else process.env.SMITHERSBOT_GOALS_ROOT = originalManagedRoot;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeRun(runId: string, run: Record<string, unknown>): void {
    const runDir = path.join(tmpDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify(run), "utf8");
  }

  it("blocked goal resumed: cascade-blocked downstream/independent steps are not stale blocked", () => {
    // Mirrors the fatal-error cascade in agent-executor.ts: a failed step plus
    // downstream + independent steps all marked blocked for a technical reason.
    writeRun("cascade-blocked", {
      runId: "cascade-blocked",
      goal: "Cascade",
      state: "blocked",
      plan: {
        goal: "Cascade",
        workingDir: "/tmp",
        summary: "Plan",
        steps: [
          {
            id: "1",
            description: "Failed",
            dependsOn: [],
            status: "blocked",
            blockedReason: "error",
          },
          {
            id: "2",
            description: "Downstream",
            dependsOn: ["1"],
            status: "blocked",
            blockedReason: "error",
          },
          {
            id: "3",
            description: "Independent",
            dependsOn: [],
            status: "blocked",
            blockedReason: "out_of_credits",
          },
        ],
      },
      stepResults: {},
      blocked: { blockedAt: "execution", prompt: "stopped", requiredInputKey: "resume_execution" },
      answers: {},
      workingDir: "/tmp",
      model: undefined,
      dryRun: false,
      createdAt: "2026-01-30T00:00:00.000Z",
      updatedAt: "2026-01-30T00:00:00.000Z",
    });

    const loaded = loadRun("cascade-blocked", tmpDir);
    expect(loaded?.state).toBe("blocked");
    const display = computeDisplayStatuses(loaded!.plan!.steps);
    // None are hard (user-input) blockers. The error-blocked steps (1, 2) are
    // re-run on resume so they render pending. Step 3 is a real backend
    // usage-limit blocker: visibly usage_limited (never hidden as pending), yet
    // still retryable on resume once a compatible backend is available.
    expect(display.get("1")).toBe("pending");
    expect(display.get("2")).toBe("pending");
    expect(display.get("3")).toBe("usage_limited");
  });

  it("legacy failed/skipped steps load as retryable and render runnable, not stale blocked", () => {
    // Old runs persisted "failed"/"skipped" statuses; migrateRun maps them to
    // blocked+error (retryable), which must render as pending after the fix.
    writeRun("legacy-statuses", {
      runId: "legacy-statuses",
      goal: "Legacy",
      state: "blocked",
      plan: {
        goal: "Legacy",
        workingDir: "/tmp",
        summary: "Plan",
        steps: [
          { id: "1", description: "Done", dependsOn: [], status: "done" },
          { id: "2", description: "Failed", dependsOn: ["1"], status: "failed" },
          { id: "3", description: "Skipped final", dependsOn: ["2"], status: "skipped" },
        ],
      },
      stepResults: { "1": { stepId: "1", success: true, output: "ok", durationMs: 1 } },
      blocked: { blockedAt: "execution", prompt: "stopped", requiredInputKey: "resume_execution" },
      answers: {},
      workingDir: "/tmp",
      model: undefined,
      dryRun: false,
      createdAt: "2026-01-30T00:00:00.000Z",
      updatedAt: "2026-01-30T00:00:00.000Z",
    });

    const loaded = loadRun("legacy-statuses", tmpDir);
    // migrateRun normalizes legacy statuses to the current enum.
    expect(loaded!.plan!.steps[1]?.status).toBe("blocked");
    expect(loaded!.plan!.steps[2]?.status).toBe("blocked");

    const display = computeDisplayStatuses(loaded!.plan!.steps);
    expect(display.get("1")).toBe("done");
    expect(display.get("2")).toBe("pending");
    expect(display.get("3")).toBe("pending");
  });

  it("genuine user-input block stays blocked and keeps downstream waiting after load", () => {
    writeRun("user-input-block", {
      runId: "user-input-block",
      goal: "Needs input",
      state: "blocked",
      plan: {
        goal: "Needs input",
        workingDir: "/tmp",
        summary: "Plan",
        steps: [
          {
            id: "1",
            description: "Ask user",
            dependsOn: [],
            status: "blocked",
            blockedReason: "user_input",
            blockedQuestion: "Which DB?",
          },
          {
            id: "2",
            description: "Downstream",
            dependsOn: ["1"],
            status: "blocked",
            blockedReason: "error",
          },
          { id: "3", description: "Independent", dependsOn: [], status: "pending" },
        ],
      },
      stepResults: {},
      blocked: { blockedAt: "execution", prompt: "Which DB?", requiredInputKey: "step:1:input" },
      answers: {},
      workingDir: "/tmp",
      model: undefined,
      dryRun: false,
      createdAt: "2026-01-30T00:00:00.000Z",
      updatedAt: "2026-01-30T00:00:00.000Z",
    });

    const loaded = loadRun("user-input-block", tmpDir);
    const display = computeDisplayStatuses(loaded!.plan!.steps);
    expect(display.get("1")).toBe("blocked"); // truly blocked
    expect(display.get("2")).toBe("soft_blocked"); // waiting on the hard block
    expect(display.get("3")).toBe("pending"); // independent, not blocked
  });

  it("crash-recovered run resets in_progress to pending and renders no stale blocked", () => {
    writeRun("crash-recover-display", {
      runId: "crash-recover-display",
      goal: "Crashed",
      state: "executing",
      plan: {
        goal: "Crashed",
        workingDir: "/tmp",
        summary: "Plan",
        steps: [
          { id: "1", description: "Was running", dependsOn: [], status: "in_progress" },
          { id: "2", description: "Final", dependsOn: ["1"], status: "pending" },
        ],
      },
      stepResults: {},
      blocked: null,
      answers: {},
      workingDir: "/tmp",
      model: undefined,
      dryRun: false,
      createdAt: "2026-01-30T00:00:00.000Z",
      updatedAt: "2026-01-30T00:00:00.000Z",
    });

    const loaded = loadRun("crash-recover-display", tmpDir);
    expect(loaded?.state).toBe("blocked");
    const display = computeDisplayStatuses(loaded!.plan!.steps);
    // Final step must show pending/waiting, never stale blocked.
    expect(display.get("1")).toBe("pending");
    expect(display.get("2")).toBe("pending");
  });
});

describe("session serialization", () => {
  it("round-trips GoalSession through serialized form", () => {
    const session: GoalSession = {
      goal: "Test goal",
      state: "executing",
      plan: {
        goal: "Test goal",
        workingDir: "/tmp/ws",
        summary: "A plan",
        steps: [
          {
            id: "1",
            description: "Step one",
            dependsOn: [],
            status: "done",
          },
          {
            id: "2",
            description: "Step two",
            dependsOn: ["1"],
            status: "pending",
          },
        ],
      },
      stepResults: new Map([
        ["1", { stepId: "1", success: true, output: "Created dir", durationMs: 3 }],
      ]),
      blockReason: null,
    };

    const serialized = sessionToSerialized({
      session,
      runId: "round-trip-id",
      workingDir: "/tmp/ws",
      model: undefined,
      dryRun: false,
      createdAt: "2026-01-30T00:00:00.000Z",
    });

    expect(serialized.stepResults).toEqual({
      "1": { stepId: "1", success: true, output: "Created dir", durationMs: 3 },
    });

    const restored = serializedToSession(serialized);
    expect(restored.stepResults).toBeInstanceOf(Map);
    expect(restored.stepResults.get("1")?.success).toBe(true);
    expect(restored.stepResults.has("2")).toBe(false);
    expect(restored.state).toBe("executing");
    expect(restored.goal).toBe("Test goal");
  });

  it("round-trips multiple stepResults with durationMs through serialization", () => {
    const session: GoalSession = {
      goal: "Duration round-trip",
      state: "done",
      plan: {
        goal: "Duration round-trip",
        workingDir: "/tmp/ws",
        summary: "Multi-step durations",
        steps: [
          { id: "1", description: "Fast step", dependsOn: [], status: "done" },
          { id: "2", description: "Slow step", dependsOn: ["1"], status: "done" },
          { id: "3", description: "Pending step", dependsOn: ["2"], status: "pending" },
        ],
      },
      stepResults: new Map([
        ["1", { stepId: "1", success: true, output: "Done quickly", durationMs: 1500 }],
        ["2", { stepId: "2", success: true, output: "Done slowly", durationMs: 300_000 }],
      ]),
      blockReason: null,
    };

    const serialized = sessionToSerialized({
      session,
      runId: "duration-multi-rt",
      workingDir: "/tmp/ws",
      model: undefined,
      dryRun: false,
      createdAt: "2026-01-30T00:00:00.000Z",
    });

    // Serialized form: plain object, not Map
    expect(serialized.stepResults["1"]?.durationMs).toBe(1500);
    expect(serialized.stepResults["2"]?.durationMs).toBe(300_000);
    expect(serialized.stepResults["3"]).toBeUndefined();

    // Restored form: Map with same durations
    const restored = serializedToSession(serialized);
    expect(restored.stepResults.get("1")?.durationMs).toBe(1500);
    expect(restored.stepResults.get("2")?.durationMs).toBe(300_000);
    expect(restored.stepResults.has("3")).toBe(false);
  });

  it("handles empty stepResults", () => {
    const serialized: SerializedRun = {
      runId: "empty-id",
      goal: "Empty",
      state: "planning",
      plan: null,
      stepResults: {},
      blockReason: null,
      workingDir: "/tmp",
      model: undefined,
      dryRun: false,
      createdAt: "2026-01-30T00:00:00.000Z",
      updatedAt: "2026-01-30T00:00:00.000Z",
    };

    const session = serializedToSession(serialized);
    expect(session.stepResults.size).toBe(0);
  });

  it("preserves dryRun flag", () => {
    const session: GoalSession = {
      goal: "Dry test",
      state: "done",
      plan: null,
      stepResults: new Map(),
      blockReason: null,
    };

    const serialized = sessionToSerialized({
      session,
      runId: "dry-id",
      workingDir: "/tmp",
      model: undefined,
      dryRun: true,
      createdAt: "2026-01-30T00:00:00.000Z",
    });

    expect(serialized.dryRun).toBe(true);
  });

  it("round-trips build-gate and ralph tracking fields", () => {
    const session: GoalSession = {
      goal: "Build-gate persistence",
      state: "executing",
      plan: null,
      stepResults: new Map(),
      blockReason: null,
      buildGateConfig: {
        commands: ["pnpm build"],
        runBetweenSteps: true,
      },
      stepRalphCounts: {
        "step-1": 1,
      },
      buildGateFixCounts: {
        "step-1": 2,
      },
      buildGateFixSignatures: {
        "step-1":
          "semgrep scan --config auto --error --quiet --severity ERROR --timeout 600 --exclude 'node_modules' --exclude 'dist' --exclude '.git' --exclude '.next' --exclude 'build' --exclude '*.test.ts' --exclude '.moltbot-goal-worker-results' src/example.ts\npnpm build",
      },
      buildGateResults: {
        "step-1": {
          passed: false,
          failedCommand: "pnpm build",
          output: "Cannot find module",
          timestamp: "2026-01-30T00:00:00.000Z",
        },
      },
    };

    const serialized = sessionToSerialized({
      session,
      runId: "build-gate-rt",
      workingDir: "/tmp",
      model: undefined,
      dryRun: false,
      createdAt: "2026-01-30T00:00:00.000Z",
    });

    expect(serialized.buildGateConfig).toEqual({
      commands: ["pnpm build"],
      runBetweenSteps: true,
    });
    expect(serialized.stepRalphCounts).toEqual({ "step-1": 1 });
    expect(serialized.buildGateFixCounts).toEqual({ "step-1": 2 });
    expect(serialized.buildGateFixSignatures).toEqual({
      "step-1":
        "semgrep scan --config auto --error --quiet --severity ERROR --timeout 600 --exclude 'node_modules' --exclude 'dist' --exclude '.git' --exclude '.next' --exclude 'build' --exclude '*.test.ts' --exclude '.moltbot-goal-worker-results' src/example.ts\npnpm build",
    });
    expect(serialized.buildGateResults?.["step-1"]?.failedCommand).toBe("pnpm build");

    const restored = serializedToSession(serialized);
    expect(restored.buildGateConfig?.commands).toEqual(["pnpm build"]);
    expect(restored.stepRalphCounts).toEqual({ "step-1": 1 });
    expect(restored.buildGateFixCounts).toEqual({ "step-1": 2 });
    expect(restored.buildGateFixSignatures).toEqual({
      "step-1":
        "semgrep scan --config auto --error --quiet --severity ERROR --timeout 600 --exclude 'node_modules' --exclude 'dist' --exclude '.git' --exclude '.next' --exclude 'build' --exclude '*.test.ts' --exclude '.moltbot-goal-worker-results' src/example.ts\npnpm build",
    });
    expect(restored.buildGateResults?.["step-1"]?.output).toBe("Cannot find module");
  });

  it("defaults ralph/build-gate maps to empty objects when missing", () => {
    const serialized: SerializedRun = {
      runId: "empty-ralph-buildgate",
      goal: "No ralph/build-gate state",
      state: "planning",
      plan: null,
      stepResults: {},
      blockReason: null,
      workingDir: "/tmp",
      model: undefined,
      dryRun: false,
      createdAt: "2026-01-30T00:00:00.000Z",
      updatedAt: "2026-01-30T00:00:00.000Z",
    };

    const restored = serializedToSession(serialized);
    expect(restored.stepRalphCounts).toEqual({});
    expect(restored.buildGateFixCounts).toEqual({});
    expect(restored.buildGateFixSignatures).toEqual({});
    expect(restored.buildGateResults).toEqual({});
    expect(restored.buildGateConfig).toBeUndefined();
  });

  it("preserves run metadata when previousRun is provided", () => {
    const session: GoalSession = {
      goal: "Metadata test",
      state: "executing",
      plan: null,
      stepResults: new Map(),
      blockReason: null,
    };

    const previousRun: SerializedRun = {
      runId: "meta-id",
      goal: "Metadata test",
      state: "blocked",
      plan: null,
      stepResults: {},
      blocked: null,
      answers: {},
      workingDir: "/tmp",
      model: undefined,
      dryRun: false,
      createdAt: "2026-01-30T00:00:00.000Z",
      updatedAt: "2026-01-30T00:00:00.000Z",
      planRevision: 2,
      activePlanRevision: 2,
      planHistory: [
        { revision: 1, plan: { goal: "Meta", workingDir: "/tmp", steps: [], summary: "meta" } },
      ],
      telegramPlanMessage: { chatId: 1, messageId: 2 },
      telegramQuestionMessages: [{ chatId: 1, messageId: 3, requiredInputKey: "task:1:input" }],
      telegramDoneMessage: { chatId: 1, messageId: 4 },
      telegramFeedbackPromptMessages: [{ chatId: 1, messageId: 5 }],
      agentSessionFile: "/tmp/session.jsonl",
      agentSessionId: "agent-1",
      agentMaxTurnsPerTask: 7,
      manualTests: [
        {
          description: "Run smoke test",
          criticality: 8,
          detail: "Verify login and settings flows still work.",
        },
      ],
      manualTestsError: "HTTP 401: invalid x-api-key",
      buildGateConfig: {
        commands: ["pnpm build"],
        runBetweenSteps: true,
      },
      stepRalphCounts: {
        "step-1": 2,
      },
      buildGateFixCounts: {
        "step-1": 1,
      },
      buildGateFixSignatures: {
        "step-1": "pnpm build",
      },
      buildGateResults: {
        "step-1": {
          passed: true,
          timestamp: "2026-01-30T00:00:00.000Z",
        },
      },
    };

    const serialized = sessionToSerialized({
      session,
      runId: "meta-id",
      workingDir: "/tmp",
      model: undefined,
      dryRun: false,
      createdAt: "2026-01-30T00:00:00.000Z",
      previousRun,
    });

    expect(serialized.planRevision).toBe(2);
    expect(serialized.activePlanRevision).toBe(2);
    expect(serialized.planHistory).toHaveLength(1);
    expect(serialized.telegramPlanMessage?.messageId).toBe(2);
    expect(serialized.telegramQuestionMessages?.[0]?.messageId).toBe(3);
    expect(serialized.telegramDoneMessage?.messageId).toBe(4);
    expect(serialized.telegramFeedbackPromptMessages?.[0]?.messageId).toBe(5);
    expect(serialized.agentSessionFile).toBe("/tmp/session.jsonl");
    expect(serialized.agentSessionId).toBe("agent-1");
    expect(serialized.agentMaxTurnsPerTask).toBe(7);
    expect(serialized.manualTests?.[0]?.description).toBe("Run smoke test");
    expect(serialized.manualTestsError).toBe("HTTP 401: invalid x-api-key");
    expect(serialized.buildGateConfig?.commands).toEqual(["pnpm build"]);
    expect(serialized.stepRalphCounts).toEqual({ "step-1": 2 });
    expect(serialized.buildGateFixCounts).toEqual({ "step-1": 1 });
    expect(serialized.buildGateFixSignatures).toEqual({ "step-1": "pnpm build" });
    expect(serialized.buildGateResults?.["step-1"]?.passed).toBe(true);
  });
});
