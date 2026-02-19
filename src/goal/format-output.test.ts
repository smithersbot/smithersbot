import { describe, expect, it } from "vitest";
import { formatPlanOutput } from "./format-output.js";
import type { Plan, StepResult } from "./types.js";

type PlanStepInput = Omit<Plan["steps"][number], "shortSummary"> & { shortSummary?: string };

function makePlan(input: {
  goal: string;
  workingDir: string;
  summary: string;
  shortSummary?: string;
  steps: PlanStepInput[];
}): Plan {
  return {
    goal: input.goal,
    workingDir: input.workingDir,
    summary: input.summary,
    shortSummary: input.shortSummary ?? input.summary,
    steps: input.steps.map((step) => ({
      ...step,
      shortSummary: step.shortSummary ?? step.description,
    })),
  };
}

const samplePlan: Plan = makePlan({
  goal: "Create a landing page",
  workingDir: "/tmp/workspace",
  summary: "Build a simple landing page",
  steps: [
    {
      id: "1",
      description: "Create directory",
      dependsOn: [],
      status: "pending",
      durationMinutes: 1,
    },
    {
      id: "2",
      description: "Write index.html",
      dependsOn: ["1"],
      status: "pending",
      durationMinutes: 2,
    },
    {
      id: "3",
      description: "Stage files",
      dependsOn: ["2"],
      status: "pending",
      durationMinutes: 1,
    },
  ],
});

// Branching: A -> B, A -> C
const branchingPlan: Plan = makePlan({
  goal: "Branch test",
  workingDir: "/tmp/workspace",
  summary: "Branching DAG",
  steps: [
    {
      id: "A",
      description: "Root step",
      dependsOn: [],
      status: "pending",
      durationMinutes: 1,
    },
    {
      id: "B",
      description: "Left branch",
      dependsOn: ["A"],
      status: "pending",
      durationMinutes: 1,
    },
    {
      id: "C",
      description: "Right branch",
      dependsOn: ["A"],
      status: "pending",
      durationMinutes: 1,
    },
  ],
});

// Fan-in: B -> D, C -> D (with root A -> B, A -> C)
const fanInPlan: Plan = makePlan({
  goal: "Fan-in test",
  workingDir: "/tmp/workspace",
  summary: "Fan-in DAG",
  steps: [
    {
      id: "A",
      description: "Root",
      dependsOn: [],
      status: "pending",
      durationMinutes: 1,
    },
    {
      id: "B",
      description: "Left",
      dependsOn: ["A"],
      status: "pending",
      durationMinutes: 1,
    },
    {
      id: "C",
      description: "Right",
      dependsOn: ["A"],
      status: "pending",
      durationMinutes: 1,
    },
    {
      id: "D",
      description: "Join",
      dependsOn: ["B", "C"],
      status: "pending",
      durationMinutes: 1,
    },
  ],
});

const doneSingleStepPlan: Plan = makePlan({
  goal: "Done duration test",
  workingDir: "/tmp/workspace",
  summary: "Single completed step",
  steps: [
    {
      id: "A",
      description: "Completed task",
      dependsOn: [],
      status: "done",
      durationMinutes: 10,
    },
  ],
});

/** Runtime legend tokens that must NOT appear in static plan output. */
const RUNTIME_LEGEND_TOKENS = ["[x]", "[>]", "[!]", "[-]"];

describe("formatPlanOutput", () => {
  describe("md format", () => {
    it("includes both diagrams (both)", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "both", format: "md" });
      expect(out).toContain("## Plan:");
      expect(out).toContain("### Steps");
      expect(out).toContain("### Dependencies (ASCII)");
      expect(out).toContain("### Dependency Graph (Mermaid)");
      expect(out).toContain("```mermaid");
      expect(out).toContain("flowchart TD");
    });

    it("includes only ASCII when diagram=ascii", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "ascii", format: "md" });
      expect(out).toContain("### Dependencies (ASCII)");
      expect(out).not.toContain("### Dependency Graph (Mermaid)");
      expect(out).not.toContain("```mermaid");
    });

    it("includes only Mermaid when diagram=mermaid", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "mermaid", format: "md" });
      expect(out).not.toContain("### Dependencies (ASCII)");
      expect(out).toContain("### Dependency Graph (Mermaid)");
      expect(out).toContain("```mermaid");
    });

    it("includes no diagrams when diagram=none", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "none", format: "md" });
      expect(out).toContain("### Steps");
      expect(out).not.toContain("### Dependencies");
      expect(out).not.toContain("### Dependency Graph");
      expect(out).not.toContain("```mermaid");
    });

    it("lists steps with dependencies", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "none", format: "md" });
      expect(out).toContain("**Create directory**");
      expect(out).toContain("(depends on: none)");
      expect(out).toContain("(depends on: 1)");
    });

    it("does not include runtime legend tokens in plan output", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "ascii", format: "md" });
      for (const token of RUNTIME_LEGEND_TOKENS) {
        expect(out).not.toContain(token);
      }
    });

    it("does not use pipe characters as connectors in ASCII section", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "ascii", format: "md" });
      // Extract the ASCII section only (between header and next section or end)
      const asciiStart = out.indexOf("### Dependencies (ASCII)");
      const asciiSection = out.slice(asciiStart);
      // No line that is just whitespace and pipes (graph connectors)
      const lines = asciiSection.split("\n");
      for (const line of lines) {
        expect(line.trim()).not.toMatch(/^\|[\s|]*$/);
      }
    });

    it("renders branching DAG with correct deps per step", () => {
      const out = formatPlanOutput(branchingPlan, { diagram: "ascii", format: "md" });
      expect(out).toContain("[ ] A");
      expect(out).toContain("[ ] B");
      expect(out).toContain("[ ] C");
      // A has no deps
      expect(out).toMatch(/\[ \] A\n\s+deps: none/);
      // B depends on A
      expect(out).toMatch(/\[ \] B\n\s+deps: A/);
      // C depends on A
      expect(out).toMatch(/\[ \] C\n\s+deps: A/);
    });

    it("renders fan-in DAG with correct deps per step", () => {
      const out = formatPlanOutput(fanInPlan, { diagram: "ascii", format: "md" });
      expect(out).toContain("[ ] D");
      // D depends on B and C
      expect(out).toMatch(/\[ \] D\n\s+deps: B, C/);
    });

    it("includes CPM schedule section with total duration and critical path", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "none", format: "md" });
      expect(out).toContain("### Schedule (CPM)");
      expect(out).toContain("**Total duration:** 4m");
      expect(out).toContain("**Critical path:** 1");
    });

    it("includes duration markers in step listing", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "none", format: "md" });
      expect(out).toContain("[1m]");
      expect(out).toContain("[2m]");
    });

    it("mermaid diagram includes duration labels when present", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "mermaid", format: "md" });
      expect(out).toContain("~1 min");
      expect(out).toContain("linkStyle");
    });

    it("uses actual elapsed duration labels for done steps when stepResults are provided", () => {
      const stepResults = new Map<string, StepResult>([
        [
          "A",
          {
            stepId: "A",
            success: true,
            output: "ok",
            durationMs: 42_000,
          },
        ],
      ]);

      const out = formatPlanOutput(doneSingleStepPlan, {
        diagram: "mermaid",
        format: "md",
        stepResults,
      });

      expect(out).toContain("42s");
      expect(out).not.toContain("~10 min");
    });

    it("passes stepResults through to 'both' diagram mode", () => {
      const stepResults = new Map<string, StepResult>([
        [
          "A",
          {
            stepId: "A",
            success: true,
            output: "ok",
            durationMs: 90_000,
          },
        ],
      ]);

      const out = formatPlanOutput(doneSingleStepPlan, {
        diagram: "both",
        format: "md",
        stepResults,
      });

      // Mermaid section should show actual duration
      expect(out).toContain("1m 30s");
      expect(out).not.toContain("~10 min");
    });

    it("still shows CPM estimate in step listing even when stepResults are provided", () => {
      const stepResults = new Map<string, StepResult>([
        [
          "A",
          {
            stepId: "A",
            success: true,
            output: "ok",
            durationMs: 42_000,
          },
        ],
      ]);

      const out = formatPlanOutput(doneSingleStepPlan, {
        diagram: "none",
        format: "md",
        stepResults,
      });

      // Step listing uses CPM duration markers (not actual), since that's a plan view
      expect(out).toContain("[10m]");
    });

    it("shows actual durations for multiple done steps in a chain", () => {
      const multiDonePlan: Plan = {
        goal: "Multi done",
        workingDir: "/tmp/workspace",
        summary: "Multiple completed steps",
        steps: [
          {
            id: "1",
            description: "First step",
            dependsOn: [],
            status: "done",
            durationMinutes: 5,
          },
          {
            id: "2",
            description: "Second step",
            dependsOn: ["1"],
            status: "done",
            durationMinutes: 3,
          },
          {
            id: "3",
            description: "Third step",
            dependsOn: ["2"],
            status: "pending",
            durationMinutes: 2,
          },
        ],
      };

      const stepResults = new Map<string, StepResult>([
        ["1", { stepId: "1", success: true, output: "ok", durationMs: 15_000 }],
        ["2", { stepId: "2", success: true, output: "ok", durationMs: 180_000 }],
      ]);

      const out = formatPlanOutput(multiDonePlan, {
        diagram: "mermaid",
        format: "md",
        stepResults,
      });

      expect(out).toContain("15s");
      expect(out).toContain("3 min");
      expect(out).toContain("~2 min");
    });
  });

  describe("json format", () => {
    it("outputs valid JSON with diagrams when both", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "both", format: "json" });
      const parsed = JSON.parse(out);
      expect(parsed.goal).toBe("Create a landing page");
      expect(parsed.summary).toBe("Build a simple landing page");
      expect(parsed.steps).toHaveLength(3);
      expect(parsed.diagrams.ascii).toContain("[ ] 1");
      expect(parsed.diagrams.ascii).toContain("deps:");
      expect(parsed.diagrams.mermaid).toContain("flowchart TD");
    });

    it("outputs empty diagrams object when none", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "none", format: "json" });
      const parsed = JSON.parse(out);
      expect(parsed.diagrams).toEqual({});
    });

    it("outputs only mermaid when diagram=mermaid", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "mermaid", format: "json" });
      const parsed = JSON.parse(out);
      expect(parsed.diagrams.mermaid).toContain("flowchart TD");
      expect(parsed.diagrams.ascii).toBeUndefined();
    });

    it("outputs only ascii when diagram=ascii", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "ascii", format: "json" });
      const parsed = JSON.parse(out);
      expect(parsed.diagrams.ascii).toContain("deps:");
      expect(parsed.diagrams.mermaid).toBeUndefined();
    });

    it("ascii diagram in JSON has no runtime legend tokens", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "ascii", format: "json" });
      const parsed = JSON.parse(out);
      for (const token of RUNTIME_LEGEND_TOKENS) {
        expect(parsed.diagrams.ascii).not.toContain(token);
      }
    });

    it("step objects omit runtime status field", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "none", format: "json" });
      const parsed = JSON.parse(out);
      for (const step of parsed.steps) {
        expect(step.status).toBeUndefined();
        expect(step.id).toBeTruthy();
        expect(step.description).toBeTruthy();
      }
    });

    it("renders branching DAG correctly in JSON ascii", () => {
      const out = formatPlanOutput(branchingPlan, { diagram: "ascii", format: "json" });
      const parsed = JSON.parse(out);
      const ascii = parsed.diagrams.ascii as string;
      expect(ascii).toContain("[ ] A");
      expect(ascii).toMatch(/\[ \] B\n\s+deps: A/);
      expect(ascii).toMatch(/\[ \] C\n\s+deps: A/);
    });

    it("renders fan-in DAG correctly in JSON ascii", () => {
      const out = formatPlanOutput(fanInPlan, { diagram: "ascii", format: "json" });
      const parsed = JSON.parse(out);
      const ascii = parsed.diagrams.ascii as string;
      expect(ascii).toMatch(/\[ \] D\n\s+deps: B, C/);
    });

    it("includes CPM schedule in JSON output", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "none", format: "json" });
      const parsed = JSON.parse(out);
      expect(parsed.schedule).toBeDefined();
      expect(parsed.schedule.totalDurationMinutes).toBe(4);
      expect(parsed.schedule.criticalPathStepIds).toEqual(["1", "2", "3"]);
      expect(parsed.schedule.steps["1"].isCritical).toBe(true);
    });

    it("includes durationMinutesEffective on each step in JSON", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "none", format: "json" });
      const parsed = JSON.parse(out);
      expect(parsed.steps[0].durationMinutesEffective).toBe(1);
      expect(parsed.steps[1].durationMinutesEffective).toBe(2);
      expect(parsed.steps[2].durationMinutesEffective).toBe(1);
    });

    it("JSON mermaid diagram contains duration labels", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "mermaid", format: "json" });
      const parsed = JSON.parse(out);
      expect(parsed.diagrams.mermaid).toContain("~1 min");
    });

    it("JSON mermaid uses actual elapsed duration labels for done steps when stepResults are provided", () => {
      const stepResults = new Map<string, StepResult>([
        [
          "A",
          {
            stepId: "A",
            success: true,
            output: "ok",
            durationMs: 42_000,
          },
        ],
      ]);

      const out = formatPlanOutput(doneSingleStepPlan, {
        diagram: "mermaid",
        format: "json",
        stepResults,
      });
      const parsed = JSON.parse(out);
      expect(parsed.diagrams.mermaid).toContain("42s");
      expect(parsed.diagrams.mermaid).not.toContain("~10 min");
    });

    it("JSON both diagram mode passes stepResults to mermaid", () => {
      const stepResults = new Map<string, StepResult>([
        [
          "A",
          {
            stepId: "A",
            success: true,
            output: "ok",
            durationMs: 75_000,
          },
        ],
      ]);

      const out = formatPlanOutput(doneSingleStepPlan, {
        diagram: "both",
        format: "json",
        stepResults,
      });
      const parsed = JSON.parse(out);
      expect(parsed.diagrams.mermaid).toContain("1m 15s");
      expect(parsed.diagrams.mermaid).not.toContain("~10 min");
    });

    it("JSON output without stepResults uses estimated durations for done steps", () => {
      const out = formatPlanOutput(doneSingleStepPlan, {
        diagram: "mermaid",
        format: "json",
      });
      const parsed = JSON.parse(out);
      expect(parsed.diagrams.mermaid).toContain("~10 min");
    });
  });
});
