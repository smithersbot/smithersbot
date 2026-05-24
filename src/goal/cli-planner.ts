import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeAttemptBundle, tailText } from "./attempt-bundle.js";
import {
  appendAgentHistoryEventBestEffort,
  parseBackendUsage,
  writeCriticalAgentLaunchEvent,
  type AgentBackendUsage,
} from "./agent-history-events.js";
import { workspaceNameFromWorkingDir } from "./agent-history.js";
import { resolveAgentGoalHistoryDir } from "../config/managed-paths.js";
import {
  buildClaudeCodeEnv,
  buildCredentialStrippedEnv,
  writeAuthModeArtifact,
} from "./claude-code-env.js";
import {
  appendClaudeCodeSandboxArgs,
  appendCodexNativeSandboxExecArgs,
  buildClaudeCodeSandboxLaunchConfig,
  mergeCodexNativeSandboxEnv,
  writeCodexNativeSandboxConfig,
  type ClaudeCodeLaunchSandboxConfig,
  type CodexNativeSandboxConfig,
} from "./backend-sandbox.js";
import { runCliProcess } from "./cli-process.js";
import { getCodexAskForApprovalPlacement } from "./backend-availability.js";
import { requireEffectiveEnabledWorkers } from "./effective-workers.js";
import { PROVIDER_TRANSIENT_OVERLOAD_RE, RATE_LIMIT_RE } from "./error-patterns.js";
import {
  PlanParseError,
  buildPlanSystemPrompt,
  parsePlanResultFromText,
  type PlanResult,
} from "./planner.js";
import { resolveRunDir } from "./run-store.js";
import {
  classifyScoutError,
  renderScoutTemplate,
  resolveClaudeBinary,
  resolveScoutDir,
  resolveScoutTemplatePath,
  validateScoutOutput,
  SCOUT_NEEDS_CLARIFICATION_FILE,
  SCOUT_NODE_SPECS_DIR,
  SCOUT_PLAN_DRAFT_FILE,
  SCOUT_REPORT_FILE,
  type ScoutResult,
} from "./scout.js";
import type { Plan, PlannerBackendId, PlannerDegradedReason } from "./types.js";
import type { ClaudeCodeAuthMode, CliWorkerId } from "../config/types.goal.js";
import { redactSecretValues } from "../security/secret-paths.js";
import { mirrorGoalRuntimeToAgentHistory } from "./runtime-mirror.js";

const DEFAULT_PLANNING_TIMEOUT_MS = 7_200_000;
const LOG_EXCERPT_CHARS = 2048;
const TRANSIENT_OVERLOAD_RETRY_DELAYS_MS = [5_000, 10_000] as const;

// Canonical planning artifacts live under <run>/scout/ so execution + resume can
// rely on stable paths. Shared scout constants define scout_report/node_specs/etc.
const PLANNING_BRIEF_FILE = "PLANNING_BRIEF.md";
const PLANNER_STDOUT_FILE = "planning_stdout.txt";
const PLANNER_STDERR_FILE = "planning_stderr.txt";
const PLANNER_RAW_OUTPUT_FILE = "planning_raw_output.txt";
export const EXECUTION_PLAN_FILE = "execution_plan.json";

export const CLAUDE_ALLOWED_TOOLS = "Read,Glob,Grep,Bash";
const ANTHROPIC_USAGE_LIMIT_RE =
  /(?:you(?:'|’)?ve|you have)\s+hit\s+your\s+(?:chatgpt\s+)?(?:usage\s+)?limit|usage\s+limit|resets?\s+\d/i;

function buildPlanAndScoutAppendix(enabledWorkers: CliWorkerId[]): string {
  const backendUnion = enabledWorkers
    .filter((worker) => worker === "codex" || worker === "claude_code")
    .map((worker) => `"${worker}"`)
    .join(" | ");
  return `## Canonical Execution Plan Output

After scout files, write the execution plan as {{OUTPUT_DIR}}/${EXECUTION_PLAN_FILE} and print that same JSON object as final stdout.

Requirements:
- Match the stable planning schema above, including DAG dependencies, success criteria, constraints, and backend: ${backendUnion}.
- Keep dependency structure aligned with ${SCOUT_REPORT_FILE}.
- Step ids must map to scout node ids, except bootstrap id "create-conventions".
- If clarification is required, create ${SCOUT_NEEDS_CLARIFICATION_FILE} and return:
  { "blocked": true, "question": "The specific question you need answered" }`;
}

function buildAgentVisibleScoutDir(runId: string, cwd: string): string {
  const workspaceName = workspaceNameFromWorkingDir(cwd);
  return path.join(resolveAgentGoalHistoryDir(workspaceName, runId), "runtime", "scout");
}

function buildPlanOnlyPrompt(params: {
  goalText: string;
  cwd: string;
  enabledWorkers: CliWorkerId[];
}): string {
  return `${buildPlanSystemPrompt(params.enabledWorkers)}

Goal: ${params.goalText}
Current workspace path: ${params.cwd}`;
}

function truncateForPrompt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars * 0.65);
  const tailChars = Math.max(0, maxChars - headChars);
  return `${text.slice(0, headChars)}\n\n[...truncated cached scout draft...]\n\n${text.slice(
    -tailChars,
  )}`;
}

export function buildCachedScoutSummary(params: {
  runId: string;
  cwd: string;
  scoutDir: string;
  scoutData: Extract<ScoutResult, { status: "success" }>;
}): string {
  const { runId, cwd, scoutDir, scoutData } = params;
  void scoutDir;
  const runtimeMirrorBase = buildAgentVisibleScoutDir(runId, cwd);
  const nodes = scoutData.report.nodes.map((node) =>
    [
      `- ${node.id} (${node.type})`,
      `  objective: ${node.objective}`,
      `  verification: ${node.verification}`,
      `  effort/risk/uncertainty: ${node.effort}/${node.risk}/${node.uncertainty}`,
    ].join("\n"),
  );
  const edges =
    scoutData.report.edges.length > 0
      ? scoutData.report.edges.map((edge) => `- ${edge.from} -> ${edge.to}: ${edge.why}`)
      : ["- none"];

  return [
    "## Cached Scout Context",
    "",
    "Use this compact scout context from the previous successful scout. Do not run a fresh scout by default; a fresh-rescout command path is deferred.",
    "",
    "Artifact references:",
    "- Runtime scout directory: host-internal only; use the agent-history mirror below.",
    `- Agent-history mirror: ${runtimeMirrorBase}/`,
    `- Scout report: ${runtimeMirrorBase}/${SCOUT_REPORT_FILE}`,
    `- Plan draft: ${runtimeMirrorBase}/${SCOUT_PLAN_DRAFT_FILE}`,
    `- Node specs: ${runtimeMirrorBase}/${SCOUT_NODE_SPECS_DIR}/`,
    "",
    `Scout goal id: ${scoutData.report.goal_id}`,
    "",
    "Scout nodes:",
    ...nodes,
    "",
    "Scout edges:",
    ...edges,
    "",
    "Cached plan draft excerpt:",
    truncateForPrompt(scoutData.planDraft, 6_000),
  ].join("\n");
}

export type CliPlanningParams = {
  runId: string;
  goalText: string;
  goalsDir?: string;
  timeoutMs?: number;
  /** Working directory for planner/scout CLI execution (defaults to process.cwd()). */
  cwd?: string;
  /** How the planner's Claude Code process authenticates (default: "subscription"). */
  claudeCodeAuth?: ClaudeCodeAuthMode;
  /** Restrict planning workers to codex, claude_code, or both (default: both). */
  enabledWorkers?: CliWorkerId[];
  /** Preserve legacy --no-scout semantics by skipping scout artifact generation. */
  includeScoutArtifacts?: boolean;
  /** Reuse successful scout artifacts loaded from an earlier planning attempt. */
  scoutData?: Extract<ScoutResult, { status: "success" }>;
  /** Optional cancellation signal for planner process and transient-overload backoff. */
  abortSignal?: AbortSignal;
};

export type CliPlanningSuccess = {
  status: "success";
  plan: Plan;
  scoutStatus: "success" | "skipped";
  scoutSkipReason?: string;
  scoutData?: Extract<ScoutResult, { status: "success" }>;
  plannerBackendUsed?: PlannerBackendId;
  plannerDegradedReason?: PlannerDegradedReason;
  plannerDegradedResetHint?: string;
};

export type CliPlanningBlocked = {
  status: "blocked";
  question: string;
  scoutStatus: "needs_clarification" | "success" | "skipped";
  scoutSkipReason?: string;
  scoutData?: Extract<ScoutResult, { status: "success" }>;
  plannerBackendUsed?: PlannerBackendId;
  plannerDegradedReason?: PlannerDegradedReason;
  plannerDegradedResetHint?: string;
};

export type CliPlanningResult = CliPlanningSuccess | CliPlanningBlocked;

export type CliPlanRevisionParams = {
  runId: string;
  goalText: string;
  currentPlan: Plan;
  editInstructions: string;
  priorFeedback?: string[];
  goalsDir?: string;
  timeoutMs?: number;
  /** Working directory for revision CLI execution (defaults to process.cwd()). */
  cwd?: string;
  model?: string;
  /** How Claude Code revision process authenticates (default: "subscription"). */
  claudeCodeAuth?: ClaudeCodeAuthMode;
  /** Restrict revision workers to codex, claude_code, or both (default: both). */
  enabledWorkers?: CliWorkerId[];
  /** Optional cancellation signal for revision process and transient-overload backoff. */
  abortSignal?: AbortSignal;
};

export type CliPlanRevisionResult = {
  plan: PlanResult;
  plannerBackendUsed?: PlannerBackendId;
  plannerDegradedReason?: PlannerDegradedReason;
  plannerDegradedResetHint?: string;
};

const PLAN_REVISION_DIR = "replan";
const PLAN_REVISION_STDOUT_FILE = "revision_stdout.txt";
const PLAN_REVISION_STDERR_FILE = "revision_stderr.txt";
const PLAN_REVISION_RAW_OUTPUT_FILE = "revision_raw_output.txt";
const PLAN_REVISION_PROMPT_FILE_RE = /^revision_prompt_r(\d+)\.txt$/;

function detectAnthropicDegradedReason(errorMessage: string): PlannerDegradedReason | undefined {
  if (!errorMessage) return undefined;
  if (ANTHROPIC_USAGE_LIMIT_RE.test(errorMessage)) return "anthropic_usage_limit";
  if (PROVIDER_TRANSIENT_OVERLOAD_RE.test(errorMessage)) return "anthropic_overloaded";
  if (RATE_LIMIT_RE.test(errorMessage)) return "anthropic_rate_limit";
  return undefined;
}

function extractResetHint(errorMessage: string): string | undefined {
  if (!errorMessage) return undefined;
  for (const line of errorMessage.split(/\r?\n/)) {
    const match = /\b(reset(?:s)?(?:\s+at)?\s+[^.;,\n\r]+)/i.exec(line);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function buildCodexPlanningArgs(params: {
  prompt: string;
  sandboxConfig: CodexNativeSandboxConfig;
}): string[] {
  const codexAskForApproval = getCodexAskForApprovalPlacement();
  const args = [
    ...(codexAskForApproval === "before_exec" ? ["--ask-for-approval", "never"] : []),
    "exec",
    ...(codexAskForApproval === "after_exec" ? ["--ask-for-approval", "never"] : []),
  ];
  appendCodexNativeSandboxExecArgs(args, params.sandboxConfig);
  args.push(params.prompt);
  return args;
}

function buildClaudePlanningArgs(params: {
  sandboxConfig: ClaudeCodeLaunchSandboxConfig;
  model?: string;
}): string[] {
  const args = ["-p", "--allowedTools", CLAUDE_ALLOWED_TOOLS];
  appendClaudeCodeSandboxArgs(args, params.sandboxConfig);
  if (params.model) args.push("--model", params.model);
  return args;
}

function sanitizePlannerArgvForHistory(args: readonly string[]): string[] {
  const sanitized = [...args];
  if (sanitized.length > 0) {
    sanitized[sanitized.length - 1] = "<prompt redacted; see prompt artifact>";
  }
  return sanitized;
}

function appendPlannerHistoryBestEffort(params: {
  workingDir: string;
  runId: string;
  phase: "planner" | "plan-revision";
  backend: PlannerBackendId;
  event: string;
  status?: string;
  attemptNumber?: number;
  tokenUsage?: AgentBackendUsage;
  errorClass?: string;
  outputSummary?: string;
  artifactPaths?: readonly string[];
  extra?: Record<string, unknown>;
}): void {
  appendAgentHistoryEventBestEffort(
    {
      kind: "goal",
      workspaceName: workspaceNameFromWorkingDir(params.workingDir),
      goalId: params.runId,
    },
    {
      event: params.event,
      phase: params.phase,
      backend: params.backend,
      runId: params.runId,
      goalId: params.runId,
      status: params.status,
      attemptNumber: params.attemptNumber,
      tokenUsage: params.tokenUsage,
      errorClass: params.errorClass,
      outputSummary: params.outputSummary,
      artifactPaths: params.artifactPaths,
      ...params.extra,
    },
  );
}

function mirrorPlannerRuntimeBestEffort(params: {
  workingDir: string;
  runId: string;
  goalsDir?: string;
}): void {
  const scope = {
    kind: "goal" as const,
    workspaceName: workspaceNameFromWorkingDir(params.workingDir),
    goalId: params.runId,
  };
  try {
    mirrorGoalRuntimeToAgentHistory({
      workspaceName: scope.workspaceName,
      goalId: params.runId,
      ...(params.goalsDir ? { goalsDir: params.goalsDir } : {}),
    });
  } catch (error) {
    appendAgentHistoryEventBestEffort(scope, {
      event: "runtime_mirror_warning",
      phase: "planner",
      runId: params.runId,
      goalId: params.runId,
      status: "warning",
      errorClass: error instanceof Error ? error.name : "runtime_mirror_error",
      outputSummary: `Runtime mirror failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

function resolvePlannerBackends(enabledWorkers?: CliWorkerId[]): CliWorkerId[] {
  return requireEffectiveEnabledWorkers({
    config: enabledWorkers ? { enabledWorkers } : undefined,
  });
}

function formatCodexFallbackDisabledError(params: {
  context: "Planning" | "Plan revision";
  degradedReason: PlannerDegradedReason;
  resetHint?: string;
}): string {
  const { context, degradedReason, resetHint } = params;
  if (degradedReason === "anthropic_overloaded") {
    return (
      `${context} failed: Anthropic Claude Code is temporarily overloaded (529/provider 5xx), ` +
      "and codex fallback is disabled by goal.enabledWorkers."
    );
  }
  const reasonLabel = degradedReason === "anthropic_usage_limit" ? "usage limit" : "rate limit";
  const resetSuffix = resetHint ? ` (${resetHint})` : "";
  return (
    `${context} failed: Anthropic ${reasonLabel} reached${resetSuffix}, ` +
    "and codex fallback is disabled by goal.enabledWorkers."
  );
}

function shouldRetryTransientPlannerOverload(params: {
  degradedReason: PlannerDegradedReason;
  retryCount: number;
}): boolean {
  return (
    params.degradedReason === "anthropic_overloaded" &&
    params.retryCount < TRANSIENT_OVERLOAD_RETRY_DELAYS_MS.length
  );
}

async function waitForTransientPlannerRetry(params: {
  delayMs: number;
  abortSignal?: AbortSignal;
  context: "Planning" | "Plan revision";
}): Promise<void> {
  const { delayMs, abortSignal, context } = params;
  if (abortSignal?.aborted) {
    throw new Error(`${context} aborted during transient-overload retry backoff.`);
  }
  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const cleanup = () => {
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
    };
    const onResolve = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`${context} aborted during transient-overload retry backoff.`));
    };
    timer = setTimeout(onResolve, delayMs);
    if (abortSignal) {
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function rewritePlanForDegradedPlanner(plan: Plan, enabledWorkers?: CliWorkerId[]): Plan {
  if (!resolvePlannerBackends(enabledWorkers).includes("codex")) return plan;
  return {
    ...plan,
    steps: plan.steps.map((step) => {
      const backend = !step.backend || step.backend === "claude_code" ? "codex" : step.backend;
      const executedBackend =
        step.executedBackend === "claude_code" ? "codex" : step.executedBackend;
      return { ...step, backend, executedBackend };
    }),
  };
}

function resolveCodexScoutDir(runId: string): string {
  const safeRunId = runId.replace(/[^a-zA-Z0-9-]/g, "_");
  return path.join(os.tmpdir(), "moltbot-goal-planner", safeRunId, "scout");
}

function copyScoutArtifacts(params: { sourceDir: string; targetDir: string; label: string }): void {
  const { sourceDir, targetDir } = params;
  if (!fs.existsSync(sourceDir)) return;

  const singleFileArtifacts = [
    SCOUT_PLAN_DRAFT_FILE,
    SCOUT_REPORT_FILE,
    SCOUT_NEEDS_CLARIFICATION_FILE,
    EXECUTION_PLAN_FILE,
  ];

  try {
    for (const fileName of singleFileArtifacts) {
      const sourcePath = path.join(sourceDir, fileName);
      if (!fs.existsSync(sourcePath)) continue;
      fs.mkdirSync(path.dirname(path.join(targetDir, fileName)), { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, fileName),
        redactSecretValues(fs.readFileSync(sourcePath, "utf8")),
        "utf8",
      );
    }

    const sourceNodeSpecsDir = path.join(sourceDir, SCOUT_NODE_SPECS_DIR);
    if (fs.existsSync(sourceNodeSpecsDir) && fs.statSync(sourceNodeSpecsDir).isDirectory()) {
      const sourceNodeSpecFiles = fs
        .readdirSync(sourceNodeSpecsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"));
      if (sourceNodeSpecFiles.length > 0) {
        const targetNodeSpecsDir = path.join(targetDir, SCOUT_NODE_SPECS_DIR);
        fs.rmSync(targetNodeSpecsDir, { recursive: true, force: true });
        fs.mkdirSync(targetNodeSpecsDir, { recursive: true });
        for (const entry of sourceNodeSpecFiles) {
          const sourcePath = path.join(sourceNodeSpecsDir, entry.name);
          fs.writeFileSync(
            path.join(targetNodeSpecsDir, entry.name),
            redactSecretValues(fs.readFileSync(sourcePath, "utf8")),
            "utf8",
          );
        }
      }
    }
  } catch (err) {
    throw new Error(
      `Failed to copy ${params.label} planner artifacts from ${sourceDir} to ${targetDir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function copyCodexScoutArtifacts(params: { sourceDir: string; targetDir: string }): void {
  copyScoutArtifacts({ ...params, label: "Codex" });
}

function reconcileAgentVisibleScoutArtifacts(params: {
  sourceDir: string;
  targetDir: string;
}): void {
  copyScoutArtifacts({ ...params, label: "agent-visible" });
}

function buildPlanningPrompt(params: {
  runId: string;
  goalText: string;
  cwd: string;
  scoutDir: string;
  includeScoutArtifacts: boolean;
  enabledWorkers: CliWorkerId[];
  scoutData?: Extract<ScoutResult, { status: "success" }>;
}): string {
  const { runId, goalText, cwd, scoutDir, includeScoutArtifacts, enabledWorkers, scoutData } =
    params;
  if (!includeScoutArtifacts) {
    return buildPlanOnlyPrompt({
      goalText,
      cwd,
      enabledWorkers,
    });
  }

  if (scoutData) {
    const agentVisibleScoutDir = buildAgentVisibleScoutDir(runId, cwd);
    return [
      buildPlanSystemPrompt(enabledWorkers),
      "",
      "## Replan With Cached Scout Context",
      "",
      `Goal: ${goalText}`,
      `Current workspace path: ${cwd}`,
      "",
      buildCachedScoutSummary({ runId, cwd, scoutDir, scoutData }),
      "",
      "## Replan Instructions",
      "- Consume the cached scout facts and artifact references above.",
      "- Do not rerun the Scout Phase or recreate scout artifacts during normal /goal_resume --replan.",
      `- Write the revised execution plan as ${agentVisibleScoutDir}/${EXECUTION_PLAN_FILE} and print that same JSON object as final stdout.`,
      "- Preserve the scout DAG/dependency structure unless the plan-quality rubric requires correction.",
      "- Respond ONLY with a JSON object matching the schema above.",
    ].join("\n");
  }

  const templatePath = resolveScoutTemplatePath();
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Scout template not found: ${templatePath}`);
  }

  const template = fs.readFileSync(templatePath, "utf8");
  const agentVisibleScoutDir = buildAgentVisibleScoutDir(runId, cwd);
  const scoutBrief = renderScoutTemplate({
    template,
    goalId: runId,
    goalText,
    outputDir: agentVisibleScoutDir,
  });

  return [
    buildPlanSystemPrompt(enabledWorkers),
    "",
    "## Conceptual Planning Phases",
    "",
    "### Scout Phase",
    "- Inspect the repository and project convention files from the workspace.",
    "- Emit compact scout facts/artifacts: plan draft, scout report JSON, and node specs.",
    "- Do not include giant raw dumps; summarize relevant evidence and cite files/functions.",
    "- Agent-visible runtime history is under <managed-root>/agent/history/goals/<workspace>/<goalId>/runtime/.",
    "",
    "### Planner Phase",
    "- Consume the scout facts/artifacts from the Scout Phase.",
    "- Produce the required JSON execution plan using the schema below.",
    "- Preserve the scout DAG/dependency structure unless the plan-quality rubric requires correction.",
    "- Satisfy the shared plan-quality rubric, backend selection rules, and exact verification requirements.",
    "",
    "## Context",
    "",
    `Workspace: ${cwd}`,
    "",
    scoutBrief,
    "",
    buildPlanAndScoutAppendix(enabledWorkers).replaceAll("{{OUTPUT_DIR}}", agentVisibleScoutDir),
  ].join("\n");
}

function writePlannerRawOutput(scoutDir: string, rawOutput: string): void {
  try {
    fs.writeFileSync(
      path.join(scoutDir, PLANNER_RAW_OUTPUT_FILE),
      redactSecretValues(rawOutput),
      "utf8",
    );
  } catch {
    // Best-effort diagnostics.
  }
}

function redactTextArtifactIfExists(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    fs.writeFileSync(filePath, redactSecretValues(fs.readFileSync(filePath, "utf8")), "utf8");
  } catch {
    // Best-effort diagnostics.
  }
}

function clearStalePlanningArtifacts(scoutDir: string): void {
  const staleSingleFileArtifacts = [
    SCOUT_NEEDS_CLARIFICATION_FILE,
    SCOUT_PLAN_DRAFT_FILE,
    SCOUT_REPORT_FILE,
    EXECUTION_PLAN_FILE,
    PLANNER_RAW_OUTPUT_FILE,
  ];
  for (const artifact of staleSingleFileArtifacts) {
    fs.rmSync(path.join(scoutDir, artifact), { force: true });
  }
  fs.rmSync(path.join(scoutDir, SCOUT_NODE_SPECS_DIR), { recursive: true, force: true });
}

function clearStaleReplanArtifacts(scoutDir: string): void {
  const staleSingleFileArtifacts = [
    SCOUT_NEEDS_CLARIFICATION_FILE,
    EXECUTION_PLAN_FILE,
    PLANNER_RAW_OUTPUT_FILE,
  ];
  for (const artifact of staleSingleFileArtifacts) {
    fs.rmSync(path.join(scoutDir, artifact), { force: true });
  }
}

function writeCanonicalPlanArtifact(scoutDir: string, plan: Plan): void {
  const canonical = {
    workingDir: plan.workingDir,
    summary: plan.summary,
    shortSummary: plan.shortSummary,
    buildGate: plan.buildGate,
    steps: plan.steps.map((step) => ({
      id: step.id,
      description: step.description,
      shortSummary: step.shortSummary,
      dependsOn: step.dependsOn,
      successCriteria: step.successCriteria,
      constraints: step.constraints,
      durationMinutes: step.durationMinutes,
      backend: step.backend,
      requiresNetwork: step.requiresNetwork,
    })),
  };
  try {
    fs.writeFileSync(
      path.join(scoutDir, EXECUTION_PLAN_FILE),
      JSON.stringify(canonical, null, 2),
      "utf8",
    );
  } catch {
    // Best-effort diagnostics.
  }
}

function parsePlanWithFallback(goalText: string, scoutDir: string, stdout: string): PlanResult {
  const planPath = path.join(scoutDir, EXECUTION_PLAN_FILE);
  const fileText = fs.existsSync(planPath) ? fs.readFileSync(planPath, "utf8") : "";

  if (fileText.trim().length > 0) {
    try {
      return parsePlanResultFromText(fileText, goalText);
    } catch (err) {
      // Some runs may write a valid JSON plan only to stdout.
      if (stdout.trim().length > 0) {
        return parsePlanResultFromText(stdout, goalText);
      }
      throw err;
    }
  }

  return parsePlanResultFromText(stdout, goalText);
}

function buildPlanRevisionPrompt(params: {
  goalText: string;
  currentPlan: Plan;
  cwd: string;
  editInstructions: string;
  priorFeedback?: string[];
  enabledWorkers: CliWorkerId[];
}): string {
  const { goalText, currentPlan, cwd, editInstructions, priorFeedback, enabledWorkers } = params;
  const currentPlanJson = JSON.stringify(
    {
      workingDir: currentPlan.workingDir,
      summary: currentPlan.summary,
      shortSummary: currentPlan.shortSummary,
      buildGate: currentPlan.buildGate,
      steps: currentPlan.steps.map((step) => ({
        id: step.id,
        description: step.description,
        shortSummary: step.shortSummary,
        dependsOn: step.dependsOn,
        successCriteria: step.successCriteria,
        constraints: step.constraints,
        durationMinutes: step.durationMinutes,
        backend: step.backend,
        requiresNetwork: step.requiresNetwork,
      })),
    },
    null,
    2,
  );

  const uniquePriorFeedback = [...new Set((priorFeedback ?? []).filter(Boolean))];
  const priorChecklistSection =
    uniquePriorFeedback.length > 0
      ? [
          "Prior corrections checklist:",
          "Before returning the revised plan, confirm each checklist item is still addressed and no prior fixes regress.",
          ...uniquePriorFeedback.map((feedback, index) => `${index + 1}. ${feedback}`),
          "",
        ]
      : [];

  return [
    buildPlanSystemPrompt(enabledWorkers),
    "",
    `Goal: ${goalText}`,
    `Current workspace path: ${cwd}`,
    "",
    "Current plan:",
    currentPlanJson,
    "",
    ...priorChecklistSection,
    `Revision instructions: ${editInstructions}`,
    "",
    "Generate a revised plan incorporating these changes. Keep unchanged steps as-is where possible.",
    "Respond ONLY with a JSON object matching the schema above.",
  ].join("\n");
}

function resolveNextRevisionPromptRound(revisionDir: string): number {
  try {
    const entries = fs.readdirSync(revisionDir, { withFileTypes: true });
    let maxRound = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = PLAN_REVISION_PROMPT_FILE_RE.exec(entry.name);
      if (!match?.[1]) continue;
      const round = Number.parseInt(match[1], 10);
      if (Number.isNaN(round)) continue;
      maxRound = Math.max(maxRound, round);
    }
    return maxRound + 1;
  } catch {
    return 1;
  }
}

export async function runCliPlanRevision(
  params: CliPlanRevisionParams,
): Promise<CliPlanRevisionResult> {
  const {
    runId,
    goalText,
    currentPlan,
    editInstructions,
    priorFeedback,
    goalsDir,
    model,
    claudeCodeAuth,
  } = params;
  const timeout = params.timeoutMs ?? DEFAULT_PLANNING_TIMEOUT_MS;
  // Keep revision subprocesses in the project workspace so convention files are discovered natively.
  const plannerCwd = params.cwd ?? process.cwd();

  const plannerBackends = resolvePlannerBackends(params.enabledWorkers);
  const claudeBin = plannerBackends.includes("claude_code") ? resolveClaudeBinary() : undefined;
  const claudeCommand = claudeBin ?? "claude";

  const runDir = resolveRunDir(runId, goalsDir);
  const revisionDir = path.join(runDir, PLAN_REVISION_DIR);
  fs.mkdirSync(revisionDir, { recursive: true });
  const revisionRound = resolveNextRevisionPromptRound(revisionDir);

  const authMode = claudeCodeAuth ?? "subscription";
  const revisionEnv = buildClaudeCodeEnv(authMode);
  writeAuthModeArtifact(revisionDir, authMode);

  const prompt = buildPlanRevisionPrompt({
    goalText,
    currentPlan,
    cwd: plannerCwd,
    editInstructions,
    priorFeedback,
    enabledWorkers: plannerBackends,
  });
  try {
    fs.writeFileSync(
      path.join(revisionDir, `revision_prompt_r${revisionRound}.txt`),
      prompt,
      "utf8",
    );
  } catch {
    // Best-effort diagnostics.
  }

  const claudeRevisionSandbox = buildClaudeCodeSandboxLaunchConfig({
    workingDir: plannerCwd,
    runId: `${runId}-plan-revision-r${revisionRound}`,
    purpose: "repo-chat",
  });
  const codexRevisionSandbox = plannerBackends.includes("codex")
    ? writeCodexNativeSandboxConfig({
        workingDir: plannerCwd,
        runId: `${runId}-plan-revision-r${revisionRound}`,
        purpose: "repo-chat",
        sandboxRoot: process.env.SMITHERSBOT_CODEX_SANDBOX_ROOT,
      })
    : undefined;

  let plannerBackendUsed: PlannerBackendId | undefined;
  let plannerDegradedReason: PlannerDegradedReason | undefined;
  let plannerDegradedResetHint: string | undefined;
  let attemptIndex = 0;
  let claudeOverloadRetryCount = 0;
  let processAttemptNumber = 0;
  let procResult: Awaited<ReturnType<typeof runCliProcess>> | null = null;

  while (attemptIndex < plannerBackends.length) {
    const backend = plannerBackends[attemptIndex];
    if (!backend) break;
    processAttemptNumber += 1;
    const attemptNumber = processAttemptNumber;
    const command = backend === "claude_code" ? claudeCommand : "codex";
    const args =
      backend === "claude_code"
        ? buildClaudePlanningArgs({ sandboxConfig: claudeRevisionSandbox, model })
        : buildCodexPlanningArgs({
            prompt,
            sandboxConfig: codexRevisionSandbox!,
          });
    const launchHistory = writeCriticalAgentLaunchEvent({
      scope: {
        kind: "goal",
        workspaceName: workspaceNameFromWorkingDir(plannerCwd),
        goalId: runId,
      },
      phase: "plan-revision",
      backend,
      prompt,
      command,
      argv: sanitizePlannerArgvForHistory(args),
      event: {
        runId,
        goalId: runId,
        attemptNumber,
        status: "launching",
        revisionRound,
      },
    });

    procResult = await runCliProcess({
      command,
      args,
      cwd: plannerCwd,
      timeoutMs: timeout,
      ...(backend === "claude_code" ? { stdin: prompt } : {}),
      stdoutPath: path.join(revisionDir, PLAN_REVISION_STDOUT_FILE),
      stderrPath: path.join(revisionDir, PLAN_REVISION_STDERR_FILE),
      abortSignal: params.abortSignal,
      env:
        backend === "claude_code"
          ? revisionEnv
          : mergeCodexNativeSandboxEnv(
              buildCredentialStrippedEnv(process.env, { stripAuthKeys: true }),
              codexRevisionSandbox!,
            ),
    });
    redactTextArtifactIfExists(path.join(revisionDir, PLAN_REVISION_STDOUT_FILE));
    redactTextArtifactIfExists(path.join(revisionDir, PLAN_REVISION_STDERR_FILE));
    const tokenUsage = parseBackendUsage(`${procResult.stdout}\n${procResult.stderr}`);

    if (procResult.timedOut) {
      appendPlannerHistoryBestEffort({
        workingDir: plannerCwd,
        runId,
        phase: "plan-revision",
        backend,
        event: "failure",
        status: "timeout",
        attemptNumber,
        tokenUsage,
        errorClass: "timeout",
        outputSummary: tailText(procResult.stdout || procResult.stderr, LOG_EXCERPT_CHARS),
        artifactPaths: [
          path.join(revisionDir, PLAN_REVISION_STDOUT_FILE),
          path.join(revisionDir, PLAN_REVISION_STDERR_FILE),
          launchHistory.promptArtifactPath,
        ],
        extra: { revisionRound },
      });
      throw new Error(`Plan revision timed out after ${(timeout / 60_000).toFixed(0)} minutes.`);
    }

    if ((procResult.exitCode && procResult.exitCode !== 0) || procResult.signal) {
      const errMsg =
        procResult.stderr ||
        procResult.stdout ||
        (procResult.signal
          ? `Plan revision process terminated by ${procResult.signal}.`
          : "Plan revision process failed.");
      appendPlannerHistoryBestEffort({
        workingDir: plannerCwd,
        runId,
        phase: "plan-revision",
        backend,
        event: "failure",
        status: "crash",
        attemptNumber,
        tokenUsage,
        errorClass: procResult.signal ? "signal" : "exit_code",
        outputSummary: tailText(errMsg, LOG_EXCERPT_CHARS),
        artifactPaths: [
          path.join(revisionDir, PLAN_REVISION_STDOUT_FILE),
          path.join(revisionDir, PLAN_REVISION_STDERR_FILE),
          launchHistory.promptArtifactPath,
        ],
        extra: { revisionRound, exitCode: procResult.exitCode, signal: procResult.signal },
      });

      if (backend === "claude_code") {
        const degradedReason = detectAnthropicDegradedReason(errMsg);
        if (degradedReason) {
          plannerDegradedReason = degradedReason;
          plannerDegradedResetHint = extractResetHint(errMsg);
          if (
            shouldRetryTransientPlannerOverload({
              degradedReason,
              retryCount: claudeOverloadRetryCount,
            })
          ) {
            const delayMs = TRANSIENT_OVERLOAD_RETRY_DELAYS_MS[claudeOverloadRetryCount] ?? 0;
            claudeOverloadRetryCount += 1;
            await waitForTransientPlannerRetry({
              delayMs,
              abortSignal: params.abortSignal,
              context: "Plan revision",
            });
            appendPlannerHistoryBestEffort({
              workingDir: plannerCwd,
              runId,
              phase: "plan-revision",
              backend,
              event: "retry",
              status: degradedReason,
              attemptNumber,
              errorClass: degradedReason,
              outputSummary: tailText(errMsg, LOG_EXCERPT_CHARS),
              extra: { revisionRound, delayMs },
            });
            continue;
          }
          if (plannerBackends.slice(attemptIndex + 1).includes("codex")) {
            appendPlannerHistoryBestEffort({
              workingDir: plannerCwd,
              runId,
              phase: "plan-revision",
              backend,
              event: "fallback",
              status: degradedReason,
              attemptNumber,
              errorClass: degradedReason,
              outputSummary: tailText(errMsg, LOG_EXCERPT_CHARS),
              extra: { revisionRound, fallbackBackend: "codex" },
            });
            attemptIndex += 1;
            continue;
          }
          throw new Error(
            formatCodexFallbackDisabledError({
              context: "Plan revision",
              degradedReason,
              resetHint: plannerDegradedResetHint,
            }),
          );
        }
      }

      throw new Error(`Plan revision failed: ${errMsg}`);
    }

    if (backend === "claude_code") {
      plannerDegradedReason = undefined;
      plannerDegradedResetHint = undefined;
    }
    plannerBackendUsed = backend;
    break;
  }

  if (!procResult) {
    throw new Error("Plan revision failed before producing output.");
  }

  try {
    fs.writeFileSync(
      path.join(revisionDir, PLAN_REVISION_RAW_OUTPUT_FILE),
      redactSecretValues(procResult.stdout),
      "utf8",
    );
  } catch {
    // Best-effort diagnostics.
  }

  let parsedPlan: PlanResult;
  try {
    parsedPlan = parsePlanResultFromText(procResult.stdout, goalText);
  } catch (err) {
    appendPlannerHistoryBestEffort({
      workingDir: plannerCwd,
      runId,
      phase: "plan-revision",
      backend: plannerBackendUsed ?? plannerBackends[0] ?? "claude_code",
      event: "failure",
      status: "parse_failed",
      tokenUsage: parseBackendUsage(procResult.stdout),
      errorClass: err instanceof PlanParseError ? "parse" : "validation",
      outputSummary: err instanceof Error ? err.message : String(err),
      artifactPaths: [path.join(revisionDir, PLAN_REVISION_RAW_OUTPUT_FILE)],
      extra: { revisionRound },
    });
    throw err;
  }
  const plan =
    plannerDegradedReason && !("blocked" in parsedPlan)
      ? rewritePlanForDegradedPlanner(parsedPlan, params.enabledWorkers)
      : parsedPlan;
  appendPlannerHistoryBestEffort({
    workingDir: plannerCwd,
    runId,
    phase: "plan-revision",
    backend: plannerBackendUsed ?? plannerBackends[0] ?? "claude_code",
    event: "result",
    status: "blocked" in plan ? "blocked" : "success",
    tokenUsage: parseBackendUsage(procResult.stdout),
    outputSummary:
      "blocked" in plan
        ? tailText(plan.question, LOG_EXCERPT_CHARS)
        : tailText(plan.summary, LOG_EXCERPT_CHARS),
    artifactPaths: [path.join(revisionDir, PLAN_REVISION_RAW_OUTPUT_FILE)],
    extra: { revisionRound },
  });

  return {
    plan,
    ...(plannerBackendUsed ? { plannerBackendUsed } : {}),
    ...(plannerDegradedReason ? { plannerDegradedReason } : {}),
    ...(plannerDegradedResetHint ? { plannerDegradedResetHint } : {}),
  };
}

export async function runCliPlanning(params: CliPlanningParams): Promise<CliPlanningResult> {
  const { runId, goalText, goalsDir } = params;
  const includeScoutArtifacts = params.includeScoutArtifacts !== false;
  const cachedScoutData = includeScoutArtifacts ? params.scoutData : undefined;
  const timeout = params.timeoutMs ?? DEFAULT_PLANNING_TIMEOUT_MS;
  const plannerCwd = params.cwd ?? process.cwd();

  const plannerBackends = resolvePlannerBackends(params.enabledWorkers);
  const claudeBin = plannerBackends.includes("claude_code") ? resolveClaudeBinary() : undefined;
  const claudeCommand = claudeBin ?? "claude";

  const scoutDir = resolveScoutDir(runId, goalsDir);
  const agentVisibleScoutDir =
    includeScoutArtifacts && !cachedScoutData
      ? buildAgentVisibleScoutDir(runId, plannerCwd)
      : undefined;
  fs.mkdirSync(scoutDir, { recursive: true });
  if (cachedScoutData) {
    clearStaleReplanArtifacts(scoutDir);
  } else {
    clearStalePlanningArtifacts(scoutDir);
  }
  if (includeScoutArtifacts && !cachedScoutData) {
    fs.mkdirSync(path.join(scoutDir, SCOUT_NODE_SPECS_DIR), { recursive: true });
  }
  if (agentVisibleScoutDir) {
    clearStalePlanningArtifacts(agentVisibleScoutDir);
    fs.mkdirSync(path.join(agentVisibleScoutDir, SCOUT_NODE_SPECS_DIR), { recursive: true });
  }
  const codexScoutDir =
    includeScoutArtifacts && !cachedScoutData ? resolveCodexScoutDir(runId) : undefined;
  if (codexScoutDir) {
    fs.rmSync(codexScoutDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(codexScoutDir, SCOUT_NODE_SPECS_DIR), { recursive: true });
  }

  const claudePrompt = buildPlanningPrompt({
    runId,
    goalText,
    cwd: plannerCwd,
    scoutDir,
    includeScoutArtifacts,
    enabledWorkers: plannerBackends,
    ...(cachedScoutData ? { scoutData: cachedScoutData } : {}),
  });
  const codexPrompt =
    codexScoutDir == null
      ? claudePrompt
      : buildPlanningPrompt({
          runId,
          goalText,
          cwd: plannerCwd,
          scoutDir: codexScoutDir,
          includeScoutArtifacts,
          enabledWorkers: plannerBackends,
          ...(cachedScoutData ? { scoutData: cachedScoutData } : {}),
        });
  fs.writeFileSync(path.join(scoutDir, PLANNING_BRIEF_FILE), claudePrompt, "utf8");

  const authMode = params.claudeCodeAuth ?? "subscription";
  const planningEnv = buildClaudeCodeEnv(authMode);
  writeAuthModeArtifact(scoutDir, authMode);
  const claudePlanningSandbox = buildClaudeCodeSandboxLaunchConfig({
    workingDir: plannerCwd,
    runId: `${runId}-planner`,
    purpose: "repo-chat",
    extraWritablePaths: [
      ...(includeScoutArtifacts ? [scoutDir] : []),
      ...(agentVisibleScoutDir ? [agentVisibleScoutDir] : []),
    ],
  });
  const codexPlanningSandbox = plannerBackends.includes("codex")
    ? writeCodexNativeSandboxConfig({
        workingDir: plannerCwd,
        runId: `${runId}-planner`,
        purpose: "repo-chat",
        extraWritablePaths: [
          ...(codexScoutDir ? [codexScoutDir] : []),
          ...(agentVisibleScoutDir ? [agentVisibleScoutDir] : []),
        ],
        sandboxRoot: process.env.SMITHERSBOT_CODEX_SANDBOX_ROOT,
      })
    : undefined;
  let plannerBackendUsed: PlannerBackendId | undefined;
  let plannerDegradedReason: PlannerDegradedReason | undefined;
  let plannerDegradedResetHint: string | undefined;
  let attemptIndex = 0;
  let claudeOverloadRetryCount = 0;
  let processAttemptNumber = 0;
  let finalAttemptNumber = 0;
  let procResult: Awaited<ReturnType<typeof runCliProcess>> | null = null;
  const defaultPlannerBackend: PlannerBackendId = plannerBackends[0] ?? "claude_code";

  while (attemptIndex < plannerBackends.length) {
    const backend = plannerBackends[attemptIndex];
    if (!backend) break;
    processAttemptNumber += 1;
    const attemptNumber = processAttemptNumber;
    finalAttemptNumber = attemptNumber;
    const prompt = backend === "codex" ? codexPrompt : claudePrompt;
    const command = backend === "claude_code" ? claudeCommand : "codex";
    if (agentVisibleScoutDir) {
      clearStalePlanningArtifacts(agentVisibleScoutDir);
      fs.mkdirSync(path.join(agentVisibleScoutDir, SCOUT_NODE_SPECS_DIR), { recursive: true });
    }
    const args =
      backend === "claude_code"
        ? buildClaudePlanningArgs({ sandboxConfig: claudePlanningSandbox })
        : buildCodexPlanningArgs({
            prompt,
            sandboxConfig: codexPlanningSandbox!,
          });
    const launchHistory = writeCriticalAgentLaunchEvent({
      scope: {
        kind: "goal",
        workspaceName: workspaceNameFromWorkingDir(plannerCwd),
        goalId: runId,
      },
      phase: "planner",
      backend,
      prompt,
      command,
      argv: sanitizePlannerArgvForHistory(args),
      event: {
        runId,
        goalId: runId,
        attemptNumber,
        status: "launching",
        includeScoutArtifacts,
      },
    });

    procResult = await runCliProcess({
      command,
      args,
      cwd: plannerCwd,
      timeoutMs: timeout,
      ...(backend === "claude_code" ? { stdin: prompt } : {}),
      stdoutPath: path.join(scoutDir, PLANNER_STDOUT_FILE),
      stderrPath: path.join(scoutDir, PLANNER_STDERR_FILE),
      abortSignal: params.abortSignal,
      env:
        backend === "claude_code"
          ? planningEnv
          : mergeCodexNativeSandboxEnv(
              buildCredentialStrippedEnv(process.env, { stripAuthKeys: true }),
              codexPlanningSandbox!,
            ),
    });
    redactTextArtifactIfExists(path.join(scoutDir, PLANNER_STDOUT_FILE));
    redactTextArtifactIfExists(path.join(scoutDir, PLANNER_STDERR_FILE));

    writePlannerRawOutput(scoutDir, procResult.stdout);
    const tokenUsage = parseBackendUsage(`${procResult.stdout}\n${procResult.stderr}`);

    if (procResult.timedOut) {
      const message = `Planning timed out after ${(timeout / 60_000).toFixed(0)} minutes.`;
      writeAttemptBundle(scoutDir, {
        attemptNumber,
        backend,
        outcome: "timeout",
        errorClassification: "timeout",
        logExcerpt: tailText(procResult.stdout, LOG_EXCERPT_CHARS),
        durationMs: procResult.durationMs,
        tokenUsage,
      });
      appendPlannerHistoryBestEffort({
        workingDir: plannerCwd,
        runId,
        phase: "planner",
        backend,
        event: "failure",
        status: "timeout",
        attemptNumber,
        tokenUsage,
        errorClass: "timeout",
        outputSummary: tailText(procResult.stdout || procResult.stderr, LOG_EXCERPT_CHARS),
        artifactPaths: [
          path.join(scoutDir, PLANNER_STDOUT_FILE),
          path.join(scoutDir, PLANNER_STDERR_FILE),
          launchHistory.promptArtifactPath,
        ],
        extra: { includeScoutArtifacts },
      });
      throw new Error(message);
    }

    if ((procResult.exitCode && procResult.exitCode !== 0) || procResult.signal) {
      const errMsg =
        procResult.stderr ||
        procResult.stdout ||
        (procResult.signal
          ? `Planning process terminated by ${procResult.signal}.`
          : "Planning process failed.");
      const errorKind = classifyScoutError(errMsg);
      writeAttemptBundle(scoutDir, {
        attemptNumber,
        backend,
        outcome: "crash",
        errorClassification: errorKind,
        logExcerpt: tailText(procResult.stdout, LOG_EXCERPT_CHARS),
        durationMs: procResult.durationMs,
        tokenUsage,
      });
      appendPlannerHistoryBestEffort({
        workingDir: plannerCwd,
        runId,
        phase: "planner",
        backend,
        event: "failure",
        status: "crash",
        attemptNumber,
        tokenUsage,
        errorClass: errorKind,
        outputSummary: tailText(errMsg, LOG_EXCERPT_CHARS),
        artifactPaths: [
          path.join(scoutDir, PLANNER_STDOUT_FILE),
          path.join(scoutDir, PLANNER_STDERR_FILE),
          launchHistory.promptArtifactPath,
        ],
        extra: { includeScoutArtifacts, exitCode: procResult.exitCode, signal: procResult.signal },
      });

      if (backend === "claude_code") {
        const degradedReason = detectAnthropicDegradedReason(errMsg);
        if (degradedReason) {
          plannerDegradedReason = degradedReason;
          plannerDegradedResetHint = extractResetHint(errMsg);
          if (
            shouldRetryTransientPlannerOverload({
              degradedReason,
              retryCount: claudeOverloadRetryCount,
            })
          ) {
            const delayMs = TRANSIENT_OVERLOAD_RETRY_DELAYS_MS[claudeOverloadRetryCount] ?? 0;
            claudeOverloadRetryCount += 1;
            await waitForTransientPlannerRetry({
              delayMs,
              abortSignal: params.abortSignal,
              context: "Planning",
            });
            appendPlannerHistoryBestEffort({
              workingDir: plannerCwd,
              runId,
              phase: "planner",
              backend,
              event: "retry",
              status: degradedReason,
              attemptNumber,
              errorClass: degradedReason,
              outputSummary: tailText(errMsg, LOG_EXCERPT_CHARS),
              extra: { includeScoutArtifacts, delayMs },
            });
            continue;
          }
          if (plannerBackends.slice(attemptIndex + 1).includes("codex")) {
            appendPlannerHistoryBestEffort({
              workingDir: plannerCwd,
              runId,
              phase: "planner",
              backend,
              event: "fallback",
              status: degradedReason,
              attemptNumber,
              errorClass: degradedReason,
              outputSummary: tailText(errMsg, LOG_EXCERPT_CHARS),
              extra: { includeScoutArtifacts, fallbackBackend: "codex" },
            });
            attemptIndex += 1;
            continue;
          }
          throw new Error(
            formatCodexFallbackDisabledError({
              context: "Planning",
              degradedReason,
              resetHint: plannerDegradedResetHint,
            }),
          );
        }
      }

      throw new Error(`Planning execution failed: ${errMsg}`);
    }

    if (backend === "claude_code") {
      plannerDegradedReason = undefined;
      plannerDegradedResetHint = undefined;
    }
    plannerBackendUsed = backend;
    break;
  }

  if (!procResult) {
    throw new Error("Planning process failed before producing output.");
  }
  const degradedMetadata =
    plannerDegradedReason && plannerBackendUsed
      ? {
          plannerBackendUsed,
          plannerDegradedReason,
          ...(plannerDegradedResetHint ? { plannerDegradedResetHint } : {}),
        }
      : {};

  if (includeScoutArtifacts && plannerBackendUsed === "codex" && codexScoutDir) {
    copyCodexScoutArtifacts({ sourceDir: codexScoutDir, targetDir: scoutDir });
  }
  if (includeScoutArtifacts && !cachedScoutData && agentVisibleScoutDir) {
    reconcileAgentVisibleScoutArtifacts({ sourceDir: agentVisibleScoutDir, targetDir: scoutDir });
  }

  let scoutData: Extract<ScoutResult, { status: "success" }> | undefined;
  let scoutStatus: CliPlanningResult["scoutStatus"] = "skipped";
  let scoutSkipReason: string | undefined;

  if (cachedScoutData) {
    scoutData = cachedScoutData;
    scoutStatus = "success";
  } else if (includeScoutArtifacts) {
    const scoutResult = validateScoutOutput(scoutDir);

    if (scoutResult.status === "error") {
      writeAttemptBundle(scoutDir, {
        attemptNumber: finalAttemptNumber,
        backend: plannerBackendUsed ?? defaultPlannerBackend,
        outcome: "failed",
        errorClassification: scoutResult.errorKind,
        resultFile: SCOUT_REPORT_FILE,
        logExcerpt: tailText(procResult.stdout, LOG_EXCERPT_CHARS),
        durationMs: procResult.durationMs,
        tokenUsage: parseBackendUsage(procResult.stdout),
      });
      appendPlannerHistoryBestEffort({
        workingDir: plannerCwd,
        runId,
        phase: "planner",
        backend: plannerBackendUsed ?? defaultPlannerBackend,
        event: "failure",
        status: "invalid_scout_artifacts",
        attemptNumber: finalAttemptNumber,
        tokenUsage: parseBackendUsage(procResult.stdout),
        errorClass: scoutResult.errorKind,
        outputSummary: scoutResult.error,
        artifactPaths: [SCOUT_REPORT_FILE],
      });
      throw new Error(`Planning scout artifacts invalid: ${scoutResult.error}`);
    }

    if (scoutResult.status === "needs_clarification") {
      writeAttemptBundle(scoutDir, {
        attemptNumber: finalAttemptNumber,
        backend: plannerBackendUsed ?? defaultPlannerBackend,
        outcome: "blocked",
        errorClassification: "needs_clarification",
        resultFile: SCOUT_NEEDS_CLARIFICATION_FILE,
        logExcerpt: tailText(procResult.stdout, LOG_EXCERPT_CHARS),
        durationMs: procResult.durationMs,
        tokenUsage: parseBackendUsage(procResult.stdout),
      });
      appendPlannerHistoryBestEffort({
        workingDir: plannerCwd,
        runId,
        phase: "planner",
        backend: plannerBackendUsed ?? defaultPlannerBackend,
        event: "result",
        status: "needs_clarification",
        attemptNumber: finalAttemptNumber,
        tokenUsage: parseBackendUsage(procResult.stdout),
        outputSummary: tailText(scoutResult.question, LOG_EXCERPT_CHARS),
        artifactPaths: [SCOUT_NEEDS_CLARIFICATION_FILE],
      });
      return {
        status: "blocked",
        question: scoutResult.question,
        scoutStatus: "needs_clarification",
        ...degradedMetadata,
      };
    }

    if (scoutResult.status === "skipped") {
      scoutStatus = "skipped";
      scoutSkipReason = scoutResult.reason;
    } else {
      scoutData = scoutResult;
      scoutStatus = "success";
    }
  } else {
    scoutStatus = "skipped";
    scoutSkipReason = "--no-scout flag";
  }

  let parsedPlan: PlanResult;
  try {
    parsedPlan = parsePlanWithFallback(goalText, scoutDir, procResult.stdout);
  } catch (err) {
    writeAttemptBundle(scoutDir, {
      attemptNumber: finalAttemptNumber,
      backend: plannerBackendUsed ?? defaultPlannerBackend,
      outcome: "failed",
      errorClassification: err instanceof PlanParseError ? "parse" : "validation",
      resultFile: fs.existsSync(path.join(scoutDir, EXECUTION_PLAN_FILE))
        ? EXECUTION_PLAN_FILE
        : PLANNER_STDOUT_FILE,
      logExcerpt: tailText(procResult.stdout, LOG_EXCERPT_CHARS),
      durationMs: procResult.durationMs,
      tokenUsage: parseBackendUsage(procResult.stdout),
    });
    appendPlannerHistoryBestEffort({
      workingDir: plannerCwd,
      runId,
      phase: "planner",
      backend: plannerBackendUsed ?? defaultPlannerBackend,
      event: "failure",
      status: "parse_failed",
      attemptNumber: finalAttemptNumber,
      tokenUsage: parseBackendUsage(procResult.stdout),
      errorClass: err instanceof PlanParseError ? "parse" : "validation",
      outputSummary: err instanceof Error ? err.message : String(err),
      artifactPaths: [
        fs.existsSync(path.join(scoutDir, EXECUTION_PLAN_FILE))
          ? EXECUTION_PLAN_FILE
          : PLANNER_STDOUT_FILE,
      ],
    });
    throw err;
  }

  if ("blocked" in parsedPlan) {
    writeAttemptBundle(scoutDir, {
      attemptNumber: finalAttemptNumber,
      backend: plannerBackendUsed ?? defaultPlannerBackend,
      outcome: "blocked",
      errorClassification: "needs_clarification",
      resultFile: fs.existsSync(path.join(scoutDir, EXECUTION_PLAN_FILE))
        ? EXECUTION_PLAN_FILE
        : PLANNER_STDOUT_FILE,
      logExcerpt: tailText(procResult.stdout, LOG_EXCERPT_CHARS),
      durationMs: procResult.durationMs,
      tokenUsage: parseBackendUsage(procResult.stdout),
    });
    appendPlannerHistoryBestEffort({
      workingDir: plannerCwd,
      runId,
      phase: "planner",
      backend: plannerBackendUsed ?? defaultPlannerBackend,
      event: "result",
      status: "blocked",
      attemptNumber: finalAttemptNumber,
      tokenUsage: parseBackendUsage(procResult.stdout),
      outputSummary: tailText(parsedPlan.question, LOG_EXCERPT_CHARS),
      artifactPaths: [
        fs.existsSync(path.join(scoutDir, EXECUTION_PLAN_FILE))
          ? EXECUTION_PLAN_FILE
          : PLANNER_STDOUT_FILE,
      ],
    });
    return {
      status: "blocked",
      question: parsedPlan.question,
      scoutStatus,
      ...(scoutSkipReason ? { scoutSkipReason } : {}),
      ...(scoutData ? { scoutData } : {}),
      ...degradedMetadata,
    };
  }

  const effectivePlan = plannerDegradedReason
    ? rewritePlanForDegradedPlanner(parsedPlan, params.enabledWorkers)
    : parsedPlan;
  writeCanonicalPlanArtifact(scoutDir, effectivePlan);

  writeAttemptBundle(scoutDir, {
    attemptNumber: finalAttemptNumber,
    backend: plannerBackendUsed ?? defaultPlannerBackend,
    outcome: "complete",
    resultFile: EXECUTION_PLAN_FILE,
    logExcerpt: tailText(procResult.stdout, LOG_EXCERPT_CHARS),
    durationMs: procResult.durationMs,
    tokenUsage: parseBackendUsage(procResult.stdout),
  });
  appendPlannerHistoryBestEffort({
    workingDir: plannerCwd,
    runId,
    phase: "planner",
    backend: plannerBackendUsed ?? defaultPlannerBackend,
    event: "result",
    status: "success",
    attemptNumber: finalAttemptNumber,
    tokenUsage: parseBackendUsage(procResult.stdout),
    outputSummary: tailText(effectivePlan.summary, LOG_EXCERPT_CHARS),
    artifactPaths: [EXECUTION_PLAN_FILE],
  });
  mirrorPlannerRuntimeBestEffort({ workingDir: plannerCwd, runId, goalsDir });

  return {
    status: "success",
    plan: effectivePlan,
    scoutStatus,
    ...(scoutSkipReason ? { scoutSkipReason } : {}),
    ...(scoutData ? { scoutData } : {}),
    ...degradedMetadata,
  };
}
