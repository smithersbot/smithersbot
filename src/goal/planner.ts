import fs from "node:fs";
import path from "node:path";
import { GoalLlmError } from "./errors.js";
import type { GoalLlmClient, Plan, PlanStep } from "./types.js";
import { resolveRunDir } from "./run-store.js";

const PLAN_SYSTEM_PROMPT = `You are a technical planning agent. Given a goal, break it into a structured execution plan as JSON.

Each step describes a task that an autonomous coding agent will carry out. The agent has full access to the filesystem, shell commands (bash), and can read/write/edit files. Within a single turn the agent can chain as many tool calls as it needs — read dozens of files, edit many, run builds and tests — so each step can encompass substantial work. You do NOT need to specify tools — just describe what to do.

GRANULARITY RULES (strict):
- Default to 3–7 steps for most goals. Only exceed 7 for genuinely large, multi-component efforts.
- Each step is a shippable milestone: it starts from exploration/understanding, includes implementation, and ends with verification (tests pass, build succeeds, or a smoke check).
- Target 30–120 minutes of real work per step, not 5–10 minutes.
- DO NOT create separate steps for "explore the repo", "understand the code", "read the files", or "plan the approach". Fold exploration and understanding into the implementation step that needs it.
- DO NOT split "write code" and "write tests" into separate steps. Implementation + tests belong in the same step.
- DO NOT create a standalone "run tests" or "verify" step at the end. Each step must verify its own work before completing.
- When in doubt, merge steps. Fewer, meatier steps are always better than many tiny ones.

Step schema:
- id: short unique identifier (e.g. "implement-auth", "fix-payment-flow", "add-dashboard")
- description: clear, actionable description of what the agent should do, including what "done" looks like
- dependsOn: array of step ids that must complete before this step can start (use [] for no dependencies)
- durationMinutes: estimated duration in minutes (integer, 30–120 typical)

Respond ONLY with a JSON object (no markdown fences) matching this schema:
{
  "summary": "Brief description of the plan",
  "steps": [
    {
      "id": "unique-step-id",
      "description": "What this step does and how to verify it is done",
      "dependsOn": ["step-ids-that-must-complete-first"],
      "durationMinutes": 45
    }
  ]
}

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

export async function generatePlan(client: GoalLlmClient, goal: string): Promise<PlanResult> {
  let response;
  try {
    response = await client.complete({
      systemPrompt: PLAN_SYSTEM_PROMPT,
      userMessage: `Goal: ${goal}`,
      maxTokens: 8192,
    });
  } catch (err) {
    throw wrapLlmCallError(err);
  }

  const parsed = extractJson(response.text);

  if (isBlockedResponse(parsed)) {
    return { blocked: true, question: String(parsed.question ?? "Unknown reason") };
  }

  return validatePlan(parsed, goal);
}

function isBlockedResponse(
  obj: Record<string, unknown>,
): obj is { blocked: true; question: string } {
  return obj.blocked === true && typeof obj.question === "string";
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

  throw new PlanParseError(
    `Failed to parse JSON from LLM response:\n${trimmed.slice(0, 500)}`,
    text,
  );
}

function validatePlan(raw: Record<string, unknown>, goal: string): Plan {
  const summary = typeof raw.summary === "string" ? raw.summary : goal;
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

    const dependsOn = Array.isArray(step.dependsOn) ? step.dependsOn.map(String) : [];

    const rawDuration = step.durationMinutes;
    const durationMinutes =
      typeof rawDuration === "number" && rawDuration > 0 ? Math.round(rawDuration) : undefined;

    steps.push({
      id,
      description,
      dependsOn,
      status: "pending",
      durationMinutes,
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

  return { goal, steps, summary };
}

/**
 * Generate a revised plan by sending the current plan + edit instructions to the LLM.
 * `goal` is passed explicitly (canonical goal lives on SerializedRun, not on Plan).
 */
export async function generatePlanRevision(
  client: GoalLlmClient,
  goal: string,
  currentPlan: Plan,
  editInstructions: string,
): Promise<PlanResult> {
  const currentPlanJson = JSON.stringify(
    {
      summary: currentPlan.summary,
      steps: currentPlan.steps.map((s) => ({
        id: s.id,
        description: s.description,
        dependsOn: s.dependsOn,
        durationMinutes: s.durationMinutes,
      })),
    },
    null,
    2,
  );

  let response;
  try {
    response = await client.complete({
      systemPrompt: PLAN_SYSTEM_PROMPT,
      userMessage: `Goal: ${goal}\n\nCurrent plan:\n${currentPlanJson}\n\nRevision instructions: ${editInstructions}\n\nGenerate a revised plan incorporating these changes. Keep unchanged steps as-is where possible.`,
      maxTokens: 8192,
    });
  } catch (err) {
    throw wrapLlmCallError(err);
  }

  const parsed = extractJson(response.text);
  if (isBlockedResponse(parsed)) {
    return { blocked: true, question: String(parsed.question ?? "Unknown reason") };
  }
  return validatePlan(parsed, goal);
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

const NETWORK_RE =
  /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|socket hang up|EAI_AGAIN/i;
const AUTH_RE = /401|403|unauthorized|forbidden|invalid.*key|authentication/i;

/** Wrap a raw LLM call error as a typed GoalLlmError. */
function wrapLlmCallError(err: unknown): GoalLlmError {
  if (err instanceof GoalLlmError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (NETWORK_RE.test(msg))
    return new GoalLlmError("Network error reaching planner API", "network", err);
  if (AUTH_RE.test(msg))
    return new GoalLlmError("Authentication failed for planner API", "auth", err);
  return new GoalLlmError(`Planner call failed: ${msg}`, "internal", err);
}
