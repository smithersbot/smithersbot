import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoalLlmClient, PlanStep } from "./types.js";
import { resolveAgentHistoryEventsPath } from "./agent-history-events.js";
import { workspaceNameFromWorkingDir } from "./agent-history.js";

const runCliProcessMock = vi.fn();
const resolveClaudeBinaryMock = vi.fn();
const buildClaudeCodeEnvMock = vi.fn();
const buildCredentialStrippedEnvMock = vi.fn();
const detectBackendAvailabilityMock = vi.fn();
const buildClaudeCodeSandboxLaunchConfigMock = vi.fn(
  (params: { runId: string; workingDir: string; purpose: string }) => ({
    settingsPath: `/tmp/${params.runId}-settings.json`,
    args: [
      "--settings",
      `/tmp/${params.runId}-settings.json`,
      "--setting-sources",
      "",
      "--permission-mode",
      "default",
    ],
  }),
);
const writeCodexNativeSandboxConfigMock = vi.fn(
  (params: { runId: string; workingDir: string; purpose: string; requiresNetwork?: boolean }) => ({
    profileName: "smithersbot",
    executionRoot: params.workingDir,
    codexHome: `/tmp/${params.runId}-codex-home`,
    configPath: `/tmp/${params.runId}-codex-home/config.toml`,
    helperDir: `/tmp/${params.runId}-codex-home/bin`,
    helperPath: `/tmp/${params.runId}-codex-home/bin/codex-linux-sandbox`,
    codexPath: "codex",
    authReferencePath: `/tmp/${params.runId}-codex-home/auth.json`,
    authSourcePath: "/home/test/.codex/auth.json",
    env: {
      CODEX_HOME: `/tmp/${params.runId}-codex-home`,
      PATH: `/tmp/${params.runId}-codex-home/bin:${process.env.PATH ?? ""}`,
    },
    args: ["sandbox", "linux", "--permissions-profile", "smithersbot", "--cd", params.workingDir],
    configToml: [
      'default_permissions = "smithersbot"',
      "[permissions.smithersbot.filesystem]",
      '"/" = "read"',
      `"${params.workingDir}" = "read"`,
      `"${params.workingDir}/.env" = "deny"`,
      '"/managed/private/env/smithersbot/.env" = "deny"',
      '"/home/test/.codex/auth.json" = "deny"',
    ].join("\n"),
    deniedReadPaths: [
      `${params.workingDir}/.env`,
      `${params.workingDir}/.env.local`,
      `${params.workingDir}/.env.production`,
      "/managed/private/env/smithersbot/.env",
      "/home/test/.codex/auth.json",
      "/home/test/.claude/settings.json",
    ],
    allowedReadPaths: [params.workingDir],
    writablePaths: [],
    requiresNetwork: params.requiresNetwork,
  }),
);

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

vi.mock("./backend-sandbox.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backend-sandbox.js")>();
  return {
    ...actual,
    buildClaudeCodeSandboxLaunchConfig: (...args: unknown[]) =>
      buildClaudeCodeSandboxLaunchConfigMock(...args),
    writeCodexNativeSandboxConfig: (...args: unknown[]) =>
      writeCodexNativeSandboxConfigMock(...args),
  };
});

import { clampCriticality, generateManualTests } from "./manual-tests.js";
import { buildClaudeCodeSandboxSettingsConfig } from "./backend-sandbox.js";

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
    usage: { input_tokens: 21, output_tokens: 8 },
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
    buildClaudeCodeSandboxLaunchConfigMock.mockClear();
    writeCodexNativeSandboxConfigMock.mockClear();
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

  it("records injected client prompt and usage in agent-visible history", async () => {
    const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "manual-tests-client-managed-"));
    const previousManagedRoot = process.env.SMITHERSBOT_GOALS_ROOT;
    process.env.SMITHERSBOT_GOALS_ROOT = managedRoot;
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({ tests: [] }),
      usage: { inputTokens: 33, outputTokens: 7 },
    });
    const client: GoalLlmClient = { complete };

    try {
      await generateManualTests({
        goal: "Improve authentication reliability",
        steps: makeDoneSteps(),
        client,
        runId: "manual-client-run",
        workingDir: process.cwd(),
      });

      const eventsPath = resolveAgentHistoryEventsPath({
        kind: "goal",
        workspaceName: workspaceNameFromWorkingDir(process.cwd()),
        goalId: "manual-client-run",
      });
      const events = fs
        .readFileSync(eventsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events[0]).toMatchObject({
        event: "launch",
        backend: "goal-llm-client",
        phase: "manual-tests",
      });
      expect(fs.readFileSync(String(events[0]?.promptArtifactPath), "utf8")).toContain(
        "Goal: Improve authentication reliability",
      );
      expect(events[1]).toMatchObject({
        event: "result",
        tokenUsage: { available: true, inputTokens: 33, outputTokens: 7, totalTokens: 40 },
      });
    } finally {
      if (previousManagedRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
      else process.env.SMITHERSBOT_GOALS_ROOT = previousManagedRoot;
      fs.rmSync(managedRoot, { recursive: true, force: true });
    }
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

  it("propagates a no-backend error so callers can render the skipped notice", async () => {
    resolveClaudeBinaryMock.mockReturnValueOnce(null);
    detectBackendAvailabilityMock.mockReturnValueOnce([
      { id: "pi", available: true },
      { id: "codex", available: false, reason: "codex not found on PATH" },
      { id: "claude_code", available: false, reason: "claude not found on PATH" },
    ]);

    await expect(
      withNonTestEnv(() =>
        generateManualTests({
          goal: "Improve authentication reliability",
          steps: makeDoneSteps(),
        }),
      ),
    ).rejects.toThrow(/no worker backend available/);
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
    expect(call.args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--max-turns",
      "1",
      "--settings",
      "/tmp/manual-tests-manual-tests-1-settings.json",
      "--setting-sources",
      "",
      "--permission-mode",
      "default",
    ]);
    expect(call.cwd).toBe(process.cwd());
    expect(call.timeoutMs).toBe(300_000);
    expect(call.env).toEqual({ CLAUDE_AUTH: "subscription" });
    expect(buildClaudeCodeSandboxLaunchConfigMock).toHaveBeenCalledWith({
      workingDir: process.cwd(),
      runId: "manual-tests-manual-tests-1",
      purpose: "repo-chat",
    });
    expect(call.stdin).toContain("## System Prompt");
    expect(call.stdin.startsWith("## System Prompt\nYou are a QA assistant")).toBe(true);
    expect(call.stdin).toContain("You are a QA assistant");
    expect(call.stdin).toContain("## User Message");
    expect(call.stdin).toContain("Goal: Improve authentication reliability");
    expect(call.stdin.length).toBeLessThanOrEqual(2969);
  });

  it("falls back to Codex when Claude Code hits a usage limit", async () => {
    runCliProcessMock
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "API 429: You've hit your org's monthly usage limit. Resets at 3pm.",
        timedOut: false,
        exitCode: 1,
        signal: null,
        durationMs: 10,
      })
      .mockResolvedValueOnce({
        stdout: makeCliResultOutput(
          JSON.stringify({
            tests: [{ description: "Verify fallback path", criticality: 5, detail: "Do X" }],
          }),
        ),
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 20,
      });

    const tests = await withNonTestEnv(() =>
      generateManualTests({ goal: "Improve reliability", steps: makeDoneSteps() }),
    );

    expect(tests).toHaveLength(1);
    expect(tests[0]?.description).toBe("Verify fallback path");
    expect(runCliProcessMock).toHaveBeenCalledTimes(2);
    const first = runCliProcessMock.mock.calls[0]?.[0] as { command: string };
    const second = runCliProcessMock.mock.calls[1]?.[0] as { command: string };
    expect(first.command).toBe("/usr/bin/claude");
    expect(second.command).toBe("codex");
    const secondCall = runCliProcessMock.mock.calls[1]?.[0] as {
      args: string[];
      env: Record<string, string | undefined>;
    };
    expect(secondCall.args).not.toContain("--sandbox");
    expect(secondCall.args).not.toContain("workspace-write");
    expect(secondCall.args).not.toContain("--dangerously-skip-permissions");
    expect(secondCall.args).not.toContain("--allow-dangerously-skip-permissions");
    expect(secondCall.env.CODEX_HOME).toContain("manual-tests-manual-tests-2-codex-home");
    const sandboxConfig = writeCodexNativeSandboxConfigMock.mock.results[0]?.value as {
      writablePaths: string[];
      deniedReadPaths: string[];
      allowedReadPaths: string[];
      requiresNetwork?: boolean;
    };
    expect(sandboxConfig.writablePaths).toEqual([]);
    expect(sandboxConfig.allowedReadPaths).toContain(process.cwd());
    expect(sandboxConfig.deniedReadPaths).toEqual(
      expect.arrayContaining([
        `${process.cwd()}/.env`,
        "/managed/private/env/smithersbot/.env",
        "/home/test/.codex/auth.json",
        "/home/test/.claude/settings.json",
      ]),
    );
    expect(sandboxConfig.requiresNetwork).toBe(true);
  });

  it("uses the shared Claude read-only sandbox profile for manual-test CLI launches", () => {
    const workingDir = "/repo/manual-tests-sandbox";
    const settings = buildClaudeCodeSandboxSettingsConfig({
      workingDir,
      runId: "manual-tests-sandbox",
      purpose: "repo-chat",
      denyReadDeps: {
        homedir: () => "/home/test",
        privateRoot: () => "/managed/private",
        pathExists: () => true,
        realPath: (candidate) => candidate,
      },
    }).settings;

    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.failIfUnavailable).toBe(true);
    expect(settings.sandbox.filesystem.allowRead).toContain(workingDir);
    expect(settings.sandbox.filesystem.allowWrite).toEqual([]);
    expect(settings.sandbox.filesystem.denyRead).toEqual(
      expect.arrayContaining([
        `${workingDir}/.env`,
        `${workingDir}/.env.local`,
        "/managed/private",
        "/home/test/.claude",
      ]),
    );
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining([
        `Read(${workingDir}/.env)`,
        "Read(/home/test/.codex/**)",
        "Read(/home/test/.claude/**)",
      ]),
    );
  });

  it("throws one clear message when both backends are usage-limited", async () => {
    runCliProcessMock
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "API 429: monthly usage limit reached. Resets at 3pm.",
        timedOut: false,
        exitCode: 1,
        signal: null,
        durationMs: 10,
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "Codex weekly usage limit hit. Resets on Monday.",
        timedOut: false,
        exitCode: 1,
        signal: null,
        durationMs: 10,
      });

    await expect(
      withNonTestEnv(() =>
        generateManualTests({ goal: "Improve reliability", steps: makeDoneSteps() }),
      ),
    ).rejects.toThrow(/Claude Code hit a usage limit[\s\S]*Codex hit a usage limit/);
    expect(runCliProcessMock).toHaveBeenCalledTimes(2);
  });

  it("does not fall back to Codex for a non-usage Claude failure", async () => {
    runCliProcessMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "boom: claude crashed",
      timedOut: false,
      exitCode: 1,
      signal: null,
      durationMs: 10,
    });

    await expect(
      withNonTestEnv(() =>
        generateManualTests({ goal: "Improve reliability", steps: makeDoneSteps() }),
      ),
    ).rejects.toThrow(/boom: claude crashed/);
    expect(runCliProcessMock).toHaveBeenCalledTimes(1);
  });

  it("strips poisoned Claude subscription auth env from manual-test subprocesses", async () => {
    const { buildClaudeCodeEnv: realBuildClaudeCodeEnv } =
      await vi.importActual<typeof import("./claude-code-env.js")>("./claude-code-env.js");
    buildClaudeCodeEnvMock.mockImplementation(realBuildClaudeCodeEnv);

    const previous = new Map<string, string | undefined>();
    for (const key of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_API_KEY_OLD",
      "ANTHROPIC_BASE_URL",
      "TELEGRAM_BOT_TOKEN",
      "SMITHERSBOT_GATEWAY_TOKEN",
    ]) {
      previous.set(key, process.env[key]);
      process.env[key] = `secret-${key}`;
    }

    try {
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
          goal: "Verify Claude env strip",
          steps: makeDoneSteps(),
        }),
      );

      const call = runCliProcessMock.mock.calls[0]?.[0] as {
        command: string;
        args: string[];
        env: Record<string, string | undefined>;
      };
      expect(call.command).toBe("/usr/bin/claude");
      expect(buildClaudeCodeEnvMock).toHaveBeenCalledWith("subscription");
      expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(call.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(call.env.ANTHROPIC_API_KEY_OLD).toBeUndefined();
      expect(call.env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(call.env.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(call.env.SMITHERSBOT_GATEWAY_TOKEN).toBeUndefined();
      expect(call.args).not.toContain("--dangerously-skip-permissions");
      expect(call.args).not.toContain("--allow-dangerously-skip-permissions");
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
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
  let managedRoot: string;
  let previousManagedRoot: string | undefined;
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
    previousManagedRoot = process.env.SMITHERSBOT_GOALS_ROOT;
    managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "manual-tests-managed-"));
    process.env.SMITHERSBOT_GOALS_ROOT = managedRoot;
    createdRoots.push(tmpRunDir);
    createdRoots.push(managedRoot);
  });

  afterEach(() => {
    if (previousManagedRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
    else process.env.SMITHERSBOT_GOALS_ROOT = previousManagedRoot;
    while (createdRoots.length > 0) {
      const root = createdRoots.pop();
      if (root && fs.existsSync(root)) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  function readManualTestsHistory(
    runId = path.basename(tmpRunDir),
  ): Array<Record<string, unknown>> {
    const eventsPath = resolveAgentHistoryEventsPath({
      kind: "goal",
      workspaceName: workspaceNameFromWorkingDir(process.cwd()),
      goalId: runId,
    });
    return fs
      .readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

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
    const events = readManualTestsHistory();
    expect(events[0]).toMatchObject({
      event: "launch",
      phase: "manual-tests",
      backend: "claude_code",
      status: "started",
    });
    expect(events[0]?.promptArtifactPath).toEqual(expect.any(String));
    expect(fs.readFileSync(String(events[0]?.promptArtifactPath), "utf8")).toContain(
      "Goal: Improve reliability",
    );
    expect(events[1]).toMatchObject({
      event: "result",
      status: "success",
      tokenUsage: {
        available: true,
        inputTokens: 21,
        outputTokens: 8,
      },
    });
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

  it("strips known credential keys from the env passed to runCliProcess (Codex branch)", async () => {
    // Delegate the env-builder mock to the real implementation for this test
    // so we can verify the actual key-strip behavior end to end.
    const { buildCredentialStrippedEnv: realBuildCredentialStrippedEnv } =
      await vi.importActual<typeof import("./claude-code-env.js")>("./claude-code-env.js");
    buildCredentialStrippedEnvMock.mockImplementation(realBuildCredentialStrippedEnv);

    const originalTelegram = process.env.TELEGRAM_BOT_TOKEN;
    const originalGateway = process.env.SMITHERSBOT_GATEWAY_TOKEN;
    const originalLegacyGateway = process.env.MOLTBOT_GATEWAY_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "FAKE_TELEGRAM_TOKEN_FOR_TEST";
    process.env.SMITHERSBOT_GATEWAY_TOKEN = "FAKE_GATEWAY_TOKEN_FOR_TEST";
    process.env.MOLTBOT_GATEWAY_TOKEN = "FAKE_LEGACY_GATEWAY_TOKEN_FOR_TEST";

    try {
      resolveClaudeBinaryMock.mockReturnValue(null);
      detectBackendAvailabilityMock.mockReturnValue([
        { id: "pi", available: true },
        { id: "codex", available: true },
        { id: "claude_code", available: false, reason: "claude not found on PATH" },
      ]);
      const codexJsonl = [
        JSON.stringify({ type: "thread.started", thread_id: "thread_env_strip" }),
        JSON.stringify({ type: "result", result: JSON.stringify({ tests: [] }) }),
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
          durationMs: 8,
        };
      });

      await withNonTestEnv(() =>
        generateManualTests({
          goal: "Verify credential env strip",
          steps: makeDoneSteps(),
          runDir: tmpRunDir,
        }),
      );

      const call = runCliProcessMock.mock.calls[0]?.[0] as {
        command: string;
        env: Record<string, string>;
      };
      expect(call.command).toBe("codex");
      expect(call.env).not.toHaveProperty("TELEGRAM_BOT_TOKEN");
      expect(call.env).not.toHaveProperty("SMITHERSBOT_GATEWAY_TOKEN");
      expect(call.env).not.toHaveProperty("MOLTBOT_GATEWAY_TOKEN");
    } finally {
      if (originalTelegram == null) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = originalTelegram;
      if (originalGateway == null) delete process.env.SMITHERSBOT_GATEWAY_TOKEN;
      else process.env.SMITHERSBOT_GATEWAY_TOKEN = originalGateway;
      if (originalLegacyGateway == null) delete process.env.MOLTBOT_GATEWAY_TOKEN;
      else process.env.MOLTBOT_GATEWAY_TOKEN = originalLegacyGateway;
    }
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
    expect(call.env.CODEX_AUTH).toBe("stripped");
    expect(call.env.CODEX_HOME).toContain(`${path.basename(tmpRunDir)}-manual-tests-1-codex-home`);
    expect(call.env.PATH).toContain(`${call.env.CODEX_HOME}${path.sep}bin`);
  });

  it("redacts known secret values in stdout/stderr artifacts and returned tests", async () => {
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "FAKE_TELEGRAM_SECRET_123";
    try {
      resolveClaudeBinaryMock.mockReturnValue("/usr/bin/claude");
      const expectedStdoutPath = path.join(tmpRunDir, "manual-tests", "stdout.txt");
      const expectedStderrPath = path.join(tmpRunDir, "manual-tests", "stderr.txt");
      const assistantText = JSON.stringify({
        tests: [
          {
            description: "Check redaction",
            criticality: 7,
            reason: "Ensure FAKE_TELEGRAM_SECRET_123 is hidden",
            detail: "**Step 1.** Confirm FAKE_TELEGRAM_SECRET_123 is absent",
          },
        ],
      });
      const claudeStdout = makeCliResultOutput(assistantText);

      runCliProcessMock.mockImplementationOnce(async (params: Record<string, unknown>) => {
        const stdoutPath = params.stdoutPath as string | undefined;
        const stderrPath = params.stderrPath as string | undefined;
        if (stdoutPath) fs.writeFileSync(stdoutPath, claudeStdout, "utf8");
        if (stderrPath) fs.writeFileSync(stderrPath, "stderr FAKE_TELEGRAM_SECRET_123", "utf8");
        return {
          stdout: claudeStdout,
          stderr: "stderr FAKE_TELEGRAM_SECRET_123",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 12,
        };
      });

      const tests = await withNonTestEnv(() =>
        generateManualTests({
          goal: "Improve reliability",
          steps: makeDoneSteps(),
          runDir: tmpRunDir,
        }),
      );

      expect(tests[0]?.reason).toContain("[REDACTED]");
      expect(tests[0]?.reason).not.toContain("FAKE_TELEGRAM_SECRET_123");
      expect(tests[0]?.detail).toContain("[REDACTED]");
      expect(tests[0]?.detail).not.toContain("FAKE_TELEGRAM_SECRET_123");
      for (const artifactPath of [expectedStdoutPath, expectedStderrPath]) {
        const persisted = fs.readFileSync(artifactPath, "utf8");
        expect(persisted).toContain("[REDACTED]");
        expect(persisted).not.toContain("FAKE_TELEGRAM_SECRET_123");
      }
      const historyText = fs.readFileSync(
        resolveAgentHistoryEventsPath({
          kind: "goal",
          workspaceName: workspaceNameFromWorkingDir(process.cwd()),
          goalId: path.basename(tmpRunDir),
        }),
        "utf8",
      );
      expect(historyText).not.toContain("FAKE_TELEGRAM_SECRET_123");
    } finally {
      if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    }
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
