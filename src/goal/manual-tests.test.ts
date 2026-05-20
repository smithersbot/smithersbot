import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoalLlmClient, PlanStep } from "./types.js";

const runCliProcessMock = vi.fn();
const resolveClaudeBinaryMock = vi.fn();
const buildClaudeCodeEnvMock = vi.fn();
const buildCredentialStrippedEnvMock = vi.fn();
const detectBackendAvailabilityMock = vi.fn();

vi.mock("./cli-process.js", () => ({
  runCliProcess: (...args: unknown[]) => runCliProcessMock(...args),
}));

vi.mock("./scout.js", () => ({
  resolveClaudeBinary: (...args: unknown[]) => resolveClaudeBinaryMock(...args),
}));

vi.mock("./claude-code-env.js", () => ({
  buildClaudeCodeEnv: (...args: unknown[]) => buildClaudeCodeEnvMock(...args),
  buildCredentialStrippedEnv: (...args: unknown[]) => buildCredentialStrippedEnvMock(...args),
}));

vi.mock("./backend-availability.js", () => ({
  detectBackendAvailability: () => detectBackendAvailabilityMock(),
  getCodexAskForApprovalPlacement: () => "unsupported",
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
    buildCredentialStrippedEnvMock.mockReset();
    detectBackendAvailabilityMock.mockReset();
    resolveClaudeBinaryMock.mockReturnValue("/usr/bin/claude");
    buildClaudeCodeEnvMock.mockReturnValue({ CLAUDE_AUTH: "subscription" });
    buildCredentialStrippedEnvMock.mockReturnValue({ CODEX_AUTH: "stripped" });
    detectBackendAvailabilityMock.mockReturnValue([
      { id: "pi", available: true },
      { id: "codex", available: true },
      { id: "claude_code", available: true },
    ]);
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

  it("uses Codex-only manual test generation when Claude Code is unavailable", async () => {
    resolveClaudeBinaryMock.mockReturnValueOnce(null);
    detectBackendAvailabilityMock.mockReturnValueOnce([
      { id: "pi", available: true },
      { id: "codex", available: true },
      { id: "claude_code", available: false, reason: "claude not found on PATH" },
    ]);
    runCliProcessMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        type: "result",
        result: JSON.stringify({
          tests: [
            {
              description: "Test Telegram approval",
              criticality: 7,
              reason: "Requires a real Telegram client",
              detail: "**Step 1.** Send the command.\n**Step 2.** Confirm the approval prompt.",
            },
          ],
        }),
      }),
      stderr: "",
      timedOut: false,
      exitCode: 0,
      signal: null,
      durationMs: 31,
    });

    const manualTests = await withNonTestEnv(() =>
      generateManualTests({
        goal: "Improve Telegram flow",
        steps: makeDoneSteps(),
      }),
    );

    expect(manualTests).toEqual([
      {
        description: "Test Telegram approval",
        criticality: 7,
        reason: "Requires a real Telegram client",
        detail: "**Step 1.** Send the command.\n**Step 2.** Confirm the approval prompt.",
      },
    ]);
    const call = runCliProcessMock.mock.calls[0]?.[0] as { command: string; args: string[] };
    expect(call.command).toBe("codex");
    expect(call.args).toContain("exec");
    expect(call.args).toContain("--json");
  });

  it("falls back to generated manual tests when no CLI backend is available", async () => {
    resolveClaudeBinaryMock.mockReturnValueOnce(null);
    detectBackendAvailabilityMock.mockReturnValueOnce([
      { id: "pi", available: true },
      { id: "codex", available: false, reason: "codex not found on PATH" },
      { id: "claude_code", available: false, reason: "claude not found on PATH" },
    ]);

    const manualTests = await withNonTestEnv(() =>
      generateManualTests({
        goal: "Improve authentication reliability",
        steps: makeDoneSteps(),
      }),
    );

    expect(manualTests[0]).toMatchObject({
      description: "Test login validation",
      reason: "Automated test generation returned fewer suggestions than expected.",
    });
    expect(runCliProcessMock).not.toHaveBeenCalled();
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

  it('parses Codex JSONL with a final type:"result" event containing tests', async () => {
    const finalTestsJson = JSON.stringify({
      tests: [
        {
          description: "Test Codex JSONL final result parsing",
          criticality: 7,
          reason: "Requires a real Codex CLI run",
          detail:
            "**Step 1.** Run /new_goal in Telegram.\n**Step 2.** Confirm manual tests appear.",
        },
      ],
    });
    const codexJsonl = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_xyz" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "msg_1", type: "agent_message", text: "interim progress" },
      }),
      JSON.stringify({ type: "result", result: finalTestsJson }),
    ].join("\n");
    runCliProcessMock.mockResolvedValueOnce({
      stdout: codexJsonl,
      stderr: "",
      timedOut: false,
      exitCode: 0,
      signal: null,
      durationMs: 41,
    });
    resolveClaudeBinaryMock.mockReturnValueOnce(null);
    detectBackendAvailabilityMock.mockReturnValueOnce([
      { id: "pi", available: true },
      { id: "codex", available: true },
      { id: "claude_code", available: false, reason: "claude not found on PATH" },
    ]);

    const manualTests = await withNonTestEnv(() =>
      generateManualTests({
        goal: "Improve Telegram flow",
        steps: makeDoneSteps(),
      }),
    );

    expect(manualTests).toEqual([
      {
        description: "Test Codex JSONL final result parsing",
        criticality: 7,
        reason: "Requires a real Codex CLI run",
        detail: "**Step 1.** Run /new_goal in Telegram.\n**Step 2.** Confirm manual tests appear.",
      },
    ]);
  });

  it("parses Codex JSONL with thread.started + assistant event returning tests: []", async () => {
    const codexJsonl = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_abc" }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "msg_1",
          type: "agent_message",
          text: JSON.stringify({
            tests: [],
            message: "All functionality was verified automatically",
          }),
        },
      }),
    ].join("\n");
    runCliProcessMock.mockResolvedValueOnce({
      stdout: codexJsonl,
      stderr: "",
      timedOut: false,
      exitCode: 0,
      signal: null,
      durationMs: 38,
    });
    resolveClaudeBinaryMock.mockReturnValueOnce(null);
    detectBackendAvailabilityMock.mockReturnValueOnce([
      { id: "pi", available: true },
      { id: "codex", available: true },
      { id: "claude_code", available: false, reason: "claude not found on PATH" },
    ]);

    const manualTests = await withNonTestEnv(() =>
      generateManualTests({
        goal: "Inspect repository status",
        steps: makeDoneSteps(),
      }),
    );

    expect(manualTests).toEqual([]);
  });

  it("ignores irrelevant early Codex JSONL events when extracting the assistant payload", async () => {
    const finalTestsJson = JSON.stringify({
      tests: [
        {
          description: "Test trailing-event-only parsing",
          criticality: 4,
          reason: "Bot cannot validate visual layout",
          detail: "**Step 1.** Render the page.\n**Step 2.** Confirm spacing looks correct.",
        },
      ],
    });
    const codexJsonl = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_qq" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.started", item: { id: "tool_1", type: "tool_call" } }),
      JSON.stringify({ type: "item.completed", item: { id: "tool_1", type: "tool_call" } }),
      JSON.stringify({ type: "result", result: finalTestsJson }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");
    runCliProcessMock.mockResolvedValueOnce({
      stdout: codexJsonl,
      stderr: "",
      timedOut: false,
      exitCode: 0,
      signal: null,
      durationMs: 44,
    });
    resolveClaudeBinaryMock.mockReturnValueOnce(null);
    detectBackendAvailabilityMock.mockReturnValueOnce([
      { id: "pi", available: true },
      { id: "codex", available: true },
      { id: "claude_code", available: false, reason: "claude not found on PATH" },
    ]);

    const manualTests = await withNonTestEnv(() =>
      generateManualTests({
        goal: "Polish UI spacing",
        steps: makeDoneSteps(),
      }),
    );

    expect(manualTests).toEqual([
      {
        description: "Test trailing-event-only parsing",
        criticality: 4,
        reason: "Bot cannot validate visual layout",
        detail: "**Step 1.** Render the page.\n**Step 2.** Confirm spacing looks correct.",
      },
    ]);
  });

  it("throws a clear error when Codex stdout has no assistant text or final result", async () => {
    const codexJsonl = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_no_result" }),
      JSON.stringify({ type: "turn.started" }),
    ].join("\n");
    runCliProcessMock.mockResolvedValueOnce({
      stdout: codexJsonl,
      stderr: "",
      timedOut: false,
      exitCode: 0,
      signal: null,
      durationMs: 21,
    });
    resolveClaudeBinaryMock.mockReturnValueOnce(null);
    detectBackendAvailabilityMock.mockReturnValueOnce([
      { id: "pi", available: true },
      { id: "codex", available: true },
      { id: "claude_code", available: false, reason: "claude not found on PATH" },
    ]);

    await expect(
      withNonTestEnv(() =>
        generateManualTests({
          goal: "No-op probe",
          steps: makeDoneSteps(),
        }),
      ),
    ).rejects.toThrow("Manual test CLI response did not include assistant text.");
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

describe("generateManualTests diagnostics artifacts", () => {
  let tmpRunDir: string;
  const createdRoots: string[] = [];

  beforeEach(() => {
    runCliProcessMock.mockReset();
    resolveClaudeBinaryMock.mockReset();
    buildClaudeCodeEnvMock.mockReset();
    buildCredentialStrippedEnvMock.mockReset();
    detectBackendAvailabilityMock.mockReset();
    buildClaudeCodeEnvMock.mockReturnValue({ CLAUDE_AUTH: "subscription" });
    buildCredentialStrippedEnvMock.mockReturnValue({ CODEX_AUTH: "stripped" });
    detectBackendAvailabilityMock.mockReturnValue([
      { id: "pi", available: true },
      { id: "codex", available: true },
      { id: "claude_code", available: true },
    ]);
    tmpRunDir = fs.mkdtempSync(path.join(os.tmpdir(), "manual-tests-artifacts-"));
    createdRoots.push(tmpRunDir);
  });

  afterEach(() => {
    while (createdRoots.length > 0) {
      const root = createdRoots.pop();
      if (root && fs.existsSync(root)) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("writes stdout/stderr artifact files when runDir is provided (Claude success path)", async () => {
    resolveClaudeBinaryMock.mockReturnValue("/usr/bin/claude");
    const expectedStdoutPath = path.join(tmpRunDir, "manual-tests", "stdout.txt");
    const expectedStderrPath = path.join(tmpRunDir, "manual-tests", "stderr.txt");
    const claudeStdout = makeCliResultOutput(JSON.stringify({ tests: [] }));

    runCliProcessMock.mockImplementationOnce(async (params: Record<string, unknown>) => {
      const stdoutPath = params.stdoutPath as string | undefined;
      const stderrPath = params.stderrPath as string | undefined;
      expect(stdoutPath).toBe(expectedStdoutPath);
      expect(stderrPath).toBe(expectedStderrPath);
      if (stdoutPath) fs.writeFileSync(stdoutPath, claudeStdout, "utf8");
      if (stderrPath) fs.writeFileSync(stderrPath, "", "utf8");
      return {
        stdout: claudeStdout,
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 12,
      };
    });

    await withNonTestEnv(() =>
      generateManualTests({
        goal: "Improve reliability",
        steps: makeDoneSteps(),
        runDir: tmpRunDir,
      }),
    );

    expect(fs.existsSync(expectedStdoutPath)).toBe(true);
    expect(fs.existsSync(expectedStderrPath)).toBe(true);
    expect(fs.readFileSync(expectedStdoutPath, "utf8")).toBe(claudeStdout);
  });

  it("writes artifact files and references them in the error on non-zero exit", async () => {
    resolveClaudeBinaryMock.mockReturnValue("/usr/bin/claude");
    const expectedStdoutPath = path.join(tmpRunDir, "manual-tests", "stdout.txt");
    const expectedStderrPath = path.join(tmpRunDir, "manual-tests", "stderr.txt");

    runCliProcessMock.mockImplementationOnce(async (params: Record<string, unknown>) => {
      const stdoutPath = params.stdoutPath as string | undefined;
      const stderrPath = params.stderrPath as string | undefined;
      if (stdoutPath) fs.writeFileSync(stdoutPath, "", "utf8");
      if (stderrPath) fs.writeFileSync(stderrPath, "boom: backend exploded", "utf8");
      return {
        stdout: "",
        stderr: "boom: backend exploded",
        timedOut: false,
        exitCode: 1,
        signal: null,
        durationMs: 7,
      };
    });

    await expect(
      withNonTestEnv(() =>
        generateManualTests({
          goal: "Improve reliability",
          steps: makeDoneSteps(),
          runDir: tmpRunDir,
        }),
      ),
    ).rejects.toThrow(
      new RegExp(
        `Manual test generation failed: boom: backend exploded.*${expectedStdoutPath.replace(/[.\\/]/g, "\\$&")}.*${expectedStderrPath.replace(/[.\\/]/g, "\\$&")}`,
      ),
    );
    expect(fs.existsSync(expectedStdoutPath)).toBe(true);
    expect(fs.existsSync(expectedStderrPath)).toBe(true);
  });

  it("uses the credential-stripped env for the Codex branch", async () => {
    resolveClaudeBinaryMock.mockReturnValue(null);
    detectBackendAvailabilityMock.mockReturnValue([
      { id: "pi", available: true },
      { id: "codex", available: true },
      { id: "claude_code", available: false, reason: "claude not found on PATH" },
    ]);

    const codexJsonl = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_env" }),
      JSON.stringify({
        type: "result",
        result: JSON.stringify({ tests: [] }),
      }),
    ].join("\n");

    runCliProcessMock.mockImplementationOnce(async (params: Record<string, unknown>) => {
      const stdoutPath = params.stdoutPath as string | undefined;
      const stderrPath = params.stderrPath as string | undefined;
      if (stdoutPath) fs.writeFileSync(stdoutPath, codexJsonl, "utf8");
      if (stderrPath) fs.writeFileSync(stderrPath, "", "utf8");
      return {
        stdout: codexJsonl,
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 9,
      };
    });

    await withNonTestEnv(() =>
      generateManualTests({
        goal: "Test env stripping",
        steps: makeDoneSteps(),
        runDir: tmpRunDir,
      }),
    );

    expect(buildCredentialStrippedEnvMock).toHaveBeenCalledTimes(1);
    expect(buildClaudeCodeEnvMock).not.toHaveBeenCalled();
    const call = runCliProcessMock.mock.calls[0]?.[0] as {
      command: string;
      env: Record<string, string>;
    };
    expect(call.command).toBe("codex");
    expect(call.env).toEqual({ CODEX_AUTH: "stripped" });
  });

  it("references artifact paths when the CLI produced no assistant text", async () => {
    resolveClaudeBinaryMock.mockReturnValue(null);
    detectBackendAvailabilityMock.mockReturnValue([
      { id: "pi", available: true },
      { id: "codex", available: true },
      { id: "claude_code", available: false, reason: "claude not found on PATH" },
    ]);

    const expectedStdoutPath = path.join(tmpRunDir, "manual-tests", "stdout.txt");
    const useless = [
      JSON.stringify({ type: "thread.started", thread_id: "t" }),
      JSON.stringify({ type: "turn.started" }),
    ].join("\n");

    runCliProcessMock.mockImplementationOnce(async (params: Record<string, unknown>) => {
      const stdoutPath = params.stdoutPath as string | undefined;
      const stderrPath = params.stderrPath as string | undefined;
      if (stdoutPath) fs.writeFileSync(stdoutPath, useless, "utf8");
      if (stderrPath) fs.writeFileSync(stderrPath, "", "utf8");
      return {
        stdout: useless,
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 4,
      };
    });

    await expect(
      withNonTestEnv(() =>
        generateManualTests({
          goal: "No-op probe",
          steps: makeDoneSteps(),
          runDir: tmpRunDir,
        }),
      ),
    ).rejects.toThrow(
      new RegExp(
        `Manual test CLI response did not include assistant text\\..*${expectedStdoutPath.replace(/[.\\/]/g, "\\$&")}`,
      ),
    );
  });
});
