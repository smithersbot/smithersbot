import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PlanStep, Plan } from "./types.js";
import { formatAttemptBundleSummary, type AttemptBundle } from "./attempt-bundle.js";
import {
  buildAllowedToolsList,
  buildCliArgs,
  buildGoalWorkerEnv,
  buildCliWorkerPrompt,
  parseClaudeCodeStreamError,
  parseCodexSchemaOutput,
  readWorkerResultFile,
  validateWorkerOutput,
  writeWorkerSchema,
  writeDenyFile,
} from "./cli-worker.js";
import { HARD_DENIES } from "./hard-deny.js";

vi.mock("./planner.js", () => ({
  formatPlanAsContext: vi.fn(() => "- Task step-1: Do something"),
}));

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
  describe("parseCodexSchemaOutput", () => {
    it("parses a valid JSON object", () => {
      const stdout = '{"status":"complete","summary":"Done"}';
      const result = parseCodexSchemaOutput(stdout);
      expect(result).toEqual({ status: "complete", summary: "Done" });
    });

    it("returns null for empty output", () => {
      expect(parseCodexSchemaOutput("")).toBeNull();
      expect(parseCodexSchemaOutput("   ")).toBeNull();
    });

    it("returns null for invalid JSON", () => {
      expect(parseCodexSchemaOutput("not json")).toBeNull();
    });
  });

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
        schemaPath: path.join(dir, "schema.json"),
        denyFilePath,
      });

      expect(args).not.toContain("--cwd");
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

  describe("writeWorkerSchema", () => {
    it("writes schema to output-schema.json", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-schema-"));
      const schemaPath = writeWorkerSchema(dir);
      expect(schemaPath).toBe(path.join(dir, "output-schema.json"));
      const content = fs.readFileSync(schemaPath, "utf8");
      expect(content).toContain('"status"');
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
