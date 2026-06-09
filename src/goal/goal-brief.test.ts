import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractGoalBriefSection, snapshotAndRewriteGoalBriefOnApprove } from "./goal-brief.js";
import type { ContinuationProposal, SerializedRun } from "./types.js";

let tmpRoot: string;
let previousManagedRoot: string | undefined;

beforeEach(() => {
  previousManagedRoot = process.env.SMITHERSBOT_GOALS_ROOT;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goal-brief-test-"));
  process.env.SMITHERSBOT_GOALS_ROOT = tmpRoot;
});

afterEach(() => {
  if (previousManagedRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
  else process.env.SMITHERSBOT_GOALS_ROOT = previousManagedRoot;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeRun(overrides: Partial<SerializedRun> = {}): SerializedRun {
  const runId = overrides.runId ?? "goal-brief-run";
  const workingDir = path.join(tmpRoot, "agent", "workspaces", "test-workspace");
  return {
    runId,
    goal: "Stage 1 plan only: create goal1.txt now. Stage 2 remains for a later plan that creates goal2.txt.",
    state: "done",
    plan: {
      goal: "Two-stage file goal",
      workingDir,
      summary: "Stage 1 plan only",
      steps: [],
    },
    stepResults: {},
    answers: {},
    workingDir,
    dryRun: false,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    historyWorkspaceSlug: "test-workspace",
    ...overrides,
  };
}

function makeProposal(overrides: Partial<ContinuationProposal> = {}): ContinuationProposal {
  return {
    proposalId: "proposal-1",
    fromPlanNumber: 1,
    fromRevision: 1,
    goalAchieved: false,
    briefSummary: "Plan 2 creates goal2.txt.",
    proposedPrompt: "Create goal2.txt with exact text: goal 2 completed!",
    runAt: "now",
    status: "pending",
    createdAt: "2026-06-01T01:00:00.000Z",
    ...overrides,
  };
}

function writeBrief(run: SerializedRun, content: string): string {
  const briefPath = path.join(
    tmpRoot,
    "agent",
    "history",
    "goals",
    "test-workspace",
    run.runId,
    "wiki",
    "goal-brief.md",
  );
  fs.mkdirSync(path.dirname(briefPath), { recursive: true });
  fs.writeFileSync(briefPath, content, "utf8");
  run.goalBriefPath = briefPath;
  return briefPath;
}

describe("snapshotAndRewriteGoalBriefOnApprove", () => {
  it("carries the whole-goal Goal Summary forward unchanged across plans", () => {
    const run = makeRun();
    writeBrief(
      run,
      [
        "# Goal Brief",
        "",
        "## Goal Summary",
        "Two-stage file goal: create goal1.txt in Plan 1, then goal2.txt in Plan 2.",
        "",
        "## Long Goal Summary",
        "Create both two-stage files across two plans.",
        "",
        "## Original User Ask",
        "Create goal1.txt, then continue and create goal2.txt.",
        "",
        "## Remaining Work",
        "Stage 2 remains.",
        "",
        "## Manual Tests",
        "Check both files after Plan 2.",
      ].join("\n"),
    );

    const update = snapshotAndRewriteGoalBriefOnApprove({
      run,
      proposal: makeProposal(),
    });

    expect(extractGoalBriefSection(update.content, ["Goal Summary"])).toBe(
      "Two-stage file goal: create goal1.txt in Plan 1, then goal2.txt in Plan 2.",
    );
    expect(update.content).toContain("## Next Plan Intent");
    expect(update.content).not.toContain("## First Plan Intent");
  });

  it("uses prior whole-goal fields for a missing Goal Summary fallback", () => {
    const run = makeRun();
    writeBrief(
      run,
      [
        "# Goal Brief",
        "",
        "## Long Goal Summary",
        "Two-stage file goal: create goal1.txt in Plan 1, then goal2.txt in Plan 2.",
        "",
        "## Original User Ask",
        "Original whole goal.",
      ].join("\n"),
    );

    const update = snapshotAndRewriteGoalBriefOnApprove({
      run,
      proposal: makeProposal(),
    });

    expect(extractGoalBriefSection(update.content, ["Goal Summary"])).toBe(
      "Two-stage file goal: create goal1.txt in Plan 1, then goal2.txt in Plan 2.",
    );
    expect(extractGoalBriefSection(update.content, ["Goal Summary"])).not.toContain(
      "Stage 1 plan only",
    );
  });

  it("recomputes remaining work, observation point, and manual tests for the approved next plan", () => {
    const run = makeRun({
      postExecutionReportArtifacts: {
        historyDir: path.join(
          tmpRoot,
          "agent",
          "history",
          "goals",
          "test-workspace",
          "goal-brief-run",
        ),
        markdownPath: path.join(
          tmpRoot,
          "agent",
          "history",
          "goals",
          "test-workspace",
          "goal-brief-run",
          "post-execution-report.md",
        ),
        jsonPath: path.join(
          tmpRoot,
          "agent",
          "history",
          "goals",
          "test-workspace",
          "goal-brief-run",
          "post-execution-report.json",
        ),
      },
    });
    writeBrief(
      run,
      [
        "# Goal Brief",
        "",
        "## Goal Summary",
        "Two-stage file goal: create goal1.txt in Plan 1, then goal2.txt in Plan 2.",
        "",
        "## Remaining Work",
        "Stage 1 stale remaining work: create goal1.txt.",
        "",
        "## Observation Point",
        "Stop after goal1.txt is created.",
        "",
        "## Manual Tests",
        "Check goal1.txt content equals goal 1 completed.",
      ].join("\n"),
    );

    const update = snapshotAndRewriteGoalBriefOnApprove({
      run,
      proposal: makeProposal({
        briefSummary: "Stage 2 creates goal2.txt in test-workspace.",
        proposedPrompt:
          "Create Plan 2 under the same Goal ID to create goal2.txt with exact text: goal 2 completed!",
        lastContinuationEditMessage: "Also verify goal2.txt after creating it.",
      }),
    });

    const remainingWork = extractGoalBriefSection(update.content, ["Remaining Work"]) ?? "";
    const observation = extractGoalBriefSection(update.content, ["Next Observation Point"]) ?? "";
    const manualTests = extractGoalBriefSection(update.content, ["Manual Tests"]) ?? "";

    expect(remainingWork).toContain("Stage 2 creates goal2.txt");
    expect(remainingWork).toContain("Latest Plan Report source:");
    expect(remainingWork).toContain("Also verify goal2.txt after creating it.");
    expect(observation).toContain("Stage 2 creates goal2.txt");
    expect(manualTests).toContain("Stage 2 creates goal2.txt");
    expect(remainingWork).not.toContain("Stage 1 stale remaining work");
    expect(observation).not.toContain("Stop after goal1.txt is created");
    expect(manualTests).not.toContain("Check goal1.txt content");
  });
});
