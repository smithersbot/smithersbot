import type { Plan, PlanStep } from "./types.js";
import { parseShortSummary } from "./plan-text.js";

const PLAN_SHORT_SUMMARY_MAX_CHARS = 80;
const STEP_SHORT_SUMMARY_MAX_CHARS = 60;

function cloneStep(step: PlanStep): PlanStep {
  return {
    ...step,
    shortSummary: parseShortSummary(
      step.shortSummary,
      step.description || step.id,
      STEP_SHORT_SUMMARY_MAX_CHARS,
    ),
    dependsOn: [...step.dependsOn],
    ...(step.failedDetail ? { failedDetail: { ...step.failedDetail } } : {}),
  };
}

function normalizeNewStep(step: PlanStep): PlanStep {
  return {
    ...cloneStep(step),
    status: "pending",
    turnsUsed: undefined,
    blockedQuestion: undefined,
    blockedReason: undefined,
    taskSummary: undefined,
    failedDetail: undefined,
  };
}

function stripDanglingDependencies(steps: PlanStep[]): void {
  const validIds = new Set(steps.map((step) => step.id));
  for (const step of steps) {
    const nextDependsOn: string[] = [];
    for (const depId of step.dependsOn) {
      if (depId === step.id) continue;
      if (!validIds.has(depId)) continue;
      if (nextDependsOn.includes(depId)) continue;
      nextDependsOn.push(depId);
    }
    step.dependsOn = nextDependsOn;
  }
}

/** Build revision instructions for the "Incorporate Feedback" flow. */
export function buildFeedbackRevisionInstructions(feedbackText: string): string {
  return [
    "Manual test feedback was provided after execution.",
    "Revise the plan to add only the additional fix/improvement steps needed.",
    "Keep previously completed steps represented in the revised plan (same IDs when possible).",
    "Do not remove already completed work.",
    "",
    `Feedback: ${feedbackText.trim()}`,
  ].join("\n");
}

/**
 * Merge a revised plan with all previously done steps from the original plan.
 * Done steps are preserved as done and re-inserted if omitted by the revised output.
 */
export function mergeRevisedPlanWithDoneSteps(params: {
  originalPlan: Plan;
  revisedPlan: Plan;
}): Plan {
  const { originalPlan, revisedPlan } = params;

  const doneStepsWithIndex = originalPlan.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.status === "done");

  const doneById = new Map(doneStepsWithIndex.map(({ step, index }) => [step.id, { step, index }]));

  const mergedSteps: PlanStep[] = revisedPlan.steps.map((step) => {
    const doneEntry = doneById.get(step.id);
    if (doneEntry) {
      return cloneStep(doneEntry.step);
    }
    return normalizeNewStep(step);
  });

  const presentDoneIds = new Set(mergedSteps.map((step) => step.id));
  for (const { step, index } of doneStepsWithIndex.sort((a, b) => a.index - b.index)) {
    if (presentDoneIds.has(step.id)) continue;
    const insertAt = Math.min(index, mergedSteps.length);
    mergedSteps.splice(insertAt, 0, cloneStep(step));
    presentDoneIds.add(step.id);
  }

  stripDanglingDependencies(mergedSteps);

  return {
    goal: originalPlan.goal,
    workingDir: revisedPlan.workingDir,
    summary: revisedPlan.summary,
    buildGate: revisedPlan.buildGate ?? originalPlan.buildGate,
    shortSummary: parseShortSummary(
      revisedPlan.shortSummary,
      revisedPlan.summary || originalPlan.summary,
      PLAN_SHORT_SUMMARY_MAX_CHARS,
    ),
    steps: mergedSteps,
  };
}
