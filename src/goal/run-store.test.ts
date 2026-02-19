import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  saveRun,
  loadRun,
  listRuns,
  deleteRun,
  resolveRunId,
  sessionToSerialized,
  serializedToSession,
} from "./run-store.js";
import type { GoalSession, SerializedRun } from "./types.js";

describe("run-store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-store-test-"));
  });

  afterEach(() => {
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

  it("keeps executing state when no in_progress step exists and no lock is present", () => {
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
    expect(loaded?.state).toBe("executing");
    expect(loaded?.blocked).toBeNull();
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
  });
});
