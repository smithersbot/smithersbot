import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoalLlmError, classifyGoalError } from "./errors.js";
import type { ScoutResult } from "./scout.js";
import type { GoalBackendId } from "./backend-types.js";
import type { GoalLlmClient, Plan, PlanStep } from "./types.js";
import { resolveRunDir } from "./run-store.js";
import { normalizeLabel } from "./mermaid-render.js";

export const PLAN_SYSTEM_PROMPT = `You are a technical planning agent. Given a goal, break it into a structured execution plan as JSON.

Each step describes a task that an autonomous coding agent will carry out. The agent has full access to the filesystem, shell commands (bash), and can read/write/edit files. Within a single turn the agent can chain as many tool calls as it needs — read dozens of files, edit many, run builds and tests — so each step can encompass substantial work. You do NOT need to specify tools — just describe what to do.

GRANULARITY RULES (strict):
- Default to 1–10 steps. Use 3–7 for most goals, but go as low as 1 for trivial goals or up to 10 for genuinely large efforts.
- Each step is a shippable milestone: it starts from exploration/understanding, includes implementation, and ends with verification (tests pass, build succeeds, or a smoke check).
- Target 5–30 minutes of agent runtime work per step. Avoid human-time estimates like 30–120 minutes.
- DO NOT create separate steps for "explore the repo", "understand the code", "read the files", or "plan the approach". Fold exploration and understanding into the implementation step that needs it.
- DO NOT split "write code" and "write tests" into separate steps. Implementation + tests belong in the same step.
- DO NOT create a standalone "run tests" or "verify" step at the end. Each step must verify its own work before completing.
- When in doubt, merge steps. Fewer, meatier steps are always better than many tiny ones.

BACKEND SELECTION RULES (strict):
- Every step MUST include a backend: "codex" | "claude_code" | "pi".
- Use "codex" for coding tasks (creating/modifying code or files).
- Use "claude_code" for testing tasks and every other type of task.
- If a step both creates/modifies code AND runs tests, use "codex".
- Only use "pi" if the user explicitly requests it.

Step schema:
- id: short unique identifier (e.g. "implement-auth", "fix-payment-flow", "add-dashboard")
- description: clear, actionable description of what the agent should do, including what "done" looks like
- shortSummary: concise task title (<=60 chars) for UI display
- dependsOn: array of step ids that must complete before this step can start (use [] for no dependencies)
- durationMinutes: estimated agent runtime in minutes (integer, 5–30 typical)
- backend (required): "codex" | "claude_code" | "pi" — execution backend

Top-level summary fields:
- summary: full plan description
- shortSummary: <=80 chars, human-readable goal headline focused on the outcome (not implementation details)
- Unless the goal is primarily about testing, avoid mentioning tests in shortSummary.

Respond ONLY with raw JSON (no markdown fences and no prose before/after). Your output must start with "{" and end with "}" and match this schema:
{
  "workingDir": "/absolute/path/or/~/path",
  "summary": "Brief description of the plan",
  "shortSummary": "Readable goal headline, <=80 chars",
  "steps": [
    {
      "id": "unique-step-id",
      "description": "What this step does and how to verify it is done",
      "shortSummary": "Readable task title, <=60 chars",
      "dependsOn": ["step-ids-that-must-complete-first"],
      "durationMinutes": 12,
      "backend": "codex"
    }
  ]
}

workingDir is the directory where the goal's work should happen.
- Use the current workspace path if the goal modifies an existing repo.
- Use a new path (for example ~/project-name) if the goal creates a new project or writes files outside the current workspace.
- Use ~ for home directory prefix.

If you cannot create a plan because you need more information, respond with:
{ "blocked": true, "question": "The specific question you need answered" }`;

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
): Promise<PlanResult> {
  let response;
  try {
    response = await client.complete({
      systemPrompt: PLAN_SYSTEM_PROMPT,
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

  // Fallback: allow a prose preamble before a bare JSON object.
  const braceIdx = trimmed.indexOf("{");
  if (braceIdx > 0) {
    try {
      const result = JSON.parse(trimmed.slice(braceIdx));
      if (typeof result === "object" && result !== null) return result as Record<string, unknown>;
    } catch {
      // Fall through
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

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateSummary(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const keep = Math.max(0, maxChars - 3);
  return `${value.slice(0, keep).trimEnd()}...`;
}

function parseShortSummary(raw: unknown, fallback: string, maxChars: number): string {
  const rawString = typeof raw === "string" ? collapseWhitespace(raw) : "";
  if (rawString.length > 0) return truncateSummary(rawString, maxChars);
  return truncateSummary(collapseWhitespace(fallback), maxChars);
}

/** Parse and validate backend from raw LLM output. */
function parseBackend(raw: unknown): GoalBackendId | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  if (VALID_BACKEND_IDS.includes(normalized as GoalBackendId)) {
    return normalized as GoalBackendId;
  }
  return undefined;
}

function validatePlan(raw: Record<string, unknown>, goal: string): Plan {
  const summary = typeof raw.summary === "string" ? raw.summary : goal;
  const shortSummary = parseShortSummary(raw.shortSummary, summary, PLAN_SHORT_SUMMARY_MAX_CHARS);
  const rawWorkingDir = typeof raw.workingDir === "string" ? raw.workingDir.trim() : "";
  if (!rawWorkingDir) {
    throw new Error("Plan must include a non-empty workingDir");
  }
  const workingDir =
    rawWorkingDir === "~"
      ? os.homedir()
      : rawWorkingDir.startsWith("~/")
        ? path.join(os.homedir(), rawWorkingDir.slice(2))
        : rawWorkingDir;
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new Error("Plan must contain at least one step");
  }

  const steps: PlanStep[] = [];
  const seenIds = new Set<string>();

  for (const rawStep of raw.steps) {
    const step = rawStep as Record<string, unknown>;
    const rawId = step.id;
    const id = typeof rawId === "string" ? rawId : typeof rawId === "number" ? `${rawId}` : "";
    if (!id) throw new Error("Each step must have a non-empty id");
    if (seenIds.has(id)) throw new Error(`Duplicate step id: ${id}`);
    seenIds.add(id);

    const rawDesc = step.description;
    const description = typeof rawDesc === "string" ? rawDesc : "";
    if (!description) throw new Error(`Step ${id}: description is required`);
    const shortStepSummary = parseShortSummary(
      step.shortSummary,
      normalizeLabel(description),
      STEP_SHORT_SUMMARY_MAX_CHARS,
    );

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
      status: "pending",
      durationMinutes,
      backend,
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

  return { goal, workingDir, steps, summary, shortSummary };
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
): Promise<PlanResult> {
  const currentPlanJson = JSON.stringify(
    {
      workingDir: currentPlan.workingDir,
      summary: currentPlan.summary,
      shortSummary: currentPlan.shortSummary,
      steps: currentPlan.steps.map((s) => ({
        id: s.id,
        description: s.description,
        shortSummary: s.shortSummary,
        dependsOn: s.dependsOn,
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
      systemPrompt: PLAN_SYSTEM_PROMPT,
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
