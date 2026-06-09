import path from "node:path";
import { resolveAgentGoalHistoryDir } from "../config/managed-paths.js";

/**
 * Agent-history mirror directory for a run's scout/runtime artifacts
 * (`scout_report.json`, `plan_draft.md`, `node_specs/`). The on-host runtime
 * scout dir is not agent-visible; planners/workers must point at this mirror.
 */
export function buildAgentVisibleScoutDir(runId: string, workspaceSlug: string): string {
  return path.join(resolveAgentGoalHistoryDir(workspaceSlug, runId), "runtime", "scout");
}

/** Agent-history mirror directory for a run's wiki artifacts (e.g. `goal-brief.md`). */
export function buildAgentVisibleWikiDir(runId: string, workspaceSlug: string): string {
  return path.join(resolveAgentGoalHistoryDir(workspaceSlug, runId), "wiki");
}
