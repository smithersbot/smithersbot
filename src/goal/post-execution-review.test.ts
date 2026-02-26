import { describe, expect, it } from "vitest";

import {
  buildPostExecutionReviewPrompt,
  parsePostExecutionReviewDecision,
  parsePostExecutionReviewDecisionFromText,
} from "./post-execution-review.js";
import type { PlanStep } from "./types.js";

function createPlanStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: "step-1",
    description: "Implement feature",
    shortSummary: "Implement feature",
    dependsOn: [],
    status: "pending",
    ...overrides,
  };
}

describe("parsePostExecutionReviewDecisionFromText", () => {
  it("parses valid JSON decisions", () => {
    const decision = parsePostExecutionReviewDecisionFromText(
      '{"approved":true,"issues":["Looks good"]}',
    );

    expect(decision).toEqual({ approved: true, issues: ["Looks good"] });
  });

  it("repairs a trailing extra closing brace", () => {
    const decision = parsePostExecutionReviewDecisionFromText(
      '{"approved":false,"issues":["Missing tests"]}}',
    );

    expect(decision).toEqual({ approved: false, issues: ["Missing tests"] });
  });

  it("repairs malformed JSONL lines", () => {
    const decision = parsePostExecutionReviewDecisionFromText(
      ["status update", '{"approved":true,"issues":[]}}', "done"].join("\n"),
    );

    expect(decision).toEqual({ approved: true, issues: [] });
  });

  it("extracts and repairs prose-wrapped JSON candidates", () => {
    const decision = parsePostExecutionReviewDecisionFromText(
      'Decision: {"approved":false,"issues":["Handle ENOENT",],} please address.',
    );

    expect(decision).toEqual({ approved: false, issues: ["Handle ENOENT"] });
  });
});

describe("parsePostExecutionReviewDecision", () => {
  it("repairs malformed stream-json lines before parsing", () => {
    const stdout = [
      '{"type":"assistant","content":[{"text":"reviewing"}]}',
      '{"type":"result","result":{"approved":true,"issues":[]}}}',
    ].join("\n");

    const decision = parsePostExecutionReviewDecision(stdout);

    expect(decision).toEqual({ approved: true, issues: [] });
  });
});

describe("buildPostExecutionReviewPrompt", () => {
  it("includes per-step success criteria when present", () => {
    const prompt = buildPostExecutionReviewPrompt({
      goal: "Ship feature",
      diff: "diff --git a/a b/a",
      steps: [
        createPlanStep({
          id: "step-ship",
          shortSummary: "Ship the feature",
          successCriteria: "Feature is reachable from CLI",
          taskSummary: "Added command and tests",
        }),
      ],
    });

    expect(prompt).toContain("Success criteria: Feature is reachable from CLI");
  });

  it("omits success criteria line when a step does not define it", () => {
    const prompt = buildPostExecutionReviewPrompt({
      goal: "Ship feature",
      diff: "diff --git a/a b/a",
      steps: [
        createPlanStep({
          id: "step-ship",
          shortSummary: "Ship the feature",
          successCriteria: undefined,
          taskSummary: "Added command and tests",
        }),
      ],
    });

    expect(prompt).not.toContain("Success criteria:");
  });

  it("mentions verifying success criteria in the review instructions", () => {
    const prompt = buildPostExecutionReviewPrompt({
      goal: "Ship feature",
      diff: "",
      steps: [createPlanStep()],
    });

    expect(prompt).toContain("verify that per-step success criteria were met");
  });
});
