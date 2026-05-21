// Post-execution review prompt builder.
//
// Canonical builder for the post-goal code review prompt that runs after a
// plan completes. Used by `src/goal/post-execution-review.ts`.

import type { PlanStep } from "../../goal/types.js";

export function buildPostExecutionReviewPrompt(params: {
  goal: string;
  steps: PlanStep[];
  diff: string;
}): string {
  const stepLines = params.steps.map((step, index) => {
    const headline = step.shortSummary?.trim() || step.description.trim();
    const successCriteria = step.successCriteria?.trim();
    const summary = step.taskSummary?.trim();
    return [
      `${index + 1}. ${step.id} — ${headline}`,
      successCriteria ? `   Success criteria: ${successCriteria}` : "",
      summary ? `   Result: ${summary}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  return [
    "Review this diff for: verify that per-step success criteria were met, code quality issues, missed edge cases, unnecessary complexity, security concerns, leftover debug code, incomplete error handling.",
    "",
    "Goal description:",
    params.goal,
    "",
    "Plan step summaries:",
    ...(stepLines.length > 0 ? stepLines : ["(no steps)"]),
    "",
    "Full diff:",
    "```diff",
    params.diff || "(no diff output)",
    "```",
    "",
    'Return ONLY JSON with shape: {"approved": boolean, "issues": string[]}.',
    "When approved is true, issues may be empty.",
    "When approved is false, include concrete actionable issues.",
  ].join("\n");
}
