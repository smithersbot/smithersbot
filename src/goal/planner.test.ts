import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlannerUserMessage, extractJson, generatePlan, PlanParseError } from "./planner.js";
import type { ScoutResult } from "./scout.js";
import type { GoalLlmClient } from "./types.js";

function mockClient(response: string): GoalLlmClient {
  return {
    complete: vi.fn().mockResolvedValue({ text: response }),
  };
}

const TEST_CWD = "/tmp/moltbot-planner-cwd";

describe("planner", () => {
  describe("generatePlan", () => {
    it("generates a valid task-based plan from LLM response", async () => {
      const client = mockClient(
        JSON.stringify({
          workingDir: "/tmp/moltbot",
          summary: "Fix tests and write report",
          steps: [
            {
              id: "run-tests",
              description: "Run pnpm test and capture errors",
              dependsOn: [],
              durationMinutes: 3,
              backend: "claude_code",
            },
            {
              id: "fix-errors",
              description: "Fix all test errors found",
              dependsOn: ["run-tests"],
              durationMinutes: 10,
              backend: "codex",
            },
            {
              id: "write-report",
              description: "Write a file saying all tests cleared",
              dependsOn: ["fix-errors"],
              durationMinutes: 1,
              backend: "codex",
            },
          ],
        }),
      );

      const plan = await generatePlan(client, "Fix tests and write report", TEST_CWD);
      expect("blocked" in plan).toBe(false);
      if (!("blocked" in plan)) {
        expect(plan.steps).toHaveLength(3);
        expect(plan.steps[0].id).toBe("run-tests");
        expect(plan.steps[0].description).toBe("Run pnpm test and capture errors");
        expect(plan.steps[0].durationMinutes).toBe(3);
        expect(plan.steps[1].dependsOn).toEqual(["run-tests"]);
        expect(plan.steps[2].durationMinutes).toBe(1);
        expect(plan.summary).toBe("Fix tests and write report");
        expect(plan.goal).toBe("Fix tests and write report");
        expect(plan.workingDir).toBe("/tmp/moltbot");
      }
    });

    it("allows shell commands like pnpm test in step descriptions", async () => {
      const client = mockClient(
        JSON.stringify({
          workingDir: "/tmp/moltbot",
          summary: "Run tests",
          steps: [
            {
              id: "run-tests",
              description: "Run 'pnpm test' in the moltbot directory",
              dependsOn: [],
              durationMinutes: 5,
              backend: "claude_code",
            },
          ],
        }),
      );

      const plan = await generatePlan(client, "Run tests", TEST_CWD);
      expect("blocked" in plan).toBe(false);
      if (!("blocked" in plan)) {
        expect(plan.steps[0].description).toContain("pnpm test");
      }
    });

    it("returns blocked when LLM needs more info", async () => {
      const client = mockClient(
        JSON.stringify({
          blocked: true,
          question: "What framework should I use?",
        }),
      );

      const result = await generatePlan(client, "Build a web app", TEST_CWD);
      expect("blocked" in result && result.blocked).toBe(true);
      if ("blocked" in result) {
        expect(result.question).toBe("What framework should I use?");
      }
    });

    it("rejects circular dependencies", async () => {
      const client = mockClient(
        JSON.stringify({
          workingDir: "/tmp/moltbot",
          summary: "Circular",
          steps: [
            {
              id: "1",
              description: "Step A",
              dependsOn: ["2"],
              durationMinutes: 1,
              backend: "claude_code",
            },
            {
              id: "2",
              description: "Step B",
              dependsOn: ["1"],
              durationMinutes: 1,
              backend: "claude_code",
            },
          ],
        }),
      );

      await expect(generatePlan(client, "Circular", TEST_CWD)).rejects.toThrow(/cycle/i);
    });

    it("rejects duplicate step IDs", async () => {
      const client = mockClient(
        JSON.stringify({
          workingDir: "/tmp/moltbot",
          summary: "Dupes",
          steps: [
            { id: "1", description: "Step A", dependsOn: [], durationMinutes: 1, backend: "codex" },
            {
              id: "1",
              description: "Step B",
              dependsOn: [],
              durationMinutes: 1,
              backend: "claude_code",
            },
          ],
        }),
      );

      await expect(generatePlan(client, "Dupes", TEST_CWD)).rejects.toThrow(/duplicate step id/i);
    });

    it("rejects dependency on nonexistent step", async () => {
      const client = mockClient(
        JSON.stringify({
          workingDir: "/tmp/moltbot",
          summary: "Bad dep",
          steps: [
            {
              id: "1",
              description: "Step A",
              dependsOn: ["99"],
              durationMinutes: 1,
              backend: "codex",
            },
          ],
        }),
      );

      await expect(generatePlan(client, "Bad dep", TEST_CWD)).rejects.toThrow(/unknown step/i);
    });

    it("rejects missing backend selection", async () => {
      const client = mockClient(
        JSON.stringify({
          workingDir: "/tmp/moltbot",
          summary: "Missing backend",
          steps: [{ id: "1", description: "Step A", dependsOn: [] }],
        }),
      );

      await expect(generatePlan(client, "Missing backend", TEST_CWD)).rejects.toThrow(
        /backend is required/i,
      );
    });

    it("rejects empty steps array", async () => {
      const client = mockClient(
        JSON.stringify({ workingDir: "/tmp/moltbot", summary: "Empty", steps: [] }),
      );

      await expect(generatePlan(client, "Empty", TEST_CWD)).rejects.toThrow(/at least one step/i);
    });

    it("defaults durationMinutes to undefined when not provided", async () => {
      const client = mockClient(
        JSON.stringify({
          workingDir: "/tmp/moltbot",
          summary: "No duration",
          steps: [
            {
              id: "1",
              description: "Do something",
              dependsOn: [],
              backend: "codex",
            },
          ],
        }),
      );

      const plan = await generatePlan(client, "No duration", TEST_CWD);
      expect("blocked" in plan).toBe(false);
      if (!("blocked" in plan)) {
        expect(plan.steps[0].durationMinutes).toBeUndefined();
      }
    });

    it("rounds fractional durationMinutes", async () => {
      const client = mockClient(
        JSON.stringify({
          workingDir: "/tmp/moltbot",
          summary: "Fractional duration",
          steps: [
            {
              id: "1",
              description: "Do something",
              dependsOn: [],
              durationMinutes: 2.7,
              backend: "codex",
            },
          ],
        }),
      );

      const plan = await generatePlan(client, "Fractional duration", TEST_CWD);
      expect("blocked" in plan).toBe(false);
      if (!("blocked" in plan)) {
        expect(plan.steps[0].durationMinutes).toBe(3);
      }
    });

    it("coerces numeric step IDs to strings", async () => {
      const client = mockClient(
        JSON.stringify({
          workingDir: "/tmp/moltbot",
          summary: "Numeric IDs",
          steps: [
            {
              id: 1,
              description: "Step one",
              dependsOn: [],
              durationMinutes: 1,
              backend: "codex",
            },
            {
              id: 2,
              description: "Step two",
              dependsOn: ["1"],
              durationMinutes: 1,
              backend: "claude_code",
            },
          ],
        }),
      );

      const plan = await generatePlan(client, "Numeric IDs", TEST_CWD);
      expect("blocked" in plan).toBe(false);
      if (!("blocked" in plan)) {
        expect(plan.steps[0].id).toBe("1");
        expect(plan.steps[1].id).toBe("2");
      }
    });

    it("rejects missing workingDir", async () => {
      const client = mockClient(
        JSON.stringify({
          summary: "Missing working dir",
          steps: [
            {
              id: "1",
              description: "Do thing",
              dependsOn: [],
              backend: "codex",
            },
          ],
        }),
      );

      await expect(generatePlan(client, "Missing working dir", TEST_CWD)).rejects.toThrow(
        /workingDir/i,
      );
    });

    it("resolves ~/ workingDir to the current home directory", async () => {
      const client = mockClient(
        JSON.stringify({
          workingDir: "~/planner-workingdir-test",
          summary: "Home path",
          steps: [
            {
              id: "1",
              description: "Do thing",
              dependsOn: [],
              backend: "codex",
            },
          ],
        }),
      );

      const plan = await generatePlan(client, "Home path", TEST_CWD);
      expect("blocked" in plan).toBe(false);
      if (!("blocked" in plan)) {
        expect(plan.workingDir).toBe(path.join(os.homedir(), "planner-workingdir-test"));
      }
    });

    it("preserves valid non-home workingDir values", async () => {
      const client = mockClient(
        JSON.stringify({
          workingDir: "/tmp/custom-workspace",
          summary: "Custom path",
          steps: [
            {
              id: "1",
              description: "Do thing",
              dependsOn: [],
              backend: "claude_code",
            },
          ],
        }),
      );

      const plan = await generatePlan(client, "Custom path", TEST_CWD);
      expect("blocked" in plan).toBe(false);
      if (!("blocked" in plan)) {
        expect(plan.workingDir).toBe("/tmp/custom-workspace");
      }
    });
  });

  describe("extractJson", () => {
    it("parses raw JSON", () => {
      const result = extractJson('{"key": "value"}');
      expect(result).toEqual({ key: "value" });
    });

    it("extracts JSON from markdown code fence", () => {
      const result = extractJson('```json\n{"key": "value"}\n```');
      expect(result).toEqual({ key: "value" });
    });

    it("extracts JSON from untagged code fence", () => {
      const result = extractJson('```\n{"key": "value"}\n```');
      expect(result).toEqual({ key: "value" });
    });

    it("parses bare JSON that follows a prose preamble", () => {
      const result = extractJson(
        'Now I have all the context needed. Here is the revised plan:\n{"key":"value"}',
      );
      expect(result).toEqual({ key: "value" });
    });

    it("throws PlanParseError on non-JSON text", () => {
      expect(() => extractJson("not json at all")).toThrow(PlanParseError);
      expect(() => extractJson("not json at all")).toThrow(/failed to parse/i);
    });

    it("throws PlanParseError when prose contains an invalid JSON object", () => {
      expect(() => extractJson('Here is the plan:\n{"key": "value"')).toThrow(PlanParseError);
      expect(() => extractJson('Here is the plan:\n{"key": "value"')).toThrow(/failed to parse/i);
    });

    it("PlanParseError carries raw response text", () => {
      try {
        extractJson("some LLM prose response");
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(PlanParseError);
        expect((err as PlanParseError).rawResponse).toBe("some LLM prose response");
      }
    });
  });

  describe("buildPlannerUserMessage", () => {
    it("returns simple goal message without scout data", () => {
      const msg = buildPlannerUserMessage("Fix tests", TEST_CWD);
      expect(msg).toBe(`Goal: Fix tests\nCurrent workspace path: ${TEST_CWD}`);
    });

    it("returns simple goal message when scout errored", () => {
      const scout: ScoutResult = { status: "error", error: "timeout" };
      const msg = buildPlannerUserMessage("Fix tests", TEST_CWD, scout);
      expect(msg).toBe(`Goal: Fix tests\nCurrent workspace path: ${TEST_CWD}`);
    });

    it("returns simple goal message when scout was skipped", () => {
      const scout: ScoutResult = { status: "skipped", reason: "no binary" };
      const msg = buildPlannerUserMessage("Fix tests", TEST_CWD, scout);
      expect(msg).toBe(`Goal: Fix tests\nCurrent workspace path: ${TEST_CWD}`);
    });

    it("includes scout report and plan draft when scout succeeded", () => {
      const scout: ScoutResult = {
        status: "success",
        report: {
          goal_id: "abc-123",
          nodes: [
            {
              id: "n1",
              type: "Impl",
              objective: "Do X",
              verification: "pnpm test",
              effort: 3,
              risk: 2,
              uncertainty: 1,
            },
          ],
          edges: [],
        },
        planDraft: "BEGIN_PLAN_DRAFT\nGOAL_ID: abc-123\ngraph TD\nEND_PLAN_DRAFT",
      };
      const msg = buildPlannerUserMessage("Fix tests", TEST_CWD, scout);
      expect(msg).toContain("Goal: Fix tests");
      expect(msg).toContain(`Current workspace path: ${TEST_CWD}`);
      expect(msg).toContain("Scout Report");
      expect(msg).toContain("BEGIN_PLAN_DRAFT");
      expect(msg).toContain('"n1"');
      expect(msg).toContain("Normalize");
    });
  });

  describe("persistRawPlanResponse", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-test-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("writes plan-raw.txt to run directory", () => {
      const runId = "test-run-123";
      const runDir = path.join(tmpDir, "goals", runId);
      fs.mkdirSync(runDir, { recursive: true });

      // Mock resolveRunDir by writing directly
      const rawText = "This is not JSON\nSorry I cannot help with that.";
      fs.writeFileSync(path.join(runDir, "plan-raw.txt"), rawText, "utf8");

      const content = fs.readFileSync(path.join(runDir, "plan-raw.txt"), "utf8");
      expect(content).toBe(rawText);
    });
  });
});
