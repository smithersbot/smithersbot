import fs from "node:fs";
import path from "node:path";
import { redactSecretValues } from "../security/secret-paths.js";
import { resolveStoredGoalBriefPath } from "./goal-brief.js";
import { resolveAnchoredGoalHistoryDir } from "./history-anchor.js";
import type {
  Plan,
  PlanStep,
  SerializedRun,
  WorkerSummaryReference,
  WorkerSummaryStatus,
} from "./types.js";

const EXECUTION_PLAN_FILE = "execution_plan.json";
const SCOUT_NODE_SPECS_DIR = "node_specs";

type WorkerSummarySource = {
  nodeSpecPath: string;
  goalBriefPath: string;
  planPath: string;
  planReportPath?: string;
  priorWorkerSummaries?: WorkerSummaryReference[];
};

export type WorkerSummaryEvidence = {
  command: string;
  result: "passed" | "failed" | "blocked" | "not-run";
  detail?: string;
};

export type RenderWorkerSummaryParams = {
  stepId: string;
  taskSummary: string;
  taskDescription?: string;
  whatChanged?: string[];
  evidence?: WorkerSummaryEvidence[];
  status: WorkerSummaryStatus;
  importantUncertainty?: string[];
  claimsToVerify: string[];
  sources: WorkerSummarySource;
  createdAt: string;
};

export type WriteWorkerSummaryParams = {
  runId: string;
  workingDir: string;
  historyWorkspaceSlug?: string;
  goalBriefPath?: string;
  step: PlanStep;
  plan: Plan;
  taskSummary?: string;
  usedSummaries?: WorkerSummaryReference[];
  buildGateCommands?: string[];
  buildGateTimestamp?: string;
  planReportPath?: string;
  createdAt?: string;
};

function nonEmptyList(values: readonly string[] | undefined, fallback: string): string[] {
  const normalized = values?.map((value) => value.trim()).filter((value) => value.length > 0) ?? [];
  return normalized.length > 0 ? normalized : [fallback];
}

function bulletLines(values: readonly string[]): string[] {
  return values.map((value) => `- ${value}`);
}

function formatEvidence(evidence: readonly WorkerSummaryEvidence[] | undefined): string[] {
  if (!evidence || evidence.length === 0) {
    return ["- No engine build/test gate command was recorded for this task."];
  }
  return evidence.map((entry) => {
    const detail = entry.detail?.trim();
    return `- ${entry.command} - ${entry.result}${detail ? ` (${detail})` : ""}`;
  });
}

function formatPriorSummarySources(summaries: readonly WorkerSummaryReference[] | undefined) {
  if (!summaries || summaries.length === 0) return ["- Prior Worker Summaries used: none"];
  return summaries.map((summary) => `- Prior Worker Summary: ${summary.path} - ${summary.summary}`);
}

export function renderWorkerSummaryMarkdown(params: RenderWorkerSummaryParams): string {
  const taskDescription = params.taskDescription?.trim();
  const whatChanged = nonEmptyList(
    params.whatChanged,
    `Worker reported: ${params.taskSummary.trim() || "Completed."}`,
  );
  const uncertainty = nonEmptyList(params.importantUncertainty, "None recorded by the engine.");
  const claimsToVerify = nonEmptyList(
    params.claimsToVerify,
    "Verify this summary against the actual diff and build-gate output before relying on it.",
  );

  const lines = [
    `# Worker Summary: ${params.stepId}`,
    "",
    "## Task",
    `- Task id: ${params.stepId}`,
    `- Task summary: ${params.taskSummary.trim() || "Completed."}`,
    ...(taskDescription ? [`- Task description: ${taskDescription}`] : []),
    "",
    "## What changed",
    ...bulletLines(whatChanged),
    "",
    "## Evidence / commands run",
    `- Status: ${params.status}`,
    ...formatEvidence(params.evidence),
    "",
    "## Important uncertainty",
    ...bulletLines(uncertainty),
    "",
    "## Claims to verify before relying on them",
    ...bulletLines(claimsToVerify),
    "",
    "## Sources",
    `- Task node spec: ${params.sources.nodeSpecPath}`,
    `- Goal Brief: ${params.sources.goalBriefPath}`,
    `- Execution Plan: ${params.sources.planPath}`,
    `- Plan Report: ${params.sources.planReportPath ?? "none yet"}`,
    ...formatPriorSummarySources(params.sources.priorWorkerSummaries),
    "",
    `Created at: ${params.createdAt}`,
    "",
  ];

  return `${redactSecretValues(lines.join("\n")).trimEnd()}\n`;
}

function safeStepIdForFilename(stepId: string): string {
  const safe = stepId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "task";
}

export function workerSummaryFilename(stepId: string): string {
  return `worker-summary-${safeStepIdForFilename(stepId)}.md`;
}

export function resolveWorkerSummaryPath(params: {
  runId: string;
  workingDir: string;
  historyWorkspaceSlug?: string;
  goalBriefPath?: string;
  stepId: string;
}): string {
  const goalBriefPath = resolveStoredGoalBriefPath({
    runId: params.runId,
    workingDir: params.workingDir,
    ...(params.historyWorkspaceSlug ? { historyWorkspaceSlug: params.historyWorkspaceSlug } : {}),
    goalBriefPath: params.goalBriefPath,
  });
  return path.join(path.dirname(goalBriefPath), workerSummaryFilename(params.stepId));
}

function buildSourcePaths(params: {
  runId: string;
  workingDir: string;
  historyWorkspaceSlug?: string;
  goalBriefPath?: string;
  stepId: string;
  planReportPath?: string;
  priorWorkerSummaries?: WorkerSummaryReference[];
}): WorkerSummarySource {
  const historyDir = resolveAnchoredGoalHistoryDir({
    runId: params.runId,
    workingDir: params.workingDir,
    ...(params.historyWorkspaceSlug ? { historyWorkspaceSlug: params.historyWorkspaceSlug } : {}),
  });
  const scoutDir = path.join(historyDir, "runtime", "scout");
  const goalBriefPath = resolveStoredGoalBriefPath({
    runId: params.runId,
    workingDir: params.workingDir,
    ...(params.historyWorkspaceSlug ? { historyWorkspaceSlug: params.historyWorkspaceSlug } : {}),
    goalBriefPath: params.goalBriefPath,
  });
  return {
    nodeSpecPath: path.join(scoutDir, SCOUT_NODE_SPECS_DIR, `${params.stepId}.md`),
    goalBriefPath,
    planPath: path.join(scoutDir, EXECUTION_PLAN_FILE),
    ...(params.planReportPath ? { planReportPath: params.planReportPath } : {}),
    priorWorkerSummaries: params.priorWorkerSummaries ?? [],
  };
}

function buildEvidence(params: {
  commands?: string[];
  buildGateTimestamp?: string;
}): WorkerSummaryEvidence[] {
  const commands = params.commands?.map((command) => command.trim()).filter(Boolean) ?? [];
  if (commands.length === 0) return [];
  const detail = params.buildGateTimestamp
    ? `build gate passed at ${params.buildGateTimestamp}`
    : "passed";
  return commands.map((command) => ({ command, result: "passed", detail }));
}

function buildClaimsToVerify(params: { stepId: string; hasBuildGateEvidence: boolean }): string[] {
  const claims = [
    `Verify Task ${params.stepId}'s worker summary against the actual diff before relying on it.`,
  ];
  if (params.hasBuildGateEvidence) {
    claims.push("Verify the recorded build-gate pass covers the behavior being reported.");
  } else {
    claims.push("No engine build/test gate command is recorded here; verify the claim manually.");
  }
  return claims;
}

export function writeWorkerSummary(params: WriteWorkerSummaryParams): WorkerSummaryReference {
  const taskSummary = params.taskSummary?.trim() || params.step.taskSummary?.trim() || "Completed.";
  const createdAt = params.createdAt ?? new Date().toISOString();
  const pathToWrite = resolveWorkerSummaryPath({
    runId: params.runId,
    workingDir: params.workingDir,
    ...(params.historyWorkspaceSlug ? { historyWorkspaceSlug: params.historyWorkspaceSlug } : {}),
    goalBriefPath: params.goalBriefPath,
    stepId: params.step.id,
  });
  const evidence = buildEvidence({
    commands: params.buildGateCommands,
    buildGateTimestamp: params.buildGateTimestamp,
  });
  const claimsToVerify = buildClaimsToVerify({
    stepId: params.step.id,
    hasBuildGateEvidence: evidence.length > 0,
  });
  const content = renderWorkerSummaryMarkdown({
    stepId: params.step.id,
    taskSummary,
    taskDescription: params.step.description,
    whatChanged: [`Worker reported: ${taskSummary}`],
    evidence,
    status: "pass",
    importantUncertainty: ["None recorded by the engine; verify flagged claims before reuse."],
    claimsToVerify,
    sources: buildSourcePaths({
      runId: params.runId,
      workingDir: params.workingDir,
      ...(params.historyWorkspaceSlug ? { historyWorkspaceSlug: params.historyWorkspaceSlug } : {}),
      goalBriefPath: params.goalBriefPath,
      stepId: params.step.id,
      planReportPath: params.planReportPath,
      priorWorkerSummaries: params.usedSummaries ?? [],
    }),
    createdAt,
  });

  fs.mkdirSync(path.dirname(pathToWrite), { recursive: true, mode: 0o755 });
  fs.writeFileSync(pathToWrite, content, "utf8");
  fs.chmodSync(pathToWrite, 0o644);

  return {
    id: params.step.id,
    summary: redactSecretValues(taskSummary),
    path: pathToWrite,
    status: "pass",
    createdAt,
    claimsToVerify: claimsToVerify.map((claim) => redactSecretValues(claim)),
    usedSummaryIds: (params.usedSummaries ?? []).map((summary) => summary.id),
  };
}

export function removeWorkerSummaryReference(
  summaries: readonly WorkerSummaryReference[] | undefined,
  stepId: string,
): WorkerSummaryReference[] {
  return (summaries ?? []).filter((summary) => summary.id !== stepId);
}

export function deleteWorkerSummaryFile(params: {
  runId: string;
  workingDir: string;
  historyWorkspaceSlug?: string;
  goalBriefPath?: string;
  stepId: string;
}): void {
  try {
    fs.unlinkSync(resolveWorkerSummaryPath(params));
  } catch {
    // Best-effort cleanup; absence is fine.
  }
}

function buildCompletedSummaryMap(
  completedSteps: readonly WorkerSummaryReference[],
): Map<string, WorkerSummaryReference> {
  const byId = new Map<string, WorkerSummaryReference>();
  for (const summary of completedSteps) byId.set(summary.id, summary);
  return byId;
}

export function computeChildlessSummaries(
  plan: Plan,
  completedSteps: readonly WorkerSummaryReference[],
): WorkerSummaryReference[] {
  const completedById = buildCompletedSummaryMap(completedSteps);
  const doneIds = new Set(
    plan.steps
      .filter((step) => step.status === "done" && completedById.has(step.id))
      .map((step) => step.id),
  );
  const successors = new Map<string, string[]>();
  for (const step of plan.steps) {
    successors.set(step.id, []);
  }
  for (const step of plan.steps) {
    for (const dep of step.dependsOn) {
      const list = successors.get(dep);
      if (list) list.push(step.id);
    }
  }

  const hasCompletedDescendant = (stepId: string, seen = new Set<string>()): boolean => {
    if (seen.has(stepId)) return false;
    seen.add(stepId);
    for (const childId of successors.get(stepId) ?? []) {
      if (doneIds.has(childId) || hasCompletedDescendant(childId, seen)) return true;
    }
    return false;
  };

  return plan.steps
    .filter((step) => doneIds.has(step.id) && !hasCompletedDescendant(step.id))
    .map((step) => completedById.get(step.id))
    .filter((summary): summary is WorkerSummaryReference => Boolean(summary));
}

export function workerSummariesFromSerializedRun(
  run: Pick<SerializedRun, "workerSummaries"> | undefined,
): WorkerSummaryReference[] {
  return run?.workerSummaries ?? [];
}
