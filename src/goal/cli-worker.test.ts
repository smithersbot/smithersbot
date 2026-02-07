import { describe, expect, it, vi } from "vitest";
import type { CapabilityPolicy, EffectiveCapabilities } from "./capability-types.js";
import type { PlanStep, Plan } from "./types.js";
import {
  buildAllowedToolsList,
  buildCliWorkerPrompt,
  parseStructuredOutput,
  postCheckForHardDenyEvidence,
  validateWorkerOutput,
  writeWorkerSchema,
  writeCapsFile,
} from "./cli-worker.js";

// Mock fs + run-store for artifacts
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      appendFileSync: vi.fn(),
    },
  };
});

vi.mock("./run-store.js", () => ({
  resolveRunDir: vi.fn(() => "/tmp/mock-run"),
}));

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

function makePolicy(): CapabilityPolicy {
  return {
    baseline: [],
    hardDenies: [
      {
        id: "secrets.read",
        pattern: "**/.env*",
        reason: "Reading secrets files (.env) is not allowed",
      },
      { id: "exec.sudo", pattern: "sudo *", reason: "sudo is not allowed" },
      { id: "git.force_push", pattern: "git push --force", reason: "Force push not allowed" },
    ],
    expandableIds: [],
  };
}

describe("cli-worker", () => {
  describe("parseStructuredOutput", () => {
    it("parses valid complete JSON from codex output", () => {
      const stdout = 'Some log output\n{"status":"complete","summary":"Done implementing"}';
      const result = parseStructuredOutput(stdout, "codex");
      expect(result).toEqual({ status: "complete", summary: "Done implementing" });
    });

    it("parses valid blocked JSON", () => {
      const stdout = '{"status":"blocked","question":"What API endpoint?"}';
      const result = parseStructuredOutput(stdout, "codex");
      expect(result).toEqual({ status: "blocked", question: "What API endpoint?" });
    });

    it("parses valid failed JSON", () => {
      const stdout = JSON.stringify({
        status: "failed",
        reason: "Tests failing",
        whatTried: "Fixed imports",
        errorType: "test_failure",
        suggestedNext: "Check deps",
        needsRevert: false,
      });
      const result = parseStructuredOutput(stdout, "codex");
      expect(result?.status).toBe("failed");
    });

    it("returns null for empty output", () => {
      expect(parseStructuredOutput("", "codex")).toBeNull();
      expect(parseStructuredOutput("   ", "codex")).toBeNull();
    });

    it("returns null for non-JSON output", () => {
      expect(parseStructuredOutput("Just some text output", "codex")).toBeNull();
    });

    it("extracts JSON from Claude Code wrapper", () => {
      const wrapper = JSON.stringify({
        result: 'Here is the result:\n{"status":"complete","summary":"All done"}',
      });
      const result = parseStructuredOutput(wrapper, "claude_code");
      expect(result).toEqual({ status: "complete", summary: "All done" });
    });

    it("handles Claude Code direct status object", () => {
      const stdout = JSON.stringify({ status: "complete", summary: "Done" });
      const result = parseStructuredOutput(stdout, "claude_code");
      expect(result).toEqual({ status: "complete", summary: "Done" });
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

  describe("postCheckForHardDenyEvidence", () => {
    const policy = makePolicy();

    it("detects .env access evidence", () => {
      const matches = postCheckForHardDenyEvidence("Reading .env file", "", policy);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0]!.id).toBe("secrets.read");
    });

    it("detects sudo evidence", () => {
      const matches = postCheckForHardDenyEvidence("", "running sudo apt-get", policy);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.some((m) => m.id === "exec.sudo")).toBe(true);
    });

    it("detects force push evidence", () => {
      const matches = postCheckForHardDenyEvidence("git push --force origin main", "", policy);
      expect(matches.some((m) => m.id === "git.force_push")).toBe(true);
    });

    it("returns empty for clean output", () => {
      const matches = postCheckForHardDenyEvidence(
        "pnpm test passed\nAll 42 tests pass",
        "",
        policy,
      );
      expect(matches).toHaveLength(0);
    });
  });

  describe("buildCliWorkerPrompt", () => {
    it("includes goal and task description", () => {
      const prompt = buildCliWorkerPrompt({
        step: makeStep(),
        plan: makePlan(),
        goal: "Build auth system",
        effective: makeEffective(),
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
      });
      expect(prompt).toContain("step-0: Set up project");
    });

    it("includes capability bounds", () => {
      const prompt = buildCliWorkerPrompt({
        step: makeStep(),
        plan: makePlan(),
        goal: "Build auth",
        effective: makeEffective(),
      });
      expect(prompt).toContain("CAPABILITY BOUNDS");
      expect(prompt).toContain("HARD DENIES");
    });

    it("includes output format instructions", () => {
      const prompt = buildCliWorkerPrompt({
        step: makeStep(),
        plan: makePlan(),
        goal: "Build auth",
        effective: makeEffective(),
      });
      expect(prompt).toContain("OUTPUT FORMAT");
      expect(prompt).toContain('"status": "complete"');
    });
  });

  describe("writeWorkerSchema", () => {
    it("writes schema file and returns path", async () => {
      const fs = vi.mocked(await import("node:fs")).default;
      const result = writeWorkerSchema("/tmp/worker");
      expect(result).toBe("/tmp/worker/output-schema.json");
      expect(fs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe("writeCapsFile", () => {
    it("writes caps file and returns path", async () => {
      const fs = vi.mocked(await import("node:fs")).default;
      const result = writeCapsFile(makeEffective(), "/tmp/worker");
      expect(result).toBe("/tmp/worker/capability-bounds.txt");
      expect(fs.writeFileSync).toHaveBeenCalled();
    });
  });
});
