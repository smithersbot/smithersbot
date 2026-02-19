import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonExitError } from "../cli/cli-utils.js";
import { saveRun } from "../goal/run-store.js";
import type { SerializedRun } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";

async function catchJsonExit(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof JsonExitError)) throw err;
  }
}

function outputLines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function findLineIndex(lines: string[], prefix: string): number {
  return lines.findIndex((line) => line.startsWith(prefix));
}

function getStepLines(lines: string[]): string[] {
  return lines.filter((line) => line.startsWith("- "));
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

const sampleRun: SerializedRun = {
  runId: "detail-test-aaaa",
  goal: "Build a widget",
  state: "done",
  plan: {
    goal: "Build a widget",
    workingDir: "/tmp",
    summary: "Widget plan",
    steps: [
      {
        id: "1",
        description: "Create dir",
        dependsOn: [],
        status: "done",
      },
    ],
  },
  stepResults: { "1": { stepId: "1", success: true, output: "", durationMs: 1 } },
  blocked: null,
  answers: {},
  workingDir: "/tmp",
  model: undefined,
  dryRun: false,
  createdAt: "2026-01-30T00:00:00.000Z",
  updatedAt: "2026-01-30T00:01:00.000Z",
};

describe("goal-detail command", () => {
  beforeEach(() => {
    testGoalsDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-detail-test-"));
  });

  afterEach(() => {
    fs.rmSync(testGoalsDir, { recursive: true, force: true });
  });

  it("shows all steps with full text and no truncation", async () => {
    const longDescription =
      "This is a very long step description with an explicit tail marker END-OF-LONG-DESCRIPTION-MARKER";
    saveRun({
      ...sampleRun,
      runId: "detail-full-steps",
      state: "executing",
      agentMaxTurnsPerTask: 4,
      plan: {
        goal: "Build a widget",
        workingDir: "/tmp",
        summary: "Long plan",
        steps: [
          { id: "1", description: "Prepare schema", dependsOn: [], status: "done" },
          {
            id: "2",
            description: longDescription,
            dependsOn: ["1"],
            status: "in_progress",
            turnsUsed: 3,
          },
          { id: "3", description: "Add repository layer", dependsOn: ["2"], status: "pending" },
          { id: "4", description: "Add service layer", dependsOn: ["3"], status: "pending" },
          { id: "5", description: "Add API routes", dependsOn: ["4"], status: "pending" },
          { id: "6", description: "Add integration tests", dependsOn: ["5"], status: "pending" },
          { id: "7", description: "Update docs", dependsOn: ["6"], status: "pending" },
        ],
      },
      stepResults: {},
    });

    const { goalDetailCommand } = await import("./goal-detail.js");
    const rt = mockRuntime();
    await goalDetailCommand("detail-full-steps", {}, rt);

    const output = rt.logs.join("\n");
    const lines = outputLines(output);
    const stepsHeaderIndex = findLineIndex(lines, "**Steps**");
    expect(stepsHeaderIndex).toBeGreaterThan(0);
    expect(findLineIndex(lines, "**Top Steps**")).toBe(-1);
    expect(getStepLines(lines)).toHaveLength(7);
    expect(output).not.toContain("more steps not shown");
    expect(output).toContain(longDescription);
    expect(output).toContain("END-OF-LONG-DESCRIPTION-MARKER");
    expect(output).toContain("[3/4]");
    expect(output).toContain("Run ID: detail-full-steps");
  });

  it("uses plan and step shortSummary values when present", async () => {
    saveRun({
      ...sampleRun,
      runId: "detail-short-summary",
      plan: {
        ...sampleRun.plan!,
        shortSummary: "Ship the widget flow",
        steps: [
          {
            id: "1",
            description: "Very long setup description that should not be shown in the step line",
            shortSummary: "Set up project scaffold",
            dependsOn: [],
            status: "done",
          },
          {
            id: "2",
            description: "Another verbose description that should be replaced by shortSummary",
            shortSummary: "Wire API handlers",
            dependsOn: ["1"],
            status: "done",
          },
        ],
      },
      stepResults: {},
    });

    const { goalDetailCommand } = await import("./goal-detail.js");
    const rt = mockRuntime();
    await goalDetailCommand("detail-short-summary", {}, rt);
    const output = rt.logs.join("\n");

    expect(output).toContain("✅ Done: Ship the widget flow");
    expect(output).toContain("- 1. done Set up project scaffold");
    expect(output).toContain("- 2. done Wire API handlers");
    expect(output).not.toContain("Very long setup description");
    expect(output).not.toContain("Another verbose description");
  });

  it("does not cap telegram detail output to the concise line budget", async () => {
    saveRun({
      ...sampleRun,
      runId: "detail-telegram-full",
      state: "awaiting_approval",
      plan: {
        goal: "Build a widget",
        workingDir: "/tmp",
        summary: "Long plan",
        steps: Array.from({ length: 20 }, (_, index) => ({
          id: String(index + 1),
          description: `Task ${index + 1} full detail`,
          dependsOn: index === 0 ? [] : [String(index)],
          status: index === 0 ? "done" : "pending",
        })),
      },
      stepResults: {},
    });

    const { goalDetailCommand } = await import("./goal-detail.js");
    const rt = mockRuntime();
    await goalDetailCommand("detail-telegram-full", { channel: "telegram" }, rt);
    const lines = outputLines(rt.logs.join("\n"));

    expect(lines.length).toBeGreaterThan(15);
    expect(findLineIndex(lines, "**Steps**")).toBeGreaterThan(0);
    expect(lines.some((line) => line.includes("20. pending Task 20 full detail"))).toBe(true);
    expect(lines.some((line) => line.includes("more steps not shown"))).toBe(false);
  });

  it("--json outputs strict JSON object", async () => {
    saveRun(sampleRun);
    const { goalDetailCommand } = await import("./goal-detail.js");
    const rt = mockRuntime();
    await goalDetailCommand("detail-test-aaaa", { json: true }, rt);
    const raw = rt.logs.join("");
    expect(raw.trimStart()[0]).toBe("{");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.runId).toBe("detail-test-aaaa");
    expect(parsed.goal).toBe("Build a widget");
  });

  it("renders step states for each step", async () => {
    const runId = "detail-step-states";
    saveRun({
      ...sampleRun,
      runId,
      state: "executing",
      plan: {
        goal: "Build a widget",
        workingDir: "/tmp",
        summary: "Stateful plan",
        steps: [
          { id: "1", description: "Create dir", dependsOn: [], status: "done" },
          {
            id: "2",
            description: "Generate schema",
            dependsOn: ["1"],
            status: "in_progress",
          },
          { id: "3", description: "Apply migration", dependsOn: ["2"], status: "blocked" },
          { id: "4", description: "Deploy service", dependsOn: ["3"], status: "pending" },
        ],
      },
      stepResults: {},
    });
    fs.mkdirSync(path.join(testGoalsDir, ".locks", "runs"), { recursive: true });
    fs.writeFileSync(
      path.join(testGoalsDir, ".locks", "runs", `${runId}.lock`),
      JSON.stringify({ pid: process.pid, label: "resume", createdAt: new Date().toISOString() }),
      "utf8",
    );

    const { goalDetailCommand } = await import("./goal-detail.js");
    const rt = mockRuntime();
    await goalDetailCommand(runId, {}, rt);
    const output = rt.logs.join("\n");

    expect(output).toContain("- 1. done Create dir");
    expect(output).toContain("- 2. in_progress Generate schema");
    expect(output).toContain("- 3. blocked Apply migration");
    expect(output).toContain("- 4. pending Deploy service");
  });

  it("shows blocked details and answer hint while retaining full steps", async () => {
    saveRun({
      ...sampleRun,
      runId: "detail-blocked-run",
      state: "blocked",
      blocked: { blockedAt: "execution", prompt: "Need creds", requiredInputKey: "db_password" },
      plan: {
        goal: "Build a widget",
        workingDir: "/tmp",
        summary: "Blocked plan",
        steps: [
          { id: "1", description: "Prepare schema", dependsOn: [], status: "done" },
          { id: "2", description: "Run migrations", dependsOn: ["1"], status: "blocked" },
        ],
      },
      stepResults: {},
    });

    const { goalDetailCommand } = await import("./goal-detail.js");
    const rt = mockRuntime();
    await goalDetailCommand("detail-blocked-run", {}, rt);
    const output = rt.logs.join("\n");

    expect(output).toContain("**Blocker** Execution: Need creds (key: db_password)");
    expect(output).toContain(
      "Next: moltbot goal answer detail-b --key db_password --value <VALUE>",
    );
    expect(output).toContain("**Steps**");
    expect(output).toContain("- 2. blocked Run migrations");
  });

  it("shows resume hint for auto-retry execution blocks", async () => {
    saveRun({
      ...sampleRun,
      runId: "detail-resume-blocked",
      state: "blocked",
      blocked: {
        blockedAt: "execution",
        prompt: "Run interrupted, resume to continue.",
        requiredInputKey: "resume_execution",
      },
      plan: {
        goal: "Build a widget",
        workingDir: "/tmp",
        summary: "Interrupted plan",
        steps: [{ id: "1", description: "Continue", dependsOn: [], status: "pending" }],
      },
      stepResults: {},
    });

    const { goalDetailCommand } = await import("./goal-detail.js");
    const rt = mockRuntime();
    await goalDetailCommand("detail-resume-blocked", {}, rt);
    const output = rt.logs.join("\n");

    expect(output).toContain("**Blocker** Execution: Run interrupted, resume to continue.");
    expect(output).toContain("**Goal ID:** detail-r");
    expect(output).not.toContain("moltbot goal answer");
  });

  it("--output json outputs strict JSON object", async () => {
    saveRun(sampleRun);
    const { goalDetailCommand } = await import("./goal-detail.js");
    const rt = mockRuntime();
    await goalDetailCommand("detail-test-aaaa", { output: "json" }, rt);
    const raw = rt.logs.join("");
    expect(raw.trimStart()[0]).toBe("{");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.runId).toBe("detail-test-aaaa");
  });

  it("--json error for unknown run outputs strict JSON", async () => {
    const { goalDetailCommand } = await import("./goal-detail.js");
    const rt = mockRuntime();
    await catchJsonExit(() => goalDetailCommand("nonexistent", { json: true }, rt));
    const raw = rt.logs.join("");
    expect(raw.trimStart()[0]).toBe("{");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.error).toBe("Run not found: nonexistent");
  });
});
