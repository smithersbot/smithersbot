import { describe, expect, it, vi } from "vitest";
import { generateManualTests } from "./manual-tests.js";
import type { GoalLlmClient, PlanStep } from "./types.js";

function makeClient(response: string): GoalLlmClient {
  return {
    complete: vi.fn().mockResolvedValue({ text: response }),
  };
}

function makeDoneSteps(): PlanStep[] {
  return [
    {
      id: "1",
      description: "Implement login validation",
      dependsOn: [],
      status: "done",
      taskSummary: "Added server-side validation and error messaging",
    },
    {
      id: "2",
      description: "Add session timeout handling",
      dependsOn: ["1"],
      status: "done",
      taskSummary: "Added timeout warning modal and renewal flow",
    },
    {
      id: "3",
      description: "Cover auth edge cases in tests",
      dependsOn: ["1", "2"],
      status: "done",
      taskSummary: "Added coverage for stale token and refresh failures",
    },
  ];
}

describe("generateManualTests", () => {
  it("parses model suggestions and formats criticality in range", async () => {
    const client = makeClient(
      JSON.stringify({
        tests: [
          {
            description: "Verify login with invalid credentials",
            criticality: 11,
            detail:
              "Attempt login with a bad password and confirm inline error appears without crashing.",
          },
          {
            description: "Verify timeout warning and renewal",
            criticality: "8",
            reason: "Needs a real browser idle session",
            detail:
              "Stay idle until timeout warning appears, then renew and confirm session persists.",
          },
          {
            description: "Verify refresh-token failure path",
            criticality: 7.4,
            detail:
              "Force refresh failure and ensure user is redirected to login with a clear message.",
          },
        ],
      }),
    );

    const tests = await generateManualTests({
      goal: "Improve authentication reliability",
      steps: makeDoneSteps(),
      client,
    });

    expect(tests).toHaveLength(3);
    expect(tests[0]).toEqual({
      description: "Verify login with invalid credentials",
      criticality: 10,
      detail:
        "Attempt login with a bad password and confirm inline error appears without crashing.",
    });
    expect(tests[1]?.criticality).toBe(8);
    expect(tests[1]?.reason).toBe("Needs a real browser idle session");
    expect(tests[2]?.criticality).toBe(7);
  });

  it("throws when model call fails with auth error", async () => {
    const client: GoalLlmClient = {
      complete: vi
        .fn()
        .mockRejectedValue(
          new Error(
            '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
          ),
        ),
    };

    await expect(
      generateManualTests({
        goal: "Improve authentication reliability",
        steps: makeDoneSteps(),
        client,
      }),
    ).rejects.toThrow(/authentication_error/i);
  });

  it("throws when ANTHROPIC_API_KEY is missing and no client is injected", async () => {
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    const originalVitest = process.env.VITEST;
    const originalPoolId = process.env.VITEST_POOL_ID;
    const originalWorkerId = process.env.VITEST_WORKER_ID;
    const originalNodeEnv = process.env.NODE_ENV;

    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.VITEST;
    delete process.env.VITEST_POOL_ID;
    delete process.env.VITEST_WORKER_ID;
    process.env.NODE_ENV = "development";

    try {
      await expect(
        generateManualTests({
          goal: "Improve authentication reliability",
          steps: makeDoneSteps(),
        }),
      ).rejects.toThrow("ANTHROPIC_API_KEY is required to generate manual tests.");
    } finally {
      if (originalApiKey == null) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalApiKey;
      if (originalVitest == null) delete process.env.VITEST;
      else process.env.VITEST = originalVitest;
      if (originalPoolId == null) delete process.env.VITEST_POOL_ID;
      else process.env.VITEST_POOL_ID = originalPoolId;
      if (originalWorkerId == null) delete process.env.VITEST_WORKER_ID;
      else process.env.VITEST_WORKER_ID = originalWorkerId;
      if (originalNodeEnv == null) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("returns an empty array when the model explicitly returns tests: []", async () => {
    const client = makeClient(
      JSON.stringify({
        tests: [],
        message: "All functionality was verified automatically",
      }),
    );

    const manualTests = await generateManualTests({
      goal: "Improve authentication reliability",
      steps: makeDoneSteps(),
      client,
    });

    expect(manualTests).toEqual([]);
  });

  it("tops up with fallback tests when the model returns fewer tests than required", async () => {
    const client = makeClient(
      JSON.stringify({
        tests: [
          {
            description: "Test real login error banner",
            criticality: 7,
            reason: "Requires browser interaction",
            detail:
              "Step 1. Submit invalid credentials in the live UI.\nStep 2. Confirm the error banner appears.",
          },
        ],
      }),
    );

    const manualTests = await generateManualTests({
      goal: "Improve authentication reliability",
      steps: makeDoneSteps(),
      client,
      minTests: 3,
    });

    expect(manualTests).toHaveLength(3);
    expect(manualTests[1]).toMatchObject({
      description: "Test login validation",
      criticality: 6,
      reason: "Automated test generation returned fewer suggestions than expected.",
    });
    expect(manualTests[2]).toMatchObject({
      description: "Test session timeout handling",
      criticality: 5,
      reason: "Automated test generation returned fewer suggestions than expected.",
    });
    expect(manualTests[1]?.description.startsWith("Validate:")).toBe(false);
    expect(manualTests[2]?.description.startsWith("Validate:")).toBe(false);
  });
});
