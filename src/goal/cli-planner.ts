import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeAttemptBundle, tailText } from "./attempt-bundle.js";
import { resolveEnabledWorkers } from "./backend-types.js";
import { buildClaudeCodeEnv, writeAuthModeArtifact } from "./claude-code-env.js";
import { runCliProcess } from "./cli-process.js";
import { getCodexAskForApprovalPlacement } from "./backend-availability.js";
import { RATE_LIMIT_RE } from "./error-patterns.js";
import {
  PLAN_SYSTEM_PROMPT,
  PlanParseError,
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

const DEFAULT_PLANNING_TIMEOUT_MS = 1_200_000;
const LOG_EXCERPT_CHARS = 2048;

// Canonical planning artifacts live under <run>/scout/ so execution + resume can
// rely on stable paths. Shared scout constants define scout_report/node_specs/etc.
const PLANNING_BRIEF_FILE = "PLANNING_BRIEF.md";
const PLANNER_STDOUT_FILE = "planning_stdout.txt";
const PLANNER_STDERR_FILE = "planning_stderr.txt";
const PLANNER_RAW_OUTPUT_FILE = "planning_raw_output.txt";
export const EXECUTION_PLAN_FILE = "execution_plan.json";

const CLAUDE_ALLOWED_TOOLS = "Read,Glob,Grep,Bash,Write";
const ANTHROPIC_USAGE_LIMIT_RE =
  /(?:you(?:'|’)?ve|you have)\s+hit\s+your\s+(?:chatgpt\s+)?(?:usage\s+)?limit|usage\s+limit|resets?\s+\d/i;

const PLAN_AND_SCOUT_APPENDIX = `## Canonical Execution Plan Output

After writing all scout output files, create this file:
- {{OUTPUT_DIR}}/${EXECUTION_PLAN_FILE}

Then print the exact same JSON object as your final stdout response.

The JSON must satisfy the planning schema below exactly.

${PLAN_SYSTEM_PROMPT}

Additional requirements:
- Keep dependency structure aligned with ${SCOUT_REPORT_FILE}.
- Every step id must map to an existing scout node id, except bootstrap step id "create-conventions".
- If clarification is required, create ${SCOUT_NEEDS_CLARIFICATION_FILE} and return:
  { "blocked": true, "question": "The specific question you need answered" }`;

const PLAN_ONLY_PROMPT = `${PLAN_SYSTEM_PROMPT}

Goal: {{GOAL_TEXT}}
Current workspace path: {{CURRENT_WORKSPACE_PATH}}`;

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

function buildCodexPlanningArgs(plannerCwd: string, prompt: string): string[] {
  const codexAskForApproval = getCodexAskForApprovalPlacement();
  return [
    ...(codexAskForApproval === "before_exec" ? ["--ask-for-approval", "never"] : []),
    "exec",
    ...(codexAskForApproval === "after_exec" ? ["--ask-for-approval", "never"] : []),
    "--sandbox",
    "workspace-write",
    "--cd",
    plannerCwd,
    "-c",
    "net.allowed=true",
    prompt,
  ];
}

function resolvePlannerBackends(enabledWorkers?: CliWorkerId[]): CliWorkerId[] {
  const resolvedWorkers = resolveEnabledWorkers(enabledWorkers ? { enabledWorkers } : undefined);
  const hasClaudeCode = resolvedWorkers.includes("claude_code");
  const hasCodex = resolvedWorkers.includes("codex");
  if (hasClaudeCode && hasCodex) return ["claude_code", "codex"];
  if (hasClaudeCode) return ["claude_code"];
  return ["codex"];
}

function formatCodexFallbackDisabledError(params: {
  context: "Planning" | "Plan revision";
  degradedReason: PlannerDegradedReason;
  resetHint?: string;
}): string {
  const { context, degradedReason, resetHint } = params;
  const reasonLabel = degradedReason === "anthropic_usage_limit" ? "usage limit" : "rate limit";
  const resetSuffix = resetHint ? ` (${resetHint})` : "";
  return (
    `${context} failed: Anthropic ${reasonLabel} reached${resetSuffix}, ` +
    "and codex fallback is disabled by goal.enabledWorkers."
  );
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

function copyCodexScoutArtifacts(params: { sourceDir: string; targetDir: string }): void {
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
      fs.copyFileSync(sourcePath, path.join(targetDir, fileName));
    }

    const sourceNodeSpecsDir = path.join(sourceDir, SCOUT_NODE_SPECS_DIR);
    if (fs.existsSync(sourceNodeSpecsDir) && fs.statSync(sourceNodeSpecsDir).isDirectory()) {
      const sourceNodeSpecFiles = fs
        .readdirSync(sourceNodeSpecsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"));
      if (sourceNodeSpecFiles.length > 0) {
        const targetNodeSpecsDir = path.join(targetDir, SCOUT_NODE_SPECS_DIR);
        fs.rmSync(targetNodeSpecsDir, { recursive: true, force: true });
        fs.cpSync(sourceNodeSpecsDir, targetNodeSpecsDir, { recursive: true });
      }
    }
  } catch (err) {
    throw new Error(
      `Failed to copy Codex planner artifacts from ${sourceDir} to ${targetDir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function buildPlanningPrompt(params: {
  runId: string;
  goalText: string;
  cwd: string;
  scoutDir: string;
  includeScoutArtifacts: boolean;
}): string {
  const { runId, goalText, cwd, scoutDir, includeScoutArtifacts } = params;
  if (!includeScoutArtifacts) {
    return PLAN_ONLY_PROMPT.replace("{{GOAL_TEXT}}", goalText).replace(
      "{{CURRENT_WORKSPACE_PATH}}",
      cwd,
    );
  }

  const templatePath = resolveScoutTemplatePath();
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Scout template not found: ${templatePath}`);
  }

  const template = fs.readFileSync(templatePath, "utf8");
  const scoutBrief = renderScoutTemplate({
    template,
    goalId: runId,
    goalText,
    outputDir: scoutDir,
  });

  return [
    `Current workspace path: ${cwd}`,
    "",
    scoutBrief,
    "",
    PLAN_AND_SCOUT_APPENDIX.replaceAll("{{OUTPUT_DIR}}", scoutDir),
  ].join("\n");
}

function writePlannerRawOutput(scoutDir: string, rawOutput: string): void {
  try {
    fs.writeFileSync(path.join(scoutDir, PLANNER_RAW_OUTPUT_FILE), rawOutput, "utf8");
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
}): string {
  const { goalText, currentPlan, cwd, editInstructions, priorFeedback } = params;
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
    PLAN_SYSTEM_PROMPT,
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
  const plannerCwd = params.cwd ?? process.cwd();

  const plannerBackends = resolvePlannerBackends(params.enabledWorkers);
  const claudeBin = plannerBackends.includes("claude_code") ? resolveClaudeBinary() : undefined;
  if (plannerBackends.includes("claude_code") && !claudeBin) {
    throw new Error("claude binary not found on PATH");
  }
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

  let plannerBackendUsed: PlannerBackendId | undefined;
  let plannerDegradedReason: PlannerDegradedReason | undefined;
  let plannerDegradedResetHint: string | undefined;
  let attemptIndex = 0;
  let procResult: Awaited<ReturnType<typeof runCliProcess>> | null = null;

  while (attemptIndex < plannerBackends.length) {
    const backend = plannerBackends[attemptIndex];
    if (!backend) break;
    const command = backend === "claude_code" ? claudeCommand : "codex";
    const args =
      backend === "claude_code"
        ? ["-p", "--allowedTools", CLAUDE_ALLOWED_TOOLS, ...(model ? ["--model", model] : [])]
        : buildCodexPlanningArgs(plannerCwd, prompt);

    procResult = await runCliProcess({
      command,
      args,
      cwd: plannerCwd,
      timeoutMs: timeout,
      ...(backend === "claude_code" ? { stdin: prompt } : {}),
      stdoutPath: path.join(revisionDir, PLAN_REVISION_STDOUT_FILE),
      stderrPath: path.join(revisionDir, PLAN_REVISION_STDERR_FILE),
      env: backend === "claude_code" ? revisionEnv : { ...process.env },
    });

    if (procResult.timedOut) {
      throw new Error(`Plan revision timed out after ${(timeout / 60_000).toFixed(0)} minutes.`);
    }

    if ((procResult.exitCode && procResult.exitCode !== 0) || procResult.signal) {
      const errMsg =
        procResult.stderr ||
        procResult.stdout ||
        (procResult.signal
          ? `Plan revision process terminated by ${procResult.signal}.`
          : "Plan revision process failed.");

      if (backend === "claude_code") {
        const degradedReason = detectAnthropicDegradedReason(errMsg);
        if (degradedReason) {
          plannerDegradedReason = degradedReason;
          plannerDegradedResetHint = extractResetHint(errMsg);
          if (plannerBackends.slice(attemptIndex + 1).includes("codex")) {
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

    plannerBackendUsed = backend;
    break;
  }

  if (!procResult) {
    throw new Error("Plan revision failed before producing output.");
  }

  try {
    fs.writeFileSync(
      path.join(revisionDir, PLAN_REVISION_RAW_OUTPUT_FILE),
      procResult.stdout,
      "utf8",
    );
  } catch {
    // Best-effort diagnostics.
  }

  const parsedPlan = parsePlanResultFromText(procResult.stdout, goalText);
  const plan =
    plannerDegradedReason && !("blocked" in parsedPlan)
      ? rewritePlanForDegradedPlanner(parsedPlan, params.enabledWorkers)
      : parsedPlan;

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
  const timeout = params.timeoutMs ?? DEFAULT_PLANNING_TIMEOUT_MS;
  const plannerCwd = params.cwd ?? process.cwd();

  const plannerBackends = resolvePlannerBackends(params.enabledWorkers);
  const claudeBin = plannerBackends.includes("claude_code") ? resolveClaudeBinary() : undefined;
  if (plannerBackends.includes("claude_code") && !claudeBin) {
    throw new Error("claude binary not found on PATH");
  }
  const claudeCommand = claudeBin ?? "claude";

  const scoutDir = resolveScoutDir(runId, goalsDir);
  fs.mkdirSync(scoutDir, { recursive: true });
  clearStalePlanningArtifacts(scoutDir);
  if (includeScoutArtifacts) {
    fs.mkdirSync(path.join(scoutDir, SCOUT_NODE_SPECS_DIR), { recursive: true });
  }
  const codexScoutDir = includeScoutArtifacts ? resolveCodexScoutDir(runId) : undefined;
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
        });
  fs.writeFileSync(path.join(scoutDir, PLANNING_BRIEF_FILE), claudePrompt, "utf8");

  const authMode = params.claudeCodeAuth ?? "subscription";
  const planningEnv = buildClaudeCodeEnv(authMode);
  writeAuthModeArtifact(scoutDir, authMode);
  let plannerBackendUsed: PlannerBackendId | undefined;
  let plannerDegradedReason: PlannerDegradedReason | undefined;
  let plannerDegradedResetHint: string | undefined;
  let attemptIndex = 0;
  let finalAttemptNumber = 0;
  let procResult: Awaited<ReturnType<typeof runCliProcess>> | null = null;
  const defaultPlannerBackend: PlannerBackendId = plannerBackends[0] ?? "claude_code";

  while (attemptIndex < plannerBackends.length) {
    const backend = plannerBackends[attemptIndex];
    if (!backend) break;
    const attemptNumber = attemptIndex + 1;
    finalAttemptNumber = attemptNumber;
    const prompt = backend === "codex" ? codexPrompt : claudePrompt;
    const command = backend === "claude_code" ? claudeCommand : "codex";
    const args =
      backend === "claude_code"
        ? ["-p", "--allowedTools", CLAUDE_ALLOWED_TOOLS]
        : buildCodexPlanningArgs(plannerCwd, prompt);

    procResult = await runCliProcess({
      command,
      args,
      cwd: plannerCwd,
      timeoutMs: timeout,
      ...(backend === "claude_code" ? { stdin: prompt } : {}),
      stdoutPath: path.join(scoutDir, PLANNER_STDOUT_FILE),
      stderrPath: path.join(scoutDir, PLANNER_STDERR_FILE),
      env: backend === "claude_code" ? planningEnv : { ...process.env },
    });

    writePlannerRawOutput(scoutDir, procResult.stdout);

    if (procResult.timedOut) {
      const message = `Planning timed out after ${(timeout / 60_000).toFixed(0)} minutes.`;
      writeAttemptBundle(scoutDir, {
        attemptNumber,
        backend,
        outcome: "timeout",
        errorClassification: "timeout",
        logExcerpt: tailText(procResult.stdout, LOG_EXCERPT_CHARS),
        durationMs: procResult.durationMs,
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
      });

      if (backend === "claude_code") {
        const degradedReason = detectAnthropicDegradedReason(errMsg);
        if (degradedReason) {
          plannerDegradedReason = degradedReason;
          plannerDegradedResetHint = extractResetHint(errMsg);
          if (plannerBackends.slice(attemptIndex + 1).includes("codex")) {
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

  let scoutData: Extract<ScoutResult, { status: "success" }> | undefined;
  let scoutStatus: CliPlanningResult["scoutStatus"] = "skipped";
  let scoutSkipReason: string | undefined;

  if (includeScoutArtifacts) {
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
  });

  return {
    status: "success",
    plan: effectivePlan,
    scoutStatus,
    ...(scoutSkipReason ? { scoutSkipReason } : {}),
    ...(scoutData ? { scoutData } : {}),
    ...degradedMetadata,
  };
}
