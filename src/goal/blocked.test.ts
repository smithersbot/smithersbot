import { describe, expect, it } from "vitest";
import { aggregateBlockedDetails } from "./blocked.js";
import type { PlanStep } from "./types.js";

function makeStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: "1",
    description: "Default step",
    shortSummary: "Default step",
    dependsOn: [],
    status: "pending",
    ...overrides,
  };
}

describe("aggregateBlockedDetails", () => {
  it("keeps blocked-only aggregation behavior unchanged", () => {
    const single = aggregateBlockedDetails([
      makeStep({
        id: "A",
        description: "Collect credentials",
        status: "blocked",
        blockedQuestion: "Please provide credentials.",
      }),
    ]);
    expect(single).toEqual({
      blockedAt: "execution",
      prompt: "Please provide credentials.",
      requiredInputKey: "task:A:input",
      stepId: "A",
    });

    const multiple = aggregateBlockedDetails([
      makeStep({
        id: "A",
        description: "Collect credentials",
        status: "blocked",
        blockedQuestion: "Please provide credentials.",
      }),
      makeStep({
        id: "B",
        description: "Provision database",
        status: "blocked",
        blockedReason: "user_input",
      }),
    ]);
    expect(multiple).toEqual({
      blockedAt: "execution",
      prompt:
        "Multiple tasks need attention:\n" +
        "- Task A (Collect credentials): Please provide credentials.\n" +
        "- Task B (Provision database): user_input",
      requiredInputKey: "tasks:A,B:input",
    });
  });

  it("uses resume_execution for in_progress-only steps", () => {
    const detail = aggregateBlockedDetails([
      makeStep({
        id: "2",
        description: "Run migration",
        status: "in_progress",
      }),
      makeStep({
        id: "3",
        description: "Finalize",
        status: "done",
      }),
    ]);

    expect(detail).toEqual({
      blockedAt: "execution",
      prompt: "Step 2 stuck at in_progress — needs re-execution",
      requiredInputKey: "resume_execution",
    });
  });

  it("uses resume_execution for mixed blocked and in_progress steps", () => {
    const detail = aggregateBlockedDetails([
      makeStep({
        id: "1",
        description: "Collect API key",
        status: "blocked",
        blockedQuestion: "Need API key.",
      }),
      makeStep({
        id: "2",
        description: "Execute sync",
        status: "in_progress",
      }),
    ]);

    expect(detail).toEqual({
      blockedAt: "execution",
      prompt:
        "Multiple tasks need attention:\n" +
        "- Task 1 (Collect API key): Need API key.\n" +
        "- Step 2 (Execute sync): Step 2 stuck at in_progress — needs re-execution",
      requiredInputKey: "resume_execution",
    });
  });

  it("deduplicates attempt history shared across cascaded blocked steps", () => {
    const history =
      "Attempt history:\n- Attempt 1 [codex]: failed (error)\n- Attempt 2 [claude_code]: failed (error)";
    const blockedQuestion = `Worker failed/interrupted; resume needed.\n\n${history}`;
    const detail = aggregateBlockedDetails([
      makeStep({
        id: "A",
        description: "Build",
        status: "blocked",
        blockedReason: "error",
        blockedQuestion,
      }),
      makeStep({
        id: "B",
        description: "Test",
        status: "blocked",
        blockedReason: "error",
        blockedQuestion,
      }),
    ]);

    expect(detail).not.toBeNull();
    const prompt = detail!.prompt;
    // Attempt history appears once, not under every step.
    expect(prompt.match(/Attempt history:/g)?.length).toBe(1);
    // Per-step reason lines no longer carry the verbose history.
    expect(prompt).toContain("- Task A (Build): Worker failed/interrupted; resume needed.");
    expect(prompt).toContain("- Task B (Test): Worker failed/interrupted; resume needed.");
    expect(detail!.requiredInputKey).toBe("resume_execution");
  });

  it("returns null when all steps are done", () => {
    const detail = aggregateBlockedDetails([
      makeStep({ id: "1", status: "done" }),
      makeStep({ id: "2", status: "done" }),
    ]);
    expect(detail).toBeNull();
  });
});
