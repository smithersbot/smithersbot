import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoalLlmError, classifyGoalError } from "./errors.js";
import type { ScoutResult } from "./scout.js";
import type { GoalBackendId } from "./backend-types.js";
import { PlanInputSchema } from "./goal-schemas.js";
import type { GoalLlmClient, Plan, PlanStep } from "./types.js";
import { resolveRunDir } from "./run-store.js";
import { normalizeLabel } from "./mermaid-render.js";
import { collapseWhitespace, parseShortSummary } from "./plan-text.js";
import { extractJsonObjectCandidates, repairJsonText } from "./json-repair.js";

export const PLAN_SYSTEM_PROMPT = `You are a technical planning agent. Given a goal, break it into a structured execution plan as JSON.

Each step describes a task that an autonomous coding agent will carry out. The agent has full access to the filesystem, shell commands (bash), and can read/write/edit files. Within a single turn the agent can chain as many tool calls as it needs — read dozens of files, edit many, run builds and tests — so each step can encompass substantial work. You do NOT need to specify tools — just describe what to do.

DOWNSTREAM AGENT CAPABILITIES:
- The executing agent has these tools: Read, Edit, Write, Glob, Grep, Bash
- Each step gets a timeout of: min(2 hours, 2× the step's durationMinutes estimate)
- The agent can chain unlimited tool calls per turn — read dozens of files, edit many, run builds and tests all within a single step
- The agent receives the full project conventions (CLAUDE.md) and can follow existing patterns autonomously
- You do NOT need to micro-manage the agent — describe WHAT to do, not HOW to use each tool

GRANULARITY RULES (strict):
- Default to 1–10 steps. Use 3–7 for most goals, but go as low as 1 for trivial goals or up to 10 for genuinely large efforts.
- Each step is a shippable milestone: it starts from exploration/understanding, includes implementation, and ends with verification (tests pass, build succeeds, or a smoke check).
- Target 5–30 minutes of agent runtime work per step. Avoid human-time estimates like 30–120 minutes.
- DO NOT create separate steps for "explore the repo", "understand the code", "read the files", or "plan the approach". Fold exploration and understanding into the implementation step that needs it.
- DO NOT split "write code" and "write tests" into separate steps. Implementation + tests belong in the same step.
- DO NOT create a standalone "run tests", "verify", or "review" step at the end. A system-level code review runs automatically after all steps complete. Each step must verify its own work before completing.
- When in doubt, merge steps. Fewer, meatier steps are always better than many tiny ones.

BACKEND SELECTION RULES (strict):
- Every step MUST include a backend: "codex" | "claude_code" | "pi".
- Use "codex" for coding tasks (creating/modifying code or files).
- Use "claude_code" for testing tasks and every other type of task.
- If a step both creates/modifies code AND runs tests, use "codex".
- Only use "pi" if the user explicitly requests it.
- If only one backend is available at runtime, the executor will automatically use the available backend regardless of what you specify. Plan for the ideal backend; the system handles fallback.

STRUCTURED PLANNING REQUIREMENTS (strict):
- Every step MUST include successCriteria: a specific, verifiable done-when condition.
- Every step MUST include constraints: explicit approaches that are off-limits.
- Step descriptions should include expected deliverables, not just generic task descriptions.
- Build-gate commands are the objective stop-token for completion. Pick commands that prove the work is actually healthy.
- For Node.js projects with a build script in package.json, set buildGate.commands to ["pnpm build"].
- For non-code projects, set buildGate.commands to [].

CONVENTION FILE RULES (strict):
- Respect project convention files (CLAUDE.md, AGENTS.md) for build/test/lint commands, coding standards, and workflow.
- Do NOT assume pnpm, Vitest, or any specific toolchain unless project conventions explicitly say so.
- If scout indicates no CLAUDE.md in the target project, insert a first step with id "create-conventions".
- "create-conventions" must create BOTH CLAUDE.md and AGENTS.md using scout findings.
- CLAUDE.md best practices:
  - First line: one sentence describing what the project does.
  - Include a commands section with build/test/lint commands.
  - Keep under 100 lines.
  - Use pointers to deeper docs (for example, "When modifying X, read: docs/ARCHITECTURE.md") instead of large inline dumps.
  - Include project-specific stack, conventions, structure, and gotchas; avoid generic coding advice.
- AGENTS.md must mirror the same project-specific conventions in Codex-compatible format.
- "create-conventions" must be first in step order with dependsOn: [], and no other step should list it in dependsOn.

Step schema:
- id: short unique identifier (e.g. "implement-auth", "fix-payment-flow", "add-dashboard")
- description: clear, actionable description of what the agent should do, including what "done" looks like
- shortSummary: concise task title (<=60 chars) for UI display
- dependsOn: array of step ids that must complete before this step can start (use [] for no dependencies)
- successCriteria (required): specific, verifiable done-when condition
- constraints (required): array of explicit do-not-do constraints (can be [] if none)
- durationMinutes: estimated agent runtime in minutes (integer, 5–30 typical)
- backend (required): "codex" | "claude_code" | "pi" — execution backend
- risk (optional): "low" | "medium" | "high" — Flag steps as "high" risk if they touch critical paths, have uncertain requirements, or could break existing behavior. The executor allocates extra retries to high-risk steps. Default: "low".

Top-level summary fields:
- summary: full plan description
- shortSummary: <=80 chars, human-readable goal headline focused on the outcome (not implementation details)
- Unless the goal is primarily about testing, avoid mentioning tests in shortSummary.
- buildGate: post-execution verification gate for this plan
- buildGate.commands: array of commands to run as objective verification (empty array for non-code projects)
- buildGate.runBetweenSteps: true to run gate after each completed step, false to run only at the end

Respond ONLY with raw JSON (no markdown fences and no prose before/after). Your output must start with "{" and end with "}" and match this schema:
{
  "workingDir": "/absolute/path/or/~/path",
  "summary": "Brief description of the plan",
  "shortSummary": "Readable goal headline, <=80 chars",
  "buildGate": {
    "commands": ["pnpm build"],
    "runBetweenSteps": true
  },
  "steps": [
    {
      "id": "unique-step-id",
      "description": "What this step does and how to verify it is done",
      "shortSummary": "Readable task title, <=60 chars",
      "dependsOn": ["step-ids-that-must-complete-first"],
      "successCriteria": "Verifiable done-when condition",
      "constraints": ["Explicit do-not-do constraint"],
      "durationMinutes": 12,
      "backend": "codex"
    }
  ]
}

EXAMPLE — GOOD PLAN:
Goal: "Implement /create_repo Telegram command"
Steps:
1. id: "implement-command" — Create src/telegram/create-repo-command.ts following the existing pattern in gateway-restart.ts. Implementation: (1) export createRepoCommand(ctx) function, (2) parse repo name from ctx.message.text, (3) validate name is non-empty alphanumeric, (4) use execFileSync (NOT spawn) to call 'gh repo create', (5) reply with success/error message. Constraints: ["Do not use child_process.spawn", "Follow gateway-restart.ts pattern exactly"]. successCriteria: "File exists, exports createRepoCommand, handles missing/invalid repo name gracefully."
2. id: "register-command" — Register createRepoCommand in src/telegram/index.ts command map and add to bot.command() handlers. successCriteria: "Bot responds to /create_repo in Telegram."
3. id: "build-and-test" — Run pnpm build && pnpm lint && pnpm vitest run src/telegram/. Fix any type errors or lint failures. successCriteria: "Build, lint, and tests all pass with zero errors."
4. id: "edge-cases" — Test edge cases found in step 3: empty repo name, name with special characters, gh CLI not installed. Add error handling for each. successCriteria: "All edge cases return user-friendly error messages."
Why this is good: specific file paths, numbered sub-tasks, named constraints, verifiable success criteria, each step is a shippable milestone.

EXAMPLE — BAD PLAN (do NOT produce plans like this):
Goal: "Nightly maintenance fixes"
Steps:
1. id: "fix-everything" — Fix the permission race condition in capability broker, update the build gate label rendering, fix the timer leak in agent executor, harden hard-deny patterns with edge case tests, improve reply-to UX across all channels, and add better error logging to the CLI worker. Add test coverage for all changes.
Why this is bad: (1) Mixes unrelated concerns (security, UX, logging, testing) with no coherent narrative. (2) Step description is a 1000+ character wall of text with embedded sub-tasks that should be separate steps. (3) Success criteria like "add test coverage" are vague and unverifiable. (4) No specific file paths or concrete code locations. (5) The planner did not read source first, so autocheck rejected it for contradicting existing code. Each concern should be its own focused step with specific files, constraints, and verifiable criteria.

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
