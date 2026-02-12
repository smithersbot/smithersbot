import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PlanStep, Plan } from "./types.js";
import {
  buildAllowedToolsList,
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
