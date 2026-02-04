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

export type ScoutResult =
  | { status: "success"; report: ScoutReport; planDraft: string }
  | { status: "blocked"; question: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; error: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCOUT_TIMEOUT_MS = 180_000;
const SCOUT_MAX_BUFFER = 10 * 1024 * 1024; // 10 MB
const SCOUT_BUDGET_USD = "0.50";
const DEFAULT_NODE_COUNT_MIN = 3;
const DEFAULT_NODE_COUNT_MAX = 7;

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
  // Blocked check first: if plan_blocked.md exists, surface the question
  const blockedPath = path.join(scoutDir, "plan_blocked.md");
  if (fs.existsSync(blockedPath)) {
    const question = fs.readFileSync(blockedPath, "utf8").trim();
    return { status: "blocked", question: question || "Scout is blocked (no details provided)." };
  }

  // --- plan_draft.md ---
  const draftPath = path.join(scoutDir, "plan_draft.md");
  if (!fs.existsSync(draftPath)) {
    return { status: "error", error: "plan_draft.md not found" };
  }
  const draft = fs.readFileSync(draftPath, "utf8");

  if (!draft.includes("BEGIN_PLAN_DRAFT") || !draft.includes("END_PLAN_DRAFT")) {
    return {
      status: "error",
      error: "plan_draft.md missing BEGIN_PLAN_DRAFT / END_PLAN_DRAFT sentinels",
    };
  }
  if (!draft.includes("GOAL_ID:")) {
    return { status: "error", error: "plan_draft.md missing GOAL_ID" };
  }
  if (!draft.includes("graph TD") && !draft.includes("flowchart TD")) {
    return {
      status: "error",
      error: "plan_draft.md missing mermaid graph (expected 'graph TD' or 'flowchart TD')",
    };
  }

  // --- scout_report.json ---
  const reportPath = path.join(scoutDir, "scout_report.json");
  if (!fs.existsSync(reportPath)) {
    return { status: "error", error: "scout_report.json not found" };
  }

  let report: ScoutReport;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as ScoutReport;
  } catch {
    return { status: "error", error: "scout_report.json is not valid JSON" };
  }

  if (!report.goal_id) {
    return { status: "error", error: "scout_report.json missing goal_id" };
  }
  if (!Array.isArray(report.nodes) || report.nodes.length === 0) {
    return { status: "error", error: "scout_report.json has no nodes" };
  }
  if (!Array.isArray(report.edges)) {
    return { status: "error", error: "scout_report.json missing edges array" };
  }

  // --- node_specs/ ---
  const nodeSpecsDir = resolveNodeSpecsDir(scoutDir);
  if (!fs.existsSync(nodeSpecsDir)) {
    return { status: "error", error: "node_specs/ directory not found" };
  }

  const specFiles = new Set(fs.readdirSync(nodeSpecsDir).filter((f) => f.endsWith(".md")));
  if (specFiles.size === 0) {
    return { status: "error", error: "node_specs/ contains no .md files" };
  }

  // Every node in report must have a matching spec file
  for (const node of report.nodes) {
    if (!specFiles.has(`${node.id}.md`)) {
      return { status: "error", error: `Missing node spec: node_specs/${node.id}.md` };
    }
  }

  // Extract plan draft content between sentinels
  const beginIdx = draft.indexOf("BEGIN_PLAN_DRAFT");
  const endIdx = draft.indexOf("END_PLAN_DRAFT");
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
    const stdout = execFileSync(
      claudeBin,
      ["-p", "--allowedTools", "Read,Glob,Grep,Bash,Write", "--max-budget-usd", SCOUT_BUDGET_USD],
      {
        input: brief,
        encoding: "utf8",
        timeout,
        maxBuffer: SCOUT_MAX_BUFFER,
        cwd: process.cwd(),
      },
    );
    fs.writeFileSync(stdoutPath, stdout, "utf8");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    writeScoutError(scoutDir, errMsg);
    return { status: "error", error: `Scout execution failed: ${errMsg}` };
  }

  // Validate output artifacts
  const result = validateScoutOutput(scoutDir);
  if (result.status === "error") {
    writeScoutError(scoutDir, result.error);
  }

  return result;
}

/** Write scout_error.txt for post-mortem debugging. */
function writeScoutError(scoutDir: string, message: string): void {
  try {
    fs.writeFileSync(path.join(scoutDir, "scout_error.txt"), message, "utf8");
  } catch {
    // Best-effort; don't mask the original error.
  }
}
