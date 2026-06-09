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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expectNoRawStepIdNodeTokens(mermaid: string, ids: readonly string[]): void {
  for (const id of ids) {
    const escaped = escapeRegExp(id);
    expect(mermaid).not.toMatch(new RegExp(`^\\s*${escaped}\\[`, "m"));
    expect(mermaid).not.toMatch(new RegExp(`^\\s*${escaped}\\s+-->`, "m"));
    expect(mermaid).not.toMatch(new RegExp(`-->\\s+${escaped}\\s*$`, "m"));
    expect(mermaid).not.toMatch(new RegExp(`^\\s*class\\s+${escaped}\\s+`, "m"));
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

function makeBlockedRunFixture(
  runId: string,
  blocked: NonNullable<SerializedRun["blocked"]>,
): SerializedRun {
  return {
    ...sampleRun,
    runId,
    state: "blocked",
    plan: {
      ...sampleRun.plan!,
      steps: sampleRun.plan!.steps.map((step) => ({ ...step, status: "pending" })),
    },
    stepResults: {},
    blocked,
  };
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
    const planIndex = findLineIndex(lines, "**Plan** Plan 1");
    const runIdIndex = findLineIndex(lines, "Run ID: status-test-aaaa");
    expect(headlineIndex).toBe(0);
    expect(progressIndex).toBeGreaterThan(headlineIndex);
    expect(retriesIndex).toBeGreaterThan(progressIndex);
    expect(planIndex).toBeGreaterThan(retriesIndex);
    expect(runIdIndex).toBeGreaterThan(planIndex);
  });

  it("labels status by user-visible planNumber and shows pending continuation banner", async () => {
    saveRunFixture({
      ...sampleRun,
      runId: "status-plan-two",
      state: "done",
      planNumber: 2,
      planRevision: 7,
      pendingContinuation: {
        proposalId: "proposal-status-1",
        fromPlanNumber: 2,
        fromRevision: 7,
        goalAchieved: false,
        briefSummary: "A follow-up plan is useful.",
        proposedPrompt: "Make another plan for the next phase.",
        runAt: "now",
        status: "pending",
        createdAt: "2026-01-30T00:02:00.000Z",
      },
    });
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("status-plan-two", {}, rt);
    const output = rt.logs.join("\n");
    expect(output).toContain("**Plan** Plan 2");
    expect(output).toContain("**Continuation** Pending next-plan prompt");
    expect(output).not.toContain("Revision 7");
    expect(output.toLowerCase()).not.toContain("cycle");
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
    expect(output).toContain("class n0 inprog;");
  });

  it("mermaid output uses safe node ids for unsafe raw step ids", async () => {
    const runId = "status-unsafe-ids";
    const ids = ["build-api", "data.load", "ask:input", "docs/readme", "1-start"];
    saveRunFixture({
      ...sampleRun,
      runId,
      state: "executing",
      plan: {
        goal: "Build a widget",
        workingDir: "/tmp",
        summary: "Unsafe plan",
        steps: [
          { id: ids[0], description: "Build API", dependsOn: [], status: "done" },
          { id: ids[1], description: "Load data", dependsOn: [ids[0]], status: "done" },
          { id: ids[2], description: "Ask input", dependsOn: [ids[1]], status: "blocked" },
          { id: ids[3], description: "Write docs", dependsOn: [ids[2]], status: "pending" },
          { id: ids[4], description: "Numeric leading", dependsOn: [ids[3]], status: "pending" },
        ],
      },
      stepResults: {},
    });

    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand(runId, { diagram: "mermaid" }, rt);
    const output = rt.logs.join("\n");
    expect(output).toContain("flowchart TD");
    expect(output).toContain("n0 --> n1");
    expect(output).toContain("class n2 blocked;");
    expectNoRawStepIdNodeTokens(output, ids);
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
    expect(output).toContain("**Next:**");
    expect(output).toContain("moltbot goal answer");
  });

  it("text mode shows resume hint for auto-retry execution blocks", async () => {
    saveRunFixture(
      makeBlockedRunFixture("blocked-resume-run", {
        blockedAt: "execution",
        prompt: "Run interrupted, resume to continue.",
        requiredInputKey: "resume_execution",
      }),
    );
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("blocked-resume-run", {}, rt);
    const output = rt.logs.join("\n");
    expect(output).toContain("Run interrupted, resume to continue.");
    expect(output).toContain("**Goal ID:** blocked-");
    expect(output).not.toContain("moltbot goal answer");
  });

  it('text mode shows goal ID only for blocked runs with requiredInputKey "none"', async () => {
    saveRunFixture({
      ...sampleRun,
      runId: "blocked-none-run",
      state: "blocked",
      blocked: {
        blockedAt: "execution",
        prompt: "Temporary system failure, resume to continue.",
        requiredInputKey: "none",
      },
    });
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("blocked-none-run", {}, rt);
    const output = rt.logs.join("\n");

    expect(output).toContain("Temporary system failure, resume to continue.");
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

  it("done goal with a stale blocker field renders no top-level blocker", async () => {
    saveRunFixture({
      ...sampleRun,
      runId: "done-stale-blocker",
      state: "done",
      blocked: {
        blockedAt: "execution",
        prompt: "You've hit your usage limit. Upgrade at https://example.com/upgrade",
        requiredInputKey: "none",
      },
      lastError: "You've hit your usage limit. Upgrade at https://example.com/upgrade",
    });
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("done-stale-blocker", {}, rt);
    const output = rt.logs.join("\n");
    expect(output).toContain("✅ Done:");
    expect(output).not.toContain("**Blocker**");
    expect(output).not.toContain("usage limit");
    expect(output).not.toContain("https://example.com/upgrade");
  });

  it("done goal surfaces GitHub review URL, completion headline, and delivery failures", async () => {
    const reviewUrl =
      "https://github.com/smithers/test-private/tree/smithersbot/20260525-120000Z-status-review";
    saveRunFixture({
      ...sampleRun,
      runId: "done-github-success",
      completionSummary: "✅ Done: Widget shipped\n**Progress** 1/1\n**Goal ID:** done-git",
      deliveryFailed: true,
      deliveryError: "message unavailable",
      githubPushOutcome: {
        enabled: true,
        branch: "smithersbot/20260525-120000Z-status-review",
        remote: "origin",
        attempted: true,
        succeeded: true,
        pushedSha: "feedfacecafebeef1234567890abcdef12345678",
        reviewUrl,
        message: "Run branch pushed to origin (feedfac)",
        timestamp: "2026-05-25T12:34:56.000Z",
      },
    });
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("done-github-success", {}, rt);
    const output = rt.logs.join("\n");

    expect(output).toContain("**Completion** ✅ Done: Widget shipped");
    expect(output).toContain(reviewUrl);
    expect(output).toContain("smithersbot/20260525-120000Z-status-review");
    expect(output).toContain("**Delivery** Completion notification failed: message unavailable");
  });

  it("done goal surfaces GitHub push failure and skipped reasons", async () => {
    saveRunFixture({
      ...sampleRun,
      runId: "done-github-failed",
      completionSummary: "✅ Done: Widget shipped",
      githubPushOutcome: {
        enabled: true,
        branch: "smithersbot/20260525-120000Z-status-failed",
        remote: "origin",
        attempted: true,
        succeeded: false,
        message: "GitHub push failed: Permission denied (publickey)",
        timestamp: "2026-05-25T12:34:56.000Z",
      },
    });
    saveRunFixture({
      ...sampleRun,
      runId: "done-github-skipped",
      completionSummary: "✅ Done: Widget shipped",
      githubPushOutcome: {
        enabled: true,
        branch: "smithersbot/20260525-120000Z-status-skipped",
        remote: "origin",
        attempted: false,
        succeeded: false,
        message: "GitHub push skipped: working repository is not private.",
        timestamp: "2026-05-25T12:34:56.000Z",
      },
    });
    const { goalStatusCommand } = await import("./goal-status.js");
    const failedRuntime = mockRuntime();
    await goalStatusCommand("done-github-failed", {}, failedRuntime);
    const skippedRuntime = mockRuntime();
    await goalStatusCommand("done-github-skipped", {}, skippedRuntime);

    expect(failedRuntime.logs.join("\n")).toContain(
      "GitHub push failed: Permission denied (publickey)",
    );
    expect(skippedRuntime.logs.join("\n")).toContain(
      "GitHub push skipped: working repository is not private.",
    );
  });

  it("executing goal with runnable work and a stale blocker field renders no blocker", async () => {
    const runId = "executing-stale-blocker";
    saveRunFixture({
      ...sampleRun,
      runId,
      state: "executing",
      blocked: {
        blockedAt: "execution",
        prompt: "You've hit your usage limit. Upgrade at https://example.com/upgrade",
        requiredInputKey: "none",
      },
      lastError: "You've hit your usage limit. Upgrade at https://example.com/upgrade",
      plan: {
        goal: "Build a widget",
        workingDir: "/tmp",
        summary: "Widget plan",
        steps: [
          { id: "1", description: "Create dir", dependsOn: [], status: "done" },
          { id: "2", description: "Write code", dependsOn: ["1"], status: "in_progress" },
        ],
      },
      stepResults: { "1": { stepId: "1", success: true, output: "", durationMs: 1 } },
    });
    // An active run lock keeps loadRun from recovering this as a stale/blocked run.
    fs.mkdirSync(path.join(testGoalsDir, ".locks", "runs"), { recursive: true });
    fs.writeFileSync(
      path.join(testGoalsDir, ".locks", "runs", `${runId}.lock`),
      JSON.stringify({ pid: process.pid, label: "execute", createdAt: new Date().toISOString() }),
      "utf8",
    );
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand(runId, {}, rt);
    const output = rt.logs.join("\n");
    expect(output).toContain("⏳ Executing:");
    expect(output).not.toContain("**Blocker**");
    expect(output).not.toContain("usage limit");
  });

  it("actually usage-limit-blocked goal renders a clear usage-limit blocker", async () => {
    saveRunFixture(
      makeBlockedRunFixture("blocked-usage-limit", {
        blockedAt: "execution",
        prompt: "You've hit your usage limit. Resume to retry once it resets.",
        requiredInputKey: "resume_execution",
      }),
    );
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("blocked-usage-limit", {}, rt);
    const output = rt.logs.join("\n");
    expect(output).toContain("**Blocker**");
    expect(output).toContain("You've hit your usage limit");
  });

  it("actually user-input-blocked goal renders needs-input blocker", async () => {
    saveRunFixture({
      ...sampleRun,
      runId: "blocked-needs-input",
      state: "blocked",
      blocked: { blockedAt: "execution", prompt: "Need API key", requiredInputKey: "api_key" },
    });
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("blocked-needs-input", {}, rt);
    const output = rt.logs.join("\n");
    expect(output).toContain("**Blocker** Execution: Need API key (key: api_key)");
  });

  it("does not show raw backend error text after resolution (done with stale lastError)", async () => {
    saveRunFixture({
      ...sampleRun,
      runId: "done-stale-lasterror",
      state: "done",
      blocked: null,
      lastError:
        "error_max_turns stop_reason tool_use — see https://console.example.com/settings/billing",
    });
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("done-stale-lasterror", {}, rt);
    const output = rt.logs.join("\n");
    expect(output).toContain("✅ Done:");
    expect(output).not.toContain("**Blocker**");
    expect(output).not.toContain("error_max_turns");
    expect(output).not.toContain("console.example.com");
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
