import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentVisibleScoutDir, buildAgentVisibleWikiDir } from "./agent-visible-paths.js";
import {
  PENDING_WORKSPACE_SLUG,
  migrateGoalHistory,
  resolveGoalHistoryDirForSlug,
  resolveHistoryWorkspaceSlug,
} from "./history-anchor.js";

let tmpRoot: string;
let agentRoot: string;
let previousManagedRoot: string | undefined;

beforeEach(() => {
  previousManagedRoot = process.env.SMITHERSBOT_GOALS_ROOT;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "history-anchor-"));
  agentRoot = path.join(tmpRoot, "agent");
  process.env.SMITHERSBOT_GOALS_ROOT = tmpRoot;
});

afterEach(() => {
  if (previousManagedRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
  else process.env.SMITHERSBOT_GOALS_ROOT = previousManagedRoot;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function historyDir(workspaceSlug: string, runId = "goal-1"): string {
  return resolveGoalHistoryDirForSlug({ runId, workspaceSlug, agentRoot });
}

describe("history-anchor", () => {
  it("renames pending history into exactly one final folder when target is absent", () => {
    const pendingDir = historyDir(PENDING_WORKSPACE_SLUG);
    const finalDir = historyDir("test-workspace");
    writeText(path.join(pendingDir, "wiki", "goal-brief.md"), "Goal Brief\n");

    migrateGoalHistory({ runId: "goal-1", toSlug: "test-workspace", agentRoot });

    expect(fs.existsSync(pendingDir)).toBe(false);
    expect(fs.readFileSync(path.join(finalDir, "wiki", "goal-brief.md"), "utf8")).toBe(
      "Goal Brief\n",
    );
    expect(fs.existsSync(path.join(finalDir, ".history-anchor-migration.json"))).toBe(true);
    expect(fs.existsSync(historyDir("smithersbot-dev"))).toBe(false);
  });

  it("merges pending history into an existing target without overwriting target files", () => {
    const pendingDir = historyDir(PENDING_WORKSPACE_SLUG);
    const finalDir = historyDir("test-workspace");
    writeText(path.join(pendingDir, "wiki", "goal-brief.md"), "pending brief\n");
    writeText(path.join(pendingDir, "runtime", "scout", "scout_report.json"), "{}\n");
    writeText(path.join(finalDir, "wiki", "goal-brief.md"), "newer final brief\n");
    writeText(path.join(finalDir, "wiki", "existing.md"), "existing\n");

    migrateGoalHistory({ runId: "goal-1", toSlug: "test-workspace", agentRoot });

    expect(fs.existsSync(pendingDir)).toBe(false);
    expect(fs.readFileSync(path.join(finalDir, "wiki", "goal-brief.md"), "utf8")).toBe(
      "newer final brief\n",
    );
    expect(fs.readFileSync(path.join(finalDir, "wiki", "existing.md"), "utf8")).toBe("existing\n");
    expect(
      fs.readFileSync(path.join(finalDir, "runtime", "scout", "scout_report.json"), "utf8"),
    ).toBe("{}\n");
  });

  it("is idempotent after the pending folder has already been migrated", () => {
    const pendingDir = historyDir(PENDING_WORKSPACE_SLUG);
    const finalDir = historyDir("test-workspace");
    writeText(path.join(pendingDir, "wiki", "goal-brief.md"), "Goal Brief\n");

    migrateGoalHistory({ runId: "goal-1", toSlug: "test-workspace", agentRoot });
    migrateGoalHistory({ runId: "goal-1", toSlug: "test-workspace", agentRoot });

    expect(fs.existsSync(pendingDir)).toBe(false);
    expect(
      fs.readdirSync(path.dirname(finalDir)).filter((entry) => entry === "goal-1"),
    ).toHaveLength(1);
    expect(fs.readFileSync(path.join(finalDir, "wiki", "goal-brief.md"), "utf8")).toBe(
      "Goal Brief\n",
    );
  });

  it("prefers the stored historyWorkspaceSlug and falls back to workingDir for legacy runs", () => {
    const workingDir = path.join(agentRoot, "workspaces", "smithersbot-dev");

    expect(
      resolveHistoryWorkspaceSlug({
        runId: "goal-1",
        workingDir,
        historyWorkspaceSlug: "test-workspace",
      }),
    ).toBe("test-workspace");
    expect(resolveHistoryWorkspaceSlug({ runId: "goal-1", workingDir })).toBe("smithersbot-dev");
  });

  it("keeps pre-adoption planning writes under _pending then migrates to the final workspace", () => {
    const runId = "live-split-shape";
    const pendingScoutDir = buildAgentVisibleScoutDir(runId, PENDING_WORKSPACE_SLUG);
    const pendingWikiDir = buildAgentVisibleWikiDir(runId, PENDING_WORKSPACE_SLUG);
    writeText(path.join(pendingScoutDir, "scout_report.json"), "{}\n");
    writeText(path.join(pendingWikiDir, "goal-brief.md"), "Goal Brief\n");

    migrateGoalHistory({ runId, toSlug: "test-workspace", agentRoot });

    const finalDir = historyDir("test-workspace", runId);
    expect(fs.existsSync(path.join(finalDir, "runtime", "scout", "scout_report.json"))).toBe(true);
    expect(fs.existsSync(path.join(finalDir, "wiki", "goal-brief.md"))).toBe(true);
    expect(fs.existsSync(historyDir(PENDING_WORKSPACE_SLUG, runId))).toBe(false);
    expect(fs.existsSync(historyDir("smithersbot-dev", runId))).toBe(false);
  });

  it("also sweeps an accidental gateway-slug history folder into the final workspace", () => {
    const runId = "live-gateway-slug-shape";
    const gatewayCwd = path.join(agentRoot, "workspaces", "smithersbot-dev");
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(gatewayCwd);
    try {
      writeText(path.join(historyDir(PENDING_WORKSPACE_SLUG, runId), "events.jsonl"), "{}\n");
      writeText(
        path.join(historyDir("smithersbot-dev", runId), "prompts", "planner.txt"),
        "planner prompt\n",
      );

      migrateGoalHistory({ runId, toSlug: "test-workspace", agentRoot });

      const finalDir = historyDir("test-workspace", runId);
      expect(fs.readFileSync(path.join(finalDir, "events.jsonl"), "utf8")).toBe("{}\n");
      expect(fs.readFileSync(path.join(finalDir, "prompts", "planner.txt"), "utf8")).toBe(
        "planner prompt\n",
      );
      expect(fs.existsSync(historyDir(PENDING_WORKSPACE_SLUG, runId))).toBe(false);
      expect(fs.existsSync(historyDir("smithersbot-dev", runId))).toBe(false);
    } finally {
      cwdSpy.mockRestore();
    }
  });
});
