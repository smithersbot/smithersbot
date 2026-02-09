import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { EffectiveCapabilities } from "./capability-types.js";
import type { PlanStep, Plan } from "./types.js";
import {
  buildAllowedToolsList,
  buildCliWorkerPrompt,
  parseCodexSchemaOutput,
  readWorkerResultFile,
  validateWorkerOutput,
  writeWorkerSchema,
  writeCapsFile,
} from "./cli-worker.js";

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

function makeEffective(
  grantIds: string[] = ["fs.read", "fs.write", "exec.safe"],
): EffectiveCapabilities {
  return {
    grants: grantIds.map((id) => ({ id: id as any })),
    denies: [
      { id: "secrets.read", pattern: "**/.env*", reason: "No secrets" },
      { id: "exec.sudo", pattern: "sudo *", reason: "No sudo" },
    ],
    nodeGrants: [],
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

      const result = readWorkerResultFile(dir);
      expect(result.output).toEqual({ status: "complete", summary: "All set" });
      expect(result.error).toBeUndefined();
    });

    it("reports invalid JSON", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-result-"));
      const resultPath = path.join(dir, "worker_result.json");
      fs.writeFileSync(resultPath, "{not json", "utf8");

      const result = readWorkerResultFile(dir);
      expect(result.output).toBeNull();
      expect(result.error?.kind).toBe("invalid_json");
    });

    it("reports schema mismatch", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-result-"));
      const resultPath = path.join(dir, "worker_result.json");
      fs.writeFileSync(resultPath, JSON.stringify({ status: "complete" }), "utf8");

      const result = readWorkerResultFile(dir);
      expect(result.output).toBeNull();
      expect(result.error?.kind).toBe("invalid_schema");
    });

    it("reports missing file", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-result-"));
      const result = readWorkerResultFile(dir);
      expect(result.output).toBeNull();
      expect(result.error?.kind).toBe("missing");
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

    it("validates blocked output with missingCapabilities", () => {
      const result = validateWorkerOutput({
        status: "blocked",
        question: "Need caps",
        missingCapabilities: ["exec.install_deps"],
      });
      expect(result).toEqual({
        status: "blocked",
        question: "Need caps",
        missingCapabilities: ["exec.install_deps"],
      });
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

    it("rejects missing status", () => {
      expect(validateWorkerOutput({ summary: "Done" })).toBeNull();
    });

    it("rejects unknown status", () => {
      expect(validateWorkerOutput({ status: "unknown" })).toBeNull();
    });

    it("rejects complete with missing summary", () => {
      expect(validateWorkerOutput({ status: "complete" })).toBeNull();
    });

    it("rejects blocked with missing question", () => {
      expect(validateWorkerOutput({ status: "blocked" })).toBeNull();
    });

    it("rejects failed with missing required fields", () => {
      expect(validateWorkerOutput({ status: "failed", reason: "x" })).toBeNull();
    });

    it("rejects failed with wrong needsRevert type", () => {
      expect(
        validateWorkerOutput({
          status: "failed",
          reason: "x",
          whatTried: "y",
          errorType: "z",
          suggestedNext: "w",
          needsRevert: "yes",
        }),
      ).toBeNull();
    });
  });

  describe("buildAllowedToolsList", () => {
    it("includes baseline tools always", () => {
      const tools = buildAllowedToolsList(makeEffective([]));
      expect(tools).toContain("Read");
      expect(tools).toContain("Edit");
      expect(tools).toContain("Write");
      expect(tools).toContain("Glob");
      expect(tools).toContain("Grep");
    });

    it("adds exec patterns for exec.safe", () => {
      const tools = buildAllowedToolsList(makeEffective(["exec.safe"]));
      expect(tools).toContain("Bash(pnpm test*)");
      expect(tools).toContain("Bash(git status*)");
    });

    it("adds install patterns for exec.install_deps", () => {
      const tools = buildAllowedToolsList(makeEffective(["exec.install_deps"]));
      expect(tools).toContain("Bash(npm install*)");
      expect(tools).toContain("Bash(pnpm install*)");
    });

    it("adds git push for git.push_private", () => {
      const tools = buildAllowedToolsList(makeEffective(["git.push_private"]));
      expect(tools).toContain("Bash(git push*)");
    });

    it("adds network tools for network.read_only", () => {
      const tools = buildAllowedToolsList(makeEffective(["network.read_only"]));
      expect(tools).toContain("Bash(curl *)");
      expect(tools).toContain("Bash(wget *)");
    });

    it("does not add install patterns without exec.install_deps", () => {
      const tools = buildAllowedToolsList(makeEffective(["exec.safe"]));
      expect(tools).not.toContain("Bash(npm install*)");
    });
  });

  describe("buildCliWorkerPrompt", () => {
    it("includes goal and task description", () => {
      const prompt = buildCliWorkerPrompt({
        step: makeStep(),
        plan: makePlan(),
        goal: "Build auth system",
        effective: makeEffective(),
        resultPath: "/tmp/worker/worker_result.json",
      });
      expect(prompt).toContain("Build auth system");
      expect(prompt).toContain("Implement auth module");
    });

    it("includes completed summaries when present", () => {
      const prompt = buildCliWorkerPrompt({
        step: makeStep(),
        plan: makePlan(),
        goal: "Build auth",
        effective: makeEffective(),
        completedSummaries: [{ id: "step-0", summary: "Set up project" }],
        resultPath: "/tmp/worker/worker_result.json",
      });
      expect(prompt).toContain("step-0: Set up project");
    });

    it("includes capability bounds", () => {
      const prompt = buildCliWorkerPrompt({
        step: makeStep(),
        plan: makePlan(),
        goal: "Build auth",
        effective: makeEffective(),
        resultPath: "/tmp/worker/worker_result.json",
      });
      expect(prompt).toContain("CAPABILITY BOUNDS");
      expect(prompt).toContain("HARD DENIES");
    });

    it("includes result protocol instructions", () => {
      const prompt = buildCliWorkerPrompt({
        step: makeStep(),
        plan: makePlan(),
        goal: "Build auth",
        effective: makeEffective(),
        resultPath: "/tmp/worker/worker_result.json",
      });
      expect(prompt).toContain("RESULT PROTOCOL");
      expect(prompt).toContain("/tmp/worker/worker_result.json");
      expect(prompt).toContain('"status": "complete"');
    });
  });

  describe("writeWorkerSchema", () => {
    it("writes schema file and returns path", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-schema-"));
      const result = writeWorkerSchema(dir);
      expect(result).toBe(path.join(dir, "output-schema.json"));
      expect(fs.existsSync(result)).toBe(true);
    });
  });

  describe("writeCapsFile", () => {
    it("writes caps file and returns path", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-worker-caps-"));
      const result = writeCapsFile(makeEffective(), dir);
      expect(result).toBe(path.join(dir, "capability-bounds.txt"));
      expect(fs.existsSync(result)).toBe(true);
    });
  });
});
