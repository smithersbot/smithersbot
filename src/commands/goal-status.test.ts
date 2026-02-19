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

function saveRunFixture(run: SerializedRun): void {
  if (!run.plan) {
    saveRun(run);
    return;
  }

  const normalizedPlan = {
    ...run.plan,
    shortSummary: run.plan.shortSummary || run.plan.summary || run.goal,
    steps: run.plan.steps.map((step) => ({
      ...step,
      shortSummary: step.shortSummary || step.description || step.id,
    })),
  };
  saveRun({ ...run, plan: normalizedPlan });
}

const sampleRun: SerializedRun = {
  runId: "status-test-aaaa",
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

describe("goal-status command", () => {
  beforeEach(() => {
    testGoalsDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-status-test-"));
  });

  afterEach(() => {
    fs.rmSync(testGoalsDir, { recursive: true, force: true });
  });

  it("shows run details in text mode", async () => {
    saveRunFixture(sampleRun);
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("status-test-aaaa", {}, rt);
    const lines = outputLines(rt.logs.join("\n"));
    const headlineIndex = findLineIndex(lines, "✅ Done: Widget plan");
    const progressIndex = findLineIndex(lines, "**Progress** 1/1");
    const retriesIndex = findLineIndex(lines, "**Retries** 0 retries");
    const runIdIndex = findLineIndex(lines, "Run ID: status-test-aaaa");
    expect(headlineIndex).toBe(0);
    expect(progressIndex).toBeGreaterThan(headlineIndex);
    expect(retriesIndex).toBeGreaterThan(progressIndex);
    expect(runIdIndex).toBeGreaterThan(retriesIndex);
  });

  it("uses plan shortSummary for the status headline when present", async () => {
    saveRunFixture({
      ...sampleRun,
      runId: "status-short-summary",
      plan: {
        ...sampleRun.plan!,
        shortSummary: "Ship the widget flow",
      },
    });
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("status-short-summary", {}, rt);
    const output = rt.logs.join("\n");
    expect(output).toContain("✅ Done: Ship the widget flow");
    expect(output).not.toContain("✅ Done: Build a widget");
  });

  it("renders in-progress Mermaid class when run lock is active", async () => {
    const runId = "status-inprog";
    saveRunFixture({
      ...sampleRun,
      runId,
      state: "executing",
      plan: {
        goal: "Build a widget",
        workingDir: "/tmp",
        summary: "Widget plan",
        steps: [
          {
            id: "1",
            description: "Create dir",
            dependsOn: [],
            status: "in_progress",
          },
        ],
      },
      stepResults: {},
    });
    fs.mkdirSync(path.join(testGoalsDir, ".locks", "runs"), { recursive: true });
    fs.writeFileSync(
      path.join(testGoalsDir, ".locks", "runs", `${runId}.lock`),
      JSON.stringify({ pid: process.pid, label: "approve", createdAt: new Date().toISOString() }),
      "utf8",
    );

    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand(runId, { diagram: "mermaid" }, rt);
    const output = rt.logs.join("\n");
    expect(output).toContain("🛠");
    expect(output).toContain("class 1 inprog;");
  });

  it("--json outputs strict JSON object", async () => {
    saveRunFixture(sampleRun);
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("status-test-aaaa", { json: true }, rt);
    const raw = rt.logs.join("");
    expect(raw.trimStart()[0]).toBe("{");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.runId).toBe("status-test-aaaa");
    expect(parsed.goal).toBe("Build a widget");
  });

  it("--output json outputs strict JSON object", async () => {
    saveRunFixture(sampleRun);
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("status-test-aaaa", { output: "json" }, rt);
    const raw = rt.logs.join("");
    expect(raw.trimStart()[0]).toBe("{");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.runId).toBe("status-test-aaaa");
  });

  it("--output md with --json true uses md (output wins)", async () => {
    saveRunFixture(sampleRun);
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("status-test-aaaa", { json: true, output: "md" }, rt);
    const output = rt.logs.join("\n");
    expect(output).toContain("✅ Done: Widget plan");
    expect(output).toContain("**Progress**");
  });

  it("errors for unknown run ID", async () => {
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("nonexistent", {}, rt);
    expect(rt.errors).toContain("Run not found: nonexistent");
  });

  it("--json error for unknown run outputs strict JSON", async () => {
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await catchJsonExit(() => goalStatusCommand("nonexistent", { json: true }, rt));
    const raw = rt.logs.join("");
    expect(raw.trimStart()[0]).toBe("{");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.error).toBe("Run not found: nonexistent");
  });

  it("resolves partial run IDs", async () => {
    saveRunFixture(sampleRun);
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("status-t", {}, rt);
    const output = rt.logs.join("\n");
    expect(output).toContain("status-test-aaaa");
  });

  it("text mode shows lastError for incomplete runs", async () => {
    saveRunFixture({
      ...sampleRun,
      runId: "failed-status-run",
      state: "planning",
      lastError: "shell_exec command not in read-only allowlist",
    });
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("failed-status-run", {}, rt);
    const output = rt.logs.join("\n");
    expect(output).toContain("Planning");
    expect(output).toContain("shell_exec command not in read-only allowlist");
  });

  it("JSON mode includes lastError for incomplete runs", async () => {
    saveRunFixture({
      ...sampleRun,
      runId: "failed-json-status",
      state: "planning",
      lastError: "Planning error",
    });
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("failed-json-status", { json: true }, rt);
    const raw = rt.logs.join("");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.state).toBe("planning");
    expect(parsed.lastError).toBe("Planning error");
  });

  it("text mode shows blocked details with answer hint", async () => {
    saveRunFixture({
      ...sampleRun,
      runId: "blocked-detail-run",
      state: "blocked",
      blocked: { blockedAt: "execution", prompt: "Need creds", requiredInputKey: "db_password" },
    });
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("blocked-detail-run", {}, rt);
    const output = rt.logs.join("\n");
    expect(output).toContain("Need creds");
    expect(output).toContain("db_password");
    expect(output).toContain("moltbot goal answer");
  });

  it("text mode shows resume hint for auto-retry execution blocks", async () => {
    saveRunFixture({
      ...sampleRun,
      runId: "blocked-resume-run",
      state: "blocked",
      blocked: {
        blockedAt: "execution",
        prompt: "Run interrupted, resume to continue.",
        requiredInputKey: "resume_execution",
      },
    });
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("blocked-resume-run", {}, rt);
    const output = rt.logs.join("\n");
    expect(output).toContain("Run interrupted, resume to continue.");
    expect(output).toContain("**Goal ID:** blocked-");
    expect(output).not.toContain("moltbot goal answer");
  });

  it("shows retry summary without top steps output", async () => {
    const runId = "retry-status-run";
    saveRunFixture({
      ...sampleRun,
      runId,
      state: "executing",
      agentMaxTurnsPerTask: 4,
      plan: {
        goal: "Build a widget",
        workingDir: "/tmp",
        summary: "Retry-heavy plan",
        steps: [
          { id: "1", description: "Prepare schema", dependsOn: [], status: "done", turnsUsed: 2 },
          { id: "2", description: "Run migrations", dependsOn: ["1"], status: "blocked" },
          { id: "3", description: "Write service layer", dependsOn: ["2"], status: "pending" },
          { id: "4", description: "Add API routes", dependsOn: ["3"], status: "pending" },
          { id: "5", description: "Add tests", dependsOn: ["4"], status: "pending" },
          { id: "6", description: "Update docs", dependsOn: ["5"], status: "pending" },
        ],
      },
      stepResults: {},
    });

    const stepWorkerDir = path.join(testGoalsDir, runId, "workers", "2");
    fs.mkdirSync(stepWorkerDir, { recursive: true });
    fs.writeFileSync(
      path.join(stepWorkerDir, "attempt-1.json"),
      JSON.stringify({
        attemptNumber: 1,
        backend: "claude_code",
        outcome: "timeout",
        durationMs: 1000,
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(stepWorkerDir, "attempt-2.json"),
      JSON.stringify({
        attemptNumber: 2,
        backend: "codex",
        outcome: "blocked",
        durationMs: 1000,
      }),
      "utf8",
    );

    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand(runId, {}, rt);
    const lines = outputLines(rt.logs.join("\n"));
    const retriesIndex = findLineIndex(lines, "**Retries** 2 retries across 2 steps");
    expect(retriesIndex).toBeGreaterThan(0);
    expect(findLineIndex(lines, "**Top Steps**")).toBe(-1);
    expect(lines.some((line) => line.startsWith("- "))).toBe(false);
    expect(lines.some((line) => line.includes("more steps not shown"))).toBe(false);
  });

  it("uses Telegram line budget when channel is telegram", async () => {
    const runId = "telegram-status-run";
    saveRunFixture({
      ...sampleRun,
      runId,
      state: "awaiting_approval",
      plan: {
        goal: "Build a widget",
        workingDir: "/tmp",
        summary: "Long plan",
        steps: Array.from({ length: 25 }, (_, index) => ({
          id: String(index + 1),
          description: `Task ${index + 1} with long explanation that should be truncated for Telegram readability`,
          dependsOn: index === 0 ? [] : [String(index)],
          status: index === 0 ? "done" : "pending",
        })),
      },
      stepResults: {},
    });

    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand(runId, { channel: "telegram" }, rt);
    const lines = outputLines(rt.logs.join("\n"));
    expect(lines.length).toBeLessThanOrEqual(15);
    expect(findLineIndex(lines, "✅ Awaiting Approval: Long plan")).toBe(0);
    expect(findLineIndex(lines, "**Progress** 1/25")).toBe(1);
    expect(findLineIndex(lines, "**Retries** 0 retries")).toBe(2);
    expect(findLineIndex(lines, "**Top Steps**")).toBe(-1);
    expect(lines.some((line) => line.startsWith("**Goal ID:** telegram"))).toBe(true);
    expect(lines.some((line) => line.includes("more steps not shown"))).toBe(false);
    expect(lines.some((line) => line.includes("Run ID:"))).toBe(false);
    expect(lines.some((line) => line.includes("Dependency Graph"))).toBe(false);
  });

  it("JSON mode includes blocked object with prompt and requiredInputKey", async () => {
    saveRunFixture({
      ...sampleRun,
      runId: "blocked-json-detail",
      state: "blocked",
      blocked: { blockedAt: "execution", prompt: "Need creds", requiredInputKey: "db_password" },
    });
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("blocked-json-detail", { json: true }, rt);
    const raw = rt.logs.join("");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const blocked = parsed.blocked as Record<string, unknown>;
    expect(blocked.prompt).toBe("Need creds");
    expect(blocked.requiredInputKey).toBe("db_password");
  });
});
