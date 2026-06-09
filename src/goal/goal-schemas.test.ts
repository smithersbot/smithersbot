import { describe, expect, it } from "vitest";
import { GoalWorkerOutputSchema, PlanInputSchema } from "./goal-schemas.js";

function parseSingleStep(step: unknown) {
  return PlanInputSchema.safeParse({
    goal: "Goal",
    workingDir: "/tmp/moltbot",
    steps: [step],
  });
}

describe("goal-schemas", () => {
  describe("GoalWorkerOutputSchema", () => {
    it("accepts all valid worker output variants", () => {
      const complete = GoalWorkerOutputSchema.safeParse({
        status: "complete",
        summary: "Updated tests and fixed lint issues",
      });
      const blocked = GoalWorkerOutputSchema.safeParse({
        status: "blocked",
        question: "Should I target Node 22 or Node 24?",
      });
      const ralph = GoalWorkerOutputSchema.safeParse({
        status: "ralph",
        approachTried: "Patched imports manually",
        specificErrors: "Build still fails with unresolved aliases",
        keyInsight: "Alias resolution happens before tsconfig path mapping",
        suggestedApproach: "Update shared resolver and rerun build",
      });
      const failed = GoalWorkerOutputSchema.safeParse({
        status: "failed",
        reason: "CI job timed out",
        whatTried: "Retried with the same command",
        errorType: "timeout",
        suggestedNext: "Narrow test scope for this run",
        needsRevert: false,
      });

      expect(complete.success).toBe(true);
      expect(blocked.success).toBe(true);
      expect(ralph.success).toBe(true);
      expect(failed.success).toBe(true);
    });

    it("rejects invalid worker output payloads", () => {
      const missingSummary = GoalWorkerOutputSchema.safeParse({
        status: "complete",
      });
      const unknownStatus = GoalWorkerOutputSchema.safeParse({
        status: "done",
        summary: "ok",
      });
      const emptyRalphField = GoalWorkerOutputSchema.safeParse({
        status: "ralph",
        approachTried: "   ",
        specificErrors: "errors",
        keyInsight: "insight",
        suggestedApproach: "next",
      });

      expect(missingSummary.success).toBe(false);
      expect(unknownStatus.success).toBe(false);
      expect(emptyRalphField.success).toBe(false);
    });
  });

  describe("Plan step shape", () => {
    it("accepts valid planner step input with optional fields", () => {
      const parsed = parseSingleStep({
        id: 1,
        description: "Implement CLI prompt changes and update tests",
        shortSummary: "Implement prompt updates",
        successCriteria: "Target tests pass and prompt text is updated",
        constraints: ["Do not modify unrelated command files"],
        dependsOn: ["bootstrap"],
        durationMinutes: 12.4,
        backend: "codex",
        requiresDevGatewayControl: true,
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.steps[0]?.requiresDevGatewayControl).toBe(true);
      }
    });

    it("rejects invalid planner step input", () => {
      const missingRequiredFields = parseSingleStep({
        id: "step-1",
        dependsOn: [],
      });
      const invalidDependsOn = parseSingleStep({
        id: "step-1",
        description: "Run tests",
        backend: "claude_code",
        dependsOn: "step-0",
      });

      expect(missingRequiredFields.success).toBe(false);
      expect(invalidDependsOn.success).toBe(false);
    });
  });

  describe("PlanInputSchema", () => {
    it("accepts a valid plan input shape", () => {
      const parsed = PlanInputSchema.safeParse({
        goal: "Harden goal worker validation",
        workingDir: "/tmp/moltbot",
        summary: "Add schemas and wire validation",
        shortSummary: "Harden goal worker validation",
        buildGate: {
          commands: ["pnpm build", "pnpm vitest run src/goal/"],
          runBetweenSteps: true,
          postExecutionReview: false,
        },
        steps: [
          {
            id: "create-schemas",
            description: "Add goal-schemas.ts and tests",
            dependsOn: [],
            durationMinutes: 10,
            backend: "codex",
          },
        ],
      });

      expect(parsed.success).toBe(true);
    });

    it("rejects invalid plan input payloads", () => {
      const missingGoal = PlanInputSchema.safeParse({
        workingDir: "/tmp/moltbot",
        steps: [
          {
            id: "step-1",
            description: "Do work",
            backend: "codex",
          },
        ],
      });
      const emptySteps = PlanInputSchema.safeParse({
        goal: "Goal",
        workingDir: "/tmp/moltbot",
        steps: [],
      });
      const invalidBuildGate = PlanInputSchema.safeParse({
        goal: "Goal",
        workingDir: "/tmp/moltbot",
        steps: [
          {
            id: "step-1",
            description: "Do work",
            backend: "codex",
          },
        ],
        buildGate: {
          commands: ["pnpm build"],
          runBetweenSteps: "yes",
        },
      });

      expect(missingGoal.success).toBe(false);
      expect(emptySteps.success).toBe(false);
      expect(invalidBuildGate.success).toBe(false);
    });
  });
});
