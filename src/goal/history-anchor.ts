import fs from "node:fs";
import path from "node:path";
import { resolveAgentRoot, slugifyWorkspaceName } from "../config/managed-paths.js";
import { workspaceNameFromWorkingDir } from "./agent-history.js";
import type { SerializedRun, WorkerSummaryReference } from "./types.js";

export const PENDING_WORKSPACE_SLUG = "_pending";

const HISTORY_MIGRATION_SENTINEL = ".history-anchor-migration.json";

export type HistoryAnchoredRun = Pick<SerializedRun, "runId" | "workingDir"> & {
  historyWorkspaceSlug?: string;
};

export type HistoryArtifactRun = HistoryAnchoredRun & {
  goalBriefPath?: string;
  postExecutionReportArtifacts?: SerializedRun["postExecutionReportArtifacts"];
  workerSummaries?: WorkerSummaryReference[];
};

export function resolveHistoryWorkspaceSlug(run: HistoryAnchoredRun): string {
  return run.historyWorkspaceSlug ?? workspaceNameFromWorkingDir(run.workingDir);
}

export function resolveGoalHistoryDirForSlug(params: {
  runId: string;
  workspaceSlug: string;
  agentRoot?: string;
}): string {
  const agentRoot = params.agentRoot ?? resolveAgentRoot();
  return path.join(
    agentRoot,
    "history",
    "goals",
    slugifyWorkspaceName(params.workspaceSlug),
    slugifyWorkspaceName(params.runId),
  );
}

export function resolveAnchoredGoalHistoryDir(run: HistoryAnchoredRun): string {
  return resolveGoalHistoryDirForSlug({
    runId: run.runId,
    workspaceSlug: resolveHistoryWorkspaceSlug(run),
  });
}

function migrationSentinelPayload(runId: string, fromSlug: string, toSlug: string): string {
  return `${JSON.stringify(
    {
      runId,
      fromSlug: slugifyWorkspaceName(fromSlug),
      toSlug: slugifyWorkspaceName(toSlug),
      migratedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`;
}

function writeMigrationSentinel(
  targetDir: string,
  runId: string,
  fromSlug: string,
  toSlug: string,
): void {
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o755 });
  fs.writeFileSync(
    path.join(targetDir, HISTORY_MIGRATION_SENTINEL),
    migrationSentinelPayload(runId, fromSlug, toSlug),
    "utf8",
  );
}

function migrateSourceDir(params: {
  sourceDir: string;
  sourceSlug: string;
  targetDir: string;
  runId: string;
  toSlug: string;
}): boolean {
  if (!fs.existsSync(params.sourceDir)) return false;

  fs.mkdirSync(path.dirname(params.targetDir), { recursive: true, mode: 0o755 });
  if (!fs.existsSync(params.targetDir)) {
    fs.renameSync(params.sourceDir, params.targetDir);
    writeMigrationSentinel(params.targetDir, params.runId, params.sourceSlug, params.toSlug);
    return true;
  }

  copyMissingTree(params.sourceDir, params.targetDir);
  fs.rmSync(params.sourceDir, { recursive: true, force: true });
  writeMigrationSentinel(params.targetDir, params.runId, params.sourceSlug, params.toSlug);
  return true;
}

function copyMissingTree(sourcePath: string, targetPath: string): void {
  const sourceStat = fs.lstatSync(sourcePath);
  if (sourceStat.isDirectory()) {
    if (fs.existsSync(targetPath) && !fs.lstatSync(targetPath).isDirectory()) return;
    fs.mkdirSync(targetPath, { recursive: true, mode: 0o755 });
    for (const entry of fs.readdirSync(sourcePath)) {
      copyMissingTree(path.join(sourcePath, entry), path.join(targetPath, entry));
    }
    return;
  }

  if (fs.existsSync(targetPath)) return;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o755 });
  if (sourceStat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(sourcePath), targetPath);
    return;
  }
  fs.copyFileSync(sourcePath, targetPath);
}

export function migrateGoalHistory(params: {
  runId: string;
  toSlug: string;
  agentRoot?: string;
}): void {
  const toSlug = slugifyWorkspaceName(params.toSlug);
  if (toSlug === PENDING_WORKSPACE_SLUG) return;

  const targetDir = resolveGoalHistoryDirForSlug({
    runId: params.runId,
    workspaceSlug: toSlug,
    agentRoot: params.agentRoot,
  });
  const sourceSlugs = [PENDING_WORKSPACE_SLUG, workspaceNameFromWorkingDir(process.cwd())].filter(
    (slug, index, slugs) => slug !== toSlug && slugs.indexOf(slug) === index,
  );

  for (const sourceSlug of sourceSlugs) {
    migrateSourceDir({
      sourceDir: resolveGoalHistoryDirForSlug({
        runId: params.runId,
        workspaceSlug: sourceSlug,
        agentRoot: params.agentRoot,
      }),
      sourceSlug,
      targetDir,
      runId: params.runId,
      toSlug,
    });
  }
}

export function rewriteRunHistoryArtifactPaths(run: HistoryArtifactRun): void {
  const historyDir = resolveAnchoredGoalHistoryDir(run);
  if (run.goalBriefPath) {
    run.goalBriefPath = path.join(historyDir, "wiki", "goal-brief.md");
  }
  if (run.postExecutionReportArtifacts) {
    run.postExecutionReportArtifacts = {
      historyDir,
      markdownPath: path.join(historyDir, "post-execution-report.md"),
      jsonPath: path.join(historyDir, "post-execution-report.json"),
    };
  }
  if (run.workerSummaries) {
    const wikiDir = path.join(historyDir, "wiki");
    run.workerSummaries = run.workerSummaries.map((summary) => ({
      ...summary,
      path: path.join(wikiDir, path.basename(summary.path)),
    }));
  }
}
