import fs from "node:fs";
import path from "node:path";
import { writeAttemptBundle, tailText } from "./attempt-bundle.js";
import { buildClaudeCodeEnv, writeAuthModeArtifact } from "./claude-code-env.js";
import { runCliProcess } from "./cli-process.js";
import {
  PLAN_SYSTEM_PROMPT,
  PlanParseError,
  parsePlanResultFromText,
  type PlanResult,
} from "./planner.js";
import {
  classifyScoutError,
  renderScoutTemplate,
  resolveClaudeBinary,
  resolveScoutDir,
  resolveScoutTemplatePath,
  validateScoutOutput,
  SCOUT_NEEDS_CLARIFICATION_FILE,
  SCOUT_NODE_SPECS_DIR,
  SCOUT_REPORT_FILE,
  type ScoutResult,
} from "./scout.js";
import type { Plan } from "./types.js";
import type { ClaudeCodeAuthMode } from "../config/types.goal.js";

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

const PLAN_AND_SCOUT_APPENDIX = `## Canonical Execution Plan Output

After writing all scout output files, create this file:
- {{OUTPUT_DIR}}/${EXECUTION_PLAN_FILE}

Then print the exact same JSON object as your final stdout response.

The JSON must satisfy the planning schema below exactly.

${PLAN_SYSTEM_PROMPT}

Additional requirements:
- Keep dependency structure aligned with ${SCOUT_REPORT_FILE}.
- Every step id must map to an existing scout node id.
- If clarification is required, create ${SCOUT_NEEDS_CLARIFICATION_FILE} and return:
  { "blocked": true, "question": "The specific question you need answered" }`;

const PLAN_ONLY_PROMPT = `${PLAN_SYSTEM_PROMPT}

Goal: {{GOAL_TEXT}}`;

export type CliPlanningParams = {
  runId: string;
  goalText: string;
  goalsDir?: string;
  timeoutMs?: number;
  /** How the planner's Claude Code process authenticates (default: "subscription"). */
  claudeCodeAuth?: ClaudeCodeAuthMode;
  /** Preserve legacy --no-scout semantics by skipping scout artifact generation. */
  includeScoutArtifacts?: boolean;
};

export type CliPlanningSuccess = {
  status: "success";
  plan: Plan;
  scoutStatus: "success" | "skipped";
  scoutSkipReason?: string;
  scoutData?: Extract<ScoutResult, { status: "success" }>;
};

export type CliPlanningBlocked = {
  status: "blocked";
  question: string;
  scoutStatus: "needs_clarification" | "success" | "skipped";
  scoutSkipReason?: string;
  scoutData?: Extract<ScoutResult, { status: "success" }>;
};

export type CliPlanningResult = CliPlanningSuccess | CliPlanningBlocked;

function buildPlanningPrompt(params: {
  runId: string;
  goalText: string;
  scoutDir: string;
  includeScoutArtifacts: boolean;
}): string {
  const { runId, goalText, scoutDir, includeScoutArtifacts } = params;
  if (!includeScoutArtifacts) {
    return PLAN_ONLY_PROMPT.replace("{{GOAL_TEXT}}", goalText);
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

  return scoutBrief + "\n\n" + PLAN_AND_SCOUT_APPENDIX.replaceAll("{{OUTPUT_DIR}}", scoutDir);
}

function writePlannerRawOutput(scoutDir: string, rawOutput: string): void {
  try {
    fs.writeFileSync(path.join(scoutDir, PLANNER_RAW_OUTPUT_FILE), rawOutput, "utf8");
  } catch {
    // Best-effort diagnostics.
  }
}

function writeCanonicalPlanArtifact(scoutDir: string, plan: Plan): void {
  const canonical = {
    summary: plan.summary,
    steps: plan.steps.map((step) => ({
      id: step.id,
      description: step.description,
      dependsOn: step.dependsOn,
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

export async function runCliPlanning(params: CliPlanningParams): Promise<CliPlanningResult> {
  const { runId, goalText, goalsDir } = params;
  const includeScoutArtifacts = params.includeScoutArtifacts !== false;
  const timeout = params.timeoutMs ?? DEFAULT_PLANNING_TIMEOUT_MS;

  const claudeBin = resolveClaudeBinary();
  if (!claudeBin) {
    throw new Error("claude binary not found on PATH");
  }

  const scoutDir = resolveScoutDir(runId, goalsDir);
  fs.mkdirSync(scoutDir, { recursive: true });
  if (includeScoutArtifacts) {
    fs.mkdirSync(path.join(scoutDir, SCOUT_NODE_SPECS_DIR), { recursive: true });
  }

  const prompt = buildPlanningPrompt({
    runId,
    goalText,
    scoutDir,
    includeScoutArtifacts,
  });
  fs.writeFileSync(path.join(scoutDir, PLANNING_BRIEF_FILE), prompt, "utf8");

  const authMode = params.claudeCodeAuth ?? "subscription";
  const planningEnv = buildClaudeCodeEnv(authMode);
  writeAuthModeArtifact(scoutDir, authMode);

  const procResult = await runCliProcess({
    command: claudeBin,
    args: ["-p", "--allowedTools", CLAUDE_ALLOWED_TOOLS],
    cwd: process.cwd(),
    timeoutMs: timeout,
    stdin: prompt,
    stdoutPath: path.join(scoutDir, PLANNER_STDOUT_FILE),
    stderrPath: path.join(scoutDir, PLANNER_STDERR_FILE),
    env: planningEnv,
  });

  writePlannerRawOutput(scoutDir, procResult.stdout);

  if (procResult.timedOut) {
    const message = `Planning timed out after ${(timeout / 60_000).toFixed(0)} minutes.`;
    writeAttemptBundle(scoutDir, {
      attemptNumber: 1,
      backend: "claude_code",
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
      attemptNumber: 1,
      backend: "claude_code",
      outcome: "crash",
      errorClassification: errorKind,
      logExcerpt: tailText(procResult.stdout, LOG_EXCERPT_CHARS),
      durationMs: procResult.durationMs,
    });
    throw new Error(`Planning execution failed: ${errMsg}`);
  }

  let scoutData: Extract<ScoutResult, { status: "success" }> | undefined;
  let scoutStatus: CliPlanningResult["scoutStatus"] = "skipped";
  let scoutSkipReason: string | undefined;

  if (includeScoutArtifacts) {
    const scoutResult = validateScoutOutput(scoutDir);

    if (scoutResult.status === "error") {
      writeAttemptBundle(scoutDir, {
        attemptNumber: 1,
        backend: "claude_code",
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
        attemptNumber: 1,
        backend: "claude_code",
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
      attemptNumber: 1,
      backend: "claude_code",
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
      attemptNumber: 1,
      backend: "claude_code",
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
    };
  }

  writeCanonicalPlanArtifact(scoutDir, parsedPlan);

  writeAttemptBundle(scoutDir, {
    attemptNumber: 1,
    backend: "claude_code",
    outcome: "complete",
    resultFile: EXECUTION_PLAN_FILE,
    logExcerpt: tailText(procResult.stdout, LOG_EXCERPT_CHARS),
    durationMs: procResult.durationMs,
  });

  return {
    status: "success",
    plan: parsedPlan,
    scoutStatus,
    ...(scoutSkipReason ? { scoutSkipReason } : {}),
    ...(scoutData ? { scoutData } : {}),
  };
}
