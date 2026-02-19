import { describe, expect, it } from "vitest";
import { buildFeedbackRevisionInstructions, mergeRevisedPlanWithDoneSteps } from "./feedback.js";
import type { Plan } from "./types.js";

describe("goal feedback planning helpers", () => {
  it("builds revision instructions that include the user feedback text", () => {
    const instructions = buildFeedbackRevisionInstructions("Login button is broken on Safari.");
    expect(instructions).toContain("Manual test feedback");
    expect(instructions).toContain("Login button is broken on Safari.");
    expect(instructions).toContain("Keep previously completed steps");
  });

  it("preserves done steps, re-inserts omitted done steps, and strips dangling dependencies", () => {
    const originalPlan: Plan = {
      goal: "Ship signup flow",
      summary: "Original",
      shortSummary: "Ship signup flow",
      steps: [
        {
          id: "1",
          description: "Build form",
          shortSummary: "Build form",
          dependsOn: [],
          status: "done",
        },
        {
          id: "2",
          description: "Add validation",
          shortSummary: "Add validation",
          dependsOn: ["1"],
          status: "done",
        },
        {
          id: "3",
          description: "Implement API",
          shortSummary: "Implement API",
          dependsOn: ["2"],
          status: "done",
        },
      ],
    };

    const revisedPlan: Plan = {
      goal: "Ship signup flow",
      summary: "Revised from feedback",
      shortSummary: "Fix Safari signup issue",
      steps: [
        {
          id: "1",
          description: "Changed by planner",
          shortSummary: "Changed title",
          dependsOn: [],
          status: "pending",
        },
        {
          id: "4",
          description: "Fix Safari edge-case",
          shortSummary: "Fix Safari edge case",
          dependsOn: ["3", "missing"],
          status: "pending",
        },
      ],
    };

    const merged = mergeRevisedPlanWithDoneSteps({ originalPlan, revisedPlan });
    expect(merged.summary).toBe("Revised from feedback");
    expect(merged.shortSummary).toBe("Fix Safari signup issue");
    expect(merged.steps.map((step) => step.id)).toEqual(["1", "2", "3", "4"]);

    const step1 = merged.steps.find((step) => step.id === "1");
    const step2 = merged.steps.find((step) => step.id === "2");
    const step3 = merged.steps.find((step) => step.id === "3");
    const step4 = merged.steps.find((step) => step.id === "4");

    expect(step1?.status).toBe("done");
    expect(step1?.description).toBe("Build form");
    expect(step1?.shortSummary).toBe("Build form");
    expect(step2?.status).toBe("done");
    expect(step3?.status).toBe("done");
    expect(step4?.status).toBe("pending");
    expect(step4?.shortSummary).toBe("Fix Safari edge case");
    expect(step4?.dependsOn).toEqual(["3"]);
  });

  it("preserves all completed steps across iterative feedback rounds", () => {
    const baseDonePlan: Plan = {
      goal: "Fix release",
      summary: "Done",
      steps: [
        { id: "1", description: "Initial fix", dependsOn: [], status: "done" },
        { id: "2", description: "Regression test", dependsOn: ["1"], status: "done" },
      ],
    };

    const firstRevision: Plan = {
      goal: "Fix release",
      summary: "First feedback revision",
      steps: [
        { id: "1", description: "Initial fix", dependsOn: [], status: "pending" },
        { id: "3", description: "Fix crash in Safari", dependsOn: ["1"], status: "pending" },
      ],
    };
    const firstMerged = mergeRevisedPlanWithDoneSteps({
      originalPlan: baseDonePlan,
      revisedPlan: firstRevision,
    });

    // Simulate completion of the first feedback round.
    const firstRoundDone: Plan = {
      ...firstMerged,
      steps: firstMerged.steps.map((step) => ({ ...step, status: "done" as const })),
    };

    const secondRevision: Plan = {
      goal: "Fix release",
      summary: "Second feedback revision",
      steps: [
        { id: "1", description: "Initial fix", dependsOn: [], status: "pending" },
        { id: "4", description: "Fix iOS rendering bug", dependsOn: ["3"], status: "pending" },
      ],
    };

    const secondMerged = mergeRevisedPlanWithDoneSteps({
      originalPlan: firstRoundDone,
      revisedPlan: secondRevision,
    });

    expect(secondMerged.steps.find((step) => step.id === "1")?.status).toBe("done");
    expect(secondMerged.steps.find((step) => step.id === "2")?.status).toBe("done");
    expect(secondMerged.steps.find((step) => step.id === "3")?.status).toBe("done");
    expect(secondMerged.steps.find((step) => step.id === "4")?.status).toBe("pending");
  });
});
