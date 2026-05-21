// Lesson-extraction prompts.
//
// Canonical prompt builders for the per-run lesson-extraction LLM call.
// Used by `src/goal/lessons.ts`.

import type { Lesson } from "../../goal/lessons.js";
import { collapseWhitespace } from "../../goal/cli-output-parsing.js";

const MAX_EXISTING_LESSONS_FOR_PROMPT = 25;

/** Wrap the user-message body for the Claude Code lesson-extraction CLI call. */
export function buildClaudeExtractionPrompt(userPrompt: string): string {
  const systemPrompt = [
    "You extract reusable lessons from a completed engineering goal run.",
    'Output only JSON with shape: {"lessons":[{"pattern":"...","lesson":"...","scope":"project|global","stepId":"optional"}]}',
    'Return {"lessons":[]} when there are no useful new lessons.',
  ].join(" ");
  return ["## System Prompt", systemPrompt, "", "## User Message", userPrompt].join("\n");
}

function buildExistingLessonsSummary(
  existingLessons: Array<Pick<Lesson, "pattern" | "lesson">>,
): string {
  const entries = existingLessons
    .map((entry) => ({
      pattern: collapseWhitespace(entry.pattern),
      lesson: collapseWhitespace(entry.lesson),
    }))
    .filter((entry) => entry.pattern.length > 0 && entry.lesson.length > 0)
    .slice(0, MAX_EXISTING_LESSONS_FOR_PROMPT);
  if (entries.length === 0) return "None.";
  return entries.map((entry) => `- [${entry.pattern}] ${entry.lesson}`).join("\n");
}

/** Build the user message body sent to the lesson-extractor (Claude or Codex). */
export function buildLessonExtractionPrompt(params: {
  runId: string;
  workingDir: string;
  existingLessons: Array<Pick<Lesson, "pattern" | "lesson">>;
  correctionSummary: string;
}): string {
  return [
    "Extract reusable project lessons from this completed goal run.",
    "",
    `Run: ${params.runId}`,
    `Working directory: ${params.workingDir}`,
    "",
    "Existing lessons (do not duplicate or paraphrase these):",
    buildExistingLessonsSummary(params.existingLessons),
    "",
    "Correction summary artifacts:",
    params.correctionSummary,
    "",
    "Critical framing:",
    "- Every correction in this summary has ALREADY been applied to the codebase; the code is in its fully fixed, committed state.",
    "- The worker on the next run will see the fixed code directly.",
    "- Only create a lesson if it captures a forward-looking principle that would NOT be obvious from reading the current source code.",
    "",
    "Return ONLY JSON with this shape:",
    '{ "lessons": [{ "pattern": "short-keyword", "lesson": "1-3 sentence insight", "scope": "project|global", "stepId": "optional step id" }] }',
    "",
    "Rules:",
    "- Lessons are ONLY for improving the worker prompt (the CLI agent executing individual plan steps).",
    "- Do NOT include advice for the planner, plan autocheck/reviewer, manual-test suggester, post-execution reviewer, or any other LLM surface.",
    "- Only include lessons about issues that actually caused problems or confusion in this run.",
    "- Lessons must encode forward-looking principles that improve future worker decisions and are not obvious from current source.",
    "- Reject any candidate that merely describes what was changed or fixed in this run.",
    "- Reject any candidate that gives advice about things the worker cannot control (for example system config, hardcoded build-gate policy, Semgrep severity/excludes).",
    "- Reject any candidate that works around a flaky code path instead of fixing code.",
    "- Reject any candidate that restates implementation details already visible in source.",
    "- Pattern should be short and specific (kebab-case preferred).",
    "- Lesson text should be concrete and generalizable.",
    '- Classify scope for each lesson: "global" for principles that apply to any project, "project" for lessons specific to this working directory.',
    "- If unsure whether a lesson should be included, do not include it.",
    '- If no useful new lessons exist, return exactly: {"lessons":[]}.',
  ].join("\n");
}
