import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mirrorGoalRunToAgentHistory } from "./agent-history.js";
import type { SerializedRun } from "./types.js";

describe("agent history goal summary", () => {
  let tmpDir: string;
  let originalManagedRoot: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-history-summary-test-"));
    originalManagedRoot = process.env.SMITHERSBOT_GOALS_ROOT;
    process.env.SMITHERSBOT_GOALS_ROOT = path.join(tmpDir, "managed");
  });

  afterEach(() => {
    if (originalManagedRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
    else process.env.SMITHERSBOT_GOALS_ROOT = originalManagedRoot;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("mirrors a redacted GitHub push outcome into the goal summary", () => {
    const workingDir = path.join(
      process.env.SMITHERSBOT_GOALS_ROOT!,
      "agent",
      "workspaces",
      "smithersbot",
      "repo",
    );
    const plantedToken = "ghp_FAKEGITHUBTOKEN12345678901234567890";
    const run: SerializedRun = {
      runId: "run-push-outcome",
      goal: "Persist push outcome",
      state: "done",
      plan: null,
      stepResults: {},
      blocked: null,
      answers: {},
      workingDir,
      model: undefined,
      dryRun: false,
      createdAt: "2026-05-25T12:00:00.000Z",
      updatedAt: "2026-05-25T12:05:00.000Z",
      githubPushOutcome: {
        enabled: true,
        branch: "claw/run/20260525-120000Z-run-push-outcome",
        remote: `https://x-access-token:${plantedToken}@github.com/smithers/private.git`,
        attempted: true,
        succeeded: false,
        pushedSha: "feedfacecafebeef1234567890abcdef12345678",
        prUrl: `https://github.com/smithers/private/pull/7?token=${plantedToken}`,
        message: `GitHub push failed: token ${plantedToken} was rejected`,
        timestamp: "2026-05-25T12:04:00.000Z",
      },
    };

    mirrorGoalRunToAgentHistory(run);

    const summaryPath = path.join(
      process.env.SMITHERSBOT_GOALS_ROOT!,
      "agent",
      "history",
      "goals",
      "smithersbot",
      "run-push-outcome",
      "summary.json",
    );
    const summaryText = fs.readFileSync(summaryPath, "utf8");
    const summary = JSON.parse(summaryText) as {
      githubPushOutcome?: SerializedRun["githubPushOutcome"];
    };

    expect(summary.githubPushOutcome).toMatchObject({
      enabled: true,
      branch: "claw/run/20260525-120000Z-run-push-outcome",
      attempted: true,
      succeeded: false,
      pushedSha: "feedfacecafebeef1234567890abcdef12345678",
      timestamp: "2026-05-25T12:04:00.000Z",
    });
    expect(summary.githubPushOutcome?.remote).toContain("[REDACTED]");
    expect(summary.githubPushOutcome?.prUrl).toContain("[REDACTED]");
    expect(summary.githubPushOutcome?.message).toContain("[REDACTED]");
    expect(summaryText).not.toContain(plantedToken);
  });
});
