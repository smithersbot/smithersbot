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
import { buildAgentVisibleScoutDir, buildAgentVisibleWikiDir } from "./agent-visible-paths.js";
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
import { runWithBackendFallback, type PhaseAttempt } from "./phase-fallback.js";
import {
  PlanParseError,
  buildPlanRevisionSystemPrompt,
  buildPlanSystemPrompt,
  formatCompactScoutEdges,
  formatCompactScoutNodes,
  parsePlanResultFromText,
  type PlanResult,
} from "./planner.js";
import { shouldInjectDevGatewayGuidance } from "./dev-gateway-workspace.js";
import { resolveRunDir } from "./run-store.js";
import {
  classifyScoutError,
  renderScoutTemplate,
  resolveClaudeBinary,
  resolveScoutDir,
  resolveScoutTemplatePath,
  validateScoutOutput,
  SCOUT_NEEDS_DECISION_FILE,
  SCOUT_NODE_SPECS_DIR,
  SCOUT_PLAN_DRAFT_FILE,
  SCOUT_REPORT_FILE,
  type ScoutDecision,
  type ScoutResult,
} from "./scout.js";
import type { Plan, PlannerBackendId, PlannerDegradedReason } from "./types.js";
import type { ClaudeCodeAuthMode, CliWorkerId, GoalConfig } from "../config/types.goal.js";
import { redactSecretValues } from "../security/secret-paths.js";
import { PENDING_WORKSPACE_SLUG } from "./history-anchor.js";
import { mirrorGoalRuntimeToAgentHistory } from "./runtime-mirror.js";
import { extractCliTextAndSession } from "./cli-output-parsing.js";

const DEFAULT_PLANNING_TIMEOUT_MS = 7_200_000;
const LOG_EXCERPT_CHARS = 2048;
const TRANSIENT_OVERLOAD_RETRY_DELAYS_MS = [5_000, 10_000] as const;

// Canonical planning artifacts live under <run>/scout/ so execution + resume can
// rely on stable paths. Shared scout constants define scout_report/node_specs/etc.
const PLANNING_BRIEF_FILE = "PLANNING_BRIEF.md";
const PLANNER_STDOUT_FILE = "planning_stdout.txt";
const PLANNER_STDERR_FILE = "planning_stderr.txt";
const PLANNER_RAW_OUTPUT_FILE = "planning_raw_output.txt";
export const GOAL_BRIEF_FILE = "goal-brief.md";
const GOAL_BRIEF_REPAIR_STDOUT_FILE = "goal_brief_repair_stdout.txt";
const GOAL_BRIEF_REPAIR_STDERR_FILE = "goal_brief_repair_stderr.txt";
export const EXECUTION_PLAN_FILE = "execution_plan.json";

export const CLAUDE_ALLOWED_TOOLS = "Read,Glob,Grep,Bash";
const ANTHROPIC_USAGE_LIMIT_RE =
  /(?:you(?:'|’)?ve|you have)\s+hit\s+your\s+(?:chatgpt\s+)?(?:usage\s+)?limit|usage\s+limit|resets?\s+\d/i;

function buildPlanAndScoutAppendix(enabledWorkers: CliWorkerId[]): string {
  const backendUnion = enabledWorkers
    .filter((worker) => worker === "codex" || worker === "claude_code")
    .map((worker) => `"${worker}"`)
    .join(" | ");
  return `## Canonical Goal Brief and Execution Plan Output

After scout files and a passed Needs Decision Gate, write the Goal Brief as {{WIKI_DIR}}/${GOAL_BRIEF_FILE}. Then read/use that Goal Brief, write the execution plan as {{OUTPUT_DIR}}/${EXECUTION_PLAN_FILE}, and print that same JSON object as final stdout.

Requirements:
- Do not create ${GOAL_BRIEF_FILE} or ${EXECUTION_PLAN_FILE} when a Needs Decision is required.
- ${GOAL_BRIEF_FILE} is required before plan approval and must be compact downstream context for workers and reporters.
- Match the stable planning schema above, including DAG dependencies, success criteria, constraints, and backend: ${backendUnion}.
- Keep dependency structure aligned with ${SCOUT_REPORT_FILE}.
- Step ids must map to scout node ids, except bootstrap id "create-conventions".
- If a Needs Decision is required, create ${SCOUT_NEEDS_DECISION_FILE} and do not create ${EXECUTION_PLAN_FILE}.
- ${SCOUT_NEEDS_DECISION_FILE} is authoritative for decision structure. Stdout may return only a concise transport summary:
  { "blocked": true, "question": "Decision needed: concise summary of the pending decision(s)" }`;
}

// Re-export the agent-visible path builders from their shared module so existing
// importers (cli-worker, tests) keep resolving them from cli-planner, while
// planner.ts can depend on the same builders without a cli-planner cycle.
export { buildAgentVisibleScoutDir, buildAgentVisibleWikiDir };

function buildPlanOnlyPrompt(params: {
  goalText: string;
  cwd: string;
  enabledWorkers: CliWorkerId[];
  goalConfig?: GoalConfig;
}): string {
  return `${buildPlanSystemPrompt(params.enabledWorkers, {
    devGatewayVerification: shouldInjectDevGatewayGuidance(params.cwd, params.goalConfig),
  })}

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
  historyWorkspaceSlug?: string;
}): string {
  const { runId, cwd, scoutDir, scoutData } = params;
  void scoutDir;
  const workspaceSlug = params.historyWorkspaceSlug ?? workspaceNameFromWorkingDir(cwd);
  const runtimeMirrorBase = buildAgentVisibleScoutDir(runId, workspaceSlug);
  const wikiDir = buildAgentVisibleWikiDir(runId, workspaceSlug);
  const nodes = formatCompactScoutNodes(scoutData.report);
  const edges = formatCompactScoutEdges(scoutData.report);

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
    `- Goal Brief: ${wikiDir}/${GOAL_BRIEF_FILE}`,
    "",
    "Prior-version lineage (follow for history):",
    `- Prior ScoutReport: ${runtimeMirrorBase}/${SCOUT_REPORT_FILE}`,
    `- Prior Goal Brief: ${wikiDir}/${GOAL_BRIEF_FILE}`,
    "- What changed since the prior scout: before reusing this context, note what changed since the prior scout (new user input, completed/failed work, or revised intent) and reconcile this plan against that delta rather than assuming the prior scout still holds.",
    "- Terms: see GLOSSARY.md.",
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
  /** Merged goal config used for prompt guidance/policy gates. */
  goalConfig?: GoalConfig;
  /** Preserve legacy --no-scout semantics by skipping scout artifact generation. */
  includeScoutArtifacts?: boolean;
  /** Reuse successful scout artifacts loaded from an earlier planning attempt. */
  scoutData?: Extract<ScoutResult, { status: "success" }>;
  /** Stored goal-history workspace anchor for prompt/event history. */
  historyWorkspaceSlug?: string;
  /** Optional cancellation signal for planner process and transient-overload backoff. */
  abortSignal?: AbortSignal;
};

export type CliPlanningSuccess = {
  status: "success";
  plan: Plan;
  goalBriefPath?: string;
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
  decisions?: ScoutDecision[];
  scoutStatus: "needs_decision" | "success" | "skipped";
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
  userEditInstructions?: string[];
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
  /** Merged goal config used for prompt guidance/policy gates. */
  goalConfig?: GoalConfig;
  /** Stored goal-history workspace anchor for prompt/event history. */
  historyWorkspaceSlug?: string;
  /** Optional cancellation signal for revision process and transient-overload backoff. */
  abortSignal?: AbortSignal;
};

export type CliPlanRevisionResult = {
  plan: PlanResult;
  plannerBackendUsed?: PlannerBackendId;
  plannerDegradedReason?: PlannerDegradedReason;
  plannerDegradedResetHint?: string;
};

export type CliContinuationPlanningParams = Omit<CliPlanningParams, "goalText"> & {
  originalGoalText: string;
  proposedPrompt: string;
  currentPlanNumber: number;
  goalBriefPath?: string;
};

export type CliContinuationPlanningResult = CliPlanningResult;

const PLAN_REVISION_DIR = "replan";
const PLAN_REVISION_STDOUT_FILE = "revision_stdout.txt";
const PLAN_REVISION_STDERR_FILE = "revision_stderr.txt";
const PLAN_REVISION_RAW_OUTPUT_FILE = "revision_raw_output.txt";
const PLAN_REVISION_PROMPT_FILE_RE = /^revision_prompt_r(\d+)\.txt$/;

export function buildContinuationPlanGoalText(params: {
  originalGoalText: string;
  proposedPrompt: string;
  currentPlanNumber: number;
  goalBriefPath?: string;
}): string {
  const nextPlanNumber = params.currentPlanNumber + 1;
  const sources = params.goalBriefPath
    ? [
        "",
        "Sources:",
        `- Updated Goal Brief with prior completed-plan background: ${params.goalBriefPath}`,
      ]
    : [];
  return [
    `Create Plan ${nextPlanNumber} under the same Goal ID from the approved continuation prompt below.`,
    "",
    "Original whole-goal ask:",
    params.originalGoalText,
    "",
    "Approved continuation prompt (primary planning instruction):",
    params.proposedPrompt,
    "",
    "Planning requirements:",
    "- Treat the approved continuation prompt as the source of truth for this next plan's Plan Summary and task list.",
    "- Use prior completed-plan information only as completed background from the linked Goal Brief source; do not recreate completed prior-plan work.",
    "- Keep the whole-goal Goal Summary stable in the Goal Brief; this plan should describe only the approved next-plan work.",
    ...sources,
  ].join("\n");
}

export async function runCliPlanForContinuation(
  params: CliContinuationPlanningParams,
): Promise<CliContinuationPlanningResult> {
  return runCliPlanning({
    ...params,
    goalText: buildContinuationPlanGoalText({
      originalGoalText: params.originalGoalText,
      proposedPrompt: params.proposedPrompt,
      currentPlanNumber: params.currentPlanNumber,
      ...(params.goalBriefPath ? { goalBriefPath: params.goalBriefPath } : {}),
    }),
  });
}

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
  historyWorkspaceSlug?: string;
}): void {
  const workspaceName =
    params.historyWorkspaceSlug ??
    (params.phase === "planner"
      ? PENDING_WORKSPACE_SLUG
      : workspaceNameFromWorkingDir(params.workingDir));
  appendAgentHistoryEventBestEffort(
    {
      kind: "goal",
      workspaceName,
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
  historyWorkspaceSlug?: string;
}): void {
  const scope = {
    kind: "goal" as const,
    workspaceName: params.historyWorkspaceSlug ?? workspaceNameFromWorkingDir(params.workingDir),
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
    SCOUT_NEEDS_DECISION_FILE,
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

export function buildPlanningPrompt(params: {
  runId: string;
  goalText: string;
  cwd: string;
  scoutDir: string;
  includeScoutArtifacts: boolean;
  enabledWorkers: CliWorkerId[];
  goalConfig?: GoalConfig;
  scoutData?: Extract<ScoutResult, { status: "success" }>;
  historyWorkspaceSlug?: string;
}): string {
  const { runId, goalText, cwd, scoutDir, includeScoutArtifacts, enabledWorkers, scoutData } =
    params;
  const historyWorkspaceSlug = params.historyWorkspaceSlug ?? PENDING_WORKSPACE_SLUG;
  const devGatewayVerification = shouldInjectDevGatewayGuidance(cwd, params.goalConfig);
  const agentVisibleWikiDir = buildAgentVisibleWikiDir(runId, historyWorkspaceSlug);
  if (!includeScoutArtifacts) {
    return buildPlanOnlyPrompt({
      goalText,
      cwd,
      enabledWorkers,
      ...(params.goalConfig ? { goalConfig: params.goalConfig } : {}),
    });
  }

  if (scoutData) {
    const agentVisibleScoutDir = buildAgentVisibleScoutDir(runId, historyWorkspaceSlug);
    return [
      buildPlanSystemPrompt(enabledWorkers, { devGatewayVerification }),
      "",
      "## Replan With Cached Scout Context",
      "",
      `Goal: ${goalText}`,
      `Current workspace path: ${cwd}`,
      "",
      buildCachedScoutSummary({ runId, cwd, scoutDir, scoutData, historyWorkspaceSlug }),
      "",
      "## Replan Instructions",
      "- Consume the cached scout facts and artifact references above.",
      "- Do not rerun the Scout Phase or recreate scout artifacts during normal /goal_resume --replan.",
      `- Read the existing Goal Brief at ${agentVisibleWikiDir}/${GOAL_BRIEF_FILE} if it exists.`,
      `- If the Goal Brief is stale or missing, create/update ${agentVisibleWikiDir}/${GOAL_BRIEF_FILE} before approval.`,
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
  const agentVisibleScoutDir = buildAgentVisibleScoutDir(runId, historyWorkspaceSlug);
  const scoutBrief = renderScoutTemplate({
    template,
    goalId: runId,
    goalText,
    outputDir: agentVisibleScoutDir,
    wikiDir: agentVisibleWikiDir,
  });

  return [
    buildPlanSystemPrompt(enabledWorkers, { devGatewayVerification }),
    "",
    "## Conceptual Planning Phases",
    "",
    "### Scout Phase",
    "- Inspect the repository and project convention files from the workspace.",
    "- Emit compact scout facts/artifacts: plan draft, scout report JSON, and node specs.",
    "- Do not include giant raw dumps; summarize relevant evidence and cite files/functions.",
    "- Agent-visible runtime history is under <managed-root>/agent/history/goals/<workspace>/<goalId>/runtime/.",
    "",
    "### Needs Decision Gate",
    "- After codebase exploration, explicitly judge whether the first Plan toward the Goal can be Specific, Measurable, and Attainable.",
    "- A Goal is the full user-requested outcome, even if it is broad, real-world, long-running, or not fully observable by SmithersBot; do not shrink it to only what SmithersBot can finish on a computer.",
    "- A Plan is bounded work SmithersBot can do now toward that Goal, stopping at an Observation Point.",
    "- SmithersBot can do computer-based work, including software, research, writing, analysis, automation, repo work, workflow automation, structured planning, and other work that can be done on a computer.",
    "- Specific means the exact first-Plan object, scope, constraints, and success boundary are clear enough for a worker to act without guessing.",
    "- Measurable means first-Plan success can be judged from observable evidence, artifacts, outputs, and a clear Observation Point.",
    "- Attainable means the first Plan can realistically be completed with available tools, permissions, context, time, and observation ability.",
    `- If a materially scope-changing user decision is still required to choose or scope the first Plan and the codebase cannot answer it, write ${agentVisibleScoutDir}/${SCOUT_NEEDS_DECISION_FILE} and stop before goal-brief.md or ${EXECUTION_PLAN_FILE}.`,
    "- The gate may ask what the first Plan should do when that is ambiguous, but must not declare the Goal invalid merely because the final outcome depends on time, market response, human action, external feedback, or real-world events.",
    "- If the codebase can answer the question, answer it in the scout artifacts instead of asking the user.",
    "",
    "### Goal Brief Phase",
    `- Run this phase only after the Needs Decision Gate determines no user decision is needed.`,
    `- Create ${agentVisibleWikiDir}/${GOAL_BRIEF_FILE} before writing ${EXECUTION_PLAN_FILE}.`,
    "- Include: Goal Summary (max 140 characters), Long Goal Summary, Original User Ask, Key Decision summaries, First Plan Intent, Remaining Work, Observation Point, Manual Tests, and Sources.",
    "- If no key decisions exist, Key Decision summaries must say: None yet.",
    "- Goal Summary is WHOLE-GOAL scoped and persists across all later plans; do not summarize only the first Plan or current Plan there.",
    "- Plan Summary / First Plan Intent are plan-scoped: use them for the bounded first Plan only.",
    "- The Goal Brief must separate the full Goal from the First Plan Intent and Observation Point: preserve the full Goal in Original User Ask and Long Goal Summary, describe only the bounded first Plan in First Plan Intent, and state where that Plan stops in Observation Point.",
    "- First Plan Intent must state what the first Plan should do toward the full Goal, what it intentionally leaves until later, and where it should stop.",
    "",
    "### Planner Phase",
    "- Consume the scout facts/artifacts from the Scout Phase.",
    `- Read and use ${agentVisibleWikiDir}/${GOAL_BRIEF_FILE} before emitting ${EXECUTION_PLAN_FILE}.`,
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
    buildPlanAndScoutAppendix(enabledWorkers)
      .replaceAll("{{OUTPUT_DIR}}", agentVisibleScoutDir)
      .replaceAll("{{WIKI_DIR}}", agentVisibleWikiDir),
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
    SCOUT_NEEDS_DECISION_FILE,
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
    SCOUT_NEEDS_DECISION_FILE,
    EXECUTION_PLAN_FILE,
    PLANNER_RAW_OUTPUT_FILE,
  ];
  for (const artifact of staleSingleFileArtifacts) {
    fs.rmSync(path.join(scoutDir, artifact), { force: true });
  }
}

function clearStaleGoalBriefArtifacts(wikiDir: string): void {
  fs.rmSync(path.join(wikiDir, GOAL_BRIEF_FILE), { force: true });
}

function hasUsableGoalBrief(wikiDir: string): boolean {
  try {
    return fs.readFileSync(path.join(wikiDir, GOAL_BRIEF_FILE), "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

function formatNeedsDecisionQuestion(decisions: readonly ScoutDecision[]): string {
  const lines = ["Decision(s) needed:"];
  decisions.forEach((decision, index) => {
    lines.push(`Decision ${index + 1}. ${decision.question}`);
    for (const option of decision.options) {
      lines.push(
        `(${option.key}) ${option.label}${option.recommended === true ? " (Recommended)" : ""}`,
      );
    }
  });
  return lines.join("\n");
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
      requiresDevGatewayControl: step.requiresDevGatewayControl,
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

function parsePlanWithFallbackWithSource(
  goalText: string,
  scoutDir: string,
  stdout: string,
): { plan: PlanResult; source: "file" | "stdout" } {
  const planPath = path.join(scoutDir, EXECUTION_PLAN_FILE);
  const fileText = fs.existsSync(planPath) ? fs.readFileSync(planPath, "utf8") : "";
  const stdoutText = extractCliTextAndSession(stdout).text || stdout;

  if (fileText.trim().length > 0) {
    try {
      return { plan: parsePlanResultFromText(fileText, goalText), source: "file" };
    } catch (err) {
      // Some runs may write a valid JSON plan only to stdout.
      if (stdoutText.trim().length > 0) {
        return { plan: parsePlanResultFromText(stdoutText, goalText), source: "stdout" };
      }
      throw err;
    }
  }

  return { plan: parsePlanResultFromText(stdoutText, goalText), source: "stdout" };
}

function listDirectoryForDiagnostics(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .sort();
  } catch (error) {
    return [`<unable to list: ${error instanceof Error ? error.message : String(error)}>`];
  }
}

function fileInfoForDiagnostics(filePath: string): { exists: boolean; size?: number } {
  try {
    const stat = fs.statSync(filePath);
    return { exists: true, size: stat.size };
  } catch {
    return { exists: false };
  }
}

function readTextPreviewForDiagnostics(filePath: string, maxChars = 1000): string {
  try {
    if (!fs.existsSync(filePath)) return "";
    return tailText(fs.readFileSync(filePath, "utf8"), maxChars);
  } catch (error) {
    return `<unable to read: ${error instanceof Error ? error.message : String(error)}>`;
  }
}

function buildScoutDiagnostic(scoutDir: string): {
  scoutDir: string;
  directoryListing: string[];
  executionPlan: { exists: boolean; size?: number };
  planningStdout: { exists: boolean; size?: number; preview: string };
} {
  const absoluteScoutDir = path.resolve(scoutDir);
  const stdoutPath = path.join(scoutDir, PLANNER_STDOUT_FILE);
  return {
    scoutDir: absoluteScoutDir,
    directoryListing: listDirectoryForDiagnostics(scoutDir),
    executionPlan: fileInfoForDiagnostics(path.join(scoutDir, EXECUTION_PLAN_FILE)),
    planningStdout: {
      ...fileInfoForDiagnostics(stdoutPath),
      preview: readTextPreviewForDiagnostics(stdoutPath),
    },
  };
}

function readTextArtifactForPrompt(filePath: string, maxChars: number): string {
  try {
    if (!fs.existsSync(filePath)) return "<missing>";
    const text = fs.readFileSync(filePath, "utf8");
    return truncateForPrompt(text, maxChars);
  } catch (error) {
    return `<unable to read: ${error instanceof Error ? error.message : String(error)}>`;
  }
}

function buildGoalBriefRepairPrompt(params: {
  runId: string;
  goalText: string;
  cwd: string;
  scoutDir: string;
  wikiDir: string;
  plan: Plan;
  originalPlanningPrompt: string;
}): string {
  const { runId, goalText, cwd, scoutDir, wikiDir, plan, originalPlanningPrompt } = params;
  return [
    "You are repairing a missing required Goal Brief for an already-created execution plan.",
    "",
    "Create exactly this markdown file and do not modify repository source files:",
    `${path.join(wikiDir, GOAL_BRIEF_FILE)}`,
    "",
    "The execution plan already exists. Do not rewrite it unless needed to read context. Do not create goal-brief.json or any other JSON duplicate.",
    "Use the same Goal-vs-Plan framing as planning: a Goal is the full user-requested outcome, even if it is broad, real-world, long-running, or not fully observable by SmithersBot; do not shrink it to only what SmithersBot can finish on a computer.",
    "A Plan is bounded work SmithersBot can do now toward that Goal, stopping at an Observation Point.",
    "SmithersBot can do computer-based work, including software, research, writing, analysis, automation, repo work, workflow automation, structured planning, and other work that can be done on a computer.",
    "Do not declare the Goal invalid merely because the final outcome depends on time, market response, human action, external feedback, or real-world events.",
    "",
    "Required Goal Brief headings:",
    "- Goal Summary (max 140 characters)",
    "- Long Goal Summary",
    "- Original User Ask",
    "- Key Decision summaries",
    "- First Plan Intent",
    "- Remaining Work",
    "- Observation Point",
    "- Manual Tests",
    "- Sources",
    "",
    "Key Decision summaries must be 1-3 sentences covering context, what was decided, and why. If no key decisions exist, write exactly: None yet.",
    "Goal Summary is WHOLE-GOAL scoped and persists across all later plans; do not summarize only the first Plan or current Plan there.",
    "Plan Summary / First Plan Intent are plan-scoped: use them for the bounded first Plan only.",
    "The Goal Brief must separate the full Goal from the First Plan Intent and Observation Point: preserve the full Goal in Original User Ask and Long Goal Summary, describe only the bounded first Plan in First Plan Intent, and state where that Plan stops in Observation Point.",
    "First Plan Intent must explain what the first Plan should do toward the full Goal, what it intentionally leaves until later, and where it should stop.",
    "Observation Point means something critical the agent cannot observe on its own because of time, inability, permissions, environment, or user/operator-only observation.",
    "",
    `GOAL_ID: ${runId}`,
    `Original user ask: ${goalText}`,
    `Current workspace path: ${cwd}`,
    "",
    "Execution plan JSON:",
    JSON.stringify(
      {
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
          requiresDevGatewayControl: step.requiresDevGatewayControl,
        })),
      },
      null,
      2,
    ),
    "",
    "Scout plan draft:",
    readTextArtifactForPrompt(path.join(scoutDir, SCOUT_PLAN_DRAFT_FILE), 6_000),
    "",
    "Scout report:",
    readTextArtifactForPrompt(path.join(scoutDir, SCOUT_REPORT_FILE), 4_000),
    "",
    "Original planning prompt excerpt:",
    truncateForPrompt(originalPlanningPrompt, 6_000),
    "",
    `Write ${path.join(wikiDir, GOAL_BRIEF_FILE)} now. Respond with a concise confirmation only.`,
  ].join("\n");
}

async function repairMissingGoalBrief(params: {
  runId: string;
  goalText: string;
  cwd: string;
  historyWorkspaceSlug?: string;
  scoutDir: string;
  wikiDir: string;
  plan: Plan;
  originalPlanningPrompt: string;
  plannerBackends: PlannerBackendId[];
  preferredBackend: PlannerBackendId;
  claudeCommand: string;
  claudeSandbox: ClaudeCodeLaunchSandboxConfig;
  codexSandbox?: CodexNativeSandboxConfig;
  planningEnv: Record<string, string | undefined>;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<{ backend: PlannerBackendId; recoveryMessage?: string }> {
  if (hasUsableGoalBrief(params.wikiDir)) {
    return { backend: params.preferredBackend };
  }

  fs.mkdirSync(params.wikiDir, { recursive: true });
  const repairPrompt = buildGoalBriefRepairPrompt(params);
  const repairBackends = [
    params.preferredBackend,
    ...params.plannerBackends.filter((backend) => backend !== params.preferredBackend),
  ];

  const result = await runWithBackendFallback<string>({
    backends: repairBackends,
    fallbackOnAnyError: true,
    attempt: async (backend): Promise<PhaseAttempt<string>> => {
      if (backend === "codex" && !params.codexSandbox) {
        return { ok: false, errorText: "Codex repair backend is unavailable." };
      }

      const command = backend === "claude_code" ? params.claudeCommand : "codex";
      const args =
        backend === "claude_code"
          ? buildClaudePlanningArgs({ sandboxConfig: params.claudeSandbox })
          : buildCodexPlanningArgs({
              prompt: repairPrompt,
              sandboxConfig: params.codexSandbox!,
            });

      appendPlannerHistoryBestEffort({
        workingDir: params.cwd,
        runId: params.runId,
        ...(params.historyWorkspaceSlug
          ? { historyWorkspaceSlug: params.historyWorkspaceSlug }
          : {}),
        phase: "planner",
        backend,
        event: "goal_brief_repair_launch",
        status: "launching",
        artifactPaths: [path.join(params.wikiDir, GOAL_BRIEF_FILE)],
      });

      const procResult = await runCliProcess({
        command,
        args,
        cwd: params.cwd,
        timeoutMs: params.timeoutMs,
        claudeDriverSite: "cli-planner",
        ...(backend === "claude_code" ? { stdin: repairPrompt } : {}),
        stdoutPath: path.join(params.scoutDir, GOAL_BRIEF_REPAIR_STDOUT_FILE),
        stderrPath: path.join(params.scoutDir, GOAL_BRIEF_REPAIR_STDERR_FILE),
        abortSignal: params.abortSignal,
        env:
          backend === "claude_code"
            ? params.planningEnv
            : mergeCodexNativeSandboxEnv(
                buildCredentialStrippedEnv(process.env, { stripAuthKeys: true }),
                params.codexSandbox!,
              ),
      });
      redactTextArtifactIfExists(path.join(params.scoutDir, GOAL_BRIEF_REPAIR_STDOUT_FILE));
      redactTextArtifactIfExists(path.join(params.scoutDir, GOAL_BRIEF_REPAIR_STDERR_FILE));

      if (procResult.timedOut) {
        return {
          ok: false,
          errorText: `Goal Brief repair timed out after ${(params.timeoutMs / 60_000).toFixed(
            0,
          )} minutes.`,
        };
      }

      if ((procResult.exitCode && procResult.exitCode !== 0) || procResult.signal) {
        return {
          ok: false,
          errorText:
            procResult.stderr ||
            procResult.stdout ||
            (procResult.signal
              ? `Goal Brief repair process terminated by ${procResult.signal}.`
              : "Goal Brief repair process failed."),
        };
      }

      if (!hasUsableGoalBrief(params.wikiDir)) {
        return {
          ok: false,
          errorText: `Goal Brief repair completed but did not create ${path.join(
            params.wikiDir,
            GOAL_BRIEF_FILE,
          )}.`,
        };
      }

      return { ok: true, value: path.join(params.wikiDir, GOAL_BRIEF_FILE) };
    },
  });

  if (result.status === "success") {
    appendPlannerHistoryBestEffort({
      workingDir: params.cwd,
      runId: params.runId,
      ...(params.historyWorkspaceSlug ? { historyWorkspaceSlug: params.historyWorkspaceSlug } : {}),
      phase: "planner",
      backend: result.backend as PlannerBackendId,
      event: "goal_brief_repair_result",
      status: "success",
      artifactPaths: [path.join(params.wikiDir, GOAL_BRIEF_FILE)],
      ...(result.recoveryMessage ? { extra: { recoveryMessage: result.recoveryMessage } } : {}),
    });
    return {
      backend: result.backend as PlannerBackendId,
      ...(result.recoveryMessage ? { recoveryMessage: result.recoveryMessage } : {}),
    };
  }

  appendPlannerHistoryBestEffort({
    workingDir: params.cwd,
    runId: params.runId,
    ...(params.historyWorkspaceSlug ? { historyWorkspaceSlug: params.historyWorkspaceSlug } : {}),
    phase: "planner",
    backend: params.preferredBackend,
    event: "goal_brief_repair_result",
    status: "failed",
    outputSummary: result.message,
    artifactPaths: [path.join(params.wikiDir, GOAL_BRIEF_FILE)],
  });
  throw new Error(
    [
      `Planning produced ${EXECUTION_PLAN_FILE} but did not create required Goal Brief at ${path.join(
        params.wikiDir,
        GOAL_BRIEF_FILE,
      )}.`,
      `Goal Brief repair failed: ${result.message}`,
    ].join(" "),
  );
}

function formatInvalidScoutDiagnostic(params: {
  scoutDir: string;
  validationError: string;
}): string {
  const diagnostic = buildScoutDiagnostic(params.scoutDir);
  const executionPlanSize =
    diagnostic.executionPlan.size === undefined ? "n/a" : `${diagnostic.executionPlan.size} bytes`;
  const planningStdoutSize =
    diagnostic.planningStdout.size === undefined
      ? "n/a"
      : `${diagnostic.planningStdout.size} bytes`;
  return [
    `Planning scout artifacts invalid: ${params.validationError}`,
    `scoutDir: ${diagnostic.scoutDir}`,
    `directory listing: ${diagnostic.directoryListing.join(", ") || "<empty>"}`,
    `execution_plan.json: exists=${diagnostic.executionPlan.exists} size=${executionPlanSize}`,
    `planning_stdout.txt: exists=${diagnostic.planningStdout.exists} size=${planningStdoutSize}`,
    `planning_stdout.txt preview: ${diagnostic.planningStdout.preview || "<empty>"}`,
    `scout validation error: ${params.validationError}`,
  ].join("\n");
}

function scoutArtifactAdvisoryEventName(validationError: string): string {
  return /\bnot found\b|\bdirectory not found\b|\bcontains no\b/i.test(validationError)
    ? "scout_artifacts_missing"
    : "scout_artifacts_invalid";
}

export function buildPlanRevisionPrompt(params: {
  goalText: string;
  currentPlan: Plan;
  cwd: string;
  editInstructions: string;
  userEditInstructions?: string[];
  priorFeedback?: string[];
  enabledWorkers: CliWorkerId[];
  goalConfig?: GoalConfig;
}): string {
  const {
    goalText,
    currentPlan,
    cwd,
    editInstructions,
    userEditInstructions,
    priorFeedback,
    enabledWorkers,
  } = params;
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
        requiresDevGatewayControl: step.requiresDevGatewayControl,
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
  const scopedUserEdits = [
    ...new Set((userEditInstructions ?? []).map((item) => item.trim()).filter(Boolean)),
  ];
  const userEditInstructionsSection =
    scopedUserEdits.length > 0
      ? [
          "User-requested changes (authoritative for this revision):",
          ...scopedUserEdits.map((instruction, index) => `${index + 1}. ${instruction}`),
          "",
        ]
      : [];

  return [
    buildPlanRevisionSystemPrompt(enabledWorkers, {
      devGatewayVerification: shouldInjectDevGatewayGuidance(cwd, params.goalConfig),
    }),
    "",
    `Goal: ${goalText}`,
    `Current workspace path: ${cwd}`,
    "",
    "Current plan:",
    currentPlanJson,
    "",
    ...priorChecklistSection,
    ...userEditInstructionsSection,
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
  const historyWorkspaceSlug =
    params.historyWorkspaceSlug ?? workspaceNameFromWorkingDir(plannerCwd);

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
    userEditInstructions: params.userEditInstructions,
    priorFeedback,
    enabledWorkers: plannerBackends,
    ...(params.goalConfig ? { goalConfig: params.goalConfig } : {}),
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
        workspaceName: historyWorkspaceSlug,
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
      claudeDriverSite: "cli-planner",
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
        historyWorkspaceSlug,
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
        historyWorkspaceSlug,
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
              historyWorkspaceSlug,
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
              historyWorkspaceSlug,
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
    parsedPlan = parsePlanResultFromText(
      extractCliTextAndSession(procResult.stdout).text || procResult.stdout,
      goalText,
    );
  } catch (err) {
    appendPlannerHistoryBestEffort({
      workingDir: plannerCwd,
      runId,
      historyWorkspaceSlug,
      phase: "plan-revision",
      backend: plannerBackendUsed ?? plannerBackends[0] ?? "claude_code",
      event: "failure",
      status: "parse_failed",
      tokenUsage: parseBackendUsage(procResult.stdout),
      errorClass: err instanceof PlanParseError ? "parse" : "validation",
      outputSummary: err instanceof Error ? err.message : "Unknown planning error",
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
    historyWorkspaceSlug,
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
  const historyWorkspaceSlug = params.historyWorkspaceSlug ?? PENDING_WORKSPACE_SLUG;

  const plannerBackends = resolvePlannerBackends(params.enabledWorkers);
  const claudeBin = plannerBackends.includes("claude_code") ? resolveClaudeBinary() : undefined;
  const claudeCommand = claudeBin ?? "claude";

  const scoutDir = resolveScoutDir(runId, goalsDir);
  const agentVisibleScoutDir =
    includeScoutArtifacts && !cachedScoutData
      ? buildAgentVisibleScoutDir(runId, historyWorkspaceSlug)
      : undefined;
  const agentVisibleWikiDir = includeScoutArtifacts
    ? buildAgentVisibleWikiDir(runId, historyWorkspaceSlug)
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
  if (agentVisibleWikiDir) {
    fs.mkdirSync(agentVisibleWikiDir, { recursive: true });
    if (!cachedScoutData) {
      clearStaleGoalBriefArtifacts(agentVisibleWikiDir);
    }
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
    historyWorkspaceSlug,
    ...(params.goalConfig ? { goalConfig: params.goalConfig } : {}),
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
          historyWorkspaceSlug,
          ...(params.goalConfig ? { goalConfig: params.goalConfig } : {}),
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
      ...(agentVisibleWikiDir ? [agentVisibleWikiDir] : []),
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
          ...(agentVisibleWikiDir ? [agentVisibleWikiDir] : []),
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
    if (cachedScoutData) {
      clearStaleReplanArtifacts(scoutDir);
    } else {
      clearStalePlanningArtifacts(scoutDir);
      if (includeScoutArtifacts) {
        fs.mkdirSync(path.join(scoutDir, SCOUT_NODE_SPECS_DIR), { recursive: true });
      }
    }
    if (agentVisibleScoutDir) {
      clearStalePlanningArtifacts(agentVisibleScoutDir);
      fs.mkdirSync(path.join(agentVisibleScoutDir, SCOUT_NODE_SPECS_DIR), { recursive: true });
    }
    if (agentVisibleWikiDir) {
      fs.mkdirSync(agentVisibleWikiDir, { recursive: true });
      if (!cachedScoutData) {
        clearStaleGoalBriefArtifacts(agentVisibleWikiDir);
      }
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
        workspaceName: historyWorkspaceSlug,
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
      claudeDriverSite: "cli-planner",
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
        historyWorkspaceSlug,
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
        historyWorkspaceSlug,
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
              historyWorkspaceSlug,
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
              historyWorkspaceSlug,
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

      const fallbackBackend = plannerBackends[attemptIndex + 1];
      if (fallbackBackend) {
        appendPlannerHistoryBestEffort({
          workingDir: plannerCwd,
          runId,
          phase: "planner",
          backend,
          event: "fallback",
          status: "crash",
          attemptNumber,
          errorClass: errorKind,
          outputSummary: tailText(errMsg, LOG_EXCERPT_CHARS),
          extra: { includeScoutArtifacts, fallbackBackend },
          historyWorkspaceSlug,
        });
        attemptIndex += 1;
        continue;
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
  // Capture the narrowed (non-undefined) process result so closures below can
  // reference it without TypeScript widening it back to `... | undefined`.
  const planningProc = procResult;
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
  let parsedPlan: PlanResult | undefined;
  let parsedPlanSource: "file" | "stdout" | undefined;
  let planParseError: unknown;

  try {
    const parsed = parsePlanWithFallbackWithSource(goalText, scoutDir, procResult.stdout);
    parsedPlan = parsed.plan;
    parsedPlanSource = parsed.source;
  } catch (err) {
    planParseError = err;
  }
  const hasUsableExecutionPlan = parsedPlan !== undefined && !("blocked" in parsedPlan);

  // Emit a blocked Needs Decision planning result. Reads scoutStatus/
  // scoutSkipReason/scoutData at call time so it works both before and after
  // scout validation has run.
  const emitBlockedPlanningResult = (
    blockedPlan: { blocked: true; question: string; decisions?: ScoutDecision[] },
    backend: PlannerBackendId,
  ): CliPlanningResult => {
    const resultFile = fs.existsSync(path.join(scoutDir, EXECUTION_PLAN_FILE))
      ? EXECUTION_PLAN_FILE
      : PLANNER_STDOUT_FILE;
    writeAttemptBundle(scoutDir, {
      attemptNumber: finalAttemptNumber,
      backend,
      outcome: "blocked",
      errorClassification: "needs_decision",
      resultFile,
      logExcerpt: tailText(planningProc.stdout, LOG_EXCERPT_CHARS),
      durationMs: planningProc.durationMs,
      tokenUsage: parseBackendUsage(planningProc.stdout),
    });
    appendPlannerHistoryBestEffort({
      workingDir: plannerCwd,
      runId,
      phase: "planner",
      backend,
      event: "result",
      status: "blocked",
      attemptNumber: finalAttemptNumber,
      tokenUsage: parseBackendUsage(planningProc.stdout),
      outputSummary: tailText(blockedPlan.question, LOG_EXCERPT_CHARS),
      artifactPaths: [resultFile],
      historyWorkspaceSlug,
    });
    return {
      status: "blocked",
      question: blockedPlan.question,
      ...(blockedPlan.decisions ? { decisions: blockedPlan.decisions } : {}),
      scoutStatus,
      ...(scoutSkipReason ? { scoutSkipReason } : {}),
      ...(scoutData ? { scoutData } : {}),
      ...degradedMetadata,
    };
  };

  // An intentional blocked Needs Decision response is authoritative and must be
  // honored BEFORE scout artifact validation. Otherwise validateScoutOutput would
  // fail with "plan_draft.md not found" for a deliberately plan-less run (for
  // example an invalid observed-runtime workingDir rejection), masking the clean
  // decision message behind a generic scout-artifact error and producing no
  // plan/branch/worker. When the planner additionally wrote a structured decision
  // artifact, defer to the scout transport below so scoutStatus and decisions
  // reflect that authoritative artifact.
  if (
    parsedPlan &&
    "blocked" in parsedPlan &&
    !fs.existsSync(path.join(scoutDir, SCOUT_NEEDS_DECISION_FILE))
  ) {
    return emitBlockedPlanningResult(parsedPlan, plannerBackendUsed ?? defaultPlannerBackend);
  }

  if (cachedScoutData) {
    // Cached replans intentionally reuse scout data only after an earlier strict
    // validation pass succeeded; first-time scout artifacts below are advisory
    // when a usable execution plan has already been parsed.
    scoutData = cachedScoutData;
    scoutStatus = "success";
  } else if (includeScoutArtifacts) {
    const hasNeedsDecisionArtifact = fs.existsSync(path.join(scoutDir, SCOUT_NEEDS_DECISION_FILE));
    const scoutResult = validateScoutOutput(scoutDir);

    if (scoutResult.status === "error") {
      if (hasUsableExecutionPlan && !hasNeedsDecisionArtifact) {
        const diagnostic = buildScoutDiagnostic(scoutDir);
        appendPlannerHistoryBestEffort({
          workingDir: plannerCwd,
          runId,
          phase: "planner",
          backend: plannerBackendUsed ?? defaultPlannerBackend,
          event: scoutArtifactAdvisoryEventName(scoutResult.error),
          status: "warning",
          attemptNumber: finalAttemptNumber,
          tokenUsage: parseBackendUsage(procResult.stdout),
          errorClass: scoutResult.errorKind,
          outputSummary: scoutResult.error,
          artifactPaths: [
            path.join(scoutDir, PLANNER_STDOUT_FILE),
            path.join(scoutDir, EXECUTION_PLAN_FILE),
          ],
          historyWorkspaceSlug,
          extra: {
            validationReason: scoutResult.error,
            validationError: scoutResult.error,
            scoutDir: diagnostic.scoutDir,
            directoryListing: diagnostic.directoryListing,
            executionPlan: diagnostic.executionPlan,
            planningStdout: diagnostic.planningStdout,
            planSource: parsedPlanSource,
          },
        });
        scoutStatus = "skipped";
        scoutSkipReason = `invalid scout artifacts: ${scoutResult.error}`;
      } else {
        const resultFile = hasNeedsDecisionArtifact ? SCOUT_NEEDS_DECISION_FILE : SCOUT_REPORT_FILE;
        writeAttemptBundle(scoutDir, {
          attemptNumber: finalAttemptNumber,
          backend: plannerBackendUsed ?? defaultPlannerBackend,
          outcome: "failed",
          errorClassification: scoutResult.errorKind,
          resultFile,
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
          artifactPaths: [resultFile],
          historyWorkspaceSlug,
          extra: {
            ...buildScoutDiagnostic(scoutDir),
            parseError:
              planParseError instanceof Error ? planParseError.message : String(planParseError),
          },
        });
        throw new Error(
          formatInvalidScoutDiagnostic({
            scoutDir,
            validationError: scoutResult.error,
          }),
        );
      }
    } else if (scoutResult.status === "needs_decision") {
      const question = formatNeedsDecisionQuestion(scoutResult.decisions);
      if (hasUsableExecutionPlan) {
        appendPlannerHistoryBestEffort({
          workingDir: plannerCwd,
          runId,
          phase: "planner",
          backend: plannerBackendUsed ?? defaultPlannerBackend,
          event: "result",
          status: "needs_decision",
          attemptNumber: finalAttemptNumber,
          tokenUsage: parseBackendUsage(procResult.stdout),
          errorClass: "needs_decision",
          outputSummary: tailText(question, LOG_EXCERPT_CHARS),
          artifactPaths: [SCOUT_NEEDS_DECISION_FILE],
          historyWorkspaceSlug,
          extra: {
            ...buildScoutDiagnostic(scoutDir),
            validationReason:
              "scout requested a user decision; decision gate blocks before plan approval",
            planSource: parsedPlanSource,
          },
        });
        scoutStatus = "needs_decision";
        return emitBlockedPlanningResult(
          { blocked: true, question, decisions: scoutResult.decisions },
          plannerBackendUsed ?? defaultPlannerBackend,
        );
      } else {
        writeAttemptBundle(scoutDir, {
          attemptNumber: finalAttemptNumber,
          backend: plannerBackendUsed ?? defaultPlannerBackend,
          outcome: "blocked",
          errorClassification: "needs_decision",
          resultFile: SCOUT_NEEDS_DECISION_FILE,
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
          status: "needs_decision",
          attemptNumber: finalAttemptNumber,
          tokenUsage: parseBackendUsage(procResult.stdout),
          outputSummary: tailText(question, LOG_EXCERPT_CHARS),
          artifactPaths: [SCOUT_NEEDS_DECISION_FILE],
          historyWorkspaceSlug,
        });
        return {
          status: "blocked",
          question,
          decisions: scoutResult.decisions,
          scoutStatus: "needs_decision",
          ...degradedMetadata,
        };
      }
    } else if (scoutResult.status === "skipped") {
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

  if (!parsedPlan) {
    const err = planParseError ?? new Error("Planning did not produce a usable execution plan.");
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
      outputSummary: err instanceof Error ? err.message : "Unknown planning error",
      artifactPaths: [
        fs.existsSync(path.join(scoutDir, EXECUTION_PLAN_FILE))
          ? EXECUTION_PLAN_FILE
          : PLANNER_STDOUT_FILE,
      ],
      historyWorkspaceSlug,
    });
    throw err;
  }

  if ("blocked" in parsedPlan) {
    // Reachable when a cached scout success accompanied a blocked replan. The
    // stdout-only blocked case is already handled before validation.
    return emitBlockedPlanningResult(parsedPlan, plannerBackendUsed ?? defaultPlannerBackend);
  }

  const effectivePlan = plannerDegradedReason
    ? rewritePlanForDegradedPlanner(parsedPlan, params.enabledWorkers)
    : parsedPlan;
  writeCanonicalPlanArtifact(scoutDir, effectivePlan);

  if (includeScoutArtifacts && agentVisibleWikiDir) {
    await repairMissingGoalBrief({
      runId,
      goalText,
      cwd: plannerCwd,
      scoutDir,
      wikiDir: agentVisibleWikiDir,
      plan: effectivePlan,
      originalPlanningPrompt: plannerBackendUsed === "codex" ? codexPrompt : claudePrompt,
      plannerBackends,
      preferredBackend: plannerBackendUsed ?? defaultPlannerBackend,
      claudeCommand,
      claudeSandbox: claudePlanningSandbox,
      ...(codexPlanningSandbox ? { codexSandbox: codexPlanningSandbox } : {}),
      planningEnv,
      timeoutMs: timeout,
      historyWorkspaceSlug,
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    });
  }
  const goalBriefPath = agentVisibleWikiDir
    ? path.join(agentVisibleWikiDir, GOAL_BRIEF_FILE)
    : undefined;

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
    historyWorkspaceSlug,
  });
  mirrorPlannerRuntimeBestEffort({ workingDir: plannerCwd, runId, goalsDir, historyWorkspaceSlug });

  return {
    status: "success",
    plan: effectivePlan,
    ...(goalBriefPath ? { goalBriefPath } : {}),
    scoutStatus,
    ...(scoutSkipReason ? { scoutSkipReason } : {}),
    ...(scoutData ? { scoutData } : {}),
    ...degradedMetadata,
  };
}
