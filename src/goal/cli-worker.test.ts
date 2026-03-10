import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanStep, Plan } from "./types.js";
import {
  collectGitDiffSummary,
  formatAttemptBundleSummary,
  resolveWorkerDir,
  writeAttemptBundle,
  type AttemptBundle,
} from "./attempt-bundle.js";
import { runCliProcess } from "./cli-process.js";
import {
  buildAllowedToolsList,
  buildCliArgs,
  buildGoalWorkerEnv,
  buildCliWorkerPrompt,
  executeTaskWithCliWorker,
  parseClaudeCodeStreamError,
  REPAIR_TIMEOUT_MS,
  readWorkerResultFile,
  repairResultFile,
  validateWorkerOutput,
  writeDenyFile,
} from "./cli-worker.js";
import { HARD_DENIES } from "./hard-deny.js";
import { WORKER_CONTEXT } from "./worker-context.js";

vi.mock("./attempt-bundle.js", async () => {
  const actual = await vi.importActual<typeof import("./attempt-bundle.js")>("./attempt-bundle.js");
  return {
    ...actual,
    collectGitDiffSummary: vi.fn(() => ({})),
    resolveWorkerDir: vi.fn(),
    writeAttemptBundle: vi.fn(),
  };
});

vi.mock("./cli-process.js", () => ({
  runCliProcess: vi.fn(),
}));

vi.mock("./planner.js", () => ({
  formatPlanAsContext: vi.fn(() => "- Task step-1: Do something"),
}));

vi.mock("./backend-availability.js", () => ({
  getCodexAskForApprovalPlacement: vi.fn(() => "before_exec"),
}));

const runCliProcessMock = vi.mocked(runCliProcess);
const resolveWorkerDirMock = vi.mocked(resolveWorkerDir);
const writeAttemptBundleMock = vi.mocked(writeAttemptBundle);
const collectGitDiffSummaryMock = vi.mocked(collectGitDiffSummary);

const EARLY_RESULT_PROGRESS_MESSAGE =
  "  [cli-worker] result file detected — waiting grace period for process exit";

beforeEach(() => {
  vi.clearAllMocks();
  collectGitDiffSummaryMock.mockReturnValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

function makeStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: "step-1",
    description: "Implement auth module",
    dependsOn: [],
    status: "pending",
    ...overrides,
  };
}

function makePlan(): Plan {
  return {
    goal: "Build auth",
    workingDir: "/tmp/workspace",
    steps: [makeStep()],
    summary: "Build auth system",
  };
}

describe("cli-worker", () => {
  describe("readWorkerResultFile", () => {
    it("reads valid result file", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-result-"));
      const resultPath = path.join(dir, "worker_result.json");
      fs.writeFileSync(
        resultPath,
        JSON.stringify({ status: "complete", summary: "All set" }),
        "utf8",
      );

      const result = readWorkerResultFile({ primaryPath: resultPath });
      expect(result.output).toEqual({ status: "complete", summary: "All set" });
      expect(result.error).toBeUndefined();
    });

    it("reports invalid JSON", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-result-"));
      const resultPath = path.join(dir, "worker_result.json");
      fs.writeFileSync(resultPath, "{not json", "utf8");

      const result = readWorkerResultFile({ primaryPath: resultPath });
      expect(result.output).toBeNull();
      expect(result.error?.kind).toBe("invalid_json");
    });

    it("reports schema mismatch", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-result-"));
      const resultPath = path.join(dir, "worker_result.json");
      fs.writeFileSync(resultPath, JSON.stringify({ status: "complete" }), "utf8");

      const result = readWorkerResultFile({ primaryPath: resultPath });
      expect(result.output).toBeNull();
      expect(result.error?.kind).toBe("invalid_schema");
    });

    it("reports missing file", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-result-"));
      const result = readWorkerResultFile({ primaryPath: path.join(dir, "worker_result.json") });
      expect(result.output).toBeNull();
      expect(result.error?.kind).toBe("missing");
    });

    it("falls back to canonical path when primary path is missing", () => {
      const primaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-primary-"));
      const fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-fallback-"));
      const primaryPath = path.join(primaryDir, "worker_result.json");
      const fallbackPath = path.join(fallbackDir, "worker_result.json");

      fs.writeFileSync(
        fallbackPath,
        JSON.stringify({ status: "complete", summary: "Recovered from fallback" }),
        "utf8",
      );

      const result = readWorkerResultFile({ primaryPath, fallbackPath });
      expect(result.output).toEqual({ status: "complete", summary: "Recovered from fallback" });
      expect(result.sourcePath).toBe(fallbackPath);
      expect(result.error).toBeUndefined();
    });

    it("does not use fallback when primary path exists but is invalid", () => {
      const primaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-primary-"));
      const fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-fallback-"));
      const primaryPath = path.join(primaryDir, "worker_result.json");
      const fallbackPath = path.join(fallbackDir, "worker_result.json");

      fs.writeFileSync(primaryPath, "{not json", "utf8");
      fs.writeFileSync(
        fallbackPath,
        JSON.stringify({ status: "complete", summary: "Should not be used" }),
        "utf8",
      );

      const result = readWorkerResultFile({ primaryPath, fallbackPath });
      expect(result.output).toBeNull();
      expect(result.error?.kind).toBe("invalid_json");
    });
  });

  describe("validateWorkerOutput", () => {
    it("validates complete output", () => {
      const result = validateWorkerOutput({ status: "complete", summary: "Done" });
      expect(result).toEqual({ status: "complete", summary: "Done" });
    });

    it("validates blocked output", () => {
      const result = validateWorkerOutput({ status: "blocked", question: "Need help" });
      expect(result).toEqual({ status: "blocked", question: "Need help" });
    });

    it("validates failed output", () => {
      const result = validateWorkerOutput({
        status: "failed",
        reason: "Build broken",
        whatTried: "Fixed imports",
        errorType: "build_failure",
        suggestedNext: "Check tsconfig",
        needsRevert: true,
      });
      expect(result).toEqual({
        status: "failed",
        reason: "Build broken",
        whatTried: "Fixed imports",
        errorType: "build_failure",
        suggestedNext: "Check tsconfig",
        needsRevert: true,
      });
    });

    it("validates ralph output", () => {
      const result = validateWorkerOutput({
        status: "ralph",
        approachTried: "Tried fixing import paths in src/index.ts",
        specificErrors: "Cannot find module './foo' from src/index.ts",
        keyInsight: "The generated file path changed; imports must be rewritten",
        suggestedApproach: "Regenerate imports first, then re-run build and fix leftovers",
      });
      expect(result).toEqual({
        status: "ralph",
        approachTried: "Tried fixing import paths in src/index.ts",
        specificErrors: "Cannot find module './foo' from src/index.ts",
        keyInsight: "The generated file path changed; imports must be rewritten",
        suggestedApproach: "Regenerate imports first, then re-run build and fix leftovers",
      });
    });

    it("rejects ralph output with empty required fields", () => {
      const result = validateWorkerOutput({
        status: "ralph",
        approachTried: "",
        specificErrors: "errors",
        keyInsight: "insight",
        suggestedApproach: "next",
      });
      expect(result).toBeNull();
    });

    it("rejects blocked with missing question", () => {
      expect(validateWorkerOutput({ status: "blocked" })).toBeNull();
    });
  });

  describe("buildAllowedToolsList", () => {
    it("includes baseline tools and Bash(*)", () => {
      const tools = buildAllowedToolsList();
      expect(tools).toContain("Read");
      expect(tools).toContain("Edit");
      expect(tools).toContain("Write");
      expect(tools).toContain("Glob");
      expect(tools).toContain("Grep");
      expect(tools).toContain("Bash(*)");
    });
  });

  describe("buildGoalWorkerEnv", () => {
    it("sets scoped test mode for codex workers without mutating process env", () => {
      const prevScope = process.env.MOLTBOT_GOAL_TEST_SCOPE;
      delete process.env.MOLTBOT_GOAL_TEST_SCOPE;
      try {
        const env = buildGoalWorkerEnv("codex", "subscription");
        expect(env.MOLTBOT_GOAL_TEST_SCOPE).toBe("1");
        expect(process.env.MOLTBOT_GOAL_TEST_SCOPE).toBeUndefined();
      } finally {
        if (prevScope === undefined) delete process.env.MOLTBOT_GOAL_TEST_SCOPE;
        else process.env.MOLTBOT_GOAL_TEST_SCOPE = prevScope;
      }
    });

    it("keeps scoping local to worker env and preserves global auth env", () => {
      const prevScope = process.env.MOLTBOT_GOAL_TEST_SCOPE;
      const prevAnthropic = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "secret";
      delete process.env.MOLTBOT_GOAL_TEST_SCOPE;
      try {
        const env = buildGoalWorkerEnv("claude_code", "subscription");
        expect(env.MOLTBOT_GOAL_TEST_SCOPE).toBe("1");
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(process.env.ANTHROPIC_API_KEY).toBe("secret");
        expect(process.env.MOLTBOT_GOAL_TEST_SCOPE).toBeUndefined();
      } finally {
        if (prevScope === undefined) delete process.env.MOLTBOT_GOAL_TEST_SCOPE;
        else process.env.MOLTBOT_GOAL_TEST_SCOPE = prevScope;
        if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prevAnthropic;
      }
    });
  });

  describe("buildCliArgs", () => {
    it("does not include --cwd for claude_code workers", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-args-"));
      const denyFilePath = path.join(dir, "deny.txt");
      fs.writeFileSync(denyFilePath, "HARD DENIES", "utf8");

      const workingDir = path.join(dir, "workspace");
      const args = buildCliArgs({
        backend: "claude_code",
        prompt: "do the task",
        workingDir,
        denyFilePath,
        projectConventions: "These conventions should be ignored by Claude Code args",
      });

      expect(args).not.toContain("--cwd");
      expect(args[args.length - 1]).toBe("do the task");
      expect(args.join(" ")).not.toContain("PROJECT CONVENTIONS (from CLAUDE.md):");
    });

    it("does not include --output-schema for codex workers", () => {
      const args = buildCliArgs({
        backend: "codex",
        prompt: "test",
        workingDir: "/tmp",
        denyFilePath: "/tmp/deny",
      });

      expect(args).not.toContain("--output-schema");
    });

    it("prepends project conventions before worker context for codex workers", () => {
      const args = buildCliArgs({
        backend: "codex",
        prompt: "do the task",
        workingDir: "/tmp",
        denyFilePath: "/tmp/deny",
        projectConventions: "Use yarn test\nNo force-push",
      });

      const prompt = args[args.length - 1]!;
      const conventionsHeader = "## PROJECT CONVENTIONS";
      const workerGuidelinesHeader = "## WORKER GUIDELINES";
      expect(prompt).toContain(conventionsHeader);
      expect(prompt).toContain(workerGuidelinesHeader);
      expect(prompt).toContain("----------------------------------------");
      expect(prompt).toContain("Use yarn test\nNo force-push");
      expect(prompt.indexOf(conventionsHeader)).toBeLessThan(prompt.indexOf(WORKER_CONTEXT));
      expect(prompt.indexOf(workerGuidelinesHeader)).toBeLessThan(prompt.indexOf(WORKER_CONTEXT));
      expect(prompt.indexOf(WORKER_CONTEXT)).toBeLessThan(prompt.indexOf("do the task"));
    });

    it("skips project conventions when codex input is empty", () => {
      const args = buildCliArgs({
        backend: "codex",
        prompt: "do the task",
        workingDir: "/tmp",
        denyFilePath: "/tmp/deny",
        projectConventions: "   ",
      });

      const prompt = args[args.length - 1]!;
      expect(prompt).not.toContain("## PROJECT CONVENTIONS");
    });
  });

  describe("repairResultFile", () => {
    it("repairs invalid JSON and returns validated output", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-repair-success-"));
      const resultPath = path.join(dir, "worker_result.json");
      fs.writeFileSync(resultPath, "{not json", "utf8");
      const repairedOutput = {
        status: "complete",
        summary: "Repaired worker result",
      } as const;

      runCliProcessMock.mockImplementationOnce(async ({ stdoutPath, stderrPath }) => {
        if (stdoutPath) fs.writeFileSync(stdoutPath, "repair stdout", "utf8");
        if (stderrPath) fs.writeFileSync(stderrPath, "repair stderr", "utf8");
        fs.writeFileSync(resultPath, JSON.stringify(repairedOutput), "utf8");
        return {
          stdout: "repair stdout",
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 25,
        };
      });

      const result = await repairResultFile({
        backend: "codex",
        resultFilePath: resultPath,
        workerDir: dir,
        attemptNumber: 1,
        workingDir: dir,
        hardDenies: HARD_DENIES.slice(0, 1),
      });

      expect(result).toEqual(repairedOutput);
      expect(runCliProcessMock).toHaveBeenCalledTimes(1);
    });

    it("returns null when file remains invalid after repair run", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-repair-fail-"));
      const resultPath = path.join(dir, "worker_result.json");
      fs.writeFileSync(resultPath, "{not json", "utf8");

      runCliProcessMock.mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 20,
      });

      const result = await repairResultFile({
        backend: "codex",
        resultFilePath: resultPath,
        workerDir: dir,
        attemptNumber: 2,
        workingDir: dir,
        hardDenies: HARD_DENIES.slice(0, 1),
      });

      expect(result).toBeNull();
      expect(runCliProcessMock).toHaveBeenCalledTimes(1);
    });

    it("writes repair logs to attempt-scoped repair files", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-repair-logs-"));
      const resultPath = path.join(dir, "worker_result.json");
      fs.writeFileSync(resultPath, "{not json", "utf8");
      const onProgress = vi.fn();

      runCliProcessMock.mockImplementationOnce(async ({ stdoutPath, stderrPath, timeoutMs }) => {
        expect(timeoutMs).toBe(REPAIR_TIMEOUT_MS);
        expect(stdoutPath).toBe(path.join(dir, "attempt-7.repair.stdout.txt"));
        expect(stderrPath).toBe(path.join(dir, "attempt-7.repair.stderr.txt"));
        fs.writeFileSync(resultPath, JSON.stringify({ status: "complete", summary: "ok" }), "utf8");
        return {
          stdout: "",
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 15,
        };
      });

      await repairResultFile({
        backend: "codex",
        resultFilePath: resultPath,
        workerDir: dir,
        attemptNumber: 7,
        workingDir: dir,
        hardDenies: HARD_DENIES.slice(0, 1),
        onProgress,
      });

      expect(onProgress).toHaveBeenCalledWith(
        "  [cli-worker:codex] repairing invalid worker_result.json",
      );
    });
  });

  describe("executeTaskWithCliWorker", () => {
    it("terminates a hanging process once worker_result.json is detected", async () => {
      vi.useFakeTimers();

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-exec-early-"));
      const runId = "run-early";
      const stepId = "step-early";
      const step = makeStep({ id: stepId });
      const plan: Plan = { ...makePlan(), workingDir: dir, steps: [step] };

      const workerDir = path.join(dir, "worker", stepId);
      resolveWorkerDirMock.mockReturnValue(workerDir);
      writeAttemptBundleMock.mockImplementation(() => {});

      const workspaceResultPath = path.join(
        dir,
        ".moltbot-goal-worker-results",
        runId,
        stepId,
        "attempt-1",
        "worker_result.json",
      );
      const expectedOutput = {
        status: "complete",
        summary: "Detected early and stopped hanging process",
      } as const;
      const onProgress = vi.fn();

      runCliProcessMock.mockImplementation(({ abortSignal }) => {
        return new Promise((resolve) => {
          const finish = () =>
            resolve({
              stdout: "",
              stderr: "",
              timedOut: true,
              exitCode: null,
              signal: "SIGTERM",
              durationMs: 0,
            });
          if (abortSignal?.aborted) {
            finish();
            return;
          }
          abortSignal?.addEventListener("abort", finish, { once: true });
        });
      });

      setTimeout(() => {
        fs.mkdirSync(path.dirname(workspaceResultPath), { recursive: true });
        fs.writeFileSync(workspaceResultPath, JSON.stringify(expectedOutput), "utf8");
      }, 100);

      const externalAbort = new AbortController();
      const startedAt = Date.now();
      const taskPromise = executeTaskWithCliWorker({
        backend: "codex",
        step,
        plan,
        goal: "Validate early worker result detection",
        workingDir: dir,
        runId,
        hardDenies: HARD_DENIES.slice(0, 1),
        timeoutMs: 30_000,
        abortSignal: externalAbort.signal,
        onProgress,
      });

      await vi.advanceTimersByTimeAsync(4_000 + 10_000 + 500);
      const result = await taskPromise;
      const elapsedMs = Date.now() - startedAt;

      expect(result.output).toEqual(expectedOutput);
      expect(elapsedMs).toBeLessThanOrEqual(16_000);
      expect(externalAbort.signal.aborted).toBe(false);
      expect(onProgress).toHaveBeenCalledWith(EARLY_RESULT_PROGRESS_MESSAGE);
      expect(runCliProcessMock).toHaveBeenCalledTimes(1);
      expect(runCliProcessMock.mock.calls[0]?.[0]?.abortSignal).toBeDefined();
      expect(runCliProcessMock.mock.calls[0]?.[0]?.abortSignal).not.toBe(externalAbort.signal);
      expect(runCliProcessMock.mock.calls[0]?.[0]?.abortSignal?.aborted).toBe(true);
    });

    it("keeps normal behavior when process exits before polling finds a result file", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-exec-normal-"));
      const runId = "run-normal";
      const stepId = "step-normal";
      const step = makeStep({ id: stepId });
      const plan: Plan = { ...makePlan(), workingDir: dir, steps: [step] };
      const onProgress = vi.fn();

      const workerDir = path.join(dir, "worker", stepId);
      resolveWorkerDirMock.mockReturnValue(workerDir);
      writeAttemptBundleMock.mockImplementation(() => {});

      const workspaceResultPath = path.join(
        dir,
        ".moltbot-goal-worker-results",
        runId,
        stepId,
        "attempt-1",
        "worker_result.json",
      );
      const expectedOutput = {
        status: "complete",
        summary: "Process exited normally",
      } as const;

      runCliProcessMock.mockImplementation(async () => {
        fs.mkdirSync(path.dirname(workspaceResultPath), { recursive: true });
        fs.writeFileSync(workspaceResultPath, JSON.stringify(expectedOutput), "utf8");
        return {
          stdout: "",
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 25,
        };
      });

      const result = await executeTaskWithCliWorker({
        backend: "codex",
        step,
        plan,
        goal: "Verify normal worker exit path",
        workingDir: dir,
        runId,
        hardDenies: HARD_DENIES.slice(0, 1),
        timeoutMs: 30_000,
        onProgress,
      });

      expect(result.output).toEqual(expectedOutput);
      expect(onProgress).not.toHaveBeenCalledWith(EARLY_RESULT_PROGRESS_MESSAGE);
      expect(runCliProcessMock.mock.calls[0]?.[0]?.abortSignal?.aborted).toBe(false);
    });

    it("writes the assembled codex prompt artifact for each attempt", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-exec-codex-prompt-"));
      const runId = "run-codex-prompt";
      const stepId = "step-codex-prompt";
      const step = makeStep({ id: stepId });
      const plan: Plan = { ...makePlan(), workingDir: dir, steps: [step] };

      const workerDir = path.join(dir, "worker", stepId);
      resolveWorkerDirMock.mockReturnValue(workerDir);
      writeAttemptBundleMock.mockImplementation(() => {});

      const workspaceResultPath = path.join(
        dir,
        ".moltbot-goal-worker-results",
        runId,
        stepId,
        "attempt-2",
        "worker_result.json",
      );
      const expectedOutput = {
        status: "complete",
        summary: "Prompt artifact captured for codex",
      } as const;

      runCliProcessMock.mockImplementation(async () => {
        fs.mkdirSync(path.dirname(workspaceResultPath), { recursive: true });
        fs.writeFileSync(workspaceResultPath, JSON.stringify(expectedOutput), "utf8");
        return {
          stdout: "",
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 20,
        };
      });

      await executeTaskWithCliWorker({
        backend: "codex",
        step,
        plan,
        goal: "Verify codex prompt artifact",
        workingDir: dir,
        runId,
        hardDenies: HARD_DENIES.slice(0, 1),
        timeoutMs: 30_000,
        attemptNumber: 2,
        projectConventions: "Use bun test\nDo not force-push",
      });

      const promptArtifactPath = path.join(workerDir, "worker-prompt-2.txt");
      const artifact = fs.readFileSync(promptArtifactPath, "utf8");
      expect(artifact).toContain("## PROJECT CONVENTIONS");
      expect(artifact).toContain("Use bun test\nDo not force-push");
      expect(artifact).toContain("## WORKER GUIDELINES");
      expect(artifact).toContain(WORKER_CONTEXT);
      expect(artifact).toContain("YOUR TASK: Implement auth module");
    });

    it("writes the assembled claude code prompt artifact for each attempt", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-exec-claude-prompt-"));
      const runId = "run-claude-prompt";
      const stepId = "step-claude-prompt";
      const step = makeStep({ id: stepId });
      const plan: Plan = { ...makePlan(), workingDir: dir, steps: [step] };

      const workerDir = path.join(dir, "worker", stepId);
      resolveWorkerDirMock.mockReturnValue(workerDir);
      writeAttemptBundleMock.mockImplementation(() => {});

      const workspaceResultPath = path.join(
        dir,
        ".moltbot-goal-worker-results",
        runId,
        stepId,
        "attempt-3",
        "worker_result.json",
      );
      const expectedOutput = {
        status: "complete",
        summary: "Prompt artifact captured for claude code",
      } as const;

      runCliProcessMock.mockImplementation(async () => {
        fs.mkdirSync(path.dirname(workspaceResultPath), { recursive: true });
        fs.writeFileSync(workspaceResultPath, JSON.stringify(expectedOutput), "utf8");
        return {
          stdout: "",
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 20,
        };
      });

      await executeTaskWithCliWorker({
        backend: "claude_code",
        step,
        plan,
        goal: "Verify claude prompt artifact",
        workingDir: dir,
        runId,
        hardDenies: HARD_DENIES.slice(0, 1),
        timeoutMs: 30_000,
        attemptNumber: 3,
      });

      const promptArtifactPath = path.join(workerDir, "worker-prompt-3.txt");
      const artifact = fs.readFileSync(promptArtifactPath, "utf8");
      expect(artifact).toContain("## APPENDED SYSTEM PROMPT");
      expect(artifact).toContain("HARD DENIES (enforced):");
      expect(artifact).toContain(WORKER_CONTEXT);
      expect(artifact).toContain("## USER PROMPT");
      expect(artifact).toContain("YOUR TASK: Implement auth module");
    });

    it("repairs invalid worker_result.json and returns repaired output", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-exec-repair-"));
      const runId = "run-repair";
      const stepId = "step-repair";
      const step = makeStep({ id: stepId });
      const plan: Plan = { ...makePlan(), workingDir: dir, steps: [step] };
      const onProgress = vi.fn();

      const workerDir = path.join(dir, "worker", stepId);
      resolveWorkerDirMock.mockReturnValue(workerDir);
      writeAttemptBundleMock.mockImplementation(() => {});

      const workspaceResultPath = path.join(
        dir,
        ".moltbot-goal-worker-results",
        runId,
        stepId,
        "attempt-1",
        "worker_result.json",
      );
      const canonicalResultPath = path.join(workerDir, "worker_result.json");
      const repairedOutput = {
        status: "complete",
        summary: "Repaired after invalid JSON",
      } as const;

      runCliProcessMock
        .mockImplementationOnce(async () => {
          fs.mkdirSync(path.dirname(workspaceResultPath), { recursive: true });
          fs.writeFileSync(workspaceResultPath, "{not json", "utf8");
          return {
            stdout: "",
            stderr: "",
            timedOut: false,
            exitCode: 0,
            signal: null,
            durationMs: 50,
          };
        })
        .mockImplementationOnce(async () => {
          fs.writeFileSync(workspaceResultPath, JSON.stringify(repairedOutput), "utf8");
          return {
            stdout: "",
            stderr: "",
            timedOut: false,
            exitCode: 0,
            signal: null,
            durationMs: 35,
          };
        });

      const result = await executeTaskWithCliWorker({
        backend: "codex",
        step,
        plan,
        goal: "Repair invalid worker output",
        workingDir: dir,
        runId,
        hardDenies: HARD_DENIES.slice(0, 1),
        timeoutMs: 30_000,
        onProgress,
      });

      expect(result.output).toEqual(repairedOutput);
      expect(result.output.status).toBe("complete");
      expect(runCliProcessMock).toHaveBeenCalledTimes(2);
      expect(onProgress).toHaveBeenCalledWith(
        "  [cli-worker] attempting result-file repair (invalid_json)",
      );
      expect(onProgress).toHaveBeenCalledWith("  [cli-worker] repaired worker_result.json");
      expect(readWorkerResultFile({ primaryPath: canonicalResultPath }).output).toEqual(
        repairedOutput,
      );
    });

    it("does not attempt repair when the worker process times out", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-exec-timeout-"));
      const runId = "run-timeout";
      const stepId = "step-timeout";
      const step = makeStep({ id: stepId });
      const plan: Plan = { ...makePlan(), workingDir: dir, steps: [step] };
      const onProgress = vi.fn();

      const workerDir = path.join(dir, "worker", stepId);
      resolveWorkerDirMock.mockReturnValue(workerDir);
      writeAttemptBundleMock.mockImplementation(() => {});

      runCliProcessMock.mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        timedOut: true,
        exitCode: null,
        signal: null,
        durationMs: 30_000,
      });

      const result = await executeTaskWithCliWorker({
        backend: "codex",
        step,
        plan,
        goal: "Verify timeout does not trigger repair",
        workingDir: dir,
        runId,
        hardDenies: HARD_DENIES.slice(0, 1),
        timeoutMs: 30_000,
        onProgress,
      });

      expect(runCliProcessMock).toHaveBeenCalledTimes(1);
      expect(result.output.status).toBe("failed");
      expect(result.output.errorType).toBe("timeout");
      expect(
        onProgress.mock.calls.some(
          ([message]) =>
            typeof message === "string" && message.includes("attempting result-file repair"),
        ),
      ).toBe(false);
    });

    it("does not attempt repair when worker_result.json is missing", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-exec-missing-"));
      const runId = "run-missing";
      const stepId = "step-missing";
      const step = makeStep({ id: stepId });
      const plan: Plan = { ...makePlan(), workingDir: dir, steps: [step] };
      const onProgress = vi.fn();

      const workerDir = path.join(dir, "worker", stepId);
      resolveWorkerDirMock.mockReturnValue(workerDir);
      writeAttemptBundleMock.mockImplementation(() => {});

      runCliProcessMock.mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 22,
      });

      const result = await executeTaskWithCliWorker({
        backend: "codex",
        step,
        plan,
        goal: "Verify missing file does not trigger repair",
        workingDir: dir,
        runId,
        hardDenies: HARD_DENIES.slice(0, 1),
        timeoutMs: 30_000,
        onProgress,
      });

      expect(runCliProcessMock).toHaveBeenCalledTimes(1);
      expect(result.output.status).toBe("failed");
      expect(result.output.errorType).toBe("missing_result");
      expect(
        onProgress.mock.calls.some(
          ([message]) =>
            typeof message === "string" && message.includes("attempting result-file repair"),
        ),
      ).toBe(false);
    });
  });

  describe("buildCliWorkerPrompt", () => {
    it("includes hard deny list", () => {
      const prompt = buildCliWorkerPrompt({
        step: makeStep(),
        plan: makePlan(),
        goal: "Build auth",
        hardDenies: HARD_DENIES.slice(0, 2),
        resultPath: "/tmp/worker_result.json",
      });
      expect(prompt).toContain("HARD DENIES");
      expect(prompt).toContain(HARD_DENIES[0]!.pattern);
    });

    it("includes success criteria and constraints when provided", () => {
      const prompt = buildCliWorkerPrompt({
        step: makeStep({
          successCriteria: "pnpm build exits 0 with tsconfig include unchanged",
          constraints: [
            "Do not narrow tsconfig include to hide errors",
            "Do not skip build verification",
          ],
        }),
        plan: makePlan(),
        goal: "Build auth",
        hardDenies: HARD_DENIES.slice(0, 1),
        resultPath: "/tmp/worker_result.json",
      });

      expect(prompt).toContain("SUCCESS CRITERIA:");
      expect(prompt).toContain("pnpm build exits 0 with tsconfig include unchanged");
      expect(prompt).toContain("CONSTRAINTS (do NOT violate these):");
      expect(prompt).toContain("- Do not narrow tsconfig include to hide errors");
      expect(prompt).toContain("- Do not skip build verification");
    });

    it("omits success criteria and constraints sections when absent", () => {
      const prompt = buildCliWorkerPrompt({
        step: makeStep(),
        plan: makePlan(),
        goal: "Build auth",
        hardDenies: HARD_DENIES.slice(0, 1),
        resultPath: "/tmp/worker_result.json",
      });

      expect(prompt).not.toContain("SUCCESS CRITERIA:");
      expect(prompt).not.toContain("CONSTRAINTS (do NOT violate these):");
    });

    it("includes ralph context from previous attempt summary", () => {
      const previousBundle: AttemptBundle = {
        attemptNumber: 1,
        backend: "codex",
        outcome: "ralph",
        durationMs: 1000,
        ralphDetail: {
          approachTried: "Updated imports manually and re-ran build",
          specificErrors: "30 unresolved modules remained",
          keyInsight: "The codegen step must run before import fixes",
          suggestedApproach: "Run codegen first, then patch import paths",
        },
      };

      const prompt = buildCliWorkerPrompt({
        step: makeStep(),
        plan: makePlan(),
        goal: "Build auth",
        hardDenies: HARD_DENIES.slice(0, 1),
        resultPath: "/tmp/worker_result.json",
        previousAttempt: formatAttemptBundleSummary(previousBundle),
      });

      expect(prompt).toContain("PREVIOUS ATTEMPT FAILED:");
      expect(prompt).toContain("Approach tried: Updated imports manually and re-ran build");
      expect(prompt).toContain("Key insight: The codegen step must run before import fixes");
      expect(prompt).toContain("Suggested approach: Run codegen first, then patch import paths");
    });

    it("includes lessons between plan context and completed tasks when lessons exist", () => {
      const prompt = buildCliWorkerPrompt({
        step: makeStep(),
        plan: makePlan(),
        goal: "Build auth",
        hardDenies: HARD_DENIES.slice(0, 1),
        completedSummaries: [{ id: "step-0", summary: "Set up baseline scaffolding" }],
        lessons: [
          {
            pattern: "vitest-config",
            lesson: 'Use pool: "forks" to avoid flaky thread behavior in this repo.',
          },
          {
            pattern: "signal-api",
            lesson: "Include trust-new-identities on initial contact setup.",
          },
        ],
        resultPath: "/tmp/worker_result.json",
      });

      const planIndex = prompt.indexOf("PLAN CONTEXT:");
      const lessonsIndex = prompt.indexOf(
        "LESSONS FROM PRIOR RUNS (knowledge from previous work in this project):",
      );
      const completedIndex = prompt.indexOf("COMPLETED TASKS:");

      expect(planIndex).toBeGreaterThanOrEqual(0);
      expect(lessonsIndex).toBeGreaterThan(planIndex);
      expect(completedIndex).toBeGreaterThan(lessonsIndex);
      expect(prompt).toContain(
        '- [vitest-config]: Use pool: "forks" to avoid flaky thread behavior in this repo.',
      );
      expect(prompt).toContain(
        "- [signal-api]: Include trust-new-identities on initial contact setup.",
      );
    });

    it("omits lessons section when no lessons are provided", () => {
      const prompt = buildCliWorkerPrompt({
        step: makeStep(),
        plan: makePlan(),
        goal: "Build auth",
        hardDenies: HARD_DENIES.slice(0, 1),
        resultPath: "/tmp/worker_result.json",
      });

      expect(prompt).not.toContain(
        "LESSONS FROM PRIOR RUNS (knowledge from previous work in this project):",
      );
    });

    it("tells workers to keep worker_result summaries concise", () => {
      const prompt = buildCliWorkerPrompt({
        step: makeStep(),
        plan: makePlan(),
        goal: "Build auth",
        hardDenies: HARD_DENIES.slice(0, 1),
        resultPath: "/tmp/worker_result.json",
      });

      expect(prompt).toContain("In worker_result.json, write a concise outcome summary.");
    });
  });

  describe("writeDenyFile", () => {
    it("writes deny list to capability-bounds.txt", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-deny-"));
      const result = writeDenyFile(HARD_DENIES.slice(0, 1), dir);
      expect(result).toBe(path.join(dir, "capability-bounds.txt"));
      const content = fs.readFileSync(result, "utf8");
      expect(content).toContain("HARD DENIES");
      expect(content).toContain(HARD_DENIES[0]!.pattern);
    });
  });

  describe("parseClaudeCodeStreamError", () => {
    it("detects billing error from JSONL result", () => {
      const stdout = [
        '{"type":"assistant","message":"working on it"}',
        '{"type":"assistant","error":"billing_error"}',
        '{"type":"result","is_error":true,"result":"Credit balance is too low"}',
      ].join("\n");
      const result = parseClaudeCodeStreamError(stdout, "");
      expect(result).not.toBeNull();
      expect(result!.errorType).toBe("out_of_credits");
      expect(result!.message).toBe("Credit balance is too low");
    });

    it("detects auth error from result text", () => {
      const stdout = '{"type":"result","is_error":true,"result":"401 unauthorized"}\n';
      const result = parseClaudeCodeStreamError(stdout, "");
      expect(result).not.toBeNull();
      expect(result!.errorType).toBe("auth");
    });

    it("detects rate limit from result text", () => {
      const stdout = '{"type":"result","is_error":true,"result":"429 too many requests"}\n';
      const result = parseClaudeCodeStreamError(stdout, "");
      expect(result).not.toBeNull();
      expect(result!.errorType).toBe("rate_limit");
    });

    it("detects rate limit from codex error event", () => {
      const stdout =
        '{"type":"error","message":"You\'ve hit your usage limit. To get more access now, send a request to your admin or try again at 4:59 PM."}\n';
      const result = parseClaudeCodeStreamError(stdout, "");
      expect(result).not.toBeNull();
      expect(result!.errorType).toBe("rate_limit");
    });

    it("detects rate limit from codex turn.failed event", () => {
      const stdout = '{"type":"turn.failed","error":{"message":"429 too many requests"}}\n';
      const result = parseClaudeCodeStreamError(stdout, "");
      expect(result).not.toBeNull();
      expect(result!.errorType).toBe("rate_limit");
    });

    it("detects auth error from codex error event", () => {
      const stdout = '{"type":"error","message":"unauthorized"}\n';
      const result = parseClaudeCodeStreamError(stdout, "");
      expect(result).not.toBeNull();
      expect(result!.errorType).toBe("auth");
    });

    it("extracts error from full codex stream", () => {
      const stdout = [
        '{"type":"thread.started","thread_id":"thread_123"}',
        '{"type":"turn.started","turn_id":"turn_456"}',
        '{"type":"error","message":"You\'ve hit your usage limit. To get more access now, send a request to your admin or try again at 4:59 PM."}',
        '{"type":"turn.failed","error":{"message":"429 too many requests"}}',
      ].join("\n");
      const result = parseClaudeCodeStreamError(stdout, "");
      expect(result).not.toBeNull();
      expect(result!.errorType).toBe("rate_limit");
      expect(result!.message).toBe("429 too many requests");
    });

    it("detects network error from result text", () => {
      const stdout = '{"type":"result","is_error":true,"result":"fetch failed ECONNREFUSED"}\n';
      const result = parseClaudeCodeStreamError(stdout, "");
      expect(result).not.toBeNull();
      expect(result!.errorType).toBe("network");
    });

    it("returns null for clean stdout with no errors", () => {
      const stdout = [
        '{"type":"assistant","message":"working"}',
        '{"type":"result","is_error":false,"result":"all done"}',
      ].join("\n");
      const result = parseClaudeCodeStreamError(stdout, "");
      expect(result).toBeNull();
    });

    it("returns null for empty stdout", () => {
      expect(parseClaudeCodeStreamError("", "")).toBeNull();
    });

    it("handles mixed non-JSON lines", () => {
      const stdout = [
        "some random text",
        "another line",
        '{"type":"result","is_error":true,"result":"billing quota exceeded"}',
      ].join("\n");
      const result = parseClaudeCodeStreamError(stdout, "");
      expect(result).not.toBeNull();
      expect(result!.errorType).toBe("out_of_credits");
    });

    it("falls back to stderr when stdout has no error", () => {
      const stderr = '{"type":"result","is_error":true,"result":"forbidden invalid key"}\n';
      const result = parseClaudeCodeStreamError("", stderr);
      expect(result).not.toBeNull();
      expect(result!.errorType).toBe("auth");
    });

    it("classifies unknown errors as process_error", () => {
      const stdout = '{"type":"result","is_error":true,"result":"something unexpected happened"}\n';
      const result = parseClaudeCodeStreamError(stdout, "");
      expect(result).not.toBeNull();
      expect(result!.errorType).toBe("process_error");
    });
  });
});
