import { describe, expect, it } from "vitest";
import { formatPlanOutput } from "./format-output.js";
import type { Plan } from "./types.js";

const samplePlan: Plan = {
  goal: "Create a landing page",
  summary: "Build a simple landing page",
  steps: [
    {
      id: "1",
      description: "Create directory",
      dependsOn: [],
      tool: { name: "mkdir", args: { path: "site" } },
      status: "pending",
    },
    {
      id: "2",
      description: "Write index.html",
      dependsOn: ["1"],
      tool: { name: "file_write", args: { path: "site/index.html", content: "<h1>Hi</h1>" } },
      status: "pending",
    },
    {
      id: "3",
      description: "Stage files",
      dependsOn: ["2"],
      tool: { name: "git_add", args: { paths: "site/" } },
      status: "pending",
    },
  ],
};

// Branching: A -> B, A -> C
const branchingPlan: Plan = {
  goal: "Branch test",
  summary: "Branching DAG",
  steps: [
    {
      id: "A",
      description: "Root step",
      dependsOn: [],
      tool: { name: "mkdir", args: {} },
      status: "pending",
    },
    {
      id: "B",
      description: "Left branch",
      dependsOn: ["A"],
      tool: { name: "file_write", args: {} },
      status: "pending",
    },
    {
      id: "C",
      description: "Right branch",
      dependsOn: ["A"],
      tool: { name: "file_write", args: {} },
      status: "pending",
    },
  ],
};

// Fan-in: B -> D, C -> D (with root A -> B, A -> C)
const fanInPlan: Plan = {
  goal: "Fan-in test",
  summary: "Fan-in DAG",
  steps: [
    {
      id: "A",
      description: "Root",
      dependsOn: [],
      tool: { name: "mkdir", args: {} },
      status: "pending",
    },
    {
      id: "B",
      description: "Left",
      dependsOn: ["A"],
      tool: { name: "file_write", args: {} },
      status: "pending",
    },
    {
      id: "C",
      description: "Right",
      dependsOn: ["A"],
      tool: { name: "file_write", args: {} },
      status: "pending",
    },
    {
      id: "D",
      description: "Join",
      dependsOn: ["B", "C"],
      tool: { name: "git_add", args: {} },
      status: "pending",
    },
  ],
};

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
      expect(out).toContain("graph TD");
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
      expect(out).toContain("`mkdir`");
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
      expect(out).toContain("[ ] A (mkdir)");
      expect(out).toContain("[ ] B (file_write)");
      expect(out).toContain("[ ] C (file_write)");
      // A has no deps
      expect(out).toMatch(/\[ \] A \(mkdir\)\n\s+deps: none/);
      // B depends on A
      expect(out).toMatch(/\[ \] B \(file_write\)\n\s+deps: A/);
      // C depends on A
      expect(out).toMatch(/\[ \] C \(file_write\)\n\s+deps: A/);
    });

    it("renders fan-in DAG with correct deps per step", () => {
      const out = formatPlanOutput(fanInPlan, { diagram: "ascii", format: "md" });
      expect(out).toContain("[ ] D (git_add)");
      // D depends on B and C
      expect(out).toMatch(/\[ \] D \(git_add\)\n\s+deps: B, C/);
    });

    it("includes CPM schedule section with total duration and critical path", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "none", format: "md" });
      expect(out).toContain("### Schedule (CPM)");
      expect(out).toContain("**Total duration:** 3m");
      expect(out).toContain("**Critical path:** 1");
    });

    it("includes duration markers in step listing", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "none", format: "md" });
      expect(out).toContain("[1m]");
    });

    it("mermaid diagram includes duration labels when present", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "mermaid", format: "md" });
      expect(out).toContain("~1 min");
      expect(out).toContain("linkStyle");
    });
  });

  describe("json format", () => {
    it("outputs valid JSON with diagrams when both", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "both", format: "json" });
      const parsed = JSON.parse(out);
      expect(parsed.goal).toBe("Create a landing page");
      expect(parsed.summary).toBe("Build a simple landing page");
      expect(parsed.steps).toHaveLength(3);
      expect(parsed.diagrams.ascii).toContain("[ ] 1 (mkdir)");
      expect(parsed.diagrams.ascii).toContain("deps:");
      expect(parsed.diagrams.mermaid).toContain("graph TD");
    });

    it("outputs empty diagrams object when none", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "none", format: "json" });
      const parsed = JSON.parse(out);
      expect(parsed.diagrams).toEqual({});
    });

    it("outputs only mermaid when diagram=mermaid", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "mermaid", format: "json" });
      const parsed = JSON.parse(out);
      expect(parsed.diagrams.mermaid).toContain("graph TD");
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
        expect(step.tool).toBeTruthy();
      }
    });

    it("renders branching DAG correctly in JSON ascii", () => {
      const out = formatPlanOutput(branchingPlan, { diagram: "ascii", format: "json" });
      const parsed = JSON.parse(out);
      const ascii = parsed.diagrams.ascii as string;
      expect(ascii).toContain("[ ] A (mkdir)");
      expect(ascii).toMatch(/\[ \] B \(file_write\)\n\s+deps: A/);
      expect(ascii).toMatch(/\[ \] C \(file_write\)\n\s+deps: A/);
    });

    it("renders fan-in DAG correctly in JSON ascii", () => {
      const out = formatPlanOutput(fanInPlan, { diagram: "ascii", format: "json" });
      const parsed = JSON.parse(out);
      const ascii = parsed.diagrams.ascii as string;
      expect(ascii).toMatch(/\[ \] D \(git_add\)\n\s+deps: B, C/);
    });

    it("includes CPM schedule in JSON output", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "none", format: "json" });
      const parsed = JSON.parse(out);
      expect(parsed.schedule).toBeDefined();
      expect(parsed.schedule.totalDurationMinutes).toBe(3);
      expect(parsed.schedule.criticalPathStepIds).toEqual(["1", "2", "3"]);
      expect(parsed.schedule.steps["1"].isCritical).toBe(true);
    });

    it("includes durationMinutesEffective on each step in JSON", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "none", format: "json" });
      const parsed = JSON.parse(out);
      for (const step of parsed.steps) {
        expect(step.durationMinutesEffective).toBe(1);
      }
    });

    it("JSON mermaid diagram contains duration labels", () => {
      const out = formatPlanOutput(samplePlan, { diagram: "mermaid", format: "json" });
      const parsed = JSON.parse(out);
      expect(parsed.diagrams.mermaid).toContain("~1 min");
    });
  });
});
