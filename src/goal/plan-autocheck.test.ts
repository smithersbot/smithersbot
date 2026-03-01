import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plan } from "./types.js";
import { runPlanAutocheck } from "./plan-autocheck.js";

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
vi.mock("./backend-availability.js", () => ({
  getCodexAskForApprovalPlacement: () => mockGetCodexAskForApprovalPlacement(),
}));

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

describe("runPlanAutocheck", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-autocheck-test-"));
    vi.clearAllMocks();
    mockResolveClaudeBinary.mockReturnValue("/usr/bin/claude");
    mockGetCodexAskForApprovalPlacement.mockReturnValue("unsupported");
  });

  afterEach(() => {
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
});
