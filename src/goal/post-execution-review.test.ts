import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RunCliProcessResult } from "./cli-process.js";

const mockRunCliProcess = vi.hoisted(() => vi.fn());
vi.mock("./cli-process.js", () => ({
  runCliProcess: (...args: unknown[]) => mockRunCliProcess(...args),
}));

const mockResolveClaudeBinary = vi.hoisted(() => vi.fn());
vi.mock("./scout.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scout.js")>();
  return {
    ...actual,
    resolveClaudeBinary: (...args: unknown[]) => mockResolveClaudeBinary(...args),
  };
});

const mockDetectBackendAvailability = vi.hoisted(() =>
  vi.fn(() => [
    { id: "pi", available: true },
    { id: "codex", available: true },
    { id: "claude_code", available: true },
  ]),
);
vi.mock("./backend-availability.js", () => ({
  detectBackendAvailability: () => mockDetectBackendAvailability(),
  getCodexAskForApprovalPlacement: () => "unsupported",
}));

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

import {
  buildBoundedDiffOrChunks,
  buildPostExecutionReviewPrompt,
  describeApiErrorEnvelope,
  parsePostExecutionReviewDecision,
  parsePostExecutionReviewDecisionFromText,
  POST_EXECUTION_REVIEW_DIFF_MAX_CHARS,
  runPostExecutionReview,
  splitDiffByFile,
} from "./post-execution-review.js";
import type { PlanStep } from "./types.js";

function createPlanStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: "step-1",
    description: "Implement feature",
    shortSummary: "Implement feature",
    dependsOn: [],
    status: "pending",
    ...overrides,
  };
}

describe("parsePostExecutionReviewDecisionFromText", () => {
  it("parses valid JSON decisions", () => {
    const decision = parsePostExecutionReviewDecisionFromText(
      '{"approved":true,"issues":["Looks good"]}',
    );

    expect(decision).toEqual({ approved: true, issues: ["Looks good"] });
  });

  it("repairs a trailing extra closing brace", () => {
    const decision = parsePostExecutionReviewDecisionFromText(
      '{"approved":false,"issues":["Missing tests"]}}',
    );

    expect(decision).toEqual({ approved: false, issues: ["Missing tests"] });
  });

  it("repairs malformed JSONL lines", () => {
    const decision = parsePostExecutionReviewDecisionFromText(
      ["status update", '{"approved":true,"issues":[]}}', "done"].join("\n"),
    );

    expect(decision).toEqual({ approved: true, issues: [] });
  });

  it("extracts and repairs prose-wrapped JSON candidates", () => {
    const decision = parsePostExecutionReviewDecisionFromText(
      'Decision: {"approved":false,"issues":["Handle ENOENT",],} please address.',
    );

    expect(decision).toEqual({ approved: false, issues: ["Handle ENOENT"] });
  });
});

describe("parsePostExecutionReviewDecision", () => {
  it("repairs malformed stream-json lines before parsing", () => {
    const stdout = [
      '{"type":"assistant","content":[{"text":"reviewing"}]}',
      '{"type":"result","result":{"approved":true,"issues":[]}}}',
    ].join("\n");

    const decision = parsePostExecutionReviewDecision(stdout);

    expect(decision).toEqual({ approved: true, issues: [] });
  });

  it("parses --output-format json envelopes where result is a JSON string", () => {
    const decision = parsePostExecutionReviewDecision(
      '{"type":"result","subtype":"success","result":"{\\"approved\\":true,\\"issues\\":[]}"}',
    );

    expect(decision).toEqual({ approved: true, issues: [] });
  });
});

function createCliResult(overrides: Partial<RunCliProcessResult> = {}): RunCliProcessResult {
  return {
    stdout: "",
    stderr: "",
    timedOut: false,
    exitCode: 0,
    signal: null,
    durationMs: 1,
    ...overrides,
  };
}

function createDecisionStdout(decision: { approved: boolean; issues: string[] }): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    result: JSON.stringify(decision),
  });
}

describe("splitDiffByFile", () => {
  it("round-trips a 2-file diff into 2 chunks that each start with diff --git", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index 1..2 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1 +1 @@",
      "-foo",
      "+foo2",
      "diff --git a/src/bar.ts b/src/bar.ts",
      "index 3..4 100644",
      "--- a/src/bar.ts",
      "+++ b/src/bar.ts",
      "@@ -1 +1 @@",
      "-bar",
      "+bar2",
    ].join("\n");

    const parts = splitDiffByFile(diff);

    expect(parts).toHaveLength(2);
    expect(parts[0]!.path).toBe("src/foo.ts");
    expect(parts[0]!.chunk.startsWith("diff --git a/src/foo.ts")).toBe(true);
    expect(parts[1]!.path).toBe("src/bar.ts");
    expect(parts[1]!.chunk.startsWith("diff --git a/src/bar.ts")).toBe(true);
    expect(parts[0]!.chunk + parts[1]!.chunk).toBe(diff);
  });
});

describe("buildBoundedDiffOrChunks", () => {
  it("returns single when diff fits the budget", () => {
    const diff = "diff --git a/foo b/foo\n-foo\n+foo2\n";
    const result = buildBoundedDiffOrChunks(diff, 1000);
    expect(result).toEqual({ kind: "single", diff });
  });

  it("returns per-file chunks when the whole diff exceeds the budget", () => {
    const file1 = `diff --git a/a.ts b/a.ts\n${"a".repeat(60)}\n`;
    const file2 = `diff --git a/b.ts b/b.ts\n${"b".repeat(60)}\n`;
    const diff = file1 + file2;
    // Total > budget but each file alone fits.
    const result = buildBoundedDiffOrChunks(diff, file1.length + 5);

    expect(result.kind).toBe("chunks");
    if (result.kind !== "chunks") throw new Error("expected chunks");
    expect(result.chunks.map((c) => c.path)).toEqual(["a.ts", "b.ts"]);
    expect(result.truncatedFiles).toEqual([]);
  });

  it("truncates an oversized per-file chunk and records the path", () => {
    const big = `diff --git a/big.ts b/big.ts\n${"x".repeat(500)}\n`;
    const small = `diff --git a/small.ts b/small.ts\nok\n`;
    const result = buildBoundedDiffOrChunks(big + small, 100);

    expect(result.kind).toBe("chunks");
    if (result.kind !== "chunks") throw new Error("expected chunks");
    expect(result.truncatedFiles).toContain("big.ts");
    expect(result.truncatedFiles).not.toContain("small.ts");
    const bigChunk = result.chunks.find((c) => c.path === "big.ts")!;
    expect(bigChunk.diff).toMatch(/\[diff truncated: \d+ more bytes in this file\]$/);
    expect(bigChunk.diff.length).toBeLessThanOrEqual(100 + 64);
  });
});

describe("describeApiErrorEnvelope", () => {
  it("returns API 400: Prompt is too long for the observed envelope", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 400,
      duration_ms: 7447,
      duration_api_ms: 0,
      num_turns: 1,
      result: "Prompt is too long",
      stop_reason: "stop_sequence",
    });

    const description = describeApiErrorEnvelope(envelope);

    expect(description).toBeDefined();
    expect(description!.startsWith("API 400: Prompt is too long")).toBe(true);
    expect(description).toContain("diff likely too large");
    expect(description).toContain("POST_EXECUTION_REVIEW_DIFF_MAX_CHARS");
  });

  it("returns undefined for non-error envelopes", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: '{"approved":true,"issues":[]}',
    });

    expect(describeApiErrorEnvelope(envelope)).toBeUndefined();
  });
});

describe("runPostExecutionReview", () => {
  const baseParams = () => ({
    goal: "Refactor module",
    steps: [
      {
        id: "step-1",
        description: "Implement feature",
        shortSummary: "Implement feature",
        dependsOn: [],
        status: "done",
      } as PlanStep,
    ],
    workingDir: "/tmp/repo",
    claudeCodeAuth: "anthropic-api" as const,
    abortSignal: new AbortController().signal,
  });

  beforeEach(() => {
    mockRunCliProcess.mockReset();
    mockResolveClaudeBinary.mockReset();
    mockDetectBackendAvailability.mockReset();
    mockResolveClaudeBinary.mockReturnValue("/usr/local/bin/claude");
    mockDetectBackendAvailability.mockReturnValue([
      { id: "pi", available: true },
      { id: "codex", available: true },
      { id: "claude_code", available: true },
    ]);
  });

  it("returns approved unchanged for a small single-pass diff", async () => {
    mockRunCliProcess.mockResolvedValue(
      createCliResult({ stdout: createDecisionStdout({ approved: true, issues: [] }) }),
    );

    const result = await runPostExecutionReview({
      ...baseParams(),
      diff: "diff --git a/foo b/foo\n-foo\n+bar\n",
    });

    expect(mockRunCliProcess).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: "approved", issues: [] });
  });

  it("returns rejected with issues unchanged for a small single-pass diff", async () => {
    mockRunCliProcess.mockResolvedValue(
      createCliResult({
        stdout: createDecisionStdout({ approved: false, issues: ["Add a test"] }),
      }),
    );

    const result = await runPostExecutionReview({
      ...baseParams(),
      diff: "diff --git a/foo b/foo\n-foo\n+bar\n",
    });

    expect(mockRunCliProcess).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: "rejected", issues: ["Add a test"] });
  });

  it("redacts known secret values from review issues", async () => {
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "FAKE_TELEGRAM_SECRET_123";
    try {
      mockRunCliProcess.mockResolvedValue(
        createCliResult({
          stdout: createDecisionStdout({
            approved: false,
            issues: ["Remove FAKE_TELEGRAM_SECRET_123 from logs"],
          }),
        }),
      );

      const result = await runPostExecutionReview({
        ...baseParams(),
        diff: "diff --git a/foo b/foo\n-foo\n+bar\n",
      });

      expect(result.status).toBe("rejected");
      if (result.status !== "rejected") throw new Error("expected rejected");
      expect(result.issues[0]).toContain("[REDACTED]");
      expect(result.issues[0]).not.toContain("FAKE_TELEGRAM_SECRET_123");
    } finally {
      if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    }
  });

  it("falls back to Codex-only review when Claude Code is unavailable", async () => {
    mockResolveClaudeBinary.mockReturnValue(null);
    mockDetectBackendAvailability.mockReturnValue([
      { id: "pi", available: true },
      { id: "codex", available: true },
      { id: "claude_code", available: false, reason: "claude not found on PATH" },
    ]);
    mockRunCliProcess.mockResolvedValueOnce(
      createCliResult({
        stdout: JSON.stringify({
          type: "result",
          result: '{"approved":true,"issues":[]}',
        }),
      }),
    );

    const approved = await runPostExecutionReview({
      ...baseParams(),
      diff: "diff --git a/foo b/foo\n-foo\n+bar\n",
    });

    expect(approved).toEqual({ status: "approved", issues: [] });

    mockRunCliProcess.mockResolvedValueOnce(
      createCliResult({
        stdout: JSON.stringify({
          type: "result",
          result: '{"approved":false,"issues":["Add regression coverage"]}',
        }),
      }),
    );

    const rejected = await runPostExecutionReview({
      ...baseParams(),
      diff: "diff --git a/foo b/foo\n-foo\n+bar\n",
    });

    expect(rejected).toEqual({ status: "rejected", issues: ["Add regression coverage"] });
    const call = mockRunCliProcess.mock.calls[1]?.[0] as { command: string; args: string[] };
    expect(call.command).toBe("codex");
    expect(call.args).toContain("exec");
    expect(call.args).toContain("--json");
  });

  it("strips credential env vars from Codex post-execution review subprocesses", async () => {
    mockResolveClaudeBinary.mockReturnValue(null);
    mockDetectBackendAvailability.mockReturnValue([
      { id: "pi", available: true },
      { id: "codex", available: true },
      { id: "claude_code", available: false, reason: "claude not found on PATH" },
    ]);
    mockRunCliProcess.mockResolvedValueOnce(
      createCliResult({
        stdout: JSON.stringify({
          type: "result",
          result: '{"approved":true,"issues":[]}',
        }),
      }),
    );

    await withForbiddenAgentEnv(() =>
      runPostExecutionReview({
        ...baseParams(),
        diff: "diff --git a/foo b/foo\n-foo\n+bar\n",
      }),
    );

    const call = mockRunCliProcess.mock.calls[0]?.[0] as {
      command: string;
      env: Record<string, string | undefined>;
    };
    expect(call.command).toBe("codex");
    expectForbiddenAgentEnvAbsent(call.env);
  });

  it("strips poisoned Claude subscription auth env from review subprocesses", async () => {
    const previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "https://proxy.invalid";
    mockRunCliProcess.mockResolvedValueOnce(
      createCliResult({ stdout: createDecisionStdout({ approved: true, issues: [] }) }),
    );

    try {
      await withForbiddenAgentEnv(() =>
        runPostExecutionReview({
          ...baseParams(),
          claudeCodeAuth: "subscription",
          diff: "diff --git a/foo b/foo\n-foo\n+bar\n",
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
    expect(call.command).toBe("/usr/local/bin/claude");
    expectForbiddenAgentEnvAbsent(call.env);
    expect(call.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(call.args).not.toContain("--dangerously-skip-permissions");
    expect(call.args).not.toContain("--allow-dangerously-skip-permissions");
  });

  it("returns a clear setup error when no review backend is available", async () => {
    mockResolveClaudeBinary.mockReturnValue(null);
    mockDetectBackendAvailability.mockReturnValue([
      { id: "pi", available: true },
      { id: "codex", available: false, reason: "codex not found on PATH" },
      { id: "claude_code", available: false, reason: "claude not found on PATH" },
    ]);

    const result = await runPostExecutionReview({
      ...baseParams(),
      diff: "diff --git a/foo b/foo\n-foo\n+bar\n",
    });

    expect(result).toEqual({
      status: "error",
      reason: "no worker backend available — install Codex or Claude Code",
    });
  });

  it("merges chunked results: 1 reject + 2 approve yields rejected with that one issue and no truncation note", async () => {
    const bigPayload = "x".repeat(POST_EXECUTION_REVIEW_DIFF_MAX_CHARS - 100);
    const diff = [
      `diff --git a/a.ts b/a.ts\n${bigPayload}`,
      `diff --git a/b.ts b/b.ts\n${bigPayload}`,
      `diff --git a/c.ts b/c.ts\n${bigPayload}`,
    ].join("\n");

    mockRunCliProcess
      .mockResolvedValueOnce(
        createCliResult({ stdout: createDecisionStdout({ approved: true, issues: [] }) }),
      )
      .mockResolvedValueOnce(
        createCliResult({
          stdout: createDecisionStdout({ approved: false, issues: ["Missing null check"] }),
        }),
      )
      .mockResolvedValueOnce(
        createCliResult({ stdout: createDecisionStdout({ approved: true, issues: [] }) }),
      );

    const result = await runPostExecutionReview({ ...baseParams(), diff });

    expect(mockRunCliProcess).toHaveBeenCalledTimes(3);
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("expected rejected");
    expect(result.issues).toEqual(["Missing null check"]);
    expect(result.issues.some((i) => i.includes("truncated and not fully reviewed"))).toBe(false);
  });

  it("appends a truncation summary issue when truncatedFiles is non-empty", async () => {
    // First file is huge enough to trigger per-file truncation; the next two are small enough.
    const huge = "y".repeat(POST_EXECUTION_REVIEW_DIFF_MAX_CHARS + 10);
    const big = "z".repeat(POST_EXECUTION_REVIEW_DIFF_MAX_CHARS / 2);
    const diff = [
      `diff --git a/huge.ts b/huge.ts\n${huge}`,
      `diff --git a/med1.ts b/med1.ts\n${big}`,
      `diff --git a/med2.ts b/med2.ts\n${big}`,
    ].join("\n");

    mockRunCliProcess.mockResolvedValue(
      createCliResult({ stdout: createDecisionStdout({ approved: false, issues: ["Audit log"] }) }),
    );

    const result = await runPostExecutionReview({ ...baseParams(), diff });

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("expected rejected");
    expect(result.issues).toContain("Audit log");
    expect(
      result.issues.some((i) =>
        i.startsWith("Diff for these files was truncated and not fully reviewed:"),
      ),
    ).toBe(true);
    expect(result.issues.find((i) => i.includes("truncated and not fully reviewed"))!).toContain(
      "huge.ts",
    );
  });

  it("short-circuits to error with failed-file path when any chunk errors", async () => {
    const bigPayload = "x".repeat(POST_EXECUTION_REVIEW_DIFF_MAX_CHARS - 100);
    const diff = [
      `diff --git a/a.ts b/a.ts\n${bigPayload}`,
      `diff --git a/b.ts b/b.ts\n${bigPayload}`,
      `diff --git a/c.ts b/c.ts\n${bigPayload}`,
    ].join("\n");

    const apiErrorEnvelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 400,
      result: "Prompt is too long",
      stop_reason: "stop_sequence",
    });

    mockRunCliProcess
      .mockResolvedValueOnce(
        createCliResult({ stdout: createDecisionStdout({ approved: true, issues: [] }) }),
      )
      .mockResolvedValueOnce(createCliResult({ stdout: apiErrorEnvelope, exitCode: 1 }));

    const result = await runPostExecutionReview({ ...baseParams(), diff });

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected error");
    expect(result.reason.startsWith("b.ts:")).toBe(true);
    expect(result.reason).toContain("API 400");
    // Should NOT have called the third chunk.
    expect(mockRunCliProcess).toHaveBeenCalledTimes(2);
  });

  it("falls back to Codex when Claude Code hits a usage limit", async () => {
    mockRunCliProcess
      .mockResolvedValueOnce(
        createCliResult({
          stdout: "",
          stderr: "API 429: You've hit your org's monthly usage limit. Resets at 3pm.",
          exitCode: 1,
        }),
      )
      .mockResolvedValueOnce(
        createCliResult({ stdout: createDecisionStdout({ approved: true, issues: [] }) }),
      );

    const result = await runPostExecutionReview({
      ...baseParams(),
      diff: "diff --git a/foo b/foo\n-foo\n+bar\n",
    });

    expect(result).toEqual({ status: "approved", issues: [] });
    expect(mockRunCliProcess).toHaveBeenCalledTimes(2);
    const first = mockRunCliProcess.mock.calls[0]?.[0] as { command: string };
    const second = mockRunCliProcess.mock.calls[1]?.[0] as { command: string };
    expect(first.command).toBe("/usr/local/bin/claude");
    expect(second.command).toBe("codex");
  });

  it("returns one clear error with reset times when both backends are usage-limited", async () => {
    mockRunCliProcess
      .mockResolvedValueOnce(
        createCliResult({
          stdout: "",
          stderr: "API 429: monthly usage limit reached. Resets at 3pm.",
          exitCode: 1,
        }),
      )
      .mockResolvedValueOnce(
        createCliResult({
          stdout: "",
          stderr: "Codex usage limit hit (weekly). Resets on Monday.",
          exitCode: 1,
        }),
      );

    const result = await runPostExecutionReview({
      ...baseParams(),
      diff: "diff --git a/foo b/foo\n-foo\n+bar\n",
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected error");
    expect(result.reason).toContain("Claude Code hit a usage limit");
    expect(result.reason).toContain("Codex hit a usage limit");
    expect(result.reason).toContain("All compatible backends are exhausted");
    expect(result.reason).toContain("Reset times:");
    // Each backend tried at most once.
    expect(mockRunCliProcess).toHaveBeenCalledTimes(2);
  });

  it("does not fall back for a non-usage error", async () => {
    mockRunCliProcess.mockResolvedValueOnce(
      createCliResult({ stdout: "", stderr: "boom: unexpected crash", exitCode: 1 }),
    );

    const result = await runPostExecutionReview({
      ...baseParams(),
      diff: "diff --git a/foo b/foo\n-foo\n+bar\n",
    });

    expect(result.status).toBe("error");
    // Only the primary (claude) backend is attempted; no usage-limit fallback.
    expect(mockRunCliProcess).toHaveBeenCalledTimes(1);
  });
});

describe("buildPostExecutionReviewPrompt", () => {
  it("includes per-step success criteria when present", () => {
    const prompt = buildPostExecutionReviewPrompt({
      goal: "Ship feature",
      diff: "diff --git a/a b/a",
      steps: [
        createPlanStep({
          id: "step-ship",
          shortSummary: "Ship the feature",
          successCriteria: "Feature is reachable from CLI",
          taskSummary: "Added command and tests",
        }),
      ],
    });

    expect(prompt).toContain("Success criteria: Feature is reachable from CLI");
  });

  it("omits success criteria line when a step does not define it", () => {
    const prompt = buildPostExecutionReviewPrompt({
      goal: "Ship feature",
      diff: "diff --git a/a b/a",
      steps: [
        createPlanStep({
          id: "step-ship",
          shortSummary: "Ship the feature",
          successCriteria: undefined,
          taskSummary: "Added command and tests",
        }),
      ],
    });

    expect(prompt).not.toContain("Success criteria:");
  });

  it("mentions verifying success criteria in the review instructions", () => {
    const prompt = buildPostExecutionReviewPrompt({
      goal: "Ship feature",
      diff: "",
      steps: [createPlanStep()],
    });

    expect(prompt).toContain("verify that per-step success criteria were met");
  });
});
