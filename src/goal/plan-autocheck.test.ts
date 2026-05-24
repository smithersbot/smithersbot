import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plan } from "./types.js";
import { buildAutocheckPrompt, runPlanAutocheck } from "./plan-autocheck.js";
import { REVIEW_INSTRUCTION } from "../prompts/plan-autocheck/review-instruction.js";
import { workspaceNameFromWorkingDir } from "./agent-history.js";
import { resolveAgentHistoryEventsPath } from "./agent-history-events.js";

const mockRunCliProcess = vi.hoisted(() => vi.fn());
vi.mock("./cli-process.js", () => ({
  runCliProcess: (...args: unknown[]) => mockRunCliProcess(...args),
}));

const mockRunCliPlanRevision = vi.hoisted(() => vi.fn());
vi.mock("./cli-planner.js", () => ({
  runCliPlanRevision: (...args: unknown[]) => mockRunCliPlanRevision(...args),
}));

const mockResolveClaudeBinary = vi.hoisted(() => vi.fn());
vi.mock("./scout.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scout.js")>();
  return {
    ...actual,
    resolveClaudeBinary: (...args: unknown[]) => mockResolveClaudeBinary(...args),
  };
});

const mockGetCodexAskForApprovalPlacement = vi.hoisted(() => vi.fn());
const mockDetectBackendAvailability = vi.hoisted(() =>
  vi.fn(() => [
    { id: "pi", available: true },
    { id: "codex", available: true },
    { id: "claude_code", available: true },
  ]),
);
vi.mock("./backend-availability.js", () => ({
  getCodexAskForApprovalPlacement: () => mockGetCodexAskForApprovalPlacement(),
  detectBackendAvailability: () => mockDetectBackendAvailability(),
}));

const mockBuildClaudeCodeSandboxLaunchConfig = vi.hoisted(() =>
  vi.fn((params: { workingDir: string; runId: string; purpose: string }) => ({
    settingsPath: `/tmp/${params.runId}-settings.json`,
    args: [
      "--settings",
      `/tmp/${params.runId}-settings.json`,
      "--setting-sources",
      "",
      "--permission-mode",
      "default",
    ],
  })),
);
const mockWriteCodexNativeSandboxConfig = vi.hoisted(() =>
  vi.fn((params: { workingDir: string; runId: string; purpose: string }) => ({
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
      '"/home/test/.codex/auth.json" = "deny"',
    ].join("\n"),
    deniedReadPaths: [
      `${params.workingDir}/.env`,
      `${params.workingDir}/.env.local`,
      `${params.workingDir}/.env.production`,
      "/home/test/.codex/auth.json",
      "/home/test/.claude/settings.json",
    ],
    allowedReadPaths: [params.workingDir],
    writablePaths: [],
  })),
);
vi.mock("./backend-sandbox.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backend-sandbox.js")>();
  return {
    ...actual,
    buildClaudeCodeSandboxLaunchConfig: (...args: unknown[]) =>
      mockBuildClaudeCodeSandboxLaunchConfig(...args),
    writeCodexNativeSandboxConfig: (...args: unknown[]) =>
      mockWriteCodexNativeSandboxConfig(...args),
  };
});

const FORBIDDEN_AGENT_ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "SMITHERSBOT_GATEWAY_TOKEN",
  "CLAWDBOT_GATEWAY_TOKEN",
  "MOLTBOT_GATEWAY_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY_OLD",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
] as const;

function withForbiddenAgentEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of FORBIDDEN_AGENT_ENV_KEYS) {
    previous.set(key, process.env[key]);
    process.env[key] = `secret-${key}`;
  }
  return fn().finally(() => {
    for (const key of FORBIDDEN_AGENT_ENV_KEYS) {
      const prior = previous.get(key);
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  });
}

function expectForbiddenAgentEnvAbsent(env: Record<string, string | undefined>): void {
  for (const key of FORBIDDEN_AGENT_ENV_KEYS) {
    expect(env[key]).toBeUndefined();
  }
}

function makePlan(summary: string, suffix = "1", backend: "codex" | "claude_code" = "codex"): Plan {
  return {
    goal: "Ship feature",
    workingDir: "/tmp/workspace",
    summary,
    shortSummary: summary,
    steps: [
      {
        id: `step-${suffix}`,
        description: `Implement ${summary}`,
        shortSummary: `Implement ${summary}`,
        dependsOn: [],
        status: "pending",
        durationMinutes: 15,
        backend,
      },
    ],
  };
}

function cliResult(params: {
  stdout: string;
  stderr?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  durationMs?: number;
}) {
  return {
    stdout: params.stdout,
    stderr: params.stderr ?? "",
    timedOut: params.timedOut ?? false,
    exitCode: params.exitCode ?? 0,
    signal: params.signal ?? null,
    durationMs: params.durationMs ?? 100,
  };
}

function claudeStdout(params: { decision: Record<string, unknown>; sessionId?: string }): string {
  const lines: string[] = [];
  if (params.sessionId) {
    lines.push(
      JSON.stringify({
        type: "assistant",
        session_id: params.sessionId,
        content: [{ text: "review" }],
      }),
    );
  }
  lines.push(JSON.stringify({ type: "result", result: params.decision }));
  return `${lines.join("\n")}\n`;
}

function runPath(rootDir: string, runId: string): string {
  const runDir = path.join(rootDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

function readAutocheckHistoryEvents(runId: string, workingDir: string): Record<string, unknown>[] {
  const eventsPath = resolveAgentHistoryEventsPath({
    kind: "goal",
    workspaceName: workspaceNameFromWorkingDir(workingDir),
    goalId: runId,
  });
  return fs
    .readFileSync(eventsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("runPlanAutocheck", () => {
  let tmpDir: string;
  let managedRoot: string;
  let previousManagedRoot: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-autocheck-test-"));
    managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plan-autocheck-managed-"));
    previousManagedRoot = process.env.SMITHERSBOT_GOALS_ROOT;
    process.env.SMITHERSBOT_GOALS_ROOT = managedRoot;
    vi.clearAllMocks();
    mockResolveClaudeBinary.mockReturnValue("/usr/bin/claude");
    mockGetCodexAskForApprovalPlacement.mockReturnValue("unsupported");
  });

  afterEach(() => {
    if (previousManagedRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
    else process.env.SMITHERSBOT_GOALS_ROOT = previousManagedRoot;
    fs.rmSync(managedRoot, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("approves on first round and returns extracted session ID", async () => {
    const initialPlan = makePlan("Initial plan");
    mockRunCliProcess.mockResolvedValueOnce(
      cliResult({
        stdout: claudeStdout({ decision: { approved: true }, sessionId: "session-first" }),
      }),
    );

    const commitRevision = vi.fn();
    const workingDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workingDir, { recursive: true });

    const result = await runPlanAutocheck({
      plan: initialPlan,
      goalText: "Ship feature",
      mode: "claude_code",
      workingDir,
      runDir: runPath(tmpDir, "run-first"),
      commitRevision,
    });

    expect(result).toMatchObject({
      plan: initialPlan,
      autocheckRounds: 0,
      autocheckMaxRounds: 3,
      approved: true,
      exhausted: false,
      sessionId: "session-first",
      backend: "claude_code",
    });
    expect(commitRevision).not.toHaveBeenCalled();
    expect(mockRunCliPlanRevision).not.toHaveBeenCalled();

    const firstCall = mockRunCliProcess.mock.calls[0]?.[0] as {
      cwd: string;
      command: string;
      args: string[];
    };
    expect(firstCall.cwd).toBe(workingDir);
    expect(firstCall.command).toBe("/usr/bin/claude");
    expect(firstCall.args).toContain("--output-format");
    expect(firstCall.args).toContain("stream-json");
  });

  it("writes agent-visible launch and prompt history before reviewer spawn and captures tokens", async () => {
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "FAKE_AUTOCHECK_HISTORY_SECRET";
    try {
      const runId = "run-autocheck-history";
      const workingDir = tmpDir;
      mockRunCliProcess.mockImplementationOnce(async () => {
        const events = readAutocheckHistoryEvents(runId, workingDir);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          event: "launch",
          phase: "autocheck",
          backend: "codex",
          runId,
          status: "launching",
          round: 1,
          attemptLabel: "fresh",
        });
        const promptArtifactPath = String(events[0]?.promptArtifactPath);
        expect(fs.existsSync(promptArtifactPath)).toBe(true);
        const promptArtifact = fs.readFileSync(promptArtifactPath, "utf8");
        expect(promptArtifact).toContain("[REDACTED]");
        expect(promptArtifact).not.toContain("FAKE_AUTOCHECK_HISTORY_SECRET");
        expect(JSON.stringify(events[0])).not.toContain("FAKE_AUTOCHECK_HISTORY_SECRET");
        return cliResult({
          stdout: [
            JSON.stringify({
              type: "token_count",
              token_count: { input_tokens: 13, output_tokens: 5, total_tokens: 18 },
            }),
            JSON.stringify({ approved: true }),
          ].join("\n"),
        });
      });

      const result = await runPlanAutocheck({
        plan: makePlan("Secret FAKE_AUTOCHECK_HISTORY_SECRET", "1", "codex"),
        goalText: "Ship feature with FAKE_AUTOCHECK_HISTORY_SECRET",
        mode: "codex",
        workingDir,
        runDir: runPath(tmpDir, runId),
        commitRevision: vi.fn(),
      });

      expect(result.approved).toBe(true);
      const events = readAutocheckHistoryEvents(runId, workingDir);
      expect(events.map((event) => event.event)).toEqual(["launch", "result", "round"]);
      expect(events[1]).toMatchObject({
        event: "result",
        phase: "autocheck",
        backend: "codex",
        status: "approved",
        tokenUsage: {
          available: true,
          inputTokens: 13,
          outputTokens: 5,
          totalTokens: 18,
          source: "codex-json",
        },
      });
      expect(JSON.stringify(events)).not.toContain("FAKE_AUTOCHECK_HISTORY_SECRET");
    } finally {
      if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    }
  });

  it("revises then approves, calling commitRevision and resuming the same checker session", async () => {
    const originalPlan = makePlan("Original plan", "1", "claude_code");
    const revisedPlan = makePlan("Revised plan", "2", "claude_code");
    mockRunCliProcess
      .mockResolvedValueOnce(
        cliResult({
          stdout: claudeStdout({
            decision: { approved: false, editInstructions: "Add explicit verification" },
            sessionId: "session-resume",
          }),
        }),
      )
      .mockResolvedValueOnce(
        cliResult({
          stdout: claudeStdout({ decision: { approved: true } }),
        }),
      );
    mockRunCliPlanRevision.mockResolvedValueOnce({ plan: revisedPlan });

    const commitRevision = vi.fn();
    const runDir = runPath(tmpDir, "run-revise-approve");

    const result = await runPlanAutocheck({
      plan: originalPlan,
      goalText: "Ship feature",
      mode: "claude_code",
      workingDir: tmpDir,
      runDir,
      commitRevision,
    });

    expect(result).toMatchObject({
      plan: revisedPlan,
      autocheckRounds: 1,
      approved: true,
      exhausted: false,
      sessionId: "session-resume",
      backend: "claude_code",
    });

    expect(mockRunCliPlanRevision).toHaveBeenCalledOnce();
    expect(mockRunCliPlanRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        currentPlan: originalPlan,
        editInstructions: "Add explicit verification",
      }),
    );

    expect(commitRevision).toHaveBeenCalledOnce();
    expect(commitRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        round: 1,
        editInstructions: "Add explicit verification",
        previousPlan: originalPlan,
        revisedPlan,
      }),
    );

    const secondCall = mockRunCliProcess.mock.calls[1]?.[0] as { args: string[] };
    expect(secondCall.args).toContain("--resume");
    expect(secondCall.args).toContain("session-resume");
  });

  it("returns exhausted when plan revision throws", async () => {
    const originalPlan = makePlan("Revision failure", "1", "claude_code");
    const runDir = runPath(tmpDir, "run-revision-throws");

    mockRunCliProcess.mockResolvedValueOnce(
      cliResult({
        stdout: claudeStdout({
          decision: { approved: false, editInstructions: "Need changes" },
          sessionId: "session-revision-throw",
        }),
      }),
    );
    mockRunCliPlanRevision.mockRejectedValueOnce(new Error("revision boom"));

    const commitRevision = vi.fn();
    const result = await runPlanAutocheck({
      plan: originalPlan,
      goalText: "Ship feature",
      mode: "claude_code",
      workingDir: tmpDir,
      runDir,
      commitRevision,
    });

    expect(result).toMatchObject({
      plan: originalPlan,
      autocheckRounds: 0,
      autocheckMaxRounds: 3,
      approved: false,
      exhausted: true,
      sessionId: "session-revision-throw",
      backend: "claude_code",
    });
    expect(mockRunCliPlanRevision).toHaveBeenCalledOnce();
    expect(commitRevision).not.toHaveBeenCalled();

    const revisionErrorPath = path.join(runDir, "autocheck", "round-1", "revision_error.txt");
    expect(fs.existsSync(revisionErrorPath)).toBe(true);
    expect(fs.readFileSync(revisionErrorPath, "utf8")).toContain("Autocheck revision failed");
    expect(fs.readFileSync(revisionErrorPath, "utf8")).toContain("revision boom");
  });

  it("forwards only earlier rounds as priorFeedback when revising", async () => {
    const plan1 = makePlan("Plan 1", "1", "claude_code");
    const plan2 = makePlan("Plan 2", "2", "claude_code");
    const plan3 = makePlan("Plan 3", "3", "claude_code");

    mockRunCliProcess
      .mockResolvedValueOnce(
        cliResult({
          stdout: claudeStdout({
            decision: {
              approved: false,
              editInstructions: "Fix missing config helper references.",
            },
            sessionId: "session-prior-feedback",
          }),
        }),
      )
      .mockResolvedValueOnce(
        cliResult({
          stdout: claudeStdout({
            decision: {
              approved: false,
              editInstructions: "Correct scout node IDs in dependsOn.",
            },
          }),
        }),
      )
      .mockResolvedValueOnce(
        cliResult({
          stdout: claudeStdout({ decision: { approved: true } }),
        }),
      );

    mockRunCliPlanRevision
      .mockResolvedValueOnce({ plan: plan2 })
      .mockResolvedValueOnce({ plan: plan3 });

    await runPlanAutocheck({
      plan: plan1,
      goalText: "Ship feature",
      mode: "claude_code",
      workingDir: tmpDir,
      runDir: runPath(tmpDir, "run-prior-feedback"),
      commitRevision: vi.fn(),
    });

    expect(mockRunCliPlanRevision).toHaveBeenCalledTimes(2);
    const firstCall = mockRunCliPlanRevision.mock.calls[0]?.[0] as { priorFeedback?: string[] };
    const secondCall = mockRunCliPlanRevision.mock.calls[1]?.[0] as { priorFeedback?: string[] };
    expect(firstCall.priorFeedback).toEqual([]);
    expect(secondCall.priorFeedback).toEqual(["Fix missing config helper references."]);
  });

  it("returns exhausted after hitting max autocheck rounds (3/3)", async () => {
    const plan1 = makePlan("Plan 1", "1", "claude_code");
    const plan2 = makePlan("Plan 2", "2", "claude_code");
    const plan3 = makePlan("Plan 3", "3", "claude_code");
    const plan4 = makePlan("Plan 4", "4", "claude_code");

    mockRunCliProcess
      .mockResolvedValueOnce(
        cliResult({
          stdout: claudeStdout({
            decision: { approved: false, editInstructions: "Edit round 1" },
            sessionId: "session-max",
          }),
        }),
      )
      .mockResolvedValueOnce(
        cliResult({
          stdout: claudeStdout({ decision: { approved: false, editInstructions: "Edit round 2" } }),
        }),
      )
      .mockResolvedValueOnce(
        cliResult({
          stdout: claudeStdout({ decision: { approved: false, editInstructions: "Edit round 3" } }),
        }),
      )
      .mockResolvedValueOnce(
        cliResult({
          stdout: claudeStdout({ decision: { approved: false, editInstructions: "Edit round 4" } }),
        }),
      );

    mockRunCliPlanRevision
      .mockResolvedValueOnce({ plan: plan2 })
      .mockResolvedValueOnce({ plan: plan3 })
      .mockResolvedValueOnce({ plan: plan4 });

    const commitRevision = vi.fn();
    const result = await runPlanAutocheck({
      plan: plan1,
      goalText: "Ship feature",
      mode: "claude_code",
      maxRounds: 3,
      workingDir: tmpDir,
      runDir: runPath(tmpDir, "run-exhausted"),
      commitRevision,
    });

    expect(result).toMatchObject({
      plan: plan4,
      autocheckRounds: 3,
      autocheckMaxRounds: 3,
      approved: false,
      exhausted: true,
      sessionId: "session-max",
      backend: "claude_code",
    });
    expect(mockRunCliPlanRevision).toHaveBeenCalledTimes(3);
    expect(commitRevision).toHaveBeenCalledTimes(3);
    expect(commitRevision.mock.calls.map((call) => call[0].round)).toEqual([1, 2, 3]);
  });

  it("parses prose-wrapped codex JSON and resumes with codex session", async () => {
    const firstPlan = makePlan("Codex first", "1", "codex");
    const revisedPlan = makePlan("Codex revised", "2", "codex");

    mockRunCliProcess
      .mockResolvedValueOnce(
        cliResult({
          stdout:
            '{"session_id":"codex-session-1"}\nI reviewed the plan: {"approved": false, "editInstructions": "Split the implementation and verification details."}\n',
        }),
      )
      .mockResolvedValueOnce(
        cliResult({
          stdout: 'Final verdict: {"approved": true}\n',
        }),
      );
    mockRunCliPlanRevision.mockResolvedValueOnce({ plan: revisedPlan });

    const result = await runPlanAutocheck({
      plan: firstPlan,
      goalText: "Ship feature",
      mode: "codex",
      workingDir: tmpDir,
      runDir: runPath(tmpDir, "run-codex-prose"),
      commitRevision: vi.fn(),
    });

    expect(result).toMatchObject({
      plan: revisedPlan,
      autocheckRounds: 1,
      approved: true,
      exhausted: false,
      sessionId: "codex-session-1",
      backend: "codex",
    });

    const firstArgs = (mockRunCliProcess.mock.calls[0][0] as { args: string[] }).args;
    const secondArgs = (mockRunCliProcess.mock.calls[1][0] as { args: string[] }).args;
    expect(firstArgs).toContain("--json");
    expect(secondArgs).toEqual(expect.arrayContaining(["exec", "resume", "codex-session-1"]));
    expect(secondArgs).not.toContain("--json");
    expect(secondArgs).not.toContain("--color");
    expect(secondArgs).not.toContain("--sandbox");
    expect(secondArgs).not.toContain("--cd");
  });

  it("converts malformed reviewer output into edit instructions instead of crashing", async () => {
    const originalPlan = makePlan("Malformed output", "1", "claude_code");
    const revisedPlan = makePlan("After malformed", "2", "claude_code");

    mockRunCliProcess
      .mockResolvedValueOnce(
        cliResult({
          stdout: '{"type":"result","result":"This is not JSON decision output."}\n',
        }),
      )
      .mockResolvedValueOnce(
        cliResult({
          stdout: claudeStdout({ decision: { approved: true } }),
        }),
      );

    mockRunCliPlanRevision.mockResolvedValueOnce({ plan: revisedPlan });

    await runPlanAutocheck({
      plan: originalPlan,
      goalText: "Ship feature",
      mode: "claude_code",
      workingDir: tmpDir,
      runDir: runPath(tmpDir, "run-malformed"),
      commitRevision: vi.fn(),
    });

    const revisionCall = mockRunCliPlanRevision.mock.calls[0]?.[0] as { editInstructions: string };
    expect(revisionCall.editInstructions).toContain(
      "reviewer response could not be parsed as decision JSON",
    );
    expect(revisionCall.editInstructions).toContain("Raw response excerpt");
  });

  it("throws a descriptive error when reviewer subprocess fails on a fresh run", async () => {
    mockRunCliProcess.mockResolvedValueOnce(
      cliResult({
        stdout: "",
        stderr: "boom",
        exitCode: 2,
      }),
    );

    await expect(
      runPlanAutocheck({
        plan: makePlan("Failure case"),
        goalText: "Ship feature",
        mode: "claude_code",
        workingDir: tmpDir,
        runDir: runPath(tmpDir, "run-fresh-fail"),
        commitRevision: vi.fn(),
      }),
    ).rejects.toThrow(/Plan autocheck worker failed: boom/);

    expect(mockRunCliPlanRevision).not.toHaveBeenCalled();
  });

  it("falls back to Codex when the Claude reviewer hits a usage limit", async () => {
    const runId = "run-claude-usage-fallback";
    mockRunCliProcess
      .mockResolvedValueOnce(
        cliResult({
          stdout: "",
          stderr: "API 429: monthly usage limit reached. Resets at 3pm.",
          exitCode: 1,
        }),
      )
      .mockResolvedValueOnce(
        cliResult({
          stdout: `${JSON.stringify({ type: "result", result: JSON.stringify({ approved: true }) })}\n`,
        }),
      );

    const result = await runPlanAutocheck({
      plan: makePlan("Usage limit fallback"),
      goalText: "Ship feature",
      mode: "claude_code",
      workingDir: tmpDir,
      runDir: runPath(tmpDir, runId),
      commitRevision: vi.fn(),
    });

    expect(result.approved).toBe(true);
    expect(mockRunCliProcess).toHaveBeenCalledTimes(2);
    expect(mockRunCliProcess.mock.calls[0]?.[0]).toMatchObject({ command: "/usr/bin/claude" });
    expect(mockRunCliProcess.mock.calls[1]?.[0]).toMatchObject({ command: "codex" });
    const events = readAutocheckHistoryEvents(runId, tmpDir);
    expect(events.map((event) => event.event)).toEqual([
      "launch",
      "failure",
      "fallback",
      "launch",
      "result",
      "round",
    ]);
    expect(events[1]).toMatchObject({
      event: "failure",
      backend: "claude_code",
      status: "crash",
    });
    expect(events[2]).toMatchObject({
      event: "fallback",
      backend: "claude_code",
      status: "backend_failed",
    });
    expect(events[3]).toMatchObject({
      event: "launch",
      backend: "codex",
      status: "launching",
    });
  });

  it("falls back to Claude when the Codex reviewer hits a usage limit", async () => {
    mockRunCliProcess
      .mockResolvedValueOnce(
        cliResult({
          stdout: "",
          stderr: "Codex weekly usage limit hit. Resets on Monday.",
          exitCode: 1,
        }),
      )
      .mockResolvedValueOnce(cliResult({ stdout: claudeStdout({ decision: { approved: true } }) }));

    const result = await runPlanAutocheck({
      plan: makePlan("Usage limit fallback codex"),
      goalText: "Ship feature",
      mode: "codex",
      workingDir: tmpDir,
      runDir: runPath(tmpDir, "run-codex-usage-fallback"),
      commitRevision: vi.fn(),
    });

    expect(result.approved).toBe(true);
    expect(mockRunCliProcess).toHaveBeenCalledTimes(2);
    expect(mockRunCliProcess.mock.calls[0]?.[0]).toMatchObject({ command: "codex" });
    expect(mockRunCliProcess.mock.calls[1]?.[0]).toMatchObject({ command: "/usr/bin/claude" });
  });

  it("throws one clear message when both reviewer backends are usage-limited", async () => {
    mockRunCliProcess
      .mockResolvedValueOnce(
        cliResult({
          stdout: "",
          stderr: "monthly usage limit reached. Resets at 3pm.",
          exitCode: 1,
        }),
      )
      .mockResolvedValueOnce(
        cliResult({
          stdout: "",
          stderr: "weekly usage limit reached. Resets on Monday.",
          exitCode: 1,
        }),
      );

    await expect(
      runPlanAutocheck({
        plan: makePlan("Both exhausted"),
        goalText: "Ship feature",
        mode: "claude_code",
        workingDir: tmpDir,
        runDir: runPath(tmpDir, "run-both-usage-exhausted"),
        commitRevision: vi.fn(),
      }),
    ).rejects.toThrow(/Claude Code hit a usage limit[\s\S]*Codex hit a usage limit/);
    expect(mockRunCliProcess).toHaveBeenCalledTimes(2);
  });

  it("uses workingDir as reviewer cwd so the checker can inspect repo files", async () => {
    const workingDir = fs.mkdtempSync(path.join(tmpDir, "checker-cwd-"));
    mockRunCliProcess.mockResolvedValueOnce(
      cliResult({ stdout: claudeStdout({ decision: { approved: true }, sessionId: "cwd-check" }) }),
    );

    await runPlanAutocheck({
      plan: makePlan("CWD check"),
      goalText: "Ship feature",
      mode: "claude_code",
      workingDir,
      runDir: runPath(tmpDir, "run-cwd"),
      commitRevision: vi.fn(),
    });

    const call = mockRunCliProcess.mock.calls[0]?.[0] as { cwd: string };
    expect(call.cwd).toBe(workingDir);
  });

  it("redacts known secret values in reviewer artifacts and edit instructions", async () => {
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "FAKE_TELEGRAM_SECRET_123";
    try {
      const runDir = runPath(tmpDir, "run-redact");
      const commitRevision = vi.fn();
      mockRunCliPlanRevision.mockResolvedValueOnce({ plan: makePlan("Redacted revision") });
      mockRunCliProcess.mockImplementationOnce(async ({ stdoutPath, stderrPath }) => {
        fs.writeFileSync(String(stdoutPath), "stdout FAKE_TELEGRAM_SECRET_123", "utf8");
        fs.writeFileSync(String(stderrPath), "stderr FAKE_TELEGRAM_SECRET_123", "utf8");
        return cliResult({
          stdout:
            '{"session_id":"redact-session"}\n{"approved":false,"editInstructions":"Fix FAKE_TELEGRAM_SECRET_123 handling"}\n',
          stderr: "stderr FAKE_TELEGRAM_SECRET_123",
        });
      });
      mockRunCliProcess.mockResolvedValueOnce(
        cliResult({ stdout: '{"session_id":"redact-session"}\n{"approved":true}\n' }),
      );

      await runPlanAutocheck({
        plan: makePlan("Redact check"),
        goalText: "Ship feature",
        mode: "codex",
        workingDir: tmpDir,
        runDir,
        maxRounds: 1,
        commitRevision,
      });

      const roundDir = path.join(runDir, "autocheck", "round-1");
      for (const artifactPath of [
        path.join(roundDir, "fresh.stdout.txt"),
        path.join(roundDir, "fresh.stderr.txt"),
        path.join(roundDir, "response.txt"),
        path.join(roundDir, "response_text.txt"),
      ]) {
        const persisted = fs.readFileSync(artifactPath, "utf8");
        expect(persisted).toContain("[REDACTED]");
        expect(persisted).not.toContain("FAKE_TELEGRAM_SECRET_123");
      }
      const revisionCall = mockRunCliPlanRevision.mock.calls[0]?.[0] as {
        editInstructions: string;
      };
      expect(revisionCall.editInstructions).toContain("[REDACTED]");
      expect(revisionCall.editInstructions).not.toContain("FAKE_TELEGRAM_SECRET_123");
      const commitCall = commitRevision.mock.calls[0]?.[0] as { editInstructions: string };
      expect(commitCall.editInstructions).toContain("[REDACTED]");
      expect(commitCall.editInstructions).not.toContain("FAKE_TELEGRAM_SECRET_123");
    } finally {
      if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    }
  });

  it("includes plan and step shortSummary fields in the autocheck snapshot prompt", async () => {
    mockRunCliProcess.mockResolvedValueOnce(
      cliResult({
        stdout: claudeStdout({ decision: { approved: true }, sessionId: "snapshot-short-summary" }),
      }),
    );

    const planWithShortSummary: Plan = {
      ...makePlan("Snapshot plan", "1", "claude_code"),
      shortSummary: "Ship auth flow updates",
      steps: [
        {
          ...makePlan("Snapshot plan", "1", "claude_code").steps[0],
          shortSummary: "Implement auth flow",
        },
      ],
    };

    await runPlanAutocheck({
      plan: planWithShortSummary,
      goalText: "Ship feature",
      mode: "claude_code",
      workingDir: tmpDir,
      runDir: runPath(tmpDir, "run-short-summary-snapshot"),
      commitRevision: vi.fn(),
    });

    const firstArgs = (mockRunCliProcess.mock.calls[0][0] as { args: string[] }).args;
    const prompt = firstArgs.at(-1) ?? "";
    expect(prompt).toContain('"shortSummary": "Ship auth flow updates"');
    expect(prompt).toContain('"shortSummary": "Implement auth flow"');
  });

  it("includes user-requested edits in the fresh autocheck prompt", async () => {
    mockRunCliProcess.mockResolvedValueOnce(
      cliResult({
        stdout: claudeStdout({ decision: { approved: true }, sessionId: "user-edits-fresh" }),
      }),
    );

    await runPlanAutocheck({
      plan: makePlan("Fresh user edits"),
      goalText: "Ship feature",
      userEditInstructions: [
        "Add an explicit Add Details button for revision requests.",
        "Keep user-requested changes intact across planner revisions.",
      ],
      mode: "claude_code",
      workingDir: tmpDir,
      runDir: runPath(tmpDir, "run-user-edits-fresh"),
      commitRevision: vi.fn(),
    });

    const firstArgs = (mockRunCliProcess.mock.calls[0][0] as { args: string[] }).args;
    const prompt = firstArgs.at(-1) ?? "";
    expect(prompt).toContain("User-requested changes (treat as authoritative requirements):");
    expect(prompt).toContain("1. Add an explicit Add Details button for revision requests.");
    expect(prompt).toContain("2. Keep user-requested changes intact across planner revisions.");
    expect(
      prompt.indexOf("User-requested changes (treat as authoritative requirements):"),
    ).toBeLessThan(prompt.indexOf("Current /plan_detail output:"));
  });

  it("includes user-requested edits in the resume autocheck prompt", async () => {
    mockRunCliProcess.mockResolvedValueOnce(
      cliResult({
        stdout: claudeStdout({ decision: { approved: true }, sessionId: "user-edits-resume" }),
      }),
    );

    await runPlanAutocheck({
      plan: makePlan("Resume user edits"),
      goalText: "Ship feature",
      userEditInstructions: [
        "Add an explicit Add Details button for revision requests.",
        "Keep user-requested changes intact across planner revisions.",
      ],
      mode: "claude_code",
      workingDir: tmpDir,
      runDir: runPath(tmpDir, "run-user-edits-resume"),
      existingSessionId: "resume-user-edits-session",
      existingBackend: "claude_code",
      commitRevision: vi.fn(),
    });

    const firstArgs = (mockRunCliProcess.mock.calls[0][0] as { args: string[] }).args;
    expect(firstArgs).toContain("--resume");
    expect(firstArgs).toContain("resume-user-edits-session");

    const prompt = firstArgs.at(-1) ?? "";
    expect(prompt).toContain("User-requested changes (treat as authoritative requirements):");
    expect(prompt).toContain("1. Add an explicit Add Details button for revision requests.");
    expect(prompt).toContain("2. Keep user-requested changes intact across planner revisions.");
    expect(
      prompt.indexOf("User-requested changes (treat as authoritative requirements):"),
    ).toBeLessThan(prompt.indexOf("Updated /plan_detail output:"));
  });

  it("injects prior feedback in next prompt when session ID extraction fails", async () => {
    const originalPlan = makePlan("No session first", "1", "claude_code");
    const revisedPlan = makePlan("No session revised", "2", "claude_code");

    mockRunCliProcess
      .mockResolvedValueOnce(
        cliResult({
          stdout: claudeStdout({
            decision: { approved: false, editInstructions: "Please add missing file paths." },
          }),
        }),
      )
      .mockResolvedValueOnce(cliResult({ stdout: claudeStdout({ decision: { approved: true } }) }));
    mockRunCliPlanRevision.mockResolvedValueOnce({ plan: revisedPlan });

    await runPlanAutocheck({
      plan: originalPlan,
      goalText: "Ship feature",
      mode: "claude_code",
      workingDir: tmpDir,
      runDir: runPath(tmpDir, "run-no-session"),
      commitRevision: vi.fn(),
    });

    const secondCallArgs = (mockRunCliProcess.mock.calls[1][0] as { args: string[] }).args;
    expect(secondCallArgs).not.toContain("--resume");
    const secondPrompt = secondCallArgs.at(-1) ?? "";
    expect(secondPrompt).toContain("Prior reviewer feedback summary:");
    expect(secondPrompt).toContain("1. Please add missing file paths.");
  });

  it("starts a fresh session when stored backend mismatches current autocheck mode", async () => {
    mockRunCliProcess.mockResolvedValueOnce(
      cliResult({
        stdout: claudeStdout({ decision: { approved: true }, sessionId: "new-backend-session" }),
      }),
    );

    const result = await runPlanAutocheck({
      plan: makePlan("Backend mismatch"),
      goalText: "Ship feature",
      mode: "claude_code",
      workingDir: tmpDir,
      runDir: runPath(tmpDir, "run-backend-mismatch"),
      existingSessionId: "old-codex-session",
      existingBackend: "codex",
      commitRevision: vi.fn(),
    });

    expect(result.sessionId).toBe("new-backend-session");

    const firstArgs = (mockRunCliProcess.mock.calls[0][0] as { args: string[] }).args;
    expect(firstArgs).not.toContain("--resume");
    const prompt = firstArgs.at(-1) ?? "";
    expect(prompt).toContain(
      'Previous reviewer backend was "codex" but current mode is "claude_code"',
    );
  });

  it("falls back to a fresh reviewer when resume fails and logs resume failure artifacts", async () => {
    const runDir = runPath(tmpDir, "run-resume-fallback");

    mockRunCliProcess
      .mockResolvedValueOnce(
        cliResult({
          stdout: "",
          stderr: "resume not found",
          exitCode: 1,
        }),
      )
      .mockResolvedValueOnce(
        cliResult({
          stdout: claudeStdout({ decision: { approved: true }, sessionId: "fresh-session" }),
        }),
      );

    const result = await runPlanAutocheck({
      plan: makePlan("Resume fallback"),
      goalText: "Ship feature",
      mode: "claude_code",
      workingDir: tmpDir,
      runDir,
      existingSessionId: "stale-session",
      existingBackend: "claude_code",
      commitRevision: vi.fn(),
    });

    expect(result).toMatchObject({
      approved: true,
      exhausted: false,
      sessionId: "fresh-session",
    });

    expect(mockRunCliProcess).toHaveBeenCalledTimes(2);
    const firstArgs = (mockRunCliProcess.mock.calls[0][0] as { args: string[] }).args;
    const secondArgs = (mockRunCliProcess.mock.calls[1][0] as { args: string[] }).args;
    expect(firstArgs).toContain("--resume");
    expect(firstArgs).toContain("stale-session");
    expect(secondArgs).not.toContain("--resume");

    const secondPrompt = secondArgs.at(-1) ?? "";
    expect(secondPrompt).toContain("session resume failed");

    const resumeFailurePath = path.join(runDir, "autocheck", "round-1", "resume_failure.txt");
    const metadataPath = path.join(runDir, "autocheck", "round-1", "metadata.json");
    expect(fs.existsSync(resumeFailurePath)).toBe(true);
    expect(fs.readFileSync(resumeFailurePath, "utf8")).toContain("Plan autocheck worker failed");

    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    expect(metadata.resumeAttempted).toBe(true);
    expect(metadata.resumeSucceeded).toBe(false);
    expect(typeof metadata.resumeFailure).toBe("string");
  });

  it("degrades to approve with warning when resume and fresh fallback both fail", async () => {
    const runDir = runPath(tmpDir, "run-resume-fallback-double-fail");

    mockRunCliProcess
      .mockResolvedValueOnce(
        cliResult({
          stdout: "",
          stderr: "resume failed",
          exitCode: 1,
        }),
      )
      .mockResolvedValueOnce(
        cliResult({
          stdout: "",
          stderr: "fresh fallback failed",
          exitCode: 2,
        }),
      );

    const result = await runPlanAutocheck({
      plan: makePlan("Resume fallback double failure"),
      goalText: "Ship feature",
      mode: "claude_code",
      workingDir: tmpDir,
      runDir,
      existingSessionId: "stale-session",
      existingBackend: "claude_code",
      commitRevision: vi.fn(),
    });

    expect(result).toMatchObject({
      approved: true,
      exhausted: false,
      sessionId: undefined,
      autocheckRounds: 0,
      backend: "claude_code",
    });

    expect(mockRunCliProcess).toHaveBeenCalledTimes(2);
    const firstArgs = (mockRunCliProcess.mock.calls[0][0] as { args: string[] }).args;
    const secondArgs = (mockRunCliProcess.mock.calls[1][0] as { args: string[] }).args;
    expect(firstArgs).toContain("--resume");
    expect(firstArgs).toContain("stale-session");
    expect(secondArgs).not.toContain("--resume");

    const roundDir = path.join(runDir, "autocheck", "round-1");
    const resumeFailurePath = path.join(roundDir, "resume_failure.txt");
    const freshFallbackFailurePath = path.join(roundDir, "fresh_fallback_failure.txt");
    const responseTextPath = path.join(roundDir, "response_text.txt");
    const metadataPath = path.join(roundDir, "metadata.json");

    expect(fs.existsSync(resumeFailurePath)).toBe(true);
    expect(fs.existsSync(freshFallbackFailurePath)).toBe(true);
    expect(fs.readFileSync(resumeFailurePath, "utf8")).toContain("Plan autocheck worker failed");
    expect(fs.readFileSync(freshFallbackFailurePath, "utf8")).toContain(
      "Plan autocheck worker failed",
    );
    expect(fs.readFileSync(responseTextPath, "utf8")).toContain(
      "fresh reviewer fallback also failed",
    );
    expect(fs.readFileSync(responseTextPath, "utf8")).toContain("Auto-approving plan");

    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    expect(metadata.resumeAttempted).toBe(true);
    expect(metadata.resumeSucceeded).toBe(false);
    expect(typeof metadata.resumeFailure).toBe("string");
    expect(metadata.approved).toBe(true);
  });

  it("extracts codex decision JSON from prose-wrapped output", async () => {
    mockRunCliProcess.mockResolvedValueOnce(
      cliResult({
        stdout:
          'I inspected files and this is ready. Decision: {"approved": false, "editInstructions": "Tighten dependsOn links."}',
      }),
    );
    mockRunCliPlanRevision.mockResolvedValueOnce({ plan: makePlan("Codex revised", "2", "codex") });
    mockRunCliProcess.mockResolvedValueOnce(
      cliResult({
        stdout: 'Looks good now. {"approved": true}',
      }),
    );

    const result = await runPlanAutocheck({
      plan: makePlan("Codex extract", "1", "codex"),
      goalText: "Ship feature",
      mode: "codex",
      workingDir: tmpDir,
      runDir: runPath(tmpDir, "run-codex-extract"),
      commitRevision: vi.fn(),
    });

    expect(result.approved).toBe(true);
    expect(result.autocheckRounds).toBe(1);
  });

  it("strips credential env vars from Codex reviewer subprocesses", async () => {
    mockRunCliProcess.mockResolvedValueOnce(cliResult({ stdout: '{"approved":true}' }));

    await withForbiddenAgentEnv(() =>
      runPlanAutocheck({
        plan: makePlan("Codex env strip", "1", "codex"),
        goalText: "Ship feature",
        mode: "codex",
        workingDir: tmpDir,
        runDir: runPath(tmpDir, "run-codex-env-strip"),
        commitRevision: vi.fn(),
      }),
    );

    const call = mockRunCliProcess.mock.calls[0]?.[0] as {
      command: string;
      args: string[];
      env: Record<string, string | undefined>;
    };
    expect(call.command).toBe("codex");
    expectForbiddenAgentEnvAbsent(call.env);
    expect(mockWriteCodexNativeSandboxConfig).toHaveBeenCalledWith(
      expect.objectContaining({ workingDir: tmpDir, purpose: "repo-chat" }),
    );
    expect(call.args).toEqual(
      expect.arrayContaining(["exec", "--json", "--color", "never", "--cd", tmpDir]),
    );
    expect(call.args).not.toContain("--sandbox");
    expect(call.args).not.toContain("--skip-git-repo-check");
    expect(call.env.CODEX_HOME).toContain("-autocheck-r1-fresh-codex-home");
    expect(call.env.PATH).toContain("-autocheck-r1-fresh-codex-home/bin");
    const sandboxConfig = mockWriteCodexNativeSandboxConfig.mock.results[0]?.value as {
      profileName: string;
      deniedReadPaths: string[];
      writablePaths: string[];
      allowedReadPaths: string[];
      configToml: string;
    };
    expect(sandboxConfig.profileName).toBe("smithersbot");
    expect(sandboxConfig.writablePaths).toEqual([]);
    expect(sandboxConfig.allowedReadPaths).toContain(tmpDir);
    expect(sandboxConfig.deniedReadPaths).toEqual(
      expect.arrayContaining([
        `${tmpDir}/.env`,
        `${tmpDir}/.env.local`,
        `${tmpDir}/.env.production`,
        "/home/test/.codex/auth.json",
        "/home/test/.claude/settings.json",
      ]),
    );
    expect(sandboxConfig.configToml).toContain(`"${tmpDir}" = "read"`);
    expect(sandboxConfig.configToml).toContain(`"${tmpDir}/.env" = "deny"`);
  });

  it("strips poisoned Claude subscription auth env from reviewer subprocesses", async () => {
    const previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "https://proxy.invalid";
    mockRunCliProcess.mockResolvedValueOnce(
      cliResult({
        stdout: claudeStdout({ decision: { approved: true }, sessionId: "session-env" }),
      }),
    );

    try {
      await withForbiddenAgentEnv(() =>
        runPlanAutocheck({
          plan: makePlan("Claude env strip", "1", "claude_code"),
          goalText: "Ship feature",
          mode: "claude_code",
          workingDir: tmpDir,
          runDir: runPath(tmpDir, "run-claude-env-strip"),
          commitRevision: vi.fn(),
        }),
      );
    } finally {
      if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
    }

    const call = mockRunCliProcess.mock.calls[0]?.[0] as {
      command: string;
      args: string[];
      env: Record<string, string | undefined>;
    };
    expect(call.command).toBe("/usr/bin/claude");
    expectForbiddenAgentEnvAbsent(call.env);
    expect(call.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(mockBuildClaudeCodeSandboxLaunchConfig).toHaveBeenCalledWith(
      expect.objectContaining({ workingDir: tmpDir, purpose: "repo-chat" }),
    );
    expect(call.args).toEqual(
      expect.arrayContaining([
        "--settings",
        expect.stringContaining("-autocheck-r1-fresh-settings.json"),
        "--setting-sources",
        "",
        "--permission-mode",
        "default",
      ]),
    );
    expect(call.args).not.toContain("--dangerously-skip-permissions");
    expect(call.args).not.toContain("--allow-dangerously-skip-permissions");
  });

  it("keeps Codex resume args session-bound without fresh launch sandbox flags", async () => {
    mockRunCliProcess.mockResolvedValueOnce(cliResult({ stdout: '{"approved":true}' }));

    await runPlanAutocheck({
      plan: makePlan("Codex resume sandbox", "1", "codex"),
      goalText: "Ship feature",
      mode: "codex",
      workingDir: tmpDir,
      runDir: runPath(tmpDir, "run-codex-resume-sandbox"),
      existingSessionId: "codex-resume-session",
      existingBackend: "codex",
      commitRevision: vi.fn(),
    });

    const call = mockRunCliProcess.mock.calls[0]?.[0] as {
      args: string[];
      env: Record<string, string | undefined>;
    };
    expect(call.args).toEqual(["exec", "resume", "codex-resume-session", expect.any(String)]);
    expect(call.args).not.toContain("--json");
    expect(call.args).not.toContain("--color");
    expect(call.args).not.toContain("--cd");
    expect(call.args).not.toContain("--sandbox");
    expect(call.args).not.toContain("--skip-git-repo-check");
    expect(mockWriteCodexNativeSandboxConfig).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "repo-chat" }),
    );
    expect(call.env.CODEX_HOME).toContain("-autocheck-r1-resume-codex-home");
  });

  it("builds a stable review-instruction prefix and compact dynamic prior feedback", () => {
    const firstPrompt = buildAutocheckPrompt({
      goalText: "Ship feature A",
      plan: makePlan("Stable prefix A", "1", "codex"),
      workingDir: tmpDir,
      resume: false,
      priorFeedback: [
        "Round 1 feedback should be omitted after compaction.",
        "Round 2 feedback stays.",
        "Round 3 feedback stays.",
        "Round 4 feedback stays.",
      ],
      contextNotes: ["Context note A"],
    });
    const secondPrompt = buildAutocheckPrompt({
      goalText: "Ship feature B",
      plan: makePlan("Stable prefix B", "2", "claude_code"),
      workingDir: path.join(tmpDir, "other"),
      resume: false,
      priorFeedback: ["Different feedback"],
      contextNotes: [],
    });

    expect(firstPrompt.startsWith(REVIEW_INSTRUCTION)).toBe(true);
    expect(secondPrompt.startsWith(REVIEW_INSTRUCTION)).toBe(true);
    expect(firstPrompt.slice(0, REVIEW_INSTRUCTION.length)).toBe(
      secondPrompt.slice(0, REVIEW_INSTRUCTION.length),
    );
    expect(firstPrompt.indexOf(REVIEW_INSTRUCTION)).toBeLessThan(
      firstPrompt.indexOf("Original goal (verbatim):"),
    );
    expect(firstPrompt).toContain("Ship feature A");
    expect(firstPrompt).toContain("Stable prefix A");
    expect(firstPrompt).toContain("Prior reviewer feedback summary:");
    expect(firstPrompt).toContain("Earlier feedback omitted for compactness: 1 entry.");
    expect(firstPrompt).not.toContain("Round 1 feedback should be omitted");
    expect(firstPrompt).toContain("Round 4 feedback stays.");
  });

  it("omits prior feedback on resume prompts while preserving updated plan content", () => {
    const prompt = buildAutocheckPrompt({
      goalText: "Resume goal",
      plan: makePlan("Resume prompt", "1", "claude_code"),
      workingDir: tmpDir,
      resume: true,
      priorFeedback: ["Do not repeat this feedback in a resumed reviewer session."],
      contextNotes: ["Do not repeat this context note in resume mode."],
    });

    expect(prompt.startsWith(REVIEW_INSTRUCTION)).toBe(true);
    expect(prompt).toContain("You are continuing plan review in an existing reviewer session.");
    expect(prompt).toContain("Updated /plan_detail output:");
    expect(prompt).toContain("Resume prompt");
    expect(prompt).not.toContain("Prior reviewer feedback summary:");
    expect(prompt).not.toContain("Do not repeat this feedback");
    expect(prompt).not.toContain("Do not repeat this context note");
  });

  it("repairs malformed direct decision JSON with trailing brace", async () => {
    mockRunCliProcess.mockResolvedValueOnce(
      cliResult({
        stdout: '{"approved":true}}\n',
      }),
    );

    const result = await runPlanAutocheck({
      plan: makePlan("Codex repaired direct decision", "1", "codex"),
      goalText: "Ship feature",
      mode: "codex",
      workingDir: tmpDir,
      runDir: runPath(tmpDir, "run-codex-repair-direct"),
      commitRevision: vi.fn(),
    });

    expect(result).toMatchObject({
      approved: true,
      exhausted: false,
      autocheckRounds: 0,
      backend: "codex",
    });
    expect(mockRunCliPlanRevision).not.toHaveBeenCalled();
  });

  it("repairs malformed JSONL lines with trailing braces", async () => {
    mockRunCliProcess.mockResolvedValueOnce(
      cliResult({
        stdout: '{"type":"result","result":{"approved":true}}}\n',
      }),
    );

    const result = await runPlanAutocheck({
      plan: makePlan("Claude repaired jsonl line", "1", "claude_code"),
      goalText: "Ship feature",
      mode: "claude_code",
      workingDir: tmpDir,
      runDir: runPath(tmpDir, "run-claude-repair-jsonl"),
      commitRevision: vi.fn(),
    });

    expect(result).toMatchObject({
      approved: true,
      exhausted: false,
      autocheckRounds: 0,
      backend: "claude_code",
    });
    expect(mockRunCliPlanRevision).not.toHaveBeenCalled();
  });

  describe("reviewer session reuse (Stage 2U-C verification)", () => {
    // Locks in the four reviewer-session-reuse guarantees documented on
    // runPlanAutocheck: round 2+ resume the same backend-bound session; a
    // backend switch never reuses an incompatible session id; plan revision
    // preserves accumulated reviewer feedback; and launch/result/round history
    // (with token usage) is recorded for every round.

    it("resumes the SAME reviewer session id in round 2 for the same backend", async () => {
      const firstPlan = makePlan("Reuse round 1", "1", "claude_code");
      const revisedPlan = makePlan("Reuse round 2", "2", "claude_code");
      mockRunCliProcess
        .mockResolvedValueOnce(
          cliResult({
            stdout: claudeStdout({
              decision: { approved: false, editInstructions: "Add an explicit verification step." },
              sessionId: "reuse-session",
            }),
          }),
        )
        .mockResolvedValueOnce(
          cliResult({ stdout: claudeStdout({ decision: { approved: true } }) }),
        );
      mockRunCliPlanRevision.mockResolvedValueOnce({ plan: revisedPlan });

      const result = await runPlanAutocheck({
        plan: firstPlan,
        goalText: "Ship feature",
        mode: "claude_code",
        workingDir: tmpDir,
        runDir: runPath(tmpDir, "run-reuse-same-backend"),
        commitRevision: vi.fn(),
      });

      expect(result).toMatchObject({
        approved: true,
        autocheckRounds: 1,
        backend: "claude_code",
        sessionId: "reuse-session",
      });

      // Round 1 starts fresh; round 2 resumes the exact session id from round 1.
      const firstArgs = (mockRunCliProcess.mock.calls[0][0] as { args: string[] }).args;
      const secondArgs = (mockRunCliProcess.mock.calls[1][0] as { args: string[] }).args;
      expect(firstArgs).not.toContain("--resume");
      expect(secondArgs).toContain("--resume");
      expect(secondArgs).toContain("reuse-session");
    });

    it("clears the session id on a cross-backend usage-limit fallback so it is not reused", async () => {
      mockRunCliProcess
        .mockResolvedValueOnce(
          cliResult({
            stdout: "",
            stderr: "API 429: monthly usage limit reached. Resets at 3pm.",
            exitCode: 1,
          }),
        )
        .mockResolvedValueOnce(
          // The fallback backend (codex) succeeds AND reports its own session id.
          cliResult({
            stdout: '{"session_id":"codex-fallback-session"}\nFinal: {"approved": true}\n',
          }),
        );

      const result = await runPlanAutocheck({
        plan: makePlan("Backend switch clears session", "1", "claude_code"),
        goalText: "Ship feature",
        mode: "claude_code",
        workingDir: tmpDir,
        runDir: runPath(tmpDir, "run-reuse-backend-switch"),
        commitRevision: vi.fn(),
      });

      // Approval came from the fallback backend, so the claude-bound result must
      // NOT carry codex's session id forward — it is cleared to avoid resuming an
      // incompatible session in a later round/run.
      expect(result.approved).toBe(true);
      expect(result.backend).toBe("claude_code");
      expect(result.sessionId).toBeUndefined();
      expect(mockRunCliProcess.mock.calls[0]?.[0]).toMatchObject({ command: "/usr/bin/claude" });
      expect(mockRunCliProcess.mock.calls[1]?.[0]).toMatchObject({ command: "codex" });
    });

    it("does not reuse an incompatible stored session id when the backend changed", async () => {
      mockRunCliProcess.mockResolvedValueOnce(
        cliResult({
          stdout: claudeStdout({ decision: { approved: true }, sessionId: "fresh-claude-session" }),
        }),
      );

      const result = await runPlanAutocheck({
        plan: makePlan("Stored backend mismatch", "1", "claude_code"),
        goalText: "Ship feature",
        mode: "claude_code",
        workingDir: tmpDir,
        runDir: runPath(tmpDir, "run-reuse-stored-mismatch"),
        existingSessionId: "old-codex-session",
        existingBackend: "codex",
        commitRevision: vi.fn(),
      });

      expect(result.sessionId).toBe("fresh-claude-session");
      const firstArgs = (mockRunCliProcess.mock.calls[0][0] as { args: string[] }).args;
      expect(firstArgs).not.toContain("--resume");
      expect(firstArgs).not.toContain("old-codex-session");
    });

    it("preserves and accumulates prior autocheck feedback across plan revisions", async () => {
      const plan1 = makePlan("History plan 1", "1", "claude_code");
      const plan2 = makePlan("History plan 2", "2", "claude_code");
      const plan3 = makePlan("History plan 3", "3", "claude_code");
      const plan4 = makePlan("History plan 4", "4", "claude_code");

      mockRunCliProcess
        .mockResolvedValueOnce(
          cliResult({
            stdout: claudeStdout({
              decision: { approved: false, editInstructions: "Round 1: add file paths." },
              sessionId: "history-session",
            }),
          }),
        )
        .mockResolvedValueOnce(
          cliResult({
            stdout: claudeStdout({
              decision: { approved: false, editInstructions: "Round 2: fix dependency order." },
            }),
          }),
        )
        .mockResolvedValueOnce(
          cliResult({
            stdout: claudeStdout({
              decision: { approved: false, editInstructions: "Round 3: add verification." },
            }),
          }),
        )
        .mockResolvedValueOnce(
          cliResult({ stdout: claudeStdout({ decision: { approved: true } }) }),
        );
      mockRunCliPlanRevision
        .mockResolvedValueOnce({ plan: plan2 })
        .mockResolvedValueOnce({ plan: plan3 })
        .mockResolvedValueOnce({ plan: plan4 });

      await runPlanAutocheck({
        plan: plan1,
        goalText: "Ship feature",
        mode: "claude_code",
        workingDir: tmpDir,
        runDir: runPath(tmpDir, "run-reuse-history"),
        commitRevision: vi.fn(),
      });

      // Prior feedback grows each revision and never drops earlier rounds.
      expect(mockRunCliPlanRevision).toHaveBeenCalledTimes(3);
      const calls = mockRunCliPlanRevision.mock.calls.map(
        (call) => (call[0] as { priorFeedback?: string[] }).priorFeedback,
      );
      expect(calls[0]).toEqual([]);
      expect(calls[1]).toEqual(["Round 1: add file paths."]);
      expect(calls[2]).toEqual(["Round 1: add file paths.", "Round 2: fix dependency order."]);
    });

    it("records launch/result/round history with token usage for EVERY round", async () => {
      const runId = "run-reuse-per-round-history";
      const revisedPlan = makePlan("Per-round revised", "2", "codex");
      mockRunCliProcess
        .mockResolvedValueOnce(
          cliResult({
            stdout: [
              '{"session_id":"codex-tok-session"}',
              '{"type":"token_count","token_count":{"input_tokens":11,"output_tokens":4,"total_tokens":15}}',
              '{"approved":false,"editInstructions":"Tighten dependency ordering."}',
            ].join("\n"),
          }),
        )
        .mockResolvedValueOnce(
          cliResult({
            stdout: [
              '{"type":"token_count","token_count":{"input_tokens":6,"output_tokens":3,"total_tokens":9}}',
              '{"approved":true}',
            ].join("\n"),
          }),
        );
      mockRunCliPlanRevision.mockResolvedValueOnce({ plan: revisedPlan });

      const result = await runPlanAutocheck({
        plan: makePlan("Per-round history", "1", "codex"),
        goalText: "Ship feature",
        mode: "codex",
        workingDir: tmpDir,
        runDir: runPath(tmpDir, runId),
        commitRevision: vi.fn(),
      });

      expect(result).toMatchObject({ approved: true, autocheckRounds: 1, backend: "codex" });

      // Round 2 resumed the round-1 session id.
      const secondArgs = (mockRunCliProcess.mock.calls[1][0] as { args: string[] }).args;
      expect(secondArgs).toEqual(expect.arrayContaining(["exec", "resume", "codex-tok-session"]));

      const events = readAutocheckHistoryEvents(runId, tmpDir);
      const launchEvents = events.filter((event) => event.event === "launch");
      const resultEvents = events.filter((event) => event.event === "result");
      const roundEvents = events.filter((event) => event.event === "round");

      // One launch + result + round event per round, tagged with the round number.
      expect(launchEvents.map((event) => event.round)).toEqual([1, 2]);
      expect(resultEvents.map((event) => event.round)).toEqual([1, 2]);
      expect(roundEvents.map((event) => event.round)).toEqual([1, 2]);

      // Token usage is captured per round.
      expect(resultEvents[0]).toMatchObject({
        status: "rejected",
        tokenUsage: { available: true, totalTokens: 15, source: "codex-json" },
      });
      expect(resultEvents[1]).toMatchObject({
        status: "approved",
        tokenUsage: { available: true, totalTokens: 9, source: "codex-json" },
      });
      expect(roundEvents[0]).toMatchObject({ status: "revision_committed" });
      expect(roundEvents[1]).toMatchObject({ status: "approved" });
    });
  });
});

describe("Stage 2Q — plan-autocheck reviewer instruction", () => {
  // These tests fence the reviewer prompt against drift away from the Stage 2Q
  // rules that the checker must reject implementation/test splits, tsc-only
  // logic steps, missing focused regressions for command/config/prompt/worker/
  // repo-chat steps, and many-tiny-repeated-touches plans — while still
  // allowing a final verification-matrix step and a final report step.

  it("instructs the checker to verify every code-changing step is self-verifying", () => {
    expect(REVIEW_INSTRUCTION).toContain("Every code-changing step is SELF-VERIFYING");
    expect(REVIEW_INSTRUCTION).toContain(
      "it includes implementation AND focused tests AND a focused test command in its success criteria",
    );
  });

  it("rejects implementation/test splits", () => {
    expect(REVIEW_INSTRUCTION).toContain("IMPLEMENTATION/TEST SPLITS");
    expect(REVIEW_INSTRUCTION).toContain(
      "step A implements behavior and step B later adds tests for step A",
    );
  });

  it("rejects tsc-only success criteria for logic-changing steps", () => {
    expect(REVIEW_INSTRUCTION).toContain("TSC-ONLY LOGIC STEPS");
    expect(REVIEW_INSTRUCTION).toContain(
      "Logic changes require a focused regression test command in the same step",
    );
  });

  it("rejects missing focused regressions for command/config/prompt/worker/repo-chat steps", () => {
    expect(REVIEW_INSTRUCTION).toContain("MISSING FOCUSED REGRESSIONS");
    expect(REVIEW_INSTRUCTION).toContain(
      "command-handler, config-schema, prompt, worker-behavior, planner/autocheck, or repo-chat steps that lack a targeted regression test file",
    );
  });

  it("rejects vague success criteria phrases", () => {
    expect(REVIEW_INSTRUCTION).toContain("VAGUE SUCCESS CRITERIA");
  });

  it("rejects many tiny repeated touches that should be merged", () => {
    expect(REVIEW_INSTRUCTION).toContain("TINY REPEATED TOUCHES");
    expect(REVIEW_INSTRUCTION).toContain("could be a smaller number of self-verifying steps");
  });

  it("calls out the Stage 2P bad fixture for add-529-transient-classifier", () => {
    expect(REVIEW_INSTRUCTION).toContain("add-529-transient-classifier");
    expect(REVIEW_INSTRUCTION).toContain("only run `tsc`");
  });

  it("calls out the Stage 2P bad fixture for the repo-chat split", () => {
    expect(REVIEW_INSTRUCTION).toContain("add-repo-chat-cli-output-extraction");
    expect(REVIEW_INSTRUCTION).toContain("add-repo-chat-regression-tests");
  });

  it("explicitly allows a final verification-matrix and report-writing step", () => {
    expect(REVIEW_INSTRUCTION).toContain("EXPLICITLY ALLOWED");
    expect(REVIEW_INSTRUCTION).toContain("final verification-matrix step");
    expect(REVIEW_INSTRUCTION).toContain("final report-writing / documentation step");
  });

  it("warns the checker not to be so rigid that it rejects normal well-scoped plans", () => {
    expect(REVIEW_INSTRUCTION).toContain(
      "Do not make this rubric so rigid that it rejects normal, well-scoped plans",
    );
  });
});

describe("Stage 2Q — Stage 2P regression fixtures", () => {
  // Synthetic plan fixtures that materialize the Stage 2P bad/good patterns.
  // These tests verify that the *reviewer rubric text* declares each case
  // either rejectable or allowed, so future drift in the prompt is caught.

  type StepFixture = {
    id: string;
    description: string;
    successCriteria?: string;
    dependsOn: string[];
  };
  type PlanFixture = { name: string; steps: StepFixture[] };

  const STAGE_2P_BAD_529: PlanFixture = {
    name: "stage-2p-bad-529-split",
    steps: [
      {
        id: "add-529-transient-classifier",
        description: "Add transient-overload classifier to src/goal/error-patterns.ts.",
        successCriteria: "pnpm exec tsc -p tsconfig.json passes.",
        dependsOn: [],
      },
      {
        id: "add-planner-bounded-retry",
        description: "Wire bounded retry into the planner.",
        successCriteria: "pnpm exec tsc passes.",
        dependsOn: ["add-529-transient-classifier"],
      },
      {
        id: "update-529-messages-and-tests",
        description: "Add tests for the classifier and retry.",
        successCriteria: "Tests pass.",
        dependsOn: ["add-planner-bounded-retry"],
      },
    ],
  };

  const STAGE_2P_GOOD_529: PlanFixture = {
    name: "stage-2p-good-529-combined",
    steps: [
      {
        id: "add-529-transient-handling",
        description:
          "Add transient-overload classifier, bounded planner retry, and user-facing messages with tests in src/goal/error-patterns.test.ts and src/goal/cli-planner.test.ts.",
        successCriteria:
          "pnpm vitest run src/goal/error-patterns.test.ts src/goal/cli-planner.test.ts passes; pnpm exec tsc -p tsconfig.json clean; pnpm lint reports 0 warnings.",
        dependsOn: [],
      },
    ],
  };

  const STAGE_2P_BAD_REPO_CHAT: PlanFixture = {
    name: "stage-2p-bad-repo-chat-split",
    steps: [
      {
        id: "add-repo-chat-cli-output-extraction",
        description: "Implement CLI stdout extraction.",
        successCriteria: "pnpm exec tsc passes.",
        dependsOn: [],
      },
      {
        id: "fix-repo-chat-resolution-order",
        description: "Fix backend resolution order.",
        successCriteria: "pnpm exec tsc passes.",
        dependsOn: ["add-repo-chat-cli-output-extraction"],
      },
      {
        id: "add-repo-chat-regression-tests",
        description: "Add regression tests for the two implementations above.",
        successCriteria: "Tests pass.",
        dependsOn: ["fix-repo-chat-resolution-order"],
      },
    ],
  };

  const STAGE_2P_GOOD_REPO_CHAT: PlanFixture = {
    name: "stage-2p-good-repo-chat-combined",
    steps: [
      {
        id: "fix-repo-chat-output-and-resolution",
        description:
          "Implement CLI output extraction AND resolution-order fix AND regression tests in src/repo-chat/.",
        successCriteria:
          "pnpm vitest run src/repo-chat/ passes; pnpm exec tsc -p tsconfig.json clean; pnpm lint reports 0 warnings.",
        dependsOn: [],
      },
    ],
  };

  // Pure-rubric check: given the fixture, the reviewer rubric should call out
  // each anti-pattern (implementation/test split, tsc-only, vague tests-pass).
  function flagsForFixture(fixture: PlanFixture): string[] {
    const flags: string[] = [];
    const implIds = new Set(fixture.steps.map((s) => s.id));
    const testStepIds = fixture.steps
      .filter(
        (s) => /test|regression/i.test(s.id) || /add tests|regression test/i.test(s.description),
      )
      .map((s) => s.id);
    const nonTestImplSteps = fixture.steps.filter((s) => !testStepIds.includes(s.id));

    if (testStepIds.length > 0 && nonTestImplSteps.length > 0) {
      // Test step depends on impl step(s).
      const testSteps = fixture.steps.filter((s) => testStepIds.includes(s.id));
      const split = testSteps.some((t) => t.dependsOn.some((d) => implIds.has(d)));
      if (split) flags.push("implementation-test-split");
    }
    for (const step of nonTestImplSteps) {
      const crit = (step.successCriteria ?? "").toLowerCase();
      const isLogicChange = /classifier|retry|extraction|resolution|wire|implement/.test(
        step.description.toLowerCase(),
      );
      const mentionsVitest = /vitest|test\.[tj]sx?/.test(crit);
      const onlyTsc = /^[^a-z]*(pnpm\s+)?exec\s+tsc/.test(crit) || crit.startsWith("pnpm exec tsc");
      if (isLogicChange && !mentionsVitest && (onlyTsc || crit === "tests pass.")) {
        flags.push(`tsc-only-or-vague:${step.id}`);
      }
    }
    return flags;
  }

  it("classifier-split fixture is flagged as bad by the static rubric", () => {
    const flags = flagsForFixture(STAGE_2P_BAD_529);
    expect(flags).toContain("implementation-test-split");
    // The two impl steps both have tsc-only / vague criteria.
    expect(flags.filter((f) => f.startsWith("tsc-only-or-vague")).length).toBeGreaterThanOrEqual(2);
  });

  it("classifier-combined fixture passes the static rubric", () => {
    expect(flagsForFixture(STAGE_2P_GOOD_529)).toEqual([]);
  });

  it("repo-chat-split fixture is flagged as bad by the static rubric", () => {
    const flags = flagsForFixture(STAGE_2P_BAD_REPO_CHAT);
    expect(flags).toContain("implementation-test-split");
    expect(flags.filter((f) => f.startsWith("tsc-only-or-vague")).length).toBeGreaterThanOrEqual(2);
  });

  it("repo-chat-combined fixture passes the static rubric", () => {
    expect(flagsForFixture(STAGE_2P_GOOD_REPO_CHAT)).toEqual([]);
  });

  it("reviewer prompt explicitly names every anti-pattern these fixtures embody", () => {
    expect(REVIEW_INSTRUCTION).toContain("add-529-transient-classifier");
    expect(REVIEW_INSTRUCTION).toContain("add-repo-chat-cli-output-extraction");
    expect(REVIEW_INSTRUCTION).toContain("IMPLEMENTATION/TEST SPLITS");
    expect(REVIEW_INSTRUCTION).toContain("TSC-ONLY LOGIC STEPS");
  });
});
