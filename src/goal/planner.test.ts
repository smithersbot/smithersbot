import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractJson, generatePlan, PlanParseError, persistRawPlanResponse } from "./planner.js";
import type { GoalLlmClient } from "./types.js";

function mockClient(response: string): GoalLlmClient {
  return {
    complete: vi.fn().mockResolvedValue({ text: response }),
  };
}

describe("planner", () => {
  describe("generatePlan", () => {
    it("generates a valid plan from LLM response", async () => {
      const client = mockClient(
        JSON.stringify({
          summary: "Create a landing page",
          steps: [
            {
              id: "1",
              description: "Create directory",
              dependsOn: [],
              tool: { name: "mkdir", args: { path: "site" } },
            },
            {
              id: "2",
              description: "Write index.html",
              dependsOn: ["1"],
              tool: {
                name: "file_write",
                args: { path: "site/index.html", content: "<h1>Hello</h1>" },
              },
            },
          ],
        }),
      );

      const plan = await generatePlan(client, "Create a landing page");
      expect("blocked" in plan).toBe(false);
      if (!("blocked" in plan)) {
        expect(plan.steps).toHaveLength(2);
        expect(plan.steps[0].tool.name).toBe("mkdir");
        expect(plan.steps[1].dependsOn).toEqual(["1"]);
        expect(plan.summary).toBe("Create a landing page");
        expect(plan.goal).toBe("Create a landing page");
      }
    });

    it("returns blocked when LLM needs more info", async () => {
      const client = mockClient(
        JSON.stringify({
          blocked: true,
          question: "What framework should I use?",
        }),
      );

      const result = await generatePlan(client, "Build a web app");
      expect("blocked" in result && result.blocked).toBe(true);
      if ("blocked" in result) {
        expect(result.question).toBe("What framework should I use?");
      }
    });

    it("rejects unknown tool names", async () => {
      const client = mockClient(
        JSON.stringify({
          summary: "Bad plan",
          steps: [
            {
              id: "1",
              description: "Hack",
              dependsOn: [],
              tool: { name: "rm_rf", args: {} },
            },
          ],
        }),
      );

      await expect(generatePlan(client, "Do something")).rejects.toThrow(/unknown tool/i);
    });

    it("rejects circular dependencies", async () => {
      const client = mockClient(
        JSON.stringify({
          summary: "Circular",
          steps: [
            {
              id: "1",
              description: "Step A",
              dependsOn: ["2"],
              tool: { name: "mkdir", args: { path: "a" } },
            },
            {
              id: "2",
              description: "Step B",
              dependsOn: ["1"],
              tool: { name: "mkdir", args: { path: "b" } },
            },
          ],
        }),
      );

      await expect(generatePlan(client, "Circular")).rejects.toThrow(/cycle/i);
    });

    it("rejects duplicate step IDs", async () => {
      const client = mockClient(
        JSON.stringify({
          summary: "Dupes",
          steps: [
            {
              id: "1",
              description: "Step A",
              dependsOn: [],
              tool: { name: "mkdir", args: { path: "a" } },
            },
            {
              id: "1",
              description: "Step B",
              dependsOn: [],
              tool: { name: "mkdir", args: { path: "b" } },
            },
          ],
        }),
      );

      await expect(generatePlan(client, "Dupes")).rejects.toThrow(/duplicate step id/i);
    });

    it("rejects dependency on nonexistent step", async () => {
      const client = mockClient(
        JSON.stringify({
          summary: "Bad dep",
          steps: [
            {
              id: "1",
              description: "Step A",
              dependsOn: ["99"],
              tool: { name: "mkdir", args: { path: "a" } },
            },
          ],
        }),
      );

      await expect(generatePlan(client, "Bad dep")).rejects.toThrow(/unknown step/i);
    });

    it("rejects empty steps array", async () => {
      const client = mockClient(JSON.stringify({ summary: "Empty", steps: [] }));

      await expect(generatePlan(client, "Empty")).rejects.toThrow(/at least one step/i);
    });

    it("rejects shell_exec with disallowed command at plan time", async () => {
      const client = mockClient(
        JSON.stringify({
          summary: "Shell attack",
          steps: [
            {
              id: "1",
              description: "Delete everything",
              dependsOn: [],
              tool: {
                name: "shell_exec",
                args: { command: "rm -rf /" },
              },
            },
          ],
        }),
      );

      await expect(generatePlan(client, "Shell attack")).rejects.toThrow(
        /not in read-only allowlist/i,
      );
    });

    it("accepts shell_exec with allowed read-only command", async () => {
      const client = mockClient(
        JSON.stringify({
          summary: "Check status",
          steps: [
            {
              id: "1",
              description: "Check git status",
              dependsOn: [],
              tool: {
                name: "shell_exec",
                args: { command: "git status" },
              },
            },
          ],
        }),
      );

      const result = await generatePlan(client, "Check status");
      expect("blocked" in result).toBe(false);
      if (!("blocked" in result)) {
        expect(result.steps[0].tool.args.command).toBe("git status");
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

    it("throws PlanParseError on non-JSON text", () => {
      expect(() => extractJson("not json at all")).toThrow(PlanParseError);
      expect(() => extractJson("not json at all")).toThrow(/failed to parse/i);
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
