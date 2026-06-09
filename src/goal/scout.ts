import fs from "node:fs";
import path from "node:path";
import { resolveScoutTemplatePath as resolveScoutTemplatePathFromPrompts } from "../prompts/scout/loader.js";
import { RATE_LIMIT_RE } from "./error-patterns.js";
import { repairJsonText } from "./json-repair.js";
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

export type ScoutDecisionOption = {
  key: string;
  label: string;
  recommended?: boolean;
};

export type ScoutDecision = {
  id: string;
  question: string;
  options: ScoutDecisionOption[];
};

export type ScoutNeedsDecisionArtifact = {
  version: 1;
  decisions: ScoutDecision[];
};

export type ScoutErrorKind = "timeout" | "rate_limit" | "validation" | "other";

export type ScoutResult =
  | { status: "success"; report: ScoutReport; planDraft: string }
  | { status: "needs_decision"; decisions: ScoutDecision[] }
  | { status: "skipped"; reason: string }
  | { status: "error"; error: string; errorKind: ScoutErrorKind };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Canonical run-relative directory where planning/scout artifacts are persisted. */
export const SCOUT_DIR_NAME = "scout";
/** Canonical scout artifact file name with the dependency graph and node metadata. */
export const SCOUT_REPORT_FILE = "scout_report.json";
/** Canonical scout artifact file name with markdown draft + sentinels. */
export const SCOUT_PLAN_DRAFT_FILE = "plan_draft.md";
/** Canonical scout artifact file name for user decisions needed before planning. */
export const SCOUT_NEEDS_DECISION_FILE = "plan_needs_decision.json";
/** Canonical scout artifact subdirectory with one markdown file per node id. */
export const SCOUT_NODE_SPECS_DIR = "node_specs";

const DEFAULT_NODE_COUNT_MIN = 1;
const DEFAULT_NODE_COUNT_MAX = 10;

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const TIMEOUT_RE = /ETIMEDOUT|timed?\s*out|timeout|SIGTERM/i;

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

function findExecutableOnPath(commandName: string): string | null {
  const pathValue = process.env.PATH ?? "";
  const pathEntries = pathValue.split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, commandName);
    try {
      if (!fs.existsSync(candidate)) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export function resolveClaudeBinary(): string | null {
  if (claudeBinaryPath !== undefined) return claudeBinaryPath;
  claudeBinaryPath = findExecutableOnPath("claude");
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
  return path.join(resolveRunDir(runId, goalsDir), SCOUT_DIR_NAME);
}

function resolveNodeSpecsDir(scoutDir: string): string {
  return path.join(scoutDir, SCOUT_NODE_SPECS_DIR);
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

/**
 * Resolve the scout template file path. Re-exports the canonical resolver from
 * `src/prompts/scout/loader.ts` so the template path stays single-sourced.
 */
export function resolveScoutTemplatePath(): string {
  return resolveScoutTemplatePathFromPrompts();
}

export function renderScoutTemplate(params: {
  template: string;
  goalId: string;
  goalText: string;
  outputDir: string;
  wikiDir?: string;
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
    .replaceAll("{{WIKI_DIR}}", params.wikiDir ?? "{{WIKI_DIR}}")
    .replaceAll("{{NODE_COUNT_MIN}}", String(min))
    .replaceAll("{{NODE_COUNT_MAX}}", String(max));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function validateDecisionArtifactObject(value: unknown): ScoutNeedsDecisionArtifact {
  if (!isRecord(value)) {
    throw new Error(`${SCOUT_NEEDS_DECISION_FILE} must contain a JSON object`);
  }
  if (value.version !== 1) {
    throw new Error(`${SCOUT_NEEDS_DECISION_FILE} version must be 1`);
  }
  if (!Array.isArray(value.decisions) || value.decisions.length === 0) {
    throw new Error(`${SCOUT_NEEDS_DECISION_FILE} decisions must be a non-empty array`);
  }

  const decisions = value.decisions.map((decisionValue, decisionIndex): ScoutDecision => {
    const decisionLabel = `${SCOUT_NEEDS_DECISION_FILE} decisions[${decisionIndex}]`;
    if (!isRecord(decisionValue)) {
      throw new Error(`${decisionLabel} must be an object`);
    }
    const id = validateNonEmptyString(decisionValue.id, `${decisionLabel}.id`);
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) {
      throw new Error(`${decisionLabel}.id must be kebab-case`);
    }
    const question = validateNonEmptyString(decisionValue.question, `${decisionLabel}.question`);
    if (!Array.isArray(decisionValue.options) || decisionValue.options.length < 2) {
      throw new Error(`${decisionLabel}.options must contain at least two options`);
    }

    const optionKeys = new Set<string>();
    let recommendedCount = 0;
    const options = decisionValue.options.map((optionValue, optionIndex): ScoutDecisionOption => {
      const optionLabel = `${decisionLabel}.options[${optionIndex}]`;
      if (!isRecord(optionValue)) {
        throw new Error(`${optionLabel} must be an object`);
      }
      const key = validateNonEmptyString(optionValue.key, `${optionLabel}.key`);
      if (optionKeys.has(key)) {
        throw new Error(`${optionLabel}.key must be unique within its decision`);
      }
      optionKeys.add(key);
      const label = validateNonEmptyString(optionValue.label, `${optionLabel}.label`);
      const recommendedValue = optionValue.recommended;
      if (recommendedValue !== undefined && typeof recommendedValue !== "boolean") {
        throw new Error(`${optionLabel}.recommended must be a boolean when present`);
      }
      if (recommendedValue === true) recommendedCount += 1;
      return {
        key,
        label,
        ...(recommendedValue === undefined ? {} : { recommended: recommendedValue }),
      };
    });
    if (recommendedCount > 1) {
      throw new Error(`${decisionLabel}.options may include at most one recommended option`);
    }

    return { id, question, options };
  });

  return { version: 1, decisions };
}

export function parseScoutNeedsDecisionArtifact(raw: string): ScoutNeedsDecisionArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${SCOUT_NEEDS_DECISION_FILE} is not valid JSON`);
  }
  return validateDecisionArtifactObject(parsed);
}

/** Validate scout output artifacts. Pure validation — no side effects beyond reading files. */
export function validateScoutOutput(scoutDir: string): ScoutResult {
  // Needs Decision check first: this structured artifact blocks planning before
  // any draft or execution plan is required.
  const needsDecisionPath = path.join(scoutDir, SCOUT_NEEDS_DECISION_FILE);
  if (fs.existsSync(needsDecisionPath)) {
    try {
      const artifact = parseScoutNeedsDecisionArtifact(fs.readFileSync(needsDecisionPath, "utf8"));
      return {
        status: "needs_decision",
        decisions: artifact.decisions,
      };
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        errorKind: "validation",
      };
    }
  }

  // --- plan_draft.md ---
  const draftPath = path.join(scoutDir, SCOUT_PLAN_DRAFT_FILE);
  if (!fs.existsSync(draftPath)) {
    return {
      status: "error",
      error: `${SCOUT_PLAN_DRAFT_FILE} not found`,
      errorKind: "validation",
    };
  }
  const draft = fs.readFileSync(draftPath, "utf8");

  if (!draft.includes("BEGIN_PLAN_DRAFT") || !draft.includes("END_PLAN_DRAFT")) {
    return {
      status: "error",
      error: `${SCOUT_PLAN_DRAFT_FILE} missing BEGIN_PLAN_DRAFT / END_PLAN_DRAFT sentinels`,
      errorKind: "validation",
    };
  }
  if (!draft.includes("GOAL_ID:")) {
    return {
      status: "error",
      error: `${SCOUT_PLAN_DRAFT_FILE} missing GOAL_ID`,
      errorKind: "validation",
    };
  }
  if (!draft.includes("graph TD") && !draft.includes("flowchart TD")) {
    return {
      status: "error",
      error: `${SCOUT_PLAN_DRAFT_FILE} missing mermaid graph (expected 'graph TD' or 'flowchart TD')`,
      errorKind: "validation",
    };
  }

  // --- scout_report.json ---
  const reportPath = path.join(scoutDir, SCOUT_REPORT_FILE);
  if (!fs.existsSync(reportPath)) {
    return { status: "error", error: `${SCOUT_REPORT_FILE} not found`, errorKind: "validation" };
  }

  let report: ScoutReport;
  const reportRaw = fs.readFileSync(reportPath, "utf8");
  try {
    report = JSON.parse(reportRaw) as ScoutReport;
  } catch {
    try {
      report = JSON.parse(repairJsonText(reportRaw)) as ScoutReport;
    } catch {
      return {
        status: "error",
        error: `${SCOUT_REPORT_FILE} is not valid JSON`,
        errorKind: "validation",
      };
    }
  }

  if (!report.goal_id) {
    return {
      status: "error",
      error: `${SCOUT_REPORT_FILE} missing goal_id`,
      errorKind: "validation",
    };
  }
  if (!Array.isArray(report.nodes) || report.nodes.length === 0) {
    return {
      status: "error",
      error: `${SCOUT_REPORT_FILE} has no nodes`,
      errorKind: "validation",
    };
  }
  if (!Array.isArray(report.edges)) {
    return {
      status: "error",
      error: `${SCOUT_REPORT_FILE} missing edges array`,
      errorKind: "validation",
    };
  }

  // --- node_specs/ ---
  const nodeSpecsDir = resolveNodeSpecsDir(scoutDir);
  if (!fs.existsSync(nodeSpecsDir)) {
    return {
      status: "error",
      error: `${SCOUT_NODE_SPECS_DIR}/ directory not found`,
      errorKind: "validation",
    };
  }

  const specFiles = new Set(fs.readdirSync(nodeSpecsDir).filter((f) => f.endsWith(".md")));
  if (specFiles.size === 0) {
    return {
      status: "error",
      error: `${SCOUT_NODE_SPECS_DIR}/ contains no .md files`,
      errorKind: "validation",
    };
  }

  // Every node in report must have a matching spec file
  for (const node of report.nodes) {
    if (!specFiles.has(`${node.id}.md`)) {
      return {
        status: "error",
        error: `Missing node spec: ${SCOUT_NODE_SPECS_DIR}/${node.id}.md`,
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
      error: `${SCOUT_PLAN_DRAFT_FILE} has BEGIN_PLAN_DRAFT after END_PLAN_DRAFT (sentinels out of order)`,
      errorKind: "validation",
    };
  }
  const planDraft = draft.slice(beginIdx, endIdx + "END_PLAN_DRAFT".length);

  return { status: "success", report, planDraft };
}
