import path from "node:path";
import { JsonExitError } from "../cli/cli-utils.js";
import { loadAttemptBundles } from "../goal/attempt-bundle.js";
import type {
  CompactGoalStep,
  GoalOutputChannel,
  GoalRetrySummaryResult,
} from "../goal/compact-output.js";
import { buildGoalRetrySummary, formatCompactGoalOutput } from "../goal/compact-output.js";
import { computeCpm } from "../goal/cpm.js";
import { renderAsciiDependencies } from "../goal/dag-render.js";
import { computeDisplayStatuses } from "../goal/execution-status.js";
import { renderMermaid } from "../goal/mermaid-render.js";
import { loadRun, resolveGoalsDir, resolveRunId } from "../goal/run-store.js";
import type { DiagramMode, OutputFormat, SerializedRun, StepResult } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";

const NO_TRUNCATION = Number.POSITIVE_INFINITY;
const AUTO_RESUME_BLOCK_KEYS = new Set(["git", "resume_execution"]);

export type GoalDetailOptions = {
  json?: boolean;
  output?: OutputFormat;
  diagram?: DiagramMode;
  channel?: GoalOutputChannel;
};

/** Resolve whether JSON mode is active: --output wins over --json. */
function resolveIsJson(opts: GoalDetailOptions): boolean {
  if (opts.output) return opts.output === "json";
  return Boolean(opts.json);
}

function resolveChannel(opts: GoalDetailOptions): GoalOutputChannel {
  return opts.channel ?? "cli";
}

function resolveDiagramMode(opts: GoalDetailOptions, channel: GoalOutputChannel): DiagramMode {
  if (opts.diagram) return opts.diagram;
  if (channel === "telegram") return "none";
  return "both";
}

function loadWorkerAttemptCount(runId: string, stepId: string): number {
  const workerDir = path.join(resolveGoalsDir(), runId, "workers", stepId);
  return loadAttemptBundles(workerDir).length;
}

function buildRetrySummary(run: SerializedRun): GoalRetrySummaryResult {
  const steps = run.plan?.steps ?? [];
  return buildGoalRetrySummary({
    steps: steps.map((step) => ({ id: step.id, turnsUsed: step.turnsUsed })),
    attemptsTotal: run.agentMaxTurnsPerTask,
    resolveStepAttemptsUsed: (stepId) => loadWorkerAttemptCount(run.runId, stepId),
  });
}

function buildProgress(run: SerializedRun): { completed: number; total: number } {
  const planSteps = run.plan?.steps ?? [];
  if (planSteps.length > 0) {
    const completed = planSteps.filter((step) => step.status === "done").length;
    return { completed, total: planSteps.length };
  }

  const results = Object.values(run.stepResults ?? {});
  if (results.length > 0) {
    const completed = results.filter((result) => result.success).length;
    return { completed, total: results.length };
  }

  return { completed: 0, total: 0 };
}

function buildBlockerSummary(run: SerializedRun): string | undefined {
  if (run.blocked) {
    const blockedAt = run.blocked.blockedAt === "planning" ? "Planning" : "Execution";
    const keySuffix = run.blocked.requiredInputKey ? ` (key: ${run.blocked.requiredInputKey})` : "";
    return `${blockedAt}: ${run.blocked.prompt}${keySuffix}`;
  }
  return run.lastError;
}

function buildActionHint(run: SerializedRun, channel: GoalOutputChannel): string | undefined {
  const runPrefix = run.runId.slice(0, 8);

  if (run.state === "blocked" && run.blocked) {
    if (AUTO_RESUME_BLOCK_KEYS.has(run.blocked.requiredInputKey)) {
      if (channel === "telegram") {
        return `Next: /goal_resume ${runPrefix}`;
      }
      return `Next: moltbot goal resume ${runPrefix}`;
    }
    if (channel === "telegram") {
      return `Next: /goal_answer ${runPrefix} <answer>`;
    }
    return (
      `Next: moltbot goal answer ${runPrefix} --key ${run.blocked.requiredInputKey} ` +
      "--value <VALUE>"
    );
  }

  if (run.state === "awaiting_approval" || run.state === "executing") {
    if (channel === "telegram") {
      return `Next: /goal_resume ${runPrefix}`;
    }
    return `Next: moltbot goal resume ${runPrefix}`;
  }

  return undefined;
}

function buildSteps(run: SerializedRun, retrySummary: GoalRetrySummaryResult): CompactGoalStep[] {
  const planSteps = run.plan?.steps ?? [];
  return planSteps.map((step) => ({
    id: step.id,
    text: step.description,
    state: step.status,
    attempt: retrySummary.attemptsByStepId.get(step.id),
  }));
}

function renderDetailSummary(run: SerializedRun, opts: GoalDetailOptions): string {
  const channel = resolveChannel(opts);
  const retrySummary = buildRetrySummary(run);
  const actionHint = buildActionHint(run, channel);

  const compact = formatCompactGoalOutput({
    state: run.state,
    title: run.goal,
    progress: buildProgress(run),
    blockerSummary: buildBlockerSummary(run),
    retrySummary: retrySummary.text,
    steps: buildSteps(run, retrySummary),
    mode: "full",
    channel,
    textFormat: "markdown",
    stepsTitle: "Steps",
    maxSteps: NO_TRUNCATION,
    maxLines: NO_TRUNCATION,
    maxStepTextChars: NO_TRUNCATION,
    maxTitleChars: NO_TRUNCATION,
  });

  const lines = [...compact.lines];
  if (channel === "cli") {
    lines.push(`Run ID: ${run.runId}`);
  }
  if (actionHint) {
    lines.push(actionHint);
  }
  return lines.join("\n");
}

function renderDiagrams(run: SerializedRun, diagramMode: DiagramMode): string {
  if (!run.plan || diagramMode === "none") return "";
  const lines: string[] = [];
  const stepResults = new Map<string, StepResult>(Object.entries(run.stepResults));
  const wantAscii = diagramMode === "ascii" || diagramMode === "both";
  const wantMermaid = diagramMode === "mermaid" || diagramMode === "both";

  if (wantAscii) {
    lines.push("**Dependencies (ASCII)**");
    lines.push("```text");
    lines.push(renderAsciiDependencies(run.plan));
    lines.push("```");
  }

  if (wantMermaid) {
    let cpm: ReturnType<typeof computeCpm> | undefined;
    try {
      cpm = computeCpm(run.plan);
    } catch {
      // Best-effort rendering: mermaid output can proceed without CPM.
    }
    const displayStatuses = computeDisplayStatuses(run.plan.steps);
    lines.push("**Dependency Graph**");
    lines.push("```mermaid");
    lines.push(renderMermaid(run.plan, cpm, displayStatuses, stepResults));
    lines.push("```");
  }

  return lines.join("\n");
}

export async function goalDetailCommand(
  runId: string,
  opts: GoalDetailOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const isJson = resolveIsJson(opts);
  const resolvedId = resolveRunId(runId);

  if (!resolvedId) {
    if (isJson) {
      runtime.log(JSON.stringify({ error: `Run not found: ${runId}` }));
      throw new JsonExitError(1);
    }
    runtime.error(`Run not found: ${runId}`);
    return;
  }

  const run = loadRun(resolvedId);
  if (!run) {
    if (isJson) {
      runtime.log(JSON.stringify({ error: `Run file missing: ${resolvedId}` }));
      throw new JsonExitError(1);
    }
    runtime.error(`Run file missing: ${resolvedId}`);
    return;
  }

  if (isJson) {
    runtime.log(JSON.stringify(run, null, 2));
    return;
  }

  const channel = resolveChannel(opts);
  const diagramMode = resolveDiagramMode(opts, channel);

  runtime.log(renderDetailSummary(run, opts));

  if (channel === "cli") {
    const diagrams = renderDiagrams(run, diagramMode);
    if (diagrams) {
      runtime.log("");
      runtime.log(diagrams);
    }
  }
}
