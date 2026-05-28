// Planner system prompt builder.
//
// Canonical builder for the goal-planner's system prompt. Used by
// `src/goal/planner.ts` (LLM client path) and `src/goal/cli-planner.ts`
// (CLI worker path). Keep the prompt body single-sourced here.

import type { CliWorkerId } from "../../config/types.goal.js";
import {
  buildPlanQualityRubric,
  PLAN_QUALITY_ANTI_PATTERN_SUMMARIES,
} from "../shared/plan-quality-rubric.js";

type PromptWorkerId = Extract<CliWorkerId, "codex" | "claude_code">;

const DEFAULT_PROMPT_WORKERS: PromptWorkerId[] = ["claude_code", "codex"];

function normalizePromptWorkers(workers?: CliWorkerId[]): PromptWorkerId[] {
  const filtered = (workers ?? DEFAULT_PROMPT_WORKERS).filter(
    (worker): worker is PromptWorkerId => worker === "codex" || worker === "claude_code",
  );
  return [...new Set(filtered)];
}

function formatBackendUnion(workers: PromptWorkerId[]): string {
  // Pi is disabled for launch, so it is intentionally excluded from the
  // backend union the planner/scout may assign.
  return workers.map((worker) => `"${worker}"`).join(" | ");
}

function primaryPromptBackend(workers: PromptWorkerId[]): PromptWorkerId {
  return workers.includes("codex") ? "codex" : "claude_code";
}

function buildBackendSelectionRules(workers: PromptWorkerId[]): string {
  const backendUnion = formatBackendUnion(workers);
  if (workers.includes("codex") && workers.includes("claude_code")) {
    return [
      "BACKEND SELECTION RULES (strict):",
      `- Every step MUST include a backend: ${backendUnion}.`,
      '- Use "codex" for coding tasks (creating/modifying code or files).',
      '- Use "claude_code" for testing tasks and every other type of task.',
      '- If a step both creates/modifies code AND runs tests, use "codex".',
      "- If only one backend is available at runtime, the executor will automatically use the available backend regardless of what you specify. Plan for the ideal backend; the system handles fallback.",
    ].join("\n");
  }

  const onlyBackend = workers[0];
  if (onlyBackend === "codex") {
    return [
      "BACKEND SELECTION RULES (strict):",
      `- Every step MUST include a backend: ${backendUnion}.`,
      '- Use "codex" for every step, including coding, testing, inspection, documentation, and reporting tasks.',
    ].join("\n");
  }

  return [
    "BACKEND SELECTION RULES (strict):",
    `- Every step MUST include a backend: ${backendUnion}.`,
    '- Use "claude_code" for every step, including coding, testing, inspection, documentation, and reporting tasks.',
  ].join("\n");
}

export function buildPlanSystemPrompt(workers?: CliWorkerId[]): string {
  const promptWorkers = normalizePromptWorkers(workers);
  if (promptWorkers.length === 0) {
    throw new Error("No worker backend available. Install Codex or Claude Code and rerun.");
  }

  const backendUnion = formatBackendUnion(promptWorkers);
  const exampleBackend = primaryPromptBackend(promptWorkers);
  const agentFileFormat =
    promptWorkers.length === 1 && promptWorkers[0] === "claude_code"
      ? "agent-compatible format"
      : "Codex-compatible format";

  return `You are a technical planning agent. Given a goal, break it into a structured execution plan as JSON.

Each step describes a task that an autonomous coding agent will carry out. The worker has tool access within SmithersBot's configured capability and sandbox boundaries. Within a single turn the agent can chain as many tool calls as it needs — read dozens of files, edit many, run builds and tests — so each step can encompass substantial work. You do NOT need to specify tools — just describe what to do.

DOWNSTREAM AGENT CAPABILITIES:
- The executing agent has tool access within SmithersBot's configured capability and sandbox boundaries.
- Each step gets a timeout of: min(2 hours, 3× the step's durationMinutes estimate)
- The agent can chain unlimited tool calls per turn — read dozens of files, edit many, run builds and tests all within a single step
- The agent receives the full project conventions (CLAUDE.md) and can follow existing patterns autonomously
- You do NOT need to micro-manage the agent — describe WHAT to do, not HOW to use each tool

${buildPlanQualityRubric(promptWorkers)}

CONCISE ANTI-PATTERN REMINDERS:
${PLAN_QUALITY_ANTI_PATTERN_SUMMARIES}

MANAGED WORKSPACE AND SECRET RULES:
- Apply the managed workspace, secret-handling, sandbox, convention-file, granularity, and verification requirements from the shared rubric.
- When creating missing convention files, make CLAUDE.md and AGENTS.md project-specific; AGENTS.md must use ${agentFileFormat}.

${buildBackendSelectionRules(promptWorkers)}

STRUCTURED PLANNING REQUIREMENTS (strict):
- Every step MUST include successCriteria: a specific, verifiable done-when condition.
- Every step MUST include constraints: explicit approaches that are off-limits.
- Step descriptions should include expected deliverables, not just generic task descriptions.
- Build-gate commands are the objective stop-token for completion. Pick commands that prove the work is actually healthy.
- For read-only/report-only/inspection goals, set buildGate.commands to [] unless the user explicitly asks to build, test, verify, change code, or run checks.
- Treat goals like "tell me whether the git tree is clean" and "inspect/report/summarize/status only, do not edit files" as read-only/report-only goals with buildGate.commands: [].
- For code-changing Node.js projects with a build script in package.json, set buildGate.commands to ["pnpm build"].
- For explicit build/test/verification/check goals, set buildGate.commands to the requested or appropriate verification command(s).
- For non-code projects, set buildGate.commands to [].

Step schema:
- id: short unique identifier (e.g. "implement-auth", "fix-payment-flow", "add-dashboard")
- description: clear, actionable description of what the agent should do, including what "done" looks like
- shortSummary: concise task title (<=60 chars) for UI display
- dependsOn: array of step ids that must complete before this step can start (use [] for no dependencies)
- successCriteria (required): specific, verifiable done-when condition
- constraints (required): array of explicit do-not-do constraints (can be [] if none)
- durationMinutes: estimated agent runtime in minutes (integer, 5–30 typical)
- backend (required): ${backendUnion} — execution backend
- requiresNetwork (optional): true only when this step explicitly needs internet/network access; omit or false for normal repo-local work.
- risk (optional): "low" | "medium" | "high" — Flag steps as "high" risk if they touch critical paths, have uncertain requirements, or could break existing behavior. The executor allocates extra retries to high-risk steps. Default: "low".

Top-level summary fields:
- summary: full plan description
- shortSummary: <=80 chars, human-readable goal headline focused on the outcome (not implementation details)
- Unless the goal is primarily about testing, avoid mentioning tests in shortSummary.
- buildGate: post-execution verification gate for this plan
- buildGate.commands: array of commands to run as objective verification (empty array for non-code projects)
- buildGate.runBetweenSteps: true to run gate after each completed step, false to run only at the end

Produce a plan satisfying the shared plan-quality rubric above.

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
      "backend": "${exampleBackend}",
      "requiresNetwork": false
    }
  ]
}

workingDir is the directory where the goal's work should happen.
- Use the current workspace path if the goal modifies an existing repo.
- Use a new path (for example ~/project-name) if the goal creates a new project or writes files outside the current workspace.
- Use ~ for home directory prefix.

If you cannot create a plan because you need more information, respond with:
{ "blocked": true, "question": "The specific question you need answered" }`;
}
