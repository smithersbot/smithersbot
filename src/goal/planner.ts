import type { GoalLlmClient, Plan, PlanStep, ToolName } from "./types.js";

const VALID_TOOLS: Set<string> = new Set<string>([
  "file_read",
  "file_write",
  "file_modify",
  "mkdir",
  "git_add",
  "npm_init",
  "shell_exec",
]);

const SHELL_READ_ONLY_ALLOWLIST: readonly string[] = [
  "ls",
  "cat",
  "git status",
  "git diff",
  "git log",
];

const PLAN_SYSTEM_PROMPT = `You are a technical planning agent. Given a goal, generate a structured execution plan as JSON.

Each step must use exactly one tool from: file_read, file_write, file_modify, mkdir, git_add, npm_init, shell_exec.

Tool argument schemas:
- file_read: { "path": "<relative-path>" }
- file_write: { "path": "<relative-path>", "content": "<file-contents>" }
- file_modify: { "path": "<relative-path>", "search": "<text-to-find>", "replace": "<replacement>" }
- mkdir: { "path": "<relative-path>" }
- git_add: { "paths": "<space-separated-relative-paths>" }
- npm_init: { "directory": "<relative-path>" }
- shell_exec: { "command": "<read-only-command>" }
  Allowed shell_exec commands (read-only): ls, cat, git status, git diff, git log

All file paths are relative to the workspace root.

Respond ONLY with a JSON object (no markdown fences) matching this schema:
{
  "summary": "Brief description of the plan",
  "steps": [
    {
      "id": "unique-step-id",
      "description": "What this step does",
      "dependsOn": ["step-ids-that-must-complete-first"],
      "tool": { "name": "tool_name", "args": { ... } }
    }
  ]
}

If you cannot create a plan because you need more information, respond with:
{ "blocked": true, "question": "The specific question you need answered" }`;

export type PlanResult = Plan | { blocked: true; question: string };

export async function generatePlan(client: GoalLlmClient, goal: string): Promise<PlanResult> {
  const response = await client.complete({
    systemPrompt: PLAN_SYSTEM_PROMPT,
    userMessage: `Goal: ${goal}`,
    maxTokens: 8192,
  });

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

  throw new Error(`Failed to parse JSON from LLM response:\n${trimmed.slice(0, 200)}`);
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

    const tool = step.tool as Record<string, unknown> | undefined;
    if (!tool || typeof tool.name !== "string") {
      throw new Error(`Step ${id}: tool with name is required`);
    }
    if (!VALID_TOOLS.has(tool.name)) {
      throw new Error(`Step ${id}: unknown tool "${tool.name}"`);
    }

    // Validate shell_exec against read-only allowlist at plan time
    if (tool.name === "shell_exec") {
      const args = (tool.args ?? {}) as Record<string, string>;
      const cmd = (args.command ?? "").trim();
      const allowed = SHELL_READ_ONLY_ALLOWLIST.some(
        (prefix) => cmd === prefix || cmd.startsWith(`${prefix} `),
      );
      if (!allowed) {
        throw new Error(`Step ${id}: shell_exec command not in read-only allowlist: "${cmd}"`);
      }
    }

    steps.push({
      id,
      description,
      dependsOn,
      tool: {
        name: tool.name as ToolName,
        args: (tool.args ?? {}) as Record<string, string>,
      },
      status: "pending",
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
        tool: s.tool,
      })),
    },
    null,
    2,
  );

  const response = await client.complete({
    systemPrompt: PLAN_SYSTEM_PROMPT,
    userMessage: `Goal: ${goal}\n\nCurrent plan:\n${currentPlanJson}\n\nRevision instructions: ${editInstructions}\n\nGenerate a revised plan incorporating these changes. Keep unchanged steps as-is where possible.`,
    maxTokens: 8192,
  });

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
