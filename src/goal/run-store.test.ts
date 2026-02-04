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
        // stepResults is empty — agent executor doesn't populate it
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
});

describe("session serialization", () => {
  it("round-trips GoalSession through serialized form", () => {
    const session: GoalSession = {
      goal: "Test goal",
      state: "executing",
      plan: {
        goal: "Test goal",
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
});
