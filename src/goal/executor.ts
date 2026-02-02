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
import { computeCriticalPathScores, orderStepsCriticalPathFirst } from "./plan-order.js";

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
  const scores = computeCriticalPathScores(plan.steps);
  const order = orderStepsCriticalPathFirst(plan.steps, scores);

  for (const step of order) {
    // Skip steps already completed or blocked (resume scenario)
    if (step.status === "done" || step.status === "blocked") {
      progress.tick();
      continue;
    }

    // Block if any dependency is not successfully completed
    const depsOk = step.dependsOn.every((depId) => {
      const result = session.stepResults.get(depId);
      return result?.success === true;
    });
    if (!depsOk) {
      step.status = "blocked";
      step.blockedReason = "error";
      step.blockedQuestion = "Dependency failed — replan or resume needed.";
      runtime.log(`  [!] ${step.id}. ${step.description} (blocked: dependency failed)`);
      progress.tick();
      continue;
    }

    step.status = "in_progress";
    progress.setLabel(`Step ${step.id}: ${step.description}`);
    runtime.log(`  [>] ${step.id}. ${step.description}...`);

    // request_user_input: mark step blocked immediately (no tool execution)
    if (step.tool.name === "request_user_input") {
      const question = step.tool.args.question ?? "User input needed";
      step.status = "blocked";
      step.blockedReason = "user_input";
      step.blockedQuestion = question;
      runtime.log(`  [!] ${step.id}. Blocked: ${question}`);
      session.stepResults.set(step.id, {
        stepId: step.id,
        success: false,
        output: "",
        error: question,
        durationMs: 0,
      });
      progress.tick();

      session.state = "blocked";
      session.blocked = {
        prompt: question,
        requiredInputKey: `step:${step.id}:input`,
      };
      params.onStepComplete?.();
      return {
        status: "blocked",
        question,
        requiredInputKey: `step:${step.id}:input`,
      };
    }

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
      step.status = "blocked";
      step.blockedReason = "error";
      step.blockedQuestion = toolResult.error ?? "Step failed";
      runtime.log(`  [!] ${step.id}. Blocked: ${toolResult.error}`);
      params.onStepComplete?.();

      // Ask LLM whether this failure blocks the overall goal
      const verdict = await assessFailure(client, step, toolResult, plan);
      if (verdict.blocked) {
        session.state = "blocked";
        session.blocked = {
          prompt: verdict.question,
          requiredInputKey: verdict.requiredInputKey,
        };
        params.onStepComplete?.();
        return {
          status: "blocked",
          question: verdict.question,
          requiredInputKey: verdict.requiredInputKey,
        };
      }
      // Not blocked: continue with remaining steps (dependents will be skipped)
    }
  }

  session.state = "done";
  return { status: "done", summary: buildDoneSummary(session) };
}

const ASSESS_SYSTEM_PROMPT = `You are evaluating whether a step failure blocks the overall goal.

Given:
- The original goal
- The failed step and its error
- The remaining plan steps

Determine if the goal is blocked. Respond ONLY with JSON (no markdown fences):
- If blocked: { "blocked": true, "question": "A specific question to ask the user to unblock", "requiredInputKey": "a_snake_case_key_for_the_missing_input" }
- If not blocked (remaining steps can still achieve the goal): { "blocked": false }`;

async function assessFailure(
  client: GoalLlmClient,
  failedStep: PlanStep,
  toolResult: { error?: string },
  plan: Plan,
): Promise<{ blocked: boolean; question: string; requiredInputKey: string }> {
  const fallbackKey = `step:${failedStep.id}:input`;
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
        const key =
          typeof parsed.requiredInputKey === "string" && parsed.requiredInputKey
            ? parsed.requiredInputKey
            : fallbackKey;
        return { blocked: true, question: parsed.question, requiredInputKey: key };
      }
      return { blocked: false, question: "", requiredInputKey: "" };
    } catch {
      return { blocked: false, question: "", requiredInputKey: "" };
    }
  } catch {
    return {
      blocked: true,
      question: `Step "${failedStep.id}" failed: ${toolResult.error ?? "unknown error"}. Is this expected?`,
      requiredInputKey: fallbackKey,
    };
  }
}

function buildDoneSummary(session: GoalSession): string {
  const results = Array.from(session.stepResults.values());
  const succeeded = results.filter((r) => r.success).length;
  const blocked = session.plan?.steps.filter((s) => s.status === "blocked").length ?? 0;
  const total = session.plan?.steps.length ?? 0;

  const parts = [`${succeeded}/${total} steps completed`];
  if (blocked > 0) parts.push(`${blocked} blocked`);

  return `Goal "${session.goal}" finished. ${parts.join(", ")}.`;
}
