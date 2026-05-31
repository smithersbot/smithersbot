import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPlanSystemPrompt,
  buildPlannerUserMessage,
  extractJson,
  generatePlan,
  generatePlanRevision,
  parsePlanResultFromText,
  PlanParseError,
} from "./planner.js";
import {
  DEV_GATEWAY_PLANNER_GUIDANCE,
  WORKSPACE_SCOPE_PLANNER_GUIDANCE,
} from "../prompts/planner/system-prompt.js";
import { PLAN_QUALITY_RUBRIC } from "../prompts/shared/plan-quality-rubric.js";
import type { ScoutResult } from "./scout.js";
import type { GoalLlmClient } from "./types.js";

function mockClient(response: string): GoalLlmClient {
  return {
    complete: vi.fn().mockResolvedValue({ text: response }),
  };
}

const TEST_CWD = "/tmp/moltbot-planner-cwd";

function parsePromptContractPlan(goal: string, plan: Record<string, unknown>) {
  const prompt = buildPlanSystemPrompt(["claude_code", "codex"]);
  expect(prompt).toContain("STRUCTURED PLANNING REQUIREMENTS");
  expect(prompt).toContain("buildGate.commands");
  const result = parsePlanResultFromText(JSON.stringify(plan), goal);
  expect("blocked" in result).toBe(false);
  if ("blocked" in result) {
    throw new Error("Expected plan result, got blocked response");
  }
  return { prompt, result };
}

describe("planner", () => {
  describe("buildPlanSystemPrompt", () => {
    it("omits claude_code instructions for Codex-only planning", () => {
      const prompt = buildPlanSystemPrompt(["codex"]);
      expect(prompt).toContain('Use "codex" for every step');
      expect(prompt).not.toContain("claude_code");
    });

    it("omits codex instructions for Claude-only planning", () => {
      const prompt = buildPlanSystemPrompt(["claude_code"]);
      expect(prompt).toContain('Use "claude_code" for every step');
      expect(prompt.toLowerCase()).not.toContain("codex");
    });

    it("keeps dual-backend guidance when both workers are available", () => {
      const prompt = buildPlanSystemPrompt(["claude_code", "codex"]);
      expect(prompt).toContain('Use "codex" for coding tasks');
      expect(prompt).toContain('Use "claude_code" for testing tasks');
    });

    it("restricts requiresNetwork guidance to genuine network needs, not normal local build/test", () => {
      const prompt = buildPlanSystemPrompt(["claude_code", "codex"]);
      expect(prompt).toContain("requiresNetwork");
      // Network is off by default and only for genuine network work.
      expect(prompt).toMatch(/web fetch\/search/);
      expect(prompt).toMatch(/download/i);
      // Must explicitly steer away from setting it for normal local build/test.
      expect(prompt).toMatch(/Do NOT set it for normal local build\/test/);
    });

    it("does not offer pi as an assignable backend (disabled for launch)", () => {
      // Pi is disabled for launch: the planner/scout must not be told it can
      // assign pi. Check the backend union and selection rules across modes.
      for (const workers of [["claude_code", "codex"], ["codex"], ["claude_code"]] as const) {
        const prompt = buildPlanSystemPrompt([...workers]);
        expect(prompt).toContain("- Every step MUST include a backend:");
        expect(prompt).not.toContain('"pi"');
        expect(prompt).not.toContain("non-Pi");
        expect(prompt).not.toContain('Only use "pi"');
      }
    });

    it("throws the canonical setup error when no worker backend is available", () => {
      expect(() => buildPlanSystemPrompt([])).toThrow(
        "No worker backend available. Install Codex or Claude Code and rerun.",
      );
    });

    it("includes the current-instance-only goal working directory constraint", () => {
      for (const workers of [["claude_code", "codex"], ["codex"], ["claude_code"]] as const) {
        const prompt = buildPlanSystemPrompt([...workers]);
        expect(prompt).toContain(WORKSPACE_SCOPE_PLANNER_GUIDANCE);
        expect(prompt).toContain("GOAL WORKING DIRECTORY SCOPE (strict):");
        expect(prompt).toContain("/home/matt/smithersbot-home/agent/workspaces/<workspace>");
        expect(prompt).toContain("/home/matt/smithersbot-dev-home/agent/workspaces/<workspace>");
        expect(prompt).toContain("are READ-ONLY/context-only and MUST NOT be chosen as workingDir");
      }
    });

    it("appends dev-gateway verification guidance only when the dev option is set", () => {
      const withDev = buildPlanSystemPrompt(["claude_code", "codex"], {
        devGatewayVerification: true,
      });
      const withoutDev = buildPlanSystemPrompt(["claude_code", "codex"], {
        devGatewayVerification: false,
      });
      const noOpts = buildPlanSystemPrompt(["claude_code", "codex"]);

      expect(withDev).toContain(DEV_GATEWAY_PLANNER_GUIDANCE);
      expect(withDev).toContain("smithersbot-dev-gateway.service");
      expect(withoutDev).not.toContain("DEV GATEWAY VERIFICATION");
      expect(noOpts).not.toContain("DEV GATEWAY VERIFICATION");
    });
  });

  describe("dev-gateway planner guidance gating", () => {
    const validPlanJson = JSON.stringify({
      workingDir: "/tmp/moltbot",
      summary: "Change gateway restart behavior",
      steps: [
        {
          id: "edit-restart",
          description: "Update restart resolver and verify with a focused test",
          dependsOn: [],
          durationMinutes: 10,
          backend: "claude_code",
        },
      ],
    });

    // A literal path whose final segment is smithersbot-dev marks the dev
    // checkout; a non-dev path must never trigger the guidance.
    const DEV_CWD = "/tmp/agent/workspaces/smithersbot-dev";
    const NON_DEV_CWD = "/tmp/moltbot-planner-cwd";

    async function systemPromptForCwd(cwd: string): Promise<string> {
      const complete = vi.fn().mockResolvedValue({ text: validPlanJson });
      const client: GoalLlmClient = { complete };
      await generatePlan(client, "Change gateway restart behavior", cwd);
      return complete.mock.calls[0][0].systemPrompt as string;
    }

    it("injects dev-gateway guidance when planning in the smithersbot-dev checkout", async () => {
      expect(await systemPromptForCwd(DEV_CWD)).toContain(DEV_GATEWAY_PLANNER_GUIDANCE);
    });

    it("omits dev-gateway guidance for non-dev workspaces", async () => {
      expect(await systemPromptForCwd(NON_DEV_CWD)).not.toContain("DEV GATEWAY VERIFICATION");
    });
  });

  describe("read-only/report-only build gate prompt contract", () => {
    it("plans read-only git status queries with an empty build gate", () => {
      const goal = "tell me whether the git tree is clean";
      const { prompt, result } = parsePromptContractPlan(goal, {
        workingDir: TEST_CWD,
        summary: "Inspect the git working tree and report whether it is clean.",
        shortSummary: "Report git tree cleanliness",
        buildGate: {
          commands: [],
          runBetweenSteps: false,
        },
        steps: [
          {
            id: "inspect-git-status",
            description: "Inspect git status and report whether the working tree is clean.",
            shortSummary: "Inspect git status",
            dependsOn: [],
            successCriteria: "The response states whether the git tree is clean.",
            constraints: ["Do not edit files."],
            durationMinutes: 5,
            backend: "claude_code",
          },
        ],
      });

      expect(prompt).toContain("tell me whether the git tree is clean");
      expect(prompt).toContain("read-only/report-only goals with buildGate.commands: []");
      expect(result.buildGate?.commands).toEqual([]);
    });

    it("plans passive inspect/summarize goals with an empty build gate", () => {
      const goal = "inspect and summarize the goal system only, do not edit files";
      const { prompt, result } = parsePromptContractPlan(goal, {
        workingDir: TEST_CWD,
        summary: "Inspect the goal system and summarize the relevant behavior without changes.",
        shortSummary: "Summarize goal system",
        buildGate: {
          commands: [],
          runBetweenSteps: false,
        },
        steps: [
          {
            id: "summarize-goal-system",
            description: "Read the goal-system files and summarize the current behavior.",
            shortSummary: "Summarize behavior",
            dependsOn: [],
            successCriteria:
              "The final answer summarizes the requested behavior without file edits.",
            constraints: ["Do not edit files.", "Do not run build or test gates."],
            durationMinutes: 10,
            backend: "claude_code",
          },
        ],
      });

      expect(prompt).toContain("inspect/report/summarize/status only, do not edit files");
      expect(prompt).toContain("unless the user explicitly asks to build, test, verify");
      expect(result.buildGate?.commands).toEqual([]);
    });

    it("keeps pnpm build for code-changing Node goals", () => {
      const goal = "fix the Node.js build error in the goal executor";
      const { prompt, result } = parsePromptContractPlan(goal, {
        workingDir: TEST_CWD,
        summary: "Fix the Node.js build error and verify the project still builds.",
        shortSummary: "Fix Node build error",
        buildGate: {
          commands: ["pnpm build"],
          runBetweenSteps: true,
        },
        steps: [
          {
            id: "fix-node-build",
            description:
              "Update TypeScript source to fix the build error and add focused coverage.",
            shortSummary: "Fix build error",
            dependsOn: [],
            successCriteria:
              "pnpm vitest run src/goal/agent-executor.test.ts and pnpm build exit 0.",
            constraints: ["Do not remove tests to make the build pass."],
            durationMinutes: 20,
            backend: "codex",
          },
        ],
      });

      expect(prompt).toContain("code-changing Node.js projects");
      expect(prompt).toContain('set buildGate.commands to ["pnpm build"]');
      expect(result.buildGate?.commands).toContain("pnpm build");
    });

    it("keeps non-empty build gates for explicit verification goals", () => {
      const goal = "verify the planner tests pass";
      const { prompt, result } = parsePromptContractPlan(goal, {
        workingDir: TEST_CWD,
        summary: "Run the requested planner verification command and report the result.",
        shortSummary: "Verify planner tests",
        buildGate: {
          commands: ["pnpm vitest run src/goal/planner.test.ts"],
          runBetweenSteps: false,
        },
        steps: [
          {
            id: "run-planner-tests",
            description: "Run the requested planner test command and summarize the result.",
            shortSummary: "Run planner tests",
            dependsOn: [],
            successCriteria: "pnpm vitest run src/goal/planner.test.ts exits 0.",
            constraints: ["Do not edit files unless the verification failure requires a fix."],
            durationMinutes: 10,
            backend: "claude_code",
          },
        ],
      });

      expect(prompt).toContain("explicit build/test/verification/check goals");
      expect(result.buildGate?.commands.length).toBeGreaterThan(0);
    });
  });

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

    it("parses planner-provided short summaries for plan and steps", async () => {
      const client = mockClient(
        JSON.stringify({
          workingDir: "/tmp/moltbot",
          summary: "Implement authentication and regression checks",
          shortSummary: "  Improve auth + checks  ",
          steps: [
            {
              id: "implement-auth",
              description: "Implement auth changes and verify behavior",
              shortSummary: "  Implement auth  ",
              dependsOn: [],
              durationMinutes: 15,
              backend: "codex",
            },
          ],
        }),
      );

      const plan = await generatePlan(
        client,
        "Implement authentication and regression checks",
        TEST_CWD,
      );
      expect("blocked" in plan).toBe(false);
      if (!("blocked" in plan)) {
        expect(plan.shortSummary).toBe("Improve auth + checks");
        expect(plan.steps[0].shortSummary).toBe("Implement auth");
      }
    });

    it("parses buildGate, successCriteria, and constraints when provided", async () => {
      const client = mockClient(
        JSON.stringify({
          workingDir: "/tmp/moltbot",
          summary: "Fix build and keep constraints",
          buildGate: {
            commands: ["pnpm build", "pnpm test --filter goal"],
            runBetweenSteps: true,
            postExecutionReview: false,
          },
          steps: [
            {
              id: "fix-build",
              description: "Fix imports and restore build health",
              dependsOn: [],
              successCriteria: "pnpm build exits 0 with full src/**/* include intact",
              constraints: [
                "Do not narrow tsconfig includes to hide errors",
                "Do not remove tests to pass the build gate",
              ],
              durationMinutes: 15,
              backend: "codex",
            },
          ],
        }),
      );

      const plan = await generatePlan(client, "Fix build and keep constraints", TEST_CWD);
      expect("blocked" in plan).toBe(false);
      if (!("blocked" in plan)) {
        expect(plan.buildGate).toEqual({
          commands: ["pnpm build", "pnpm test --filter goal"],
          runBetweenSteps: true,
          postExecutionReview: false,
        });
        expect(plan.steps[0].successCriteria).toBe(
          "pnpm build exits 0 with full src/**/* include intact",
        );
        expect(plan.steps[0].constraints).toEqual([
          "Do not narrow tsconfig includes to hide errors",
          "Do not remove tests to pass the build gate",
        ]);
      }
    });

    it("defaults optional build-gate and step metadata when omitted", async () => {
      const client = mockClient(
        JSON.stringify({
          workingDir: "/tmp/moltbot",
          summary: "Fix build",
          steps: [
            {
              id: "fix-build",
              description: "Fix imports and restore build health",
              dependsOn: [],
              durationMinutes: 15,
              backend: "codex",
            },
          ],
        }),
      );

      const plan = await generatePlan(client, "Fix build", TEST_CWD);
      expect("blocked" in plan).toBe(false);
      if (!("blocked" in plan)) {
        expect(plan.buildGate).toBeUndefined();
        expect(plan.steps[0].successCriteria).toBeUndefined();
        expect(plan.steps[0].constraints).toEqual([]);
      }
    });

    it("omits postExecutionReview when planner returns a non-boolean value", async () => {
      const client = mockClient(
        JSON.stringify({
          workingDir: "/tmp/moltbot",
          summary: "Fix build",
          buildGate: {
            commands: ["pnpm build"],
            runBetweenSteps: true,
            postExecutionReview: "yes",
          },
          steps: [
            {
              id: "fix-build",
              description: "Fix imports and restore build health",
              dependsOn: [],
              durationMinutes: 15,
              backend: "codex",
            },
          ],
        }),
      );

      const plan = await generatePlan(client, "Fix build", TEST_CWD);
      expect("blocked" in plan).toBe(false);
      if (!("blocked" in plan)) {
        expect(plan.buildGate).toEqual({
          commands: ["pnpm build"],
          runBetweenSteps: true,
        });
      }
    });

    it("falls back short summaries when planner omits them", async () => {
      const client = mockClient(
        JSON.stringify({
          workingDir: "/tmp/moltbot",
          summary:
            "Implement authentication flow updates for multiple clients and verify behavior across environments",
          steps: [
            {
              id: "run-tests",
              description: "A. Run tests in parallel",
              dependsOn: [],
              durationMinutes: 10,
              backend: "claude_code",
            },
          ],
        }),
      );

      const plan = await generatePlan(client, "Auth update", TEST_CWD);
      expect("blocked" in plan).toBe(false);
      if (!("blocked" in plan)) {
        expect(plan.shortSummary.startsWith("Implement authentication flow updates")).toBe(true);
        expect(plan.shortSummary.endsWith("...")).toBe(true);
        expect(plan.shortSummary.length).toBeLessThanOrEqual(80);
        expect(plan.steps[0].shortSummary).toBe("Run tests");
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

    it("includes buildGate, successCriteria, and constraints in revision prompt context", async () => {
      const complete = vi.fn().mockResolvedValue({
        text: JSON.stringify({
          workingDir: "/tmp/moltbot",
          summary: "Revised plan",
          steps: [
            {
              id: "step-1",
              description: "Do work",
              dependsOn: [],
              durationMinutes: 10,
              backend: "codex",
            },
          ],
        }),
      });

      await generatePlanRevision(
        { complete },
        "Revise plan",
        TEST_CWD,
        {
          goal: "Revise plan",
          workingDir: "/tmp/moltbot",
          summary: "Current plan",
          shortSummary: "Current short summary",
          buildGate: {
            commands: ["pnpm build"],
            runBetweenSteps: false,
          },
          steps: [
            {
              id: "step-1",
              description: "Do work",
              shortSummary: "Do work",
              dependsOn: [],
              successCriteria: "pnpm build exits 0",
              constraints: ["Do not narrow tsconfig include"],
              status: "pending",
              durationMinutes: 10,
              backend: "codex",
            },
          ],
        },
        "Tighten constraints",
      );

      const prompt = String(complete.mock.calls[0]?.[0]?.userMessage ?? "");
      expect(prompt).toContain('"buildGate": {');
      expect(prompt).toContain('"commands": [');
      expect(prompt).toContain('"pnpm build"');
      expect(prompt).toContain('"runBetweenSteps": false');
      expect(prompt).toContain('"successCriteria": "pnpm build exits 0"');
      expect(prompt).toContain('"constraints": [');
      expect(prompt).toContain('"Do not narrow tsconfig include"');
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

    it("extracts fenced JSON when a string value contains nested code fences", () => {
      const result = extractJson(`\`\`\`json
{
  "workingDir": "/tmp/moltbot",
  "summary": "Create hello-world script",
  "steps": [
    {
      "id": "create-script",
      "description": "Create the script:\\n\`\`\`bash\\nmkdir -p /tmp/moltbot-test-goal\\ncat <<'EOF' > /tmp/moltbot-test-goal/hello.sh\\n#!/usr/bin/env bash\\necho hello world\\nEOF\\nchmod +x /tmp/moltbot-test-goal/hello.sh\\n\`\`\`\\nThen run it once to verify output.",
      "dependsOn": [],
      "durationMinutes": 3,
      "backend": "codex"
    }
  ]
}
\`\`\``);

      expect(result).toMatchObject({
        workingDir: "/tmp/moltbot",
        summary: "Create hello-world script",
      });
      const steps = result.steps as Array<Record<string, unknown>>;
      expect(steps).toHaveLength(1);
      const description = steps[0]?.description;
      expect(typeof description).toBe("string");
      if (typeof description !== "string") {
        throw new Error("Expected step description to be a string");
      }
      expect(description).toContain("```bash");
      expect(description).toContain("chmod +x /tmp/moltbot-test-goal/hello.sh");
    });

    it("parses bare JSON that follows a prose preamble", () => {
      const result = extractJson(
        'Now I have all the context needed. Here is the revised plan:\n{"key":"value"}',
      );
      expect(result).toEqual({ key: "value" });
    });

    it("parses JSON between prose preamble and a trailing fence marker", () => {
      const result = extractJson(
        'Now I have all the context needed. Here is the revised plan:\n{"key":"value"}\n```',
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

  describe("parsePlanResultFromText", () => {
    it("parses valid plan JSON with an extra trailing brace", () => {
      const result = parsePlanResultFromText(
        '{"workingDir":"/tmp/moltbot","summary":"Repair parse","steps":[{"id":"repair-parse","description":"Handle malformed JSON output","dependsOn":[],"backend":"codex"}]}}',
        "Repair parse",
      );

      expect("blocked" in result).toBe(false);
      if ("blocked" in result) return;
      expect(result.workingDir).toBe("/tmp/moltbot");
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]?.id).toBe("repair-parse");
    });

    it("parses fenced plan JSON with an extra trailing brace", () => {
      const result = parsePlanResultFromText(
        "```json\n" +
          '{"workingDir":"/tmp/moltbot","summary":"Fence repair","steps":[{"id":"fence-repair","description":"Handle fenced malformed JSON output","dependsOn":[],"backend":"codex"}]}}\n' +
          "```",
        "Fence repair",
      );

      expect("blocked" in result).toBe(false);
      if ("blocked" in result) return;
      expect(result.summary).toBe("Fence repair");
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]?.id).toBe("fence-repair");
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

  describe("Stage 2Q — self-verifying planner prompt", () => {
    // These tests fence the planner system prompt against drift away from the
    // Stage 2Q rules that implementation + tests + focused verification belong
    // in the SAME step, that success criteria are additive minimums, and that
    // logic-changing steps must name a focused test command.

    it("forbids splitting implementation and tests into separate steps", () => {
      const prompt = buildPlanSystemPrompt(["claude_code", "codex"]);
      expect(prompt).toContain(PLAN_QUALITY_RUBRIC);
      expect(prompt).toContain("IMPLEMENTATION/TEST SPLITS");
    });

    it("declares success criteria are additive minimums, not the full verification contract", () => {
      const prompt = buildPlanSystemPrompt(["claude_code", "codex"]);
      expect(prompt).toContain("Every code-changing step is SELF-VERIFYING");
      expect(prompt).toContain("focused tests");
    });

    it("forbids tsc-only success criteria for logic-changing steps", () => {
      const prompt = buildPlanSystemPrompt(["claude_code", "codex"]);
      expect(prompt).toContain("TSC-ONLY LOGIC STEPS");
    });

    it("requires the exact focused test command in implementation step success criteria", () => {
      const prompt = buildPlanSystemPrompt(["claude_code", "codex"]);
      expect(prompt).toContain("Every implementation step names exact focused test command(s)");
      expect(prompt).toContain("pnpm vitest run src/goal/planner.test.ts");
    });

    it("requires regression tests for command/config/prompt/worker/repo-chat surfaces", () => {
      const prompt = buildPlanSystemPrompt(["claude_code", "codex"]);
      expect(prompt).toContain("MISSING FOCUSED REGRESSIONS");
      expect(prompt).toContain("command-handler, config-schema, prompt, worker-behavior");
    });

    it("preserves an allowance for final verification-matrix and report steps", () => {
      const prompt = buildPlanSystemPrompt(["claude_code", "codex"]);
      expect(prompt).toContain("EXPLICITLY ALLOWED");
    });

    it("includes a Stage 2P bad-fixture example for add-529-transient-classifier", () => {
      const prompt = buildPlanSystemPrompt(["claude_code", "codex"]);
      expect(prompt).toContain("add-529-transient-classifier");
      expect(prompt).toContain("Stage 2P under-tested split");
      expect(prompt).not.toContain("GOOD COMBINED VARIANT");
    });

    it("includes a Stage 2P bad-fixture example for the repo-chat split", () => {
      const prompt = buildPlanSystemPrompt(["claude_code", "codex"]);
      expect(prompt).toContain("Stage 2P repo-chat split");
      expect(prompt).toContain("add-repo-chat-cli-output-extraction");
      expect(prompt).toContain("add-repo-chat-regression-tests");
    });
  });
});
