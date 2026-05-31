import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPlanSystemPrompt as buildPlanSystemPromptFromPrompts } from "../prompts/planner/system-prompt.js";
import { isSmithersbotDevWorkspace } from "./dev-gateway-workspace.js";
import { GoalLlmError, classifyGoalError } from "./errors.js";
import type { ScoutResult } from "./scout.js";
import type { GoalBackendId } from "./backend-types.js";
import { PlanInputSchema } from "./goal-schemas.js";
import type { GoalLlmClient, Plan, PlanStep } from "./types.js";
import { resolveRunDir } from "./run-store.js";
import { normalizeLabel } from "./mermaid-render.js";
import { collapseWhitespace, parseShortSummary } from "./plan-text.js";
import { extractJsonObjectCandidates, repairJsonText } from "./json-repair.js";
import type { CliWorkerId } from "../config/types.goal.js";

/**
 * Re-export of the canonical planner system-prompt builder from
 * `src/prompts/planner/system-prompt.ts`. Keep `buildPlanSystemPrompt`
 * available on the planner module so existing imports keep resolving.
 */
export const buildPlanSystemPrompt = buildPlanSystemPromptFromPrompts;

export const PLAN_SYSTEM_PROMPT = buildPlanSystemPrompt();

export type PlanResult = Plan | { blocked: true; question: string };

/** Error thrown when JSON extraction from LLM response fails. Carries raw response for diagnostics. */
export class PlanParseError extends Error {
  readonly rawResponse: string;
  constructor(message: string, rawResponse: string) {
    super(message);
    this.name = "PlanParseError";
    this.rawResponse = rawResponse;
  }
}

/** Write raw LLM response for post-mortem debugging. Returns the file path on success. */
export function persistRawPlanResponse(runId: string, rawText: string): string | undefined {
  try {
    const runDir = resolveRunDir(runId);
    if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });
    const filePath = path.join(runDir, "plan-raw.txt");
    fs.writeFileSync(filePath, rawText, "utf8");

    console.error(`[goal] Plan parse failed. Raw LLM output saved to:\n  ${filePath}`);
    return filePath;
  } catch {
    // Best-effort; don't mask the original error.
    return undefined;
  }
}

/** Build the user message for the planner, optionally enriched with scout data. */
export function buildPlannerUserMessage(
  goal: string,
  cwd: string,
  scoutData?: ScoutResult,
): string {
  if (!scoutData || scoutData.status !== "success") {
    return [`Goal: ${goal}`, `Current workspace path: ${cwd}`].join("\n");
  }

  const lines: string[] = [`Goal: ${goal}`, `Current workspace path: ${cwd}`];
  lines.push("");
  lines.push("--- Scout Report (pre-analysis by Claude Code) ---");
  lines.push(JSON.stringify(scoutData.report, null, 2));
  lines.push("");
  lines.push("--- Plan Draft ---");
  lines.push(scoutData.planDraft);
  lines.push("---");
  lines.push("");
  lines.push(
    "Use the scout analysis above as your primary reference. " +
      "Normalize node IDs, descriptions, dependencies, and durations " +
      "into the JSON plan format. Preserve the dependency graph structure from the scout report.",
  );
  return lines.join("\n");
}

export async function generatePlan(
  client: GoalLlmClient,
  goal: string,
  cwd: string,
  scoutData?: ScoutResult,
  enabledWorkers?: CliWorkerId[],
): Promise<PlanResult> {
  let response;
  try {
    response = await client.complete({
      systemPrompt: buildPlanSystemPrompt(enabledWorkers, {
        devGatewayVerification: isSmithersbotDevWorkspace(cwd),
      }),
      userMessage: buildPlannerUserMessage(goal, cwd, scoutData),
      maxTokens: 8192,
    });
  } catch (err) {
    throw wrapLlmCallError(err);
  }

  return parsePlanResultFromText(response.text, goal);
}

function isBlockedResponse(
  obj: Record<string, unknown>,
): obj is { blocked: true; question: string } {
  return obj.blocked === true && typeof obj.question === "string";
}

/** Parse planner response text into a validated plan (or blocked clarification request). */
export function parsePlanResultFromText(text: string, goal: string): PlanResult {
  const parsed = extractJson(text);
  if (isBlockedResponse(parsed)) {
    return { blocked: true, question: String(parsed.question ?? "Unknown reason") };
  }
  return validatePlan(parsed, goal);
}

/**
 * Extracts a JSON object from LLM response text. Handles raw JSON
 * and JSON wrapped in markdown code fences.
 */
export function extractJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();

  // Try raw parse first
  try {
    const result = JSON.parse(trimmed);
    if (typeof result === "object" && result !== null) return result as Record<string, unknown>;
  } catch {
    // Fall through to code fence extraction
  }

  // Extract from markdown code fence
  const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(trimmed);
  if (fenceMatch?.[1]) {
    try {
      const result = JSON.parse(fenceMatch[1].trim());
      if (typeof result === "object" && result !== null) return result as Record<string, unknown>;
    } catch {
      // Fall through
    }
  }

  // Fallback: match from the first fence opening to the last fence closing.
  const greedyFenceMatch = /```(?:json)?\s*\n?([\s\S]*)\n?\s*```/.exec(trimmed);
  if (greedyFenceMatch?.[1]) {
    try {
      const result = JSON.parse(greedyFenceMatch[1].trim());
      if (typeof result === "object" && result !== null) return result as Record<string, unknown>;
    } catch {
      // Fall through
    }
  }

  // Fallback: allow a prose preamble before a bare JSON object.
  const braceIdx = trimmed.indexOf("{");
  const lastBraceIdx = trimmed.lastIndexOf("}");
  if (braceIdx > 0 && lastBraceIdx > braceIdx) {
    try {
      const result = JSON.parse(trimmed.slice(braceIdx, lastBraceIdx + 1));
      if (typeof result === "object" && result !== null) return result as Record<string, unknown>;
    } catch {
      // Fall through
    }
  }

  // Repair malformed raw JSON (for example, an extra trailing brace).
  try {
    const repaired = repairJsonText(trimmed);
    const result = JSON.parse(repaired);
    if (typeof result === "object" && result !== null) return result as Record<string, unknown>;
  } catch {
    // Fall through
  }

  // Final fallback: extract JSON object candidates from prose/fences.
  for (const candidate of extractJsonObjectCandidates(trimmed)) {
    try {
      const result = JSON.parse(candidate);
      if (typeof result === "object" && result !== null) return result as Record<string, unknown>;
    } catch {
      try {
        const repaired = repairJsonText(candidate);
        const repairedResult = JSON.parse(repaired);
        if (typeof repairedResult === "object" && repairedResult !== null) {
          return repairedResult as Record<string, unknown>;
        }
      } catch {
        // Continue to next candidate.
      }
    }
  }

  throw new PlanParseError(
    `Failed to parse JSON from LLM response:\n${trimmed.slice(0, 500)}`,
    text,
  );
}

const VALID_BACKEND_IDS: GoalBackendId[] = ["pi", "codex", "claude_code"];
const PLAN_SHORT_SUMMARY_MAX_CHARS = 80;
const STEP_SHORT_SUMMARY_MAX_CHARS = 60;

/** Parse and validate backend from raw LLM output. */
function parseBackend(raw: unknown): GoalBackendId | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  if (VALID_BACKEND_IDS.includes(normalized as GoalBackendId)) {
    return normalized as GoalBackendId;
  }
  return undefined;
}

function parseOptionalNonEmptyString(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = collapseWhitespace(raw);
  return normalized.length > 0 ? normalized : undefined;
}

function parseConstraints(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const constraints: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const normalized = collapseWhitespace(value);
    if (normalized.length > 0) constraints.push(normalized);
  }
  return constraints;
}

function parseBuildGate(raw: unknown): Plan["buildGate"] {
  if (!raw || typeof raw !== "object") return undefined;
  const buildGate = raw as Record<string, unknown>;
  if (!Array.isArray(buildGate.commands) || typeof buildGate.runBetweenSteps !== "boolean") {
    return undefined;
  }
  const commands = buildGate.commands
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
  const postExecutionReview =
    typeof buildGate.postExecutionReview === "boolean" ? buildGate.postExecutionReview : undefined;
  return {
    commands,
    runBetweenSteps: buildGate.runBetweenSteps,
    ...(postExecutionReview !== undefined ? { postExecutionReview } : {}),
  };
}

function normalizePlanInput(raw: Record<string, unknown>, goal: string): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...raw, goal };
  if (!raw.buildGate || typeof raw.buildGate !== "object") {
    return normalized;
  }

  const buildGate = { ...(raw.buildGate as Record<string, unknown>) };
  if ("postExecutionReview" in buildGate && typeof buildGate.postExecutionReview !== "boolean") {
    delete buildGate.postExecutionReview;
  }

  normalized.buildGate = buildGate;
  return normalized;
}

function resolveStepIdForIssue(raw: Record<string, unknown>, stepIndex: unknown): string {
  if (!Array.isArray(raw.steps) || typeof stepIndex !== "number" || !raw.steps[stepIndex]) {
    return "unknown";
  }
  const rawStep = raw.steps[stepIndex];
  if (!rawStep || typeof rawStep !== "object") return "unknown";
  const rawId = (rawStep as Record<string, unknown>).id;
  if (typeof rawId === "number") return `${rawId}`;
  if (typeof rawId === "string" && rawId.length > 0) return rawId;
  return "unknown";
}

function validatePlan(raw: Record<string, unknown>, goal: string): Plan {
  const parsedPlan = PlanInputSchema.safeParse(normalizePlanInput(raw, goal));
  if (!parsedPlan.success) {
    const issue = parsedPlan.error.issues[0];
    if (!issue) throw new Error("Plan is invalid");

    if (issue.path[0] === "workingDir") {
      throw new Error("Plan must include a non-empty workingDir");
    }
    if (issue.path[0] === "steps" && issue.path.length === 1) {
      throw new Error("Plan must contain at least one step");
    }
    if (issue.path[0] === "steps" && issue.path[2] === "id") {
      throw new Error("Each step must have a non-empty id");
    }
    if (issue.path[0] === "steps" && issue.path[2] === "description") {
      const stepId = resolveStepIdForIssue(raw, issue.path[1]);
      throw new Error(`Step ${stepId}: description is required`);
    }
    if (issue.path[0] === "steps" && issue.path[2] === "backend") {
      const stepId = resolveStepIdForIssue(raw, issue.path[1]);
      throw new Error(
        `Step ${stepId}: backend is required (codex | claude_code | pi) and must be valid`,
      );
    }

    throw new Error(`Plan failed schema validation: ${issue.message}`);
  }

  const parsed = parsedPlan.data;
  const summary = typeof parsed.summary === "string" ? parsed.summary : goal;
  const shortSummary = parseShortSummary(
    parsed.shortSummary,
    summary,
    PLAN_SHORT_SUMMARY_MAX_CHARS,
  );
  const buildGate = parseBuildGate(parsed.buildGate);
  const rawWorkingDir = parsed.workingDir.trim();
  if (!rawWorkingDir) {
    throw new Error("Plan must include a non-empty workingDir");
  }
  const workingDir =
    rawWorkingDir === "~"
      ? os.homedir()
      : rawWorkingDir.startsWith("~/")
        ? path.join(os.homedir(), rawWorkingDir.slice(2))
        : rawWorkingDir;
  if (parsed.steps.length === 0) {
    throw new Error("Plan must contain at least one step");
  }

  const steps: PlanStep[] = [];
  const seenIds = new Set<string>();

  for (const step of parsed.steps) {
    const rawId = step.id;
    const id = typeof rawId === "string" ? rawId : typeof rawId === "number" ? `${rawId}` : "";
    if (!id) throw new Error("Each step must have a non-empty id");
    if (seenIds.has(id)) throw new Error(`Duplicate step id: ${id}`);
    seenIds.add(id);

    const description = step.description;
    if (!description) throw new Error(`Step ${id}: description is required`);
    const shortStepSummary = parseShortSummary(
      step.shortSummary,
      normalizeLabel(description),
      STEP_SHORT_SUMMARY_MAX_CHARS,
    );
    const successCriteria = parseOptionalNonEmptyString(step.successCriteria);
    const constraints = parseConstraints(step.constraints);

    const dependsOn = Array.isArray(step.dependsOn) ? step.dependsOn.map(String) : [];

    const rawDuration = step.durationMinutes;
    const durationMinutes =
      typeof rawDuration === "number" && rawDuration > 0 ? Math.round(rawDuration) : undefined;

    // Parse required backend
    const backend = parseBackend(step.backend);
    if (!backend) {
      throw new Error(
        `Step ${id}: backend is required (codex | claude_code | pi) and must be valid`,
      );
    }

    steps.push({
      id,
      description,
      shortSummary: shortStepSummary,
      dependsOn,
      successCriteria,
      constraints,
      status: "pending",
      durationMinutes,
      backend,
      ...(step.requiresNetwork === true ? { requiresNetwork: true } : {}),
    });
  }

  // Validate dependency references exist
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!seenIds.has(dep)) {
        throw new Error(`Step ${step.id}: depends on unknown step "${dep}"`);
      }
    }
  }

  // Detect cycles via Kahn's algorithm
  detectCycles(steps);

  return { goal, workingDir, steps, summary, shortSummary, buildGate };
}

/**
 * Generate a revised plan by sending the current plan + edit instructions to the LLM.
 * `goal` is passed explicitly (canonical goal lives on SerializedRun, not on Plan).
 */
export async function generatePlanRevision(
  client: GoalLlmClient,
  goal: string,
  cwd: string,
  currentPlan: Plan,
  editInstructions: string,
  enabledWorkers?: CliWorkerId[],
): Promise<PlanResult> {
  const currentPlanJson = JSON.stringify(
    {
      workingDir: currentPlan.workingDir,
      summary: currentPlan.summary,
      shortSummary: currentPlan.shortSummary,
      buildGate: currentPlan.buildGate,
      steps: currentPlan.steps.map((s) => ({
        id: s.id,
        description: s.description,
        shortSummary: s.shortSummary,
        dependsOn: s.dependsOn,
        successCriteria: s.successCriteria,
        constraints: s.constraints,
        durationMinutes: s.durationMinutes,
        backend: s.backend,
      })),
    },
    null,
    2,
  );

  let response;
  try {
    response = await client.complete({
      systemPrompt: buildPlanSystemPrompt(enabledWorkers, {
        devGatewayVerification: isSmithersbotDevWorkspace(cwd),
      }),
      userMessage: `Goal: ${goal}\nCurrent workspace path: ${cwd}\n\nCurrent plan:\n${currentPlanJson}\n\nRevision instructions: ${editInstructions}\n\nGenerate a revised plan incorporating these changes. Keep unchanged steps as-is where possible.`,
      maxTokens: 8192,
    });
  } catch (err) {
    throw wrapLlmCallError(err);
  }

  return parsePlanResultFromText(response.text, goal);
}

function detectCycles(steps: PlanStep[]): void {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const step of steps) {
    inDegree.set(step.id, step.dependsOn.length);
    for (const dep of step.dependsOn) {
      const children = adjacency.get(dep) ?? [];
      children.push(step.id);
      adjacency.set(dep, children);
    }
  }

  const queue: string[] = [];
  for (const step of steps) {
    if ((inDegree.get(step.id) ?? 0) === 0) queue.push(step.id);
  }

  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    visited++;
    for (const child of adjacency.get(current) ?? []) {
      const newDeg = (inDegree.get(child) ?? 1) - 1;
      inDegree.set(child, newDeg);
      if (newDeg === 0) queue.push(child);
    }
  }

  if (visited !== steps.length) {
    throw new Error("Plan contains a dependency cycle");
  }
}

/**
 * Format an approved plan as readable advisory context for the agent's system prompt.
 * The agent uses this to understand what tasks it will be given, in what order.
 */
export function formatPlanAsContext(plan: Plan): string {
  const lines: string[] = [];
  lines.push(`Summary: ${plan.summary}`);
  lines.push("");
  for (const step of plan.steps) {
    const deps = step.dependsOn.length > 0 ? ` (depends on: ${step.dependsOn.join(", ")})` : "";
    lines.push(`- Task ${step.id}: ${step.description}${deps}`);
  }
  return lines.join("\n");
}

/** Wrap a raw LLM call error as a typed GoalLlmError using the shared classifier. */
function wrapLlmCallError(err: unknown): GoalLlmError {
  if (err instanceof GoalLlmError) return err;
  const kind = classifyGoalError(err);
  const msg = err instanceof Error ? err.message : String(err);
  switch (kind) {
    case "network":
      return new GoalLlmError("Network error reaching planner API", "network", err);
    case "auth":
      return new GoalLlmError("Authentication failed for planner API", "auth", err);
    default:
      return new GoalLlmError(`Planner call failed: ${msg}`, "internal", err);
  }
}
