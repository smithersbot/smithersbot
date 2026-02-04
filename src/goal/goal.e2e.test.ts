import { describe, expect, it } from "vitest";
import { createGoalLlmClient } from "./llm-client.js";
import { generatePlan } from "./planner.js";

describe.skipIf(!process.env.CLAWDBOT_LIVE_TEST)("goal e2e (live LLM)", () => {
  it("generates a valid plan for a simple goal", async () => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY required for live test");

    const client = createGoalLlmClient({ apiKey });
    const result = await generatePlan(client, "Create a hello-world index.html file");

    expect("blocked" in result).toBe(false);
    if (!("blocked" in result)) {
      expect(result.steps.length).toBeGreaterThan(0);
      expect(result.summary).toBeTruthy();
      // All steps should have valid structure
      for (const step of result.steps) {
        expect(step.id).toBeTruthy();
        expect(step.description).toBeTruthy();
      }
    }
  }, 30_000);
});
