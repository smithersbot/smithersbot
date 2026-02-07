import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveRunDir } from "./run-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScoutNode = {
  id: string;
  type: string;
  objective: string;
  verification: string;
  effort: number;
  risk: number;
  uncertainty: number;
};

export type ScoutEdge = {
  from: string;
  to: string;
  why: string;
};

export type ScoutReport = {
  goal_id: string;
  nodes: ScoutNode[];
  edges: ScoutEdge[];
};

export type ScoutErrorKind = "timeout" | "rate_limit" | "validation" | "other";

export type ScoutResult =
  | { status: "success"; report: ScoutReport; planDraft: string }
  | { status: "needs_clarification"; question: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; error: string; errorKind: ScoutErrorKind };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCOUT_TIMEOUT_MS = 180_000;
const SCOUT_MAX_BUFFER = 10 * 1024 * 1024; // 10 MB
const DEFAULT_NODE_COUNT_MIN = 1;
const DEFAULT_NODE_COUNT_MAX = 10;

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const TIMEOUT_RE = /ETIMEDOUT|timed?\s*out|timeout|SIGTERM/i;
const RATE_LIMIT_RE = /rate.?limit|429|too many requests|overloaded/i;

/** Classify a scout execution error message into a machine-readable kind. */
export function classifyScoutError(errorMessage: string): ScoutErrorKind {
  if (TIMEOUT_RE.test(errorMessage)) return "timeout";
  if (RATE_LIMIT_RE.test(errorMessage)) return "rate_limit";
  return "other";
}

// ---------------------------------------------------------------------------
// Claude binary detection (cached for process lifetime)
// ---------------------------------------------------------------------------

let claudeBinaryPath: string | null | undefined; // undefined = not checked yet

export function resolveClaudeBinary(): string | null {
  if (claudeBinaryPath !== undefined) return claudeBinaryPath;
  try {
    const result = execFileSync("which", ["claude"], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    claudeBinaryPath = result || null;
  } catch {
    claudeBinaryPath = null;
  }
  return claudeBinaryPath;
}

/** Reset cached binary path (visible for testing). */
export function _resetClaudeBinaryCache(): void {
  claudeBinaryPath = undefined;
}

// ---------------------------------------------------------------------------
// Scout directory helpers
// ---------------------------------------------------------------------------

export function resolveScoutDir(runId: string, goalsDir?: string): string {
  return path.join(resolveRunDir(runId, goalsDir), "scout");
}

function resolveNodeSpecsDir(scoutDir: string): string {
  return path.join(scoutDir, "node_specs");
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

/** Resolve the template file path relative to the package root. */
function resolveTemplatePath(): string {
  // Works from both src/goal/ and dist/goal/ (both two levels deep)
  const moduleDir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
  return path.join(moduleDir, "..", "..", "templates", "scout_prompt_template.md");
}

export function renderScoutTemplate(params: {
  template: string;
  goalId: string;
  goalText: string;
  outputDir: string;
  nodeCountMin?: number;
  nodeCountMax?: number;
}): string {
  const { template, goalId, goalText, outputDir } = params;
  const min = params.nodeCountMin ?? DEFAULT_NODE_COUNT_MIN;
  const max = params.nodeCountMax ?? DEFAULT_NODE_COUNT_MAX;
  return template
    .replaceAll("{{GOAL_ID}}", goalId)
    .replaceAll("{{GOAL_TEXT}}", goalText)
    .replaceAll("{{OUTPUT_DIR}}", outputDir)
    .replaceAll("{{NODE_COUNT_MIN}}", String(min))
    .replaceAll("{{NODE_COUNT_MAX}}", String(max));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate scout output artifacts. Pure validation — no side effects beyond reading files. */
export function validateScoutOutput(scoutDir: string): ScoutResult {
  // Clarification check first: if the scout needs more info it writes this file
  const clarificationPath = path.join(scoutDir, "plan_needs_clarification.md");
  if (fs.existsSync(clarificationPath)) {
    const question = fs.readFileSync(clarificationPath, "utf8").trim();
    return {
      status: "needs_clarification",
      question: question || "Scout needs clarification (no details provided).",
    };
  }

  // --- plan_draft.md ---
  const draftPath = path.join(scoutDir, "plan_draft.md");
  if (!fs.existsSync(draftPath)) {
    return { status: "error", error: "plan_draft.md not found", errorKind: "validation" };
  }
  const draft = fs.readFileSync(draftPath, "utf8");

  if (!draft.includes("BEGIN_PLAN_DRAFT") || !draft.includes("END_PLAN_DRAFT")) {
    return {
      status: "error",
      error: "plan_draft.md missing BEGIN_PLAN_DRAFT / END_PLAN_DRAFT sentinels",
      errorKind: "validation",
    };
  }
  if (!draft.includes("GOAL_ID:")) {
    return { status: "error", error: "plan_draft.md missing GOAL_ID", errorKind: "validation" };
  }
  if (!draft.includes("graph TD") && !draft.includes("flowchart TD")) {
    return {
      status: "error",
      error: "plan_draft.md missing mermaid graph (expected 'graph TD' or 'flowchart TD')",
      errorKind: "validation",
    };
  }

  // --- scout_report.json ---
  const reportPath = path.join(scoutDir, "scout_report.json");
  if (!fs.existsSync(reportPath)) {
    return { status: "error", error: "scout_report.json not found", errorKind: "validation" };
  }

  let report: ScoutReport;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as ScoutReport;
  } catch {
    return {
      status: "error",
      error: "scout_report.json is not valid JSON",
      errorKind: "validation",
    };
  }

  if (!report.goal_id) {
    return { status: "error", error: "scout_report.json missing goal_id", errorKind: "validation" };
  }
  if (!Array.isArray(report.nodes) || report.nodes.length === 0) {
    return { status: "error", error: "scout_report.json has no nodes", errorKind: "validation" };
  }
  if (!Array.isArray(report.edges)) {
    return {
      status: "error",
      error: "scout_report.json missing edges array",
      errorKind: "validation",
    };
  }

  // --- node_specs/ ---
  const nodeSpecsDir = resolveNodeSpecsDir(scoutDir);
  if (!fs.existsSync(nodeSpecsDir)) {
    return { status: "error", error: "node_specs/ directory not found", errorKind: "validation" };
  }

  const specFiles = new Set(fs.readdirSync(nodeSpecsDir).filter((f) => f.endsWith(".md")));
  if (specFiles.size === 0) {
    return { status: "error", error: "node_specs/ contains no .md files", errorKind: "validation" };
  }

  // Every node in report must have a matching spec file
  for (const node of report.nodes) {
    if (!specFiles.has(`${node.id}.md`)) {
      return {
        status: "error",
        error: `Missing node spec: node_specs/${node.id}.md`,
        errorKind: "validation",
      };
    }
  }

  // Extract plan draft content between sentinels
  const beginIdx = draft.indexOf("BEGIN_PLAN_DRAFT");
  const endIdx = draft.indexOf("END_PLAN_DRAFT");
  if (beginIdx >= endIdx) {
    return {
      status: "error",
      error: "plan_draft.md has BEGIN_PLAN_DRAFT after END_PLAN_DRAFT (sentinels out of order)",
      errorKind: "validation",
    };
  }
  const planDraft = draft.slice(beginIdx, endIdx + "END_PLAN_DRAFT".length);

  return { status: "success", report, planDraft };
}

// ---------------------------------------------------------------------------
// Execute scout
// ---------------------------------------------------------------------------

export type RunScoutParams = {
  runId: string;
  goalText: string;
  goalsDir?: string;
  nodeCountMin?: number;
  nodeCountMax?: number;
  timeoutMs?: number;
};

export async function runScout(params: RunScoutParams): Promise<ScoutResult> {
  const { runId, goalText, goalsDir } = params;

  // Skip via env var
  if (process.env.MOLTBOT_NO_SCOUT === "1") {
    return { status: "skipped", reason: "MOLTBOT_NO_SCOUT=1" };
  }

  // Check claude binary
  const claudeBin = resolveClaudeBinary();
  if (!claudeBin) {
    return { status: "skipped", reason: "claude binary not found on PATH" };
  }

  const scoutDir = resolveScoutDir(runId, goalsDir);
  const nodeSpecsDir = resolveNodeSpecsDir(scoutDir);

  // Ensure output directories exist
  fs.mkdirSync(nodeSpecsDir, { recursive: true });

  // Load template
  const templatePath = resolveTemplatePath();
  if (!fs.existsSync(templatePath)) {
    return { status: "skipped", reason: `Scout template not found: ${templatePath}` };
  }
  const template = fs.readFileSync(templatePath, "utf8");

  // Render template
  const brief = renderScoutTemplate({
    template,
    goalId: runId,
    goalText,
    outputDir: scoutDir,
    nodeCountMin: params.nodeCountMin,
    nodeCountMax: params.nodeCountMax,
  });

  // Write PLANNING_BRIEF.md for debugging/audit
  const briefPath = path.join(scoutDir, "PLANNING_BRIEF.md");
  fs.writeFileSync(briefPath, brief, "utf8");

  // Execute claude -p with stdin piping
  const stdoutPath = path.join(scoutDir, "scout_stdout.txt");
  const timeout = params.timeoutMs ?? SCOUT_TIMEOUT_MS;

  try {
    const stdout = execFileSync(claudeBin, ["-p", "--allowedTools", "Read,Glob,Grep,Bash,Write"], {
      input: brief,
      encoding: "utf8",
      timeout,
      maxBuffer: SCOUT_MAX_BUFFER,
      cwd: process.cwd(),
    });
    fs.writeFileSync(stdoutPath, stdout, "utf8");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    writeScoutError(scoutDir, errMsg);
    return {
      status: "error",
      error: `Scout execution failed: ${errMsg}`,
      errorKind: classifyScoutError(errMsg),
    };
  }

  // Validate output artifacts
  const result = validateScoutOutput(scoutDir);
  if (result.status === "error") {
    writeScoutError(scoutDir, result.error);
  }

  return result;
}

/**
 * Run scout with one automatic retry on validation errors.
 *
 * - Validation failure: retry once with the validation error appended to the
 *   prompt so the scout knows what went wrong.
 * - Timeout / rate limit / other: return immediately without retrying.
 * - Skipped / needs_clarification / success: return immediately.
 */
export async function runScoutWithRetry(params: RunScoutParams): Promise<ScoutResult> {
  const firstResult = await runScout(params);

  // Only retry on validation errors
  if (firstResult.status !== "error" || firstResult.errorKind !== "validation") {
    return firstResult;
  }

  // --- Error-informed retry ---
  const { runId, goalText, goalsDir } = params;

  // Skip checks already passed in first run; go straight to re-execution
  const claudeBin = resolveClaudeBinary();
  if (!claudeBin) return firstResult; // shouldn't happen since first run used it

  const scoutDir = resolveScoutDir(runId, goalsDir);
  const nodeSpecsDir = resolveNodeSpecsDir(scoutDir);

  // Clean previous output so the scout starts fresh
  fs.rmSync(nodeSpecsDir, { recursive: true, force: true });
  fs.mkdirSync(nodeSpecsDir, { recursive: true });
  for (const file of ["plan_draft.md", "scout_report.json", "plan_needs_clarification.md"]) {
    const p = path.join(scoutDir, file);
    if (fs.existsSync(p)) fs.rmSync(p);
  }

  // Load and render template with error context appended
  const templatePath = resolveTemplatePath();
  if (!fs.existsSync(templatePath)) return firstResult;
  const template = fs.readFileSync(templatePath, "utf8");

  const brief = renderScoutTemplate({
    template,
    goalId: runId,
    goalText,
    outputDir: scoutDir,
    nodeCountMin: params.nodeCountMin,
    nodeCountMax: params.nodeCountMax,
  });

  const retryBrief =
    brief +
    "\n\n" +
    "## PREVIOUS ATTEMPT FAILED VALIDATION\n\n" +
    `Error: ${firstResult.error}\n\n` +
    "Fix the issues above. Ensure ALL required output files exist and pass validation.\n" +
    "Double-check: plan_draft.md (with sentinels), scout_report.json, and node_specs/<id>.md for every node.\n";

  // Write retry brief for debugging
  fs.writeFileSync(path.join(scoutDir, "PLANNING_BRIEF_RETRY.md"), retryBrief, "utf8");

  const stdoutPath = path.join(scoutDir, "scout_stdout_retry.txt");
  const timeout = params.timeoutMs ?? SCOUT_TIMEOUT_MS;

  try {
    const stdout = execFileSync(claudeBin, ["-p", "--allowedTools", "Read,Glob,Grep,Bash,Write"], {
      input: retryBrief,
      encoding: "utf8",
      timeout,
      maxBuffer: SCOUT_MAX_BUFFER,
      cwd: process.cwd(),
    });
    fs.writeFileSync(stdoutPath, stdout, "utf8");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    writeScoutError(scoutDir, `Retry failed: ${errMsg}`);
    return {
      status: "error",
      error: `Scout retry failed: ${errMsg} (original error: ${firstResult.error})`,
      errorKind: classifyScoutError(errMsg),
    };
  }

  const retryResult = validateScoutOutput(scoutDir);
  if (retryResult.status === "error") {
    writeScoutError(scoutDir, `Retry validation failed: ${retryResult.error}`);
    // Include both errors so the user sees the full picture
    return {
      status: "error",
      error: `Scout failed validation after retry. First: ${firstResult.error}. Retry: ${retryResult.error}`,
      errorKind: "validation",
    };
  }

  return retryResult;
}

/** Write scout_error.txt for post-mortem debugging. */
function writeScoutError(scoutDir: string, message: string): void {
  try {
    fs.writeFileSync(path.join(scoutDir, "scout_error.txt"), message, "utf8");
  } catch {
    // Best-effort; don't mask the original error.
  }
}
