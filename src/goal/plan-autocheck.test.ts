import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plan } from "./types.js";
import {
  buildAutocheckPrompt,
  checkPlanWorkingDir,
  formatReviewerResetTime,
  runPlanAutocheck,
  summarizeReviewerFailureReason,
} from "./plan-autocheck.js";
import { REVIEW_INSTRUCTION } from "../prompts/plan-autocheck/review-instruction.js";
import { workspaceNameFromWorkingDir } from "./agent-history.js";
import { resolveAgentHistoryEventsPath } from "./agent-history-events.js";
import * as runtimeMirror from "./runtime-mirror.js";

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
  isBackendAvailable: (
    backend: string,
    availability: { id: string; available: boolean; reason?: string }[],
  ) => {
    const entry = availability.find((item) => item.id === backend);
    if (!entry) return { available: false, reason: "Unknown backend" };
    return entry.available ? { available: true } : { available: false, reason: entry.reason };
  },
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

  it("mirrors autocheck round artifacts and records a warning when mirroring fails", async () => {
    const initialPlan = makePlan("Initial plan");
    const mirrorSpy = vi
      .spyOn(runtimeMirror, "mirrorGoalRuntimeToAgentHistory")
      .mockImplementationOnce(() => {
        throw new Error("mirror unavailable");
      });
    mockRunCliProcess.mockResolvedValueOnce(
      cliResult({
        stdout: claudeStdout({ decision: { approved: true }, sessionId: "session-mirror" }),
      }),
    );

    const commitRevision = vi.fn();
    const workingDir = path.join(tmpDir, "workspace");
    const runDir = runPath(tmpDir, "run-autocheck-mirror");
    fs.mkdirSync(workingDir, { recursive: true });

    const result = await runPlanAutocheck({
      plan: initialPlan,
      goalText: "Ship feature",
      mode: "claude_code",
      workingDir,
      runDir,
      commitRevision,
    });

    expect(result.approved).toBe(true);
    expect(mirrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceName: workspaceNameFromWorkingDir(workingDir),
        goalId: "run-autocheck-mirror",
        goalsDir: tmpDir,
      }),
    );
    expect(readAutocheckHistoryEvents("run-autocheck-mirror", workingDir)).toContainEqual(
      expect.objectContaining({
        event: "runtime_mirror_warning",
        phase: "autocheck",
        status: "warning",
        round: 1,
      }),
    );
    mirrorSpy.mockRestore();
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

  it("throws a descriptive error when the only available reviewer backend fails on a fresh run", async () => {
    // Only Claude Code is available, so there is no alternate to fall back to:
    // the single backend's failure surfaces directly.
    mockDetectBackendAvailability.mockReturnValueOnce([
      { id: "pi", available: false },
      { id: "codex", available: false, reason: "codex not found on PATH" },
      { id: "claude_code", available: true },
    ]);
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
    expect(mockRunCliProcess).toHaveBeenCalledTimes(1);

    expect(mockRunCliPlanRevision).not.toHaveBeenCalled();
    const roundDir = path.join(tmpDir, "run-fresh-fail", "autocheck", "round-1");
    const metadataPath = path.join(roundDir, "metadata.json");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
      failure?: { reason?: string; metadataPath?: string; artifactPaths?: string[] };
    };
    expect(metadata.failure?.reason).toContain("Plan autocheck worker failed: boom");
    expect(metadata.failure?.metadataPath).toBe(metadataPath);
    expect(metadata.failure?.artifactPaths).toContain(path.join(roundDir, "failure.txt"));
    expect(fs.readFileSync(path.join(roundDir, "failure.txt"), "utf8")).toContain("boom");
  });

  it("keeps the stable workingDir as the reviewer cwd while adding observed read roots", async () => {
    const stableWorkingDir = path.join(
      tmpDir,
      "smithersbot-home",
      "agent",
      "workspaces",
      "smithersbot-dev",
    );
    const observedDevAgentRoot = path.join(tmpDir, "smithersbot-dev-home", "agent");
    const observedDevWorkspacesRoot = path.join(observedDevAgentRoot, "workspaces");
    const observedDevHistoryRoot = path.join(observedDevAgentRoot, "history");
    const readOnlyRoots = [observedDevAgentRoot, observedDevWorkspacesRoot, observedDevHistoryRoot];
    fs.mkdirSync(stableWorkingDir, { recursive: true });
    const initialPlan = { ...makePlan("Observed read roots"), workingDir: stableWorkingDir };
    mockRunCliProcess.mockImplementationOnce(async (call: { cwd: string; args: string[] }) => {
      expect(call.cwd).toBe(stableWorkingDir);
      const prompt = call.args.at(-1) ?? "";
      expect(prompt).toContain(`"workingDir": "${stableWorkingDir}"`);
      expect(prompt).not.toContain(`"workingDir": "${observedDevWorkspacesRoot}"`);
      return cliResult({ stdout: '{"approved":true}\n' });
    });

    const result = await runPlanAutocheck({
      plan: initialPlan,
      goalText: "Verify observed dev surface",
      mode: "codex",
      workingDir: stableWorkingDir,
      readOnlyRoots,
      runDir: runPath(tmpDir, "run-observed-read-roots"),
      commitRevision: vi.fn(),
    });

    expect(result.plan.workingDir).toBe(stableWorkingDir);
    expect(mockWriteCodexNativeSandboxConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDir: stableWorkingDir,
        readOnlyRoots,
      }),
    );
  });

  it("rejects an out-of-instance plan workingDir up front (no reviewer spawn) and feeds the revision the actionable edit", async () => {
    // Stable instance: workspaces root resolves under SMITHERSBOT_GOALS_ROOT.
    const validWorkingDir = path.join(managedRoot, "agent", "workspaces", "smithersbot-dev");
    fs.mkdirSync(validWorkingDir, { recursive: true });
    // makePlan() points at /tmp/workspace, which is outside the instance root.
    const invalidPlan = makePlan("Drifted workingDir");
    const revisedPlan = { ...makePlan("Fixed workingDir", "2"), workingDir: validWorkingDir };

    mockRunCliPlanRevision.mockResolvedValueOnce({ plan: revisedPlan });
    // Round 2 reviewer (only invoked AFTER the workingDir is fixed) approves.
    mockRunCliProcess.mockResolvedValueOnce(cliResult({ stdout: '{"approved":true}\n' }));

    const commitRevision = vi.fn();
    const result = await runPlanAutocheck({
      plan: invalidPlan,
      goalText: "Ship feature",
      mode: "codex",
      workingDir: validWorkingDir,
      runDir: runPath(tmpDir, "run-workingdir-guard"),
      commitRevision,
      workspacePolicy: {
        env: { ...process.env, SMITHERSBOT_INSTANCE: "stable" } as NodeJS.ProcessEnv,
      },
    });

    // Round 1 was the programmatic workingDir rejection — no reviewer process.
    expect(mockRunCliProcess).toHaveBeenCalledTimes(1);
    expect(mockRunCliPlanRevision).toHaveBeenCalledTimes(1);
    const revisionArgs = mockRunCliPlanRevision.mock.calls[0]?.[0] as { editInstructions: string };
    expect(revisionArgs.editInstructions).toContain("/tmp/workspace");
    expect(revisionArgs.editInstructions).toContain("not an allowed executable goal working");
    expect(commitRevision).toHaveBeenCalledTimes(1);
    expect(result.approved).toBe(true);
    expect(result.plan.workingDir).toBe(validWorkingDir);
  });

  it("skips the up-front workingDir guard when no workspacePolicy identity is supplied", async () => {
    // Back-compat: callers that validated upstream omit workspacePolicy, so the
    // reviewer runs even for a plan workingDir outside the test managed root.
    const initialPlan = makePlan("No policy supplied");
    mockRunCliProcess.mockResolvedValueOnce(cliResult({ stdout: '{"approved":true}\n' }));

    const result = await runPlanAutocheck({
      plan: initialPlan,
      goalText: "Ship feature",
      mode: "codex",
      workingDir: path.join(tmpDir, "workspace"),
      runDir: runPath(tmpDir, "run-no-policy"),
      commitRevision: vi.fn(),
    });

    expect(mockRunCliProcess).toHaveBeenCalledTimes(1);
    expect(mockRunCliPlanRevision).not.toHaveBeenCalled();
    expect(result.approved).toBe(true);
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

  it("falls back to Claude Code when the Codex reviewer fails on a noninteractive-stdin error", async () => {
    // The "Reading additional input from stdin..." failure is NOT a usage limit;
    // it must still trigger backend failover instead of a silent skip.
    mockRunCliProcess
      .mockResolvedValueOnce(
        cliResult({
          stdout: "",
          stderr: "Reading additional input from stdin...",
          exitCode: 1,
          signal: null,
        }),
      )
      .mockResolvedValueOnce(cliResult({ stdout: claudeStdout({ decision: { approved: true } }) }));

    const runId = "run-codex-stdin-fallback";
    const result = await runPlanAutocheck({
      plan: makePlan("Stdin fallback codex"),
      goalText: "Ship feature",
      mode: "codex",
      workingDir: tmpDir,
      runDir: runPath(tmpDir, runId),
      commitRevision: vi.fn(),
    });

    expect(result.approved).toBe(true);
    expect(mockRunCliProcess).toHaveBeenCalledTimes(2);
    expect(mockRunCliProcess.mock.calls[0]?.[0]).toMatchObject({ command: "codex" });
    expect(mockRunCliProcess.mock.calls[1]?.[0]).toMatchObject({ command: "/usr/bin/claude" });
  });

  it("falls back to Codex when the Claude reviewer fails on a noninteractive-stdin error", async () => {
    mockRunCliProcess
      .mockResolvedValueOnce(
        cliResult({
          stdout: "",
          stderr: "Reading additional input from stdin...",
          exitCode: 1,
          signal: null,
        }),
      )
      .mockResolvedValueOnce(
        cliResult({
          stdout: `${JSON.stringify({ type: "result", result: JSON.stringify({ approved: true }) })}\n`,
        }),
      );

    const result = await runPlanAutocheck({
      plan: makePlan("Stdin fallback claude"),
      goalText: "Ship feature",
      mode: "claude_code",
      workingDir: tmpDir,
      runDir: runPath(tmpDir, "run-claude-stdin-fallback"),
      commitRevision: vi.fn(),
    });

    expect(result.approved).toBe(true);
    expect(mockRunCliProcess).toHaveBeenCalledTimes(2);
    expect(mockRunCliProcess.mock.calls[0]?.[0]).toMatchObject({ command: "/usr/bin/claude" });
    expect(mockRunCliProcess.mock.calls[1]?.[0]).toMatchObject({ command: "codex" });
  });

  it("uses Codex when the configured Claude backend is unavailable on PATH (no silent skip)", async () => {
    mockDetectBackendAvailability.mockReturnValueOnce([
      { id: "pi", available: false },
      { id: "codex", available: true },
      { id: "claude_code", available: false, reason: "claude not found on PATH" },
    ]);
    mockRunCliProcess.mockResolvedValueOnce(
      cliResult({
        stdout: `${JSON.stringify({ type: "result", result: JSON.stringify({ approved: true }) })}\n`,
      }),
    );

    const result = await runPlanAutocheck({
      plan: makePlan("Configured backend unavailable"),
      goalText: "Ship feature",
      mode: "claude_code",
      workingDir: tmpDir,
      runDir: runPath(tmpDir, "run-claude-unavailable"),
      commitRevision: vi.fn(),
    });

    // Autocheck is enabled and must not be silently skipped: the only available
    // backend (Codex) is used even though the configured backend was Claude.
    expect(result.approved).toBe(true);
    expect(mockRunCliProcess).toHaveBeenCalledTimes(1);
    expect(mockRunCliProcess.mock.calls[0]?.[0]).toMatchObject({ command: "codex" });
  });

  it("throws a clear actionable error when no reviewer backend is available", async () => {
    mockDetectBackendAvailability.mockReturnValueOnce([
      { id: "pi", available: false },
      { id: "codex", available: false, reason: "codex not found on PATH" },
      { id: "claude_code", available: false, reason: "claude not found on PATH" },
    ]);

    await expect(
      runPlanAutocheck({
        plan: makePlan("No backend available"),
        goalText: "Ship feature",
        mode: "codex",
        workingDir: tmpDir,
        runDir: runPath(tmpDir, "run-no-backend"),
        commitRevision: vi.fn(),
      }),
    ).rejects.toThrow(
      /no review backend is available[\s\S]*codex unavailable[\s\S]*claude_code unavailable/,
    );
    expect(mockRunCliProcess).not.toHaveBeenCalled();
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
    ).toBeLessThan(prompt.indexOf("Current plan JSON:"));
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
    ).toBeLessThan(prompt.indexOf("Updated plan JSON:"));
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

    // Only Claude Code is available, so the fresh fallback has no alternate
    // backend to try: resume(claude) -> fresh(claude) both fail, then degrade.
    mockDetectBackendAvailability.mockReturnValueOnce([
      { id: "pi", available: false },
      { id: "codex", available: false, reason: "codex not found on PATH" },
      { id: "claude_code", available: true },
    ]);
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
    expect(call.args).toContain("--skip-git-repo-check");
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
    expect(prompt).toContain("Updated plan JSON:");
    expect(prompt).toContain("Scout facts/artifact references:");
    expect(prompt).toContain("Resume prompt");
    expect(prompt).not.toContain("Prior reviewer feedback summary:");
    expect(prompt).not.toContain("Do not repeat this feedback");
    expect(prompt).not.toContain("Do not repeat this context note");
  });

  it("injects dev-gateway verification guidance only for the smithersbot-dev checkout", () => {
    const devDir = path.join(os.tmpdir(), "smithersbot-home", "workspaces", "smithersbot-dev");
    const devPrompt = buildAutocheckPrompt({
      goalText: "Change gateway restart behavior",
      plan: makePlan("Dev gateway change", "1", "claude_code"),
      workingDir: devDir,
      resume: false,
      priorFeedback: [],
      contextNotes: [],
    });

    expect(devPrompt).toContain("DEV GATEWAY VERIFICATION (SmithersBot dev checkout)");
    expect(devPrompt).toContain("smithersbot-dev-gateway.service");
    expect(devPrompt).toContain("REJECT the plan if it verifies only with build/lint");
    // Docs/tests-only and ordinary project goals stay exempt.
    expect(devPrompt).toContain("Do NOT require dev-gateway verification for docs-only");

    // Use a literal absolute path OUTSIDE the dev checkout. Under vitest,
    // os.tmpdir() itself resolves under the real smithersbot-dev workspace, so a
    // tmpdir-based path would (correctly) be detected as the dev checkout.
    const nonDevPrompt = buildAutocheckPrompt({
      goalText: "Change gateway restart behavior",
      plan: makePlan("Ordinary change", "1", "claude_code"),
      workingDir: "/tmp/some-other-project",
      resume: false,
      priorFeedback: [],
      contextNotes: [],
    });
    expect(nonDevPrompt).not.toContain("DEV GATEWAY VERIFICATION");
  });

  it("injects dev-gateway verification guidance on resume prompts too", () => {
    const devDir = path.join(os.tmpdir(), "workspaces", "smithersbot-dev");
    const prompt = buildAutocheckPrompt({
      goalText: "Change worker prompt injection",
      plan: makePlan("Dev resume change", "1", "claude_code"),
      workingDir: devDir,
      resume: true,
      priorFeedback: [],
      contextNotes: [],
    });
    expect(prompt.startsWith(REVIEW_INSTRUCTION)).toBe(true);
    expect(prompt).toContain("DEV GATEWAY VERIFICATION (SmithersBot dev checkout)");
    expect(prompt).toContain("You are continuing plan review in an existing reviewer session.");
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

  describe("backend-availability error rendering", () => {
    const SYSTEM_INIT_JSON =
      '{"type":"system","subtype":"init","cwd":"/repo","tools":["Read"],"model":"sonnet"}';

    it("summarizes a worker init/system JSON blob instead of printing it raw", async () => {
      // Only Codex is available; it emits a system/init control message (exit 1)
      // instead of a review. The surfaced error must be summarized, never raw.
      mockDetectBackendAvailability.mockReturnValueOnce([
        { id: "pi", available: false },
        { id: "codex", available: true },
        { id: "claude_code", available: false, reason: "claude not found on PATH" },
      ]);
      mockRunCliProcess.mockResolvedValueOnce(
        cliResult({ stdout: SYSTEM_INIT_JSON, stderr: SYSTEM_INIT_JSON, exitCode: 1 }),
      );

      let caught: unknown;
      try {
        await runPlanAutocheck({
          plan: makePlan("System init blob"),
          goalText: "Ship feature",
          mode: "codex",
          workingDir: tmpDir,
          runDir: runPath(tmpDir, "run-system-init"),
          commitRevision: vi.fn(),
        });
      } catch (err) {
        caught = err;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).toContain("Plan autocheck could not run");
      expect(message).toContain("Codex");
      expect(message).toMatch(/system\/init message/i);
      // Never echoes the raw JSON.
      expect(message).not.toContain('"type"');
      expect(message).not.toContain("{");

      // The persisted skip reason (which feeds the Telegram note) is also clean.
      const failureTxt = fs.readFileSync(
        path.join(tmpDir, "run-system-init", "autocheck", "round-1", "failure.txt"),
        "utf8",
      );
      expect(failureTxt).not.toContain("{");
      expect(failureTxt).toMatch(/system\/init message/i);
    });

    it("falls back to the alternate reviewer backend before giving up on a system/init blob", async () => {
      // Codex emits a system/init message; autocheck must try Claude Code rather
      // than skipping on the first failure.
      mockRunCliProcess
        .mockResolvedValueOnce(
          cliResult({ stdout: SYSTEM_INIT_JSON, stderr: SYSTEM_INIT_JSON, exitCode: 1 }),
        )
        .mockResolvedValueOnce(
          cliResult({ stdout: claudeStdout({ decision: { approved: true } }) }),
        );

      const result = await runPlanAutocheck({
        plan: makePlan("System init fallback"),
        goalText: "Ship feature",
        mode: "codex",
        workingDir: tmpDir,
        runDir: runPath(tmpDir, "run-system-init-fallback"),
        commitRevision: vi.fn(),
      });

      expect(result.approved).toBe(true);
      expect(mockRunCliProcess).toHaveBeenCalledTimes(2);
      expect(mockRunCliProcess.mock.calls[0]?.[0]).toMatchObject({ command: "codex" });
      expect(mockRunCliProcess.mock.calls[1]?.[0]).toMatchObject({ command: "/usr/bin/claude" });
    });

    it("renders a clean, actionable message naming both backends when all reviewers fail", async () => {
      // Codex returns a rate-limit error JSON; Claude Code returns a system/init
      // blob. Neither produces a review, so the consolidated message must name
      // both backends and stay free of raw JSON.
      mockRunCliProcess
        .mockResolvedValueOnce(
          cliResult({
            stdout: '{"error":{"type":"rate_limit_error","message":"429 too many requests"}}',
            stderr: "",
            exitCode: 1,
          }),
        )
        .mockResolvedValueOnce(
          cliResult({ stdout: SYSTEM_INIT_JSON, stderr: SYSTEM_INIT_JSON, exitCode: 1 }),
        );

      let caught: unknown;
      try {
        await runPlanAutocheck({
          plan: makePlan("All reviewers fail"),
          goalText: "Ship feature",
          mode: "codex",
          workingDir: tmpDir,
          runDir: runPath(tmpDir, "run-all-fail"),
          commitRevision: vi.fn(),
        });
      } catch (err) {
        caught = err;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).not.toContain("{");
      expect(message).not.toContain('"type"');
      expect(message).toContain("Codex");
      expect(message).toContain("Claude Code");
      expect(message).toMatch(/No reviewer backend is currently available|exhausted/i);
    });
  });
});

describe("summarizeReviewerFailureReason", () => {
  it("summarizes a worker init/system JSON line without printing it", () => {
    const raw =
      'Plan autocheck worker failed: {"type":"system","subtype":"init","model":"sonnet"} (exit=1, signal=none)';
    const summary = summarizeReviewerFailureReason(raw, { backend: "claude_code" });
    expect(summary).not.toContain("{");
    expect(summary).toContain("Claude Code");
    expect(summary).toMatch(/system\/init message/i);
  });

  it("classifies an out-of-usage provider JSON and appends the reset time", () => {
    const raw =
      '{"error":{"type":"insufficient_quota","message":"You have exceeded your quota, resets at 12:20 PM EDT"}}';
    const summary = summarizeReviewerFailureReason(raw, { backend: "codex" });
    expect(summary).not.toContain("{");
    expect(summary).toMatch(/Codex is out of usage/);
    expect(summary).toContain("12:20 PM EDT");
  });

  it("classifies a rate-limit provider JSON", () => {
    const raw = '{"error":{"type":"rate_limit_error","message":"429 too many requests"}}';
    const summary = summarizeReviewerFailureReason(raw, { backend: "claude_code" });
    expect(summary).not.toContain("{");
    expect(summary).toMatch(/Claude Code is rate limited/);
  });

  it("passes clean (non-JSON) text through unchanged so classification is preserved", () => {
    const raw = "monthly usage limit reached. Resets at 3pm.";
    expect(summarizeReviewerFailureReason(raw, { backend: "codex" })).toBe(raw);
  });
});

describe("formatReviewerResetTime", () => {
  it("formats an epoch-seconds reset into local time for the given zone", () => {
    // 2024-06-10T08:53:20Z -> 04:53 AM EDT in America/New_York.
    const formatted = formatReviewerResetTime("resets at 1718009600", "America/New_York");
    expect(formatted).toMatch(/EDT/);
    expect(formatted).toMatch(/AM|PM/);
  });

  it("formats an ISO timestamp into local time for the given zone", () => {
    const formatted = formatReviewerResetTime("2024-06-10T16:20:00Z", "America/New_York");
    expect(formatted).toMatch(/12:20\s?PM/);
    expect(formatted).toMatch(/EDT/);
  });

  it("returns a relative phrase unchanged when it has no parseable absolute time", () => {
    expect(formatReviewerResetTime("resets in 2 hours")).toBe("resets in 2 hours");
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

describe("checkPlanWorkingDir (executable workingDir autocheck guard)", () => {
  const HOME = "/home/matt";
  const homedir = () => HOME;
  const stable = {
    env: { SMITHERSBOT_INSTANCE: "stable" } as NodeJS.ProcessEnv,
    homedir,
  };
  const dev = {
    env: { SMITHERSBOT_INSTANCE: "dev" } as NodeJS.ProcessEnv,
    homedir,
  };

  it("rejects a stable plan whose workingDir is the observed dev-home workspace, with actionable edit instructions", () => {
    const decision = checkPlanWorkingDir(
      "/home/matt/smithersbot-dev-home/agent/workspaces/smithersbot-dev",
      { ...stable, observedInstances: ["dev"], config: { allowLegacyWorkingDir: true } },
    );
    expect(decision.approved).toBe(false);
    if (decision.approved) throw new Error("expected rejection");
    expect(decision.editInstructions).toContain(
      "/home/matt/smithersbot-dev-home/agent/workspaces/smithersbot-dev",
    );
    // Names the correct current-instance workspaces root to steer the revision.
    expect(decision.editInstructions).toContain("/home/matt/smithersbot-home/agent/workspaces");
    expect(decision.editInstructions.toLowerCase()).toContain("read-only");
  });

  it("rejects a stable plan with an arbitrary out-of-root workingDir", () => {
    for (const workingDir of ["/tmp/whatever", "/home/matt/.config/smithersbot"]) {
      const decision = checkPlanWorkingDir(workingDir, stable);
      expect(decision.approved).toBe(false);
      if (decision.approved) throw new Error("expected rejection");
      expect(decision.editInstructions).toContain(workingDir);
      expect(decision.editInstructions).toContain("/home/matt/smithersbot-home/agent/workspaces");
    }
  });

  it("accepts a stable plan whose workingDir is under the stable agent workspaces root", () => {
    expect(
      checkPlanWorkingDir("/home/matt/smithersbot-home/agent/workspaces/smithersbot-dev", stable),
    ).toEqual({ approved: true });
  });

  it("accepts a dev-instance plan under the dev agent workspaces root", () => {
    expect(
      checkPlanWorkingDir("/home/matt/smithersbot-dev-home/agent/workspaces/smithersbot-dev", dev),
    ).toEqual({ approved: true });
  });

  it("rejects a dev-instance plan that points at the stable-home workspaces root", () => {
    const decision = checkPlanWorkingDir(
      "/home/matt/smithersbot-home/agent/workspaces/smithersbot-dev",
      dev,
    );
    expect(decision.approved).toBe(false);
    if (decision.approved) throw new Error("expected rejection");
    expect(decision.editInstructions).toContain("/home/matt/smithersbot-dev-home/agent/workspaces");
  });

  it("hard-denies private roots even with the legacy flag enabled", () => {
    const decision = checkPlanWorkingDir(
      "/home/matt/smithersbot-home/private/env/smithersbot-dev",
      { ...stable, config: { allowLegacyWorkingDir: true } },
    );
    expect(decision.approved).toBe(false);
    if (decision.approved) throw new Error("expected rejection");
    expect(decision.editInstructions.toLowerCase()).toContain("private");
  });
});
