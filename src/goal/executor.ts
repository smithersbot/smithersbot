import type { ProgressReporter } from "../cli/progress.js";
import type { RuntimeEnv } from "../runtime.js";
import type {
  GoalLlmClient,
  GoalOutcome,
  GoalSession,
  Plan,
  PlanStep,
  StepResult,
} from "./types.js";
import { executeTool } from "./tools.js";

export async function executePlan(params: {
  session: GoalSession;
  client: GoalLlmClient;
  workingDir: string;
  runtime: RuntimeEnv;
  progress: ProgressReporter;
  onStepComplete?: () => void;
}): Promise<GoalOutcome> {
  const { session, client, workingDir, runtime, progress } = params;
  const plan = session.plan;
  if (!plan) throw new Error("No plan to execute");

  session.state = "executing";
  const order = topologicalSort(plan.steps);

  for (const step of order) {
    // Skip steps already completed (resume scenario)
    if (step.status === "done" || step.status === "failed" || step.status === "skipped") {
      progress.tick();
      continue;
    }

    // Skip if any dependency failed or was skipped
    const depsOk = step.dependsOn.every((depId) => {
      const result = session.stepResults.get(depId);
      return result?.success === true;
    });
    if (!depsOk) {
      step.status = "skipped";
      runtime.log(`  [-] ${step.id}. ${step.description} (skipped: dependency failed)`);
      progress.tick();
      continue;
    }

    step.status = "running";
    progress.setLabel(`Step ${step.id}: ${step.description}`);
    runtime.log(`  [>] ${step.id}. ${step.description}...`);

    const startMs = Date.now();
    const toolResult = executeTool(step.tool, workingDir);
    const durationMs = Date.now() - startMs;

    const stepResult: StepResult = {
      stepId: step.id,
      success: toolResult.success,
      output: toolResult.output,
      error: toolResult.error,
      durationMs,
    };
    session.stepResults.set(step.id, stepResult);
    progress.tick();

    if (toolResult.success) {
      step.status = "done";
      runtime.log(`  [x] ${step.id}. Done (${durationMs}ms)`);
      params.onStepComplete?.();
    } else {
      step.status = "failed";
      runtime.log(`  [!] ${step.id}. Failed: ${toolResult.error}`);
      params.onStepComplete?.();

      // Ask LLM whether this failure blocks the overall goal
      const verdict = await assessFailure(client, step, toolResult, plan);
      if (verdict.blocked) {
        session.state = "blocked";
        session.blockReason = verdict.question;
        params.onStepComplete?.();
        return { status: "blocked", question: verdict.question };
      }
      // Not blocked: continue with remaining steps (dependents will be skipped)
    }
  }

  session.state = "done";
  return { status: "done", summary: buildDoneSummary(session) };
}

/**
 * Topological sort using Kahn's algorithm. Returns steps in
 * dependency-respecting execution order.
 */
export function topologicalSort(steps: PlanStep[]): PlanStep[] {
  const stepMap = new Map(steps.map((s) => [s.id, s]));
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

  const result: PlanStep[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const step = stepMap.get(current);
    if (step) result.push(step);

    for (const child of adjacency.get(current) ?? []) {
      const newDeg = (inDegree.get(child) ?? 1) - 1;
      inDegree.set(child, newDeg);
      if (newDeg === 0) queue.push(child);
    }
  }

  return result;
}

const ASSESS_SYSTEM_PROMPT = `You are evaluating whether a step failure blocks the overall goal.

Given:
- The original goal
- The failed step and its error
- The remaining plan steps

Determine if the goal is blocked. Respond ONLY with JSON (no markdown fences):
- If blocked: { "blocked": true, "question": "A specific question to ask the user to unblock" }
- If not blocked (remaining steps can still achieve the goal): { "blocked": false }`;

async function assessFailure(
  client: GoalLlmClient,
  failedStep: PlanStep,
  toolResult: { error?: string },
  plan: Plan,
): Promise<{ blocked: boolean; question: string }> {
  try {
    const response = await client.complete({
      systemPrompt: ASSESS_SYSTEM_PROMPT,
      userMessage: [
        `Goal: ${plan.goal}`,
        `Failed step: ${failedStep.id} - ${failedStep.description}`,
        `Error: ${toolResult.error ?? "unknown"}`,
        `Remaining steps: ${plan.steps
          .filter((s) => s.status === "pending")
          .map((s) => `${s.id}: ${s.description}`)
          .join(", ")}`,
      ].join("\n"),
      maxTokens: 512,
    });

    const trimmed = response.text.trim();
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.blocked === true && typeof parsed.question === "string") {
        return { blocked: true, question: parsed.question };
      }
      return { blocked: false, question: "" };
    } catch {
      // If LLM response is not valid JSON, assume not blocked
      return { blocked: false, question: "" };
    }
  } catch {
    // If LLM call itself fails, default to blocked with the original error
    return {
      blocked: true,
      question: `Step "${failedStep.id}" failed: ${toolResult.error ?? "unknown error"}. Is this expected?`,
    };
  }
}

function buildDoneSummary(session: GoalSession): string {
  const results = Array.from(session.stepResults.values());
  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const skipped = session.plan?.steps.filter((s) => s.status === "skipped").length ?? 0;
  const total = session.plan?.steps.length ?? 0;

  const parts = [`${succeeded}/${total} steps completed`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);

  return `Goal "${session.goal}" finished. ${parts.join(", ")}.`;
}
