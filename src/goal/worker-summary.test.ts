import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Plan, PlanStep, WorkerSummaryReference } from "./types.js";
import {
  computeChildlessSummaries,
  renderWorkerSummaryMarkdown,
  resolveWorkerSummaryPath,
  writeWorkerSummary,
} from "./worker-summary.js";

let previousManagedRoot: string | undefined;
let managedRoot: string | undefined;

function useManagedRoot(): string {
  previousManagedRoot = process.env.SMITHERSBOT_GOALS_ROOT;
  managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "worker-summary-managed-"));
  process.env.SMITHERSBOT_GOALS_ROOT = managedRoot;
  return managedRoot;
}

afterEach(() => {
  if (managedRoot) {
    if (previousManagedRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
    else process.env.SMITHERSBOT_GOALS_ROOT = previousManagedRoot;
    fs.rmSync(managedRoot, { recursive: true, force: true });
  }
  previousManagedRoot = undefined;
  managedRoot = undefined;
});

function step(id: string, dependsOn: string[] = [], status: PlanStep["status"] = "done"): PlanStep {
  return {
    id,
    description: `Implement ${id}`,
    shortSummary: `Step ${id}`,
    dependsOn,
    status,
    backend: "codex",
    taskSummary: `Completed ${id}`,
  };
}

function plan(steps: PlanStep[]): Plan {
  return {
    goal: "Improve goal context",
    workingDir: "/tmp/workspace",
    summary: "Improve goal context",
    shortSummary: "Goal context",
    steps,
  };
}

function ref(id: string): WorkerSummaryReference {
  return {
    id,
    summary: `Completed ${id}`,
    path: `/history/wiki/worker-summary-${id}.md`,
    status: "pass",
    createdAt: "2026-06-06T00:00:00.000Z",
    claimsToVerify: [`Verify ${id}`],
    usedSummaryIds: [],
  };
}

describe("worker-summary", () => {
  it("computes childless summaries from the transitive dependsOn graph", () => {
    const p = plan([
      step("a"),
      step("b", ["a"]),
      step("c", ["b"]),
      step("d", ["a"]),
      step("e", ["c"], "pending"),
    ]);

    const childless = computeChildlessSummaries(p, [ref("a"), ref("b"), ref("c"), ref("d")]);

    expect(childless.map((summary) => summary.id)).toEqual(["c", "d"]);
  });

  it("renders a Worker Summary with evidence, claims to verify, and Sources", () => {
    const markdown = renderWorkerSummaryMarkdown({
      stepId: "task-a",
      taskSummary: "Added compact worker summary support.",
      taskDescription: "Persist worker summaries.",
      whatChanged: ["Added src/goal/worker-summary.ts"],
      evidence: [
        {
          command: "pnpm exec vitest run src/goal/worker-summary.test.ts",
          result: "passed",
          detail: "build gate passed at 2026-06-06T00:00:00.000Z",
        },
      ],
      status: "pass",
      importantUncertainty: ["Live gateway smoke was not part of this local task."],
      claimsToVerify: ["Verify the summary against the actual diff before relying on it."],
      sources: {
        nodeSpecPath: "/history/runtime/scout/node_specs/task-a.md",
        goalBriefPath: "/history/wiki/goal-brief.md",
        planPath: "/history/runtime/scout/execution_plan.json",
        planReportPath: "/history/post-execution-report.md",
        priorWorkerSummaries: [ref("setup")],
      },
      createdAt: "2026-06-06T00:00:00.000Z",
    });

    expect(markdown).toContain("# Worker Summary: task-a");
    expect(markdown).toContain("## Evidence / commands run");
    expect(markdown).toContain("- pnpm exec vitest run src/goal/worker-summary.test.ts - passed");
    expect(markdown).toContain("## Claims to verify before relying on them");
    expect(markdown).toContain("Verify the summary against the actual diff");
    expect(markdown).toContain("## Sources");
    expect(markdown).toContain("- Task node spec: /history/runtime/scout/node_specs/task-a.md");
    expect(markdown).toContain("- Goal Brief: /history/wiki/goal-brief.md");
    expect(markdown).toContain("- Execution Plan: /history/runtime/scout/execution_plan.json");
    expect(markdown).toContain(
      "- Prior Worker Summary: /history/wiki/worker-summary-setup.md - Completed setup",
    );
  });

  it("writes one summary file for a completed task into the goal wiki dir", () => {
    const root = useManagedRoot();
    const workingDir = path.join(root, "agent", "workspaces", "smithersbot-dev");
    fs.mkdirSync(workingDir, { recursive: true });
    const p = plan([step("task/a")]);

    const summary = writeWorkerSummary({
      runId: "run-worker-summary",
      workingDir,
      step: p.steps[0]!,
      plan: p,
      taskSummary: "Completed task/a safely.",
      usedSummaries: [ref("prior")],
      buildGateCommands: ["pnpm build"],
      buildGateTimestamp: "2026-06-06T00:00:00.000Z",
    });

    const expectedPath = resolveWorkerSummaryPath({
      runId: "run-worker-summary",
      workingDir,
      stepId: "task/a",
    });
    expect(summary.path).toBe(expectedPath);
    expect(summary.path).toContain(path.join("wiki", "worker-summary-task-a.md"));
    expect(fs.existsSync(summary.path)).toBe(true);
    const content = fs.readFileSync(summary.path, "utf8");
    expect(content).toContain("## Sources");
    expect(content).toContain("## Claims to verify before relying on them");
    expect(content).toContain("- pnpm build - passed");
    expect(summary.claimsToVerify.join("\n")).toContain("Verify Task task/a");
  });

  it("resolves summary paths under the history anchor instead of a divergent workingDir slug", () => {
    const root = useManagedRoot();
    const workingDir = path.join(root, "agent", "workspaces", "smithersbot-dev");
    fs.mkdirSync(workingDir, { recursive: true });

    const summaryPath = resolveWorkerSummaryPath({
      runId: "run-anchor-summary",
      workingDir,
      historyWorkspaceSlug: "test-workspace",
      goalBriefPath: path.join(
        root,
        "agent",
        "history",
        "goals",
        "smithersbot-dev",
        "run-anchor-summary",
        "wiki",
        "goal-brief.md",
      ),
      stepId: "task/a",
    });

    expect(summaryPath).toContain(
      path.join("history", "goals", "test-workspace", "run-anchor-summary", "wiki"),
    );
    expect(summaryPath).not.toContain(path.join("history", "goals", "smithersbot-dev"));
  });
});
