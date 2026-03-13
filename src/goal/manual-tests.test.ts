import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoalLlmClient, PlanStep } from "./types.js";

const runCliProcessMock = vi.fn();
const resolveClaudeBinaryMock = vi.fn();
const buildClaudeCodeEnvMock = vi.fn();

vi.mock("./cli-process.js", () => ({
  runCliProcess: (...args: unknown[]) => runCliProcessMock(...args),
}));

vi.mock("./scout.js", () => ({
  resolveClaudeBinary: (...args: unknown[]) => resolveClaudeBinaryMock(...args),
}));

vi.mock("./claude-code-env.js", () => ({
  buildClaudeCodeEnv: (...args: unknown[]) => buildClaudeCodeEnvMock(...args),
}));

import { clampCriticality, generateManualTests } from "./manual-tests.js";

describe("clampCriticality", () => {
  it("defaults invalid values to 5", () => {
    expect(clampCriticality(Number.NaN)).toBe(5);
    expect(clampCriticality("not-a-number")).toBe(5);
  });
});

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

function makeCliResultOutput(text: string): string {
  return JSON.stringify({
    result: [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text }],
        },
      },
    ],
  });
}

async function withNonTestEnv<T>(fn: () => Promise<T>): Promise<T> {
  const originalVitest = process.env.VITEST;
  const originalPoolId = process.env.VITEST_POOL_ID;
  const originalWorkerId = process.env.VITEST_WORKER_ID;
  const originalNodeEnv = process.env.NODE_ENV;

  delete process.env.VITEST;
  delete process.env.VITEST_POOL_ID;
  delete process.env.VITEST_WORKER_ID;
  process.env.NODE_ENV = "development";

  try {
    return await fn();
  } finally {
    if (originalVitest == null) delete process.env.VITEST;
    else process.env.VITEST = originalVitest;
    if (originalPoolId == null) delete process.env.VITEST_POOL_ID;
    else process.env.VITEST_POOL_ID = originalPoolId;
    if (originalWorkerId == null) delete process.env.VITEST_WORKER_ID;
    else process.env.VITEST_WORKER_ID = originalWorkerId;
    if (originalNodeEnv == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
}

describe("generateManualTests", () => {
  beforeEach(() => {
    runCliProcessMock.mockReset();
    resolveClaudeBinaryMock.mockReset();
    buildClaudeCodeEnvMock.mockReset();
    resolveClaudeBinaryMock.mockReturnValue("/usr/bin/claude");
    buildClaudeCodeEnvMock.mockReturnValue({ CLAUDE_AUTH: "subscription" });
  });

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

  it("retries once when the first response is unparseable and then succeeds", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const complete = vi
      .fn()
      .mockResolvedValueOnce({ text: "not valid json" })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          tests: [
            {
              description: "Verify timeout warning and renewal",
              criticality: 8,
              reason: "Needs an idle real browser session",
              detail:
                "Stay idle until timeout warning appears, then renew and confirm session persists.",
            },
          ],
        }),
      });
    const client: GoalLlmClient = { complete };

    try {
      const pending = generateManualTests({
        goal: "Improve authentication reliability",
        steps: makeDoneSteps(),
        client,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(complete).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(complete).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      const manualTests = await pending;

      expect(complete).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain("retrying in 2000ms");
      expect(manualTests).toEqual([
        {
          description: "Verify timeout warning and renewal",
          criticality: 8,
          reason: "Needs an idle real browser session",
          detail:
            "Stay idle until timeout warning appears, then renew and confirm session persists.",
        },
      ]);
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("throws when the claude binary cannot be resolved and no client is injected", async () => {
    resolveClaudeBinaryMock.mockReturnValueOnce(null);

    await expect(
      withNonTestEnv(() =>
        generateManualTests({
          goal: "Improve authentication reliability",
          steps: makeDoneSteps(),
        }),
      ),
    ).rejects.toThrow("claude binary not found on PATH");
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
    expect(manualTests[1]?.detail).toContain("**Step 1.**");
    expect(manualTests[1]?.detail).toContain("**Step 2.**");
    expect(manualTests[2]?.detail).toContain("**Step 1.**");
    expect(manualTests[2]?.detail).toContain("**Step 2.**");
  });

  it("runs Claude CLI with subscription auth when no client is injected", async () => {
    runCliProcessMock.mockResolvedValueOnce({
      stdout: makeCliResultOutput(JSON.stringify({ tests: [] })),
      stderr: "",
      timedOut: false,
      exitCode: 0,
      signal: null,
      durationMs: 42,
    });

    await withNonTestEnv(() =>
      generateManualTests({
        goal: "Improve authentication reliability",
        steps: makeDoneSteps(),
      }),
    );

    expect(resolveClaudeBinaryMock).toHaveBeenCalledTimes(1);
    expect(buildClaudeCodeEnvMock).toHaveBeenCalledWith("subscription");

    const call = runCliProcessMock.mock.calls[0]?.[0] as {
      command: string;
      args: string[];
      cwd: string;
      timeoutMs: number;
      stdin: string;
      env: Record<string, string>;
    };
    expect(call.command).toBe("/usr/bin/claude");
    expect(call.args).toEqual(["-p", "--output-format", "json", "--max-turns", "1"]);
    expect(call.cwd).toBe(process.cwd());
    expect(call.timeoutMs).toBe(300_000);
    expect(call.env).toEqual({ CLAUDE_AUTH: "subscription" });
    expect(call.stdin).toContain("## System Prompt");
    expect(call.stdin).toContain("You are a QA assistant");
    expect(call.stdin).toContain("## User Message");
    expect(call.stdin).toContain("Goal: Improve authentication reliability");
  });

  it("parses manual test suggestions from Claude CLI JSON output", async () => {
    runCliProcessMock.mockResolvedValueOnce({
      stdout: makeCliResultOutput(
        JSON.stringify({
          tests: [
            {
              description: "Test Telegram message splitting",
              criticality: 6,
              reason: "Requires a real Telegram client",
              detail:
                "Step 1. Send a long /new_goal message in Telegram.\nStep 2. Confirm the full prompt is preserved.",
            },
          ],
        }),
      ),
      stderr: "",
      timedOut: false,
      exitCode: 0,
      signal: null,
      durationMs: 33,
    });

    const manualTests = await withNonTestEnv(() =>
      generateManualTests({
        goal: "Improve authentication reliability",
        steps: makeDoneSteps(),
      }),
    );

    expect(manualTests).toEqual([
      {
        description: "Test Telegram message splitting",
        criticality: 6,
        reason: "Requires a real Telegram client",
        detail:
          "Step 1. Send a long /new_goal message in Telegram.\nStep 2. Confirm the full prompt is preserved.",
      },
    ]);
  });

  it("returns [] when Claude CLI returns an explicit empty tests array", async () => {
    runCliProcessMock.mockResolvedValueOnce({
      stdout: makeCliResultOutput(
        JSON.stringify({
          tests: [],
          message: "All functionality was verified automatically",
        }),
      ),
      stderr: "",
      timedOut: false,
      exitCode: 0,
      signal: null,
      durationMs: 29,
    });

    const manualTests = await withNonTestEnv(() =>
      generateManualTests({
        goal: "Improve authentication reliability",
        steps: makeDoneSteps(),
      }),
    );

    expect(manualTests).toEqual([]);
  });

  it("throws when the Claude CLI subprocess fails", async () => {
    runCliProcessMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "permission denied",
      timedOut: false,
      exitCode: 1,
      signal: null,
      durationMs: 19,
    });

    await expect(
      withNonTestEnv(() =>
        generateManualTests({
          goal: "Improve authentication reliability",
          steps: makeDoneSteps(),
        }),
      ),
    ).rejects.toThrow("Manual test generation failed: permission denied");
  });
});
