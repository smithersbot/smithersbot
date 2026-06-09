import { describe, expect, it } from "vitest";
import { computeCpm } from "./cpm.js";
import type { ExecutionDisplayStatus } from "./execution-status.js";
import { computeDisplayStatuses } from "./execution-status.js";
import { normalizeLabel, renderMermaid } from "./mermaid-render.js";
import { computeCriticalPathScores, orderStepIdsCriticalPathFirst } from "./plan-order.js";
import type { Plan, PlanStep, StepResult } from "./types.js";

function makePlan(steps: Plan["steps"]): Plan {
  return {
    goal: "test",
    workingDir: "/tmp/workspace",
    summary: "Test plan",
    shortSummary: "Test plan",
    steps: steps.map((item) => ({
      ...item,
      shortSummary: item.shortSummary ?? normalizeLabel(item.description),
    })),
  };
}

function step(overrides: Partial<PlanStep> & { id: string }): PlanStep {
  const baseStep: PlanStep = {
    id: overrides.id,
    description: `Step ${overrides.id}`,
    dependsOn: [],
    status: "pending",
    ...overrides,
  };
  return {
    ...baseStep,
    shortSummary: overrides.shortSummary ?? normalizeLabel(baseStep.description),
  };
}

function orderedStepIds(plan: Plan): string[] {
  const scores = computeCriticalPathScores(plan.steps);
  return orderStepIdsCriticalPathFirst(plan.steps, scores);
}

function nodeId(plan: Plan, stepId: string): string {
  const index = plan.steps.findIndex((step) => step.id === stepId);
  expect(index).toBeGreaterThanOrEqual(0);
  return `n${index}`;
}

function expectedNodeDeclarations(plan: Plan): string[] {
  const stepById = new Map(plan.steps.map((step) => [step.id, step]));
  return orderedStepIds(plan).map((stepId, index) => {
    const orderedStep = stepById.get(stepId);
    expect(orderedStep).toBeDefined();
    return `  ${nodeId(plan, stepId)}["${index + 1}. ${orderedStep!.shortSummary}"]`;
  });
}

function expectedInvisibleEdges(plan: Plan): string[] {
  const order = orderedStepIds(plan);
  return order
    .slice(0, -1)
    .map((stepId, index) => `  ${nodeId(plan, stepId)} ~~~ ${nodeId(plan, order[index + 1])}`);
}

function nodeDeclarations(out: string): string[] {
  return out.split("\n").filter((line) => /^\s+\S+\["/.test(line));
}

function invisibleEdges(out: string): string[] {
  return out.split("\n").filter((line) => line.includes("~~~"));
}

function visibleEdges(out: string): string[] {
  return out
    .split("\n")
    .filter((line) => line.includes("-->"))
    .map((line) => line.trim());
}

function classAssignments(out: string): string[] {
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("class "));
}

describe("normalizeLabel", () => {
  it("strips numeric prefix like '1.'", () => {
    expect(normalizeLabel("1. Create directory")).toBe("Create directory");
  });

  it("strips letter prefix like 'A.'", () => {
    expect(normalizeLabel("A. Write the file")).toBe("Write the file");
  });

  it("strips letter prefix with paren like 'B)'", () => {
    expect(normalizeLabel("B) Deploy server")).toBe("Deploy server");
  });

  it("strips slug prefix like 'write-a-txt.'", () => {
    expect(normalizeLabel("write-a-txt. Create file")).toBe("Create file");
  });

  it("strips single-char dash prefix like 'A-'", () => {
    expect(normalizeLabel("A- Build project")).toBe("Build project");
  });

  it("strips 'in parallel' filler", () => {
    expect(normalizeLabel("Run tests in parallel")).toBe("Run tests");
  });

  it("strips 'if user answered yes' filler", () => {
    expect(normalizeLabel("Deploy to prod if user answered yes")).toBe("Deploy to prod");
  });

  it("strips 'if user confirms' filler", () => {
    expect(normalizeLabel("Delete files if the user confirms")).toBe("Delete files");
  });

  it("strips trailing 'step' / 'steps'", () => {
    expect(normalizeLabel("Cleanup steps")).toBe("Cleanup");
    expect(normalizeLabel("Final step")).toBe("Final");
  });

  it("preserves question marks", () => {
    expect(normalizeLabel("Which database?")).toBe("Which database?");
  });

  it("capitalizes first letter", () => {
    expect(normalizeLabel("run the tests")).toBe("Run the tests");
  });

  it("handles already-clean descriptions", () => {
    expect(normalizeLabel("Create directory")).toBe("Create directory");
  });

  it("handles empty string", () => {
    expect(normalizeLabel("")).toBe("");
  });

  it("collapses internal whitespace and newlines", () => {
    expect(normalizeLabel("Write file\n\n  with   extra   spacing")).toBe(
      "Write file with extra spacing",
    );
  });

  it("converts 'Write file X containing Y' to 'Write X'", () => {
    expect(normalizeLabel("write-a-txt. Write file a.txt containing 'A'")).toBe("Write a.txt");
  });

  it("converts 'Write file X containing Y' after numeric prefix", () => {
    expect(normalizeLabel("1. Write file a.txt containing 'A'")).toBe("Write a.txt");
  });

  it("strips trailing 'step' after letter prefix", () => {
    expect(normalizeLabel("A. Do the cleanup step")).toBe("Do the cleanup");
  });

  it("converts 'Ask user yes/no question about creating X' to 'Ask: create X?'", () => {
    expect(normalizeLabel("Ask user yes/no question about creating b.txt")).toBe(
      "Ask: create b.txt?",
    );
  });

  it("strips 'containing' suffix and 'if user answered yes'", () => {
    expect(normalizeLabel("Create b.txt containing 'B' if user answered yes")).toBe("Create b.txt");
  });
});

describe("orderStepIdsCriticalPathFirst", () => {
  it("sorts a linear chain", () => {
    const steps = [
      step({ id: "1" }),
      step({ id: "2", dependsOn: ["1"] }),
      step({ id: "3", dependsOn: ["2"] }),
    ];
    expect(orderStepIdsCriticalPathFirst(steps)).toEqual(["1", "2", "3"]);
  });

  it("handles independent roots in input order", () => {
    const steps = [step({ id: "a" }), step({ id: "b" }), step({ id: "c" })];
    expect(orderStepIdsCriticalPathFirst(steps)).toEqual(["a", "b", "c"]);
  });

  it("handles diamond graph", () => {
    const steps = [
      step({ id: "A" }),
      step({ id: "B", dependsOn: ["A"] }),
      step({ id: "C", dependsOn: ["A"] }),
      step({ id: "D", dependsOn: ["B", "C"] }),
    ];
    expect(orderStepIdsCriticalPathFirst(steps)).toEqual(["A", "B", "C", "D"]);
  });

  it("produces correct numbering with out-of-order input", () => {
    // Steps provided out of dependency order
    const steps = [
      step({ id: "D", dependsOn: ["B", "C"] }),
      step({ id: "B", dependsOn: ["A"] }),
      step({ id: "A" }),
      step({ id: "C", dependsOn: ["A"] }),
    ];
    const sorted = orderStepIdsCriticalPathFirst(steps);
    // A must come first; B and C after A; D last
    expect(sorted.indexOf("A")).toBe(0);
    expect(sorted.indexOf("D")).toBe(3);
    expect(sorted.indexOf("B")).toBeLessThan(sorted.indexOf("D"));
    expect(sorted.indexOf("C")).toBeLessThan(sorted.indexOf("D"));
  });

  it("prioritizes longer downstream paths over plan order", () => {
    const steps = [step({ id: "B" }), step({ id: "A" }), step({ id: "C", dependsOn: ["A"] })];
    const scores = computeCriticalPathScores(steps);
    const sorted = orderStepIdsCriticalPathFirst(steps, scores);
    expect(sorted).toEqual(["A", "C", "B"]);
  });

  it("emits labels 1., 2., 3. in critical-path order for out-of-order input", () => {
    const plan = makePlan([
      step({ id: "C", dependsOn: ["B"], description: "Third" }),
      step({ id: "A", description: "First" }),
      step({ id: "B", dependsOn: ["A"], description: "Second" }),
    ]);
    const out = renderMermaid(plan);
    expect(out).toContain(`${nodeId(plan, "A")}["1. First"]`);
    expect(out).toContain(`${nodeId(plan, "B")}["2. Second"]`);
    expect(out).toContain(`${nodeId(plan, "C")}["3. Third"]`);
  });
});

describe("renderMermaid", () => {
  it("renders a linear chain with edges", () => {
    const plan = makePlan([
      {
        id: "1",
        description: "Create dir",
        dependsOn: [],
        status: "pending",
      },
      {
        id: "2",
        description: "Write file",
        dependsOn: ["1"],
        status: "pending",
      },
      {
        id: "3",
        description: "Stage",
        dependsOn: ["2"],
        status: "pending",
      },
    ]);

    const out = renderMermaid(plan);
    expect(out).toContain("flowchart TD");
    expect(out).toContain("1. Create dir");
    expect(out).not.toContain("(mkdir)");
    expect(out).toContain("2. Write file");
    expect(out).not.toContain("(file_write)");
    expect(out).toContain(`${nodeId(plan, "1")} --> ${nodeId(plan, "2")}`);
    expect(out).toContain(`${nodeId(plan, "2")} --> ${nodeId(plan, "3")}`);
  });

  it("truncates very long node labels to keep Mermaid output compact", () => {
    const longDescription = "A".repeat(300);
    const plan = makePlan([
      {
        id: "1",
        description: longDescription,
        dependsOn: [],
        status: "pending",
      },
    ]);

    const out = renderMermaid(plan);
    expect(out).toContain(`${nodeId(plan, "1")}["1. `);
    expect(out).toContain("...");
    expect(out).not.toContain(longDescription);
  });

  it("prefers shortSummary over description for node labels", () => {
    const plan = makePlan([
      {
        id: "1",
        description: "Verbose description that should not be used in the node label",
        shortSummary: "Readable task label",
        dependsOn: [],
        status: "pending",
      },
    ]);

    const out = renderMermaid(plan);
    expect(out).toContain(`${nodeId(plan, "1")}["1. Readable task label"]`);
    expect(out).not.toContain("Verbose description that should not be used in the node label");
  });

  it("renders independent roots with no edges", () => {
    const plan = makePlan([
      {
        id: "a",
        description: "Task A",
        dependsOn: [],
        status: "pending",
        durationMinutes: 1,
      },
      {
        id: "b",
        description: "Task B",
        dependsOn: [],
        status: "pending",
        durationMinutes: 5,
      },
    ]);

    const out = renderMermaid(plan);
    expect(out).toContain("flowchart TD");
    expect(orderedStepIds(plan)).toEqual(["b", "a"]);
    expect(nodeDeclarations(out)).toEqual(expectedNodeDeclarations(plan));
    expect(invisibleEdges(out)).toEqual(expectedInvisibleEdges(plan));
    expect(out).not.toContain("-->");
  });

  it("renders larger disconnected plans in numbered critical-path order with invisible links", () => {
    const plan = makePlan([
      step({ id: "a", description: "Task A", durationMinutes: 2 }),
      step({ id: "b", description: "Task B", durationMinutes: 9 }),
      step({ id: "c", description: "Task C", durationMinutes: 4 }),
      step({ id: "d", description: "Task D", durationMinutes: 7 }),
      step({ id: "e", description: "Task E", durationMinutes: 1 }),
      step({ id: "f", description: "Task F", durationMinutes: 5 }),
    ]);

    const out = renderMermaid(plan);

    expect(orderedStepIds(plan)).toEqual(["b", "d", "f", "c", "a", "e"]);
    expect(nodeDeclarations(out)).toEqual(expectedNodeDeclarations(plan));
    expect(invisibleEdges(out)).toEqual(expectedInvisibleEdges(plan));
    expect(out).not.toContain("-->");
  });

  it("renders a diamond dependency pattern", () => {
    const plan = makePlan([
      {
        id: "A",
        description: "Root",
        dependsOn: [],
        status: "pending",
      },
      {
        id: "B",
        description: "Left",
        dependsOn: ["A"],
        status: "pending",
      },
      {
        id: "C",
        description: "Right",
        dependsOn: ["A"],
        status: "pending",
      },
      {
        id: "D",
        description: "Join",
        dependsOn: ["B", "C"],
        status: "pending",
      },
    ]);

    const out = renderMermaid(plan);
    expect(out).toContain(`${nodeId(plan, "A")} --> ${nodeId(plan, "B")}`);
    expect(out).toContain(`${nodeId(plan, "A")} --> ${nodeId(plan, "C")}`);
    expect(out).toContain(`${nodeId(plan, "B")} --> ${nodeId(plan, "D")}`);
    expect(out).toContain(`${nodeId(plan, "C")} --> ${nodeId(plan, "D")}`);
  });

  it("maps Mermaid-unsafe step ids to deterministic safe node tokens", () => {
    const plan = makePlan([
      step({
        id: "build-api",
        description: "Build API service for build-api",
        status: "done",
        durationMinutes: 3,
      }),
      step({
        id: "data.load",
        description: "Load data.load inputs",
        dependsOn: ["build-api"],
        status: "done",
        durationMinutes: 5,
      }),
      step({
        id: "ask:input",
        description: "Ask about ask:input",
        dependsOn: ["build-api"],
        status: "blocked",
        durationMinutes: 1,
      }),
      step({
        id: "docs/readme",
        description: "Write docs/readme",
        dependsOn: ["data.load", "ask:input"],
        status: "pending",
        durationMinutes: 2,
      }),
      step({
        id: "1-start",
        description: "Start 1-start",
        status: "pending",
        durationMinutes: 1,
      }),
      step({
        id: "class",
        description: "Handle reserved word class",
        dependsOn: ["1-start"],
        status: "in_progress",
        durationMinutes: 1,
      }),
    ]);
    const cpm = computeCpm(plan);
    const statuses = new Map<string, ExecutionDisplayStatus>([
      ["build-api", "done"],
      ["data.load", "done"],
      ["ask:input", "blocked"],
      ["docs/readme", "pending"],
      ["1-start", "pending"],
      ["class", "in_progress"],
    ]);
    const stepResults = new Map<string, StepResult>([
      ["build-api", { stepId: "build-api", success: true, output: "ok", durationMs: 42_000 }],
      ["data.load", { stepId: "data.load", success: true, output: "ok", durationMs: 125_000 }],
    ]);

    const out = renderMermaid(plan, cpm, statuses, stepResults);

    expect(nodeDeclarations(out).map((line) => line.trim().match(/^(\w+)\[/)?.[1])).toEqual([
      "n0",
      "n1",
      "n2",
      "n3",
      "n4",
      "n5",
    ]);
    expect(visibleEdges(out)).toEqual([
      "n0 --> n1",
      "n0 --> n2",
      "n1 --> n3",
      "n2 --> n3",
      "n4 --> n5",
    ]);
    expect(classAssignments(out)).toEqual([
      "class n0 done;",
      "class n1 done;",
      "class n2 blocked;",
      "class n3 pending;",
      "class n4 pending;",
      "class n5 inprog;",
    ]);
    expect(out).toContain("Build API service for build-api<br/>42s");
    expect(out).toContain("Load data.load inputs<br/>2m 5s");
    expect(out).toContain("Ask about ask:input<br/>~1 min");
    expect(out).toContain("Write docs/readme<br/>~2 min");
    expect(out).toContain("linkStyle 0 stroke:#718096,stroke-width:4px;");
    expect(out).toContain("linkStyle 2 stroke:#718096,stroke-width:4px;");
    expect(out).not.toContain("linkStyle 1 stroke:#718096,stroke-width:4px;");

    for (const rawId of plan.steps.map((item) => item.id)) {
      expect(nodeDeclarations(out).some((line) => line.trim().startsWith(`${rawId}[`))).toBe(false);
      expect(visibleEdges(out).some((line) => line.split(/\s+-->\s+/).includes(rawId))).toBe(false);
      expect(classAssignments(out).some((line) => line.startsWith(`class ${rawId} `))).toBe(false);
    }
  });

  it("escapes double quotes in descriptions", () => {
    const plan = makePlan([
      {
        id: "1",
        description: 'Write "hello"',
        dependsOn: [],
        status: "pending",
      },
    ]);

    const out = renderMermaid(plan);
    expect(out).toContain("&quot;hello&quot;");
    // Should not contain unescaped quotes inside the label
    expect(out).not.toMatch(/\["[^"]*"hello"[^"]*"\]/);
  });

  it("escapes ampersands and angle brackets in descriptions", () => {
    const plan = makePlan([
      {
        id: "1",
        description: "A & B <C>",
        dependsOn: [],
        status: "pending",
      },
    ]);

    const out = renderMermaid(plan);
    expect(out).toContain("A &amp; B &lt;C&gt;");
  });

  it("includes duration in node labels when CPM is provided", () => {
    const plan = makePlan([
      {
        id: "1",
        description: "Create dir",
        dependsOn: [],
        status: "pending",
        durationMinutes: 3,
      },
      {
        id: "2",
        description: "Write file",
        dependsOn: ["1"],
        status: "pending",
        durationMinutes: 5,
      },
    ]);
    const cpm = computeCpm(plan);
    const out = renderMermaid(plan, cpm);
    expect(out).toContain("~3 min");
    expect(out).toContain("~5 min");
  });

  it("shows backend names beside estimated durations", () => {
    const plan = makePlan([
      {
        id: "1",
        description: "Create dir",
        dependsOn: [],
        status: "pending",
        durationMinutes: 3,
        backend: "claude_code",
      },
      {
        id: "2",
        description: "Write file",
        dependsOn: ["1"],
        status: "pending",
        durationMinutes: 5,
        backend: "pi",
      },
    ]);
    const cpm = computeCpm(plan);
    const out = renderMermaid(plan, cpm);
    expect(out).toContain("~3 min | Claude Code");
    expect(out).toContain("~5 min | Pi");
  });

  it("appends the 📡 network marker only beside requiresNetwork=true backends", () => {
    const plan = makePlan([
      {
        id: "1",
        description: "Fetch deps",
        dependsOn: [],
        status: "pending",
        durationMinutes: 3,
        backend: "codex",
        requiresNetwork: true,
      },
      {
        id: "2",
        description: "Local build",
        dependsOn: ["1"],
        status: "pending",
        durationMinutes: 5,
        backend: "claude_code",
      },
    ]);
    const cpm = computeCpm(plan);
    const out = renderMermaid(plan, cpm);
    // Network-required step shows the marker to the right of the backend label.
    expect(out).toContain("~3 min | Codex 📡");
    // Non-network step keeps the plain backend label (no marker).
    expect(out).toContain("~5 min | Claude Code");
    expect(out).not.toContain("Claude Code 📡");
  });

  it("uses linkStyle for critical path instead of classDef critical", () => {
    const plan = makePlan([
      {
        id: "A",
        description: "Root",
        dependsOn: [],
        status: "pending",
        durationMinutes: 2,
      },
    ]);
    const cpm = computeCpm(plan);
    const out = renderMermaid(plan, cpm);
    expect(out).not.toContain("classDef critical");
    // No edges → no linkStyle for critical path (only the default linkStyle in header)
    expect(out).toContain("linkStyle default");
  });

  it("marks critical edges with linkStyle lines", () => {
    const plan = makePlan([
      {
        id: "A",
        description: "Root",
        dependsOn: [],
        status: "pending",
        durationMinutes: 2,
      },
      {
        id: "B",
        description: "Long path",
        dependsOn: ["A"],
        status: "pending",
        durationMinutes: 3,
      },
      {
        id: "C",
        description: "Short path",
        dependsOn: ["A"],
        status: "pending",
        durationMinutes: 1,
      },
    ]);
    const cpm = computeCpm(plan);
    const out = renderMermaid(plan, cpm);
    // Edges: A→B (index 0), A→C (index 1). A and B are critical; C is not.
    expect(out).toContain("linkStyle 0 stroke:#718096,stroke-width:4px;");
    expect(out).not.toContain("linkStyle 1 stroke:#718096,stroke-width:4px;");
  });

  it("critical-path linkStyle indices correct for diamond graph", () => {
    // Diamond: A→B, A→C, B→D, C→D — equal durations so all critical
    const plan = makePlan([
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
    ]);
    const cpm = computeCpm(plan);
    const out = renderMermaid(plan, cpm);
    // Edges emitted in order: A→B(0), A→C(1), B→D(2), C→D(3) — all critical
    expect(out).toContain("linkStyle 0 stroke:#718096,stroke-width:4px;");
    expect(out).toContain("linkStyle 1 stroke:#718096,stroke-width:4px;");
    expect(out).toContain("linkStyle 2 stroke:#718096,stroke-width:4px;");
    expect(out).toContain("linkStyle 3 stroke:#718096,stroke-width:4px;");
  });

  describe("execution status styling", () => {
    // A(done, no deps), B(blocked, deps:A), C(pending, no deps), D(in_progress, no deps)
    // Critical-path-first order: A=1, then B, C, D by plan order.
    const statusPlan = makePlan([
      {
        id: "A",
        description: "Done step",
        dependsOn: [],
        status: "done",
      },
      {
        id: "B",
        description: "Blocked step",
        dependsOn: ["A"],
        status: "blocked",
        blockedQuestion: "q",
      },
      {
        id: "C",
        description: "Pending step",
        dependsOn: [],
        status: "pending",
      },
      {
        id: "D",
        description: "In-progress step",
        dependsOn: [],
        status: "in_progress",
      },
    ]);

    it("emits classDef lines for all status types in style header", () => {
      const statuses = new Map<string, ExecutionDisplayStatus>([
        ["A", "done"],
        ["B", "blocked"],
        ["C", "soft_blocked"],
        ["D", "in_progress"],
      ]);
      const out = renderMermaid(statusPlan, undefined, statuses);
      expect(out).toContain("classDef blocked fill:#450a0a");
      expect(out).toContain("classDef waiting fill:#4C1D95");
      expect(out).toContain("classDef inprog fill:#C2410C");
      expect(out).toContain("classDef done fill:#3F4F3A");
      expect(out).toContain("classDef pending fill:#2D3748");
    });

    it("assigns per-node class matching the status map", () => {
      const statuses = new Map<string, ExecutionDisplayStatus>([
        ["A", "done"],
        ["B", "blocked"],
        ["C", "soft_blocked"],
        ["D", "in_progress"],
      ]);
      const out = renderMermaid(statusPlan, undefined, statuses);
      expect(out).toContain(`class ${nodeId(statusPlan, "A")} done;`);
      expect(out).toContain(`class ${nodeId(statusPlan, "B")} blocked;`);
      expect(out).toContain(`class ${nodeId(statusPlan, "C")} waiting;`);
      expect(out).toContain(`class ${nodeId(statusPlan, "D")} inprog;`);
    });

    it("uses done class directly for done status", () => {
      const statuses = new Map<string, ExecutionDisplayStatus>([["A", "done"]]);
      const out = renderMermaid(statusPlan, undefined, statuses);
      expect(out).toContain(`class ${nodeId(statusPlan, "A")} done;`);
    });

    it("assigns pending class to all nodes when displayStatuses is omitted (plan mode: no emojis)", () => {
      const out = renderMermaid(statusPlan);
      // All nodes get pending class by default
      expect(out).toContain(`class ${nodeId(statusPlan, "A")} pending;`);
      expect(out).toContain(`class ${nodeId(statusPlan, "B")} pending;`);
      expect(out).toContain(`class ${nodeId(statusPlan, "C")} pending;`);
      expect(out).toContain(`class ${nodeId(statusPlan, "D")} pending;`);
      // No emojis in labels when displayStatuses is omitted
      expect(out).not.toContain("✅");
      expect(out).not.toContain("⛔");
      expect(out).not.toContain("🛠");
      expect(out).not.toContain("⏳");
    });

    it("adds emoji prefixes to labels when displayStatuses is provided", () => {
      const statuses = new Map<string, ExecutionDisplayStatus>([
        ["A", "done"],
        ["B", "blocked"],
        ["C", "soft_blocked"],
        ["D", "in_progress"],
      ]);
      const out = renderMermaid(statusPlan, undefined, statuses);
      // Topo numbering: A=1, B=2, C=3, D=4
      expect(out).toContain("✅ 1.");
      expect(out).toContain("⛔ 2.");
      expect(out).toContain("⏳ 3.");
      expect(out).toContain("🛠 4.");
    });

    it("soft_blocked maps to ⏳ emoji and waiting class", () => {
      const statuses = new Map<string, ExecutionDisplayStatus>([["C", "soft_blocked"]]);
      const out = renderMermaid(statusPlan, undefined, statuses);
      expect(out).toContain("⏳ 3.");
      expect(out).toContain(`class ${nodeId(statusPlan, "C")} waiting;`);
    });

    it("usage_limited follows the approved blocked rule (no amber/dashed class, no battery icon)", () => {
      const statuses = new Map<string, ExecutionDisplayStatus>([["C", "usage_limited"]]);
      const out = renderMermaid(statusPlan, undefined, statuses);
      // A usage-limit block uses the same approved blocked style/icon — no
      // invented amber/dashed `usagelimited` class and no battery icon.
      expect(out).toContain("⛔ 3.");
      expect(out).toContain(`class ${nodeId(statusPlan, "C")} blocked;`);
      expect(out).not.toContain("🪫");
      expect(out).not.toContain("usagelimited");
      expect(out).not.toContain("#FBBF24");
      expect(out).not.toContain("#713F12");
    });

    it("pending status has no emoji prefix", () => {
      const statuses = new Map<string, ExecutionDisplayStatus>([["C", "pending"]]);
      const out = renderMermaid(statusPlan, undefined, statuses);
      // Should have the number but no emoji before it
      expect(out).toMatch(/\b3\. Pending/);
      expect(out).not.toMatch(/[✅⛔🏃⏳]\s*3\./);
    });

    it("works together with CPM critical path styling", () => {
      const plan = makePlan([
        {
          id: "X",
          description: "Task X",
          dependsOn: [],
          status: "done",
          durationMinutes: 3,
        },
      ]);
      const cpm = computeCpm(plan);
      const statuses = new Map<string, ExecutionDisplayStatus>([["X", "done"]]);
      const out = renderMermaid(plan, cpm, statuses);
      // Both linkStyle (via header) and status class should be present
      expect(out).toContain("linkStyle default");
      expect(out).not.toContain("classDef critical");
      expect(out).toContain("classDef done");
      expect(out).toContain(`class ${nodeId(plan, "X")} done;`);
    });

    it("uses actual elapsed duration labels for done steps when stepResults are provided", () => {
      const plan = makePlan([
        {
          id: "A",
          description: "Done step",
          dependsOn: [],
          status: "done",
          durationMinutes: 10,
        },
        {
          id: "B",
          description: "Pending step",
          dependsOn: ["A"],
          status: "pending",
          durationMinutes: 2,
        },
      ]);
      const cpm = computeCpm(plan);
      const statuses = new Map<string, ExecutionDisplayStatus>([
        ["A", "done"],
        ["B", "pending"],
      ]);
      const stepResults = new Map<string, StepResult>([
        ["A", { stepId: "A", success: true, output: "ok", durationMs: 31_000 }],
      ]);

      const out = renderMermaid(plan, cpm, statuses, stepResults);
      expect(out).toContain("Done<br/>31s");
      expect(out).not.toContain("Done<br/>~10 min");
      expect(out).toContain("Pending<br/>~2 min");
    });

    it("prefers executedBackend over backend in duration labels", () => {
      const plan = makePlan([
        {
          id: "A",
          description: "Done step",
          dependsOn: [],
          status: "done",
          durationMinutes: 10,
          backend: "pi",
          executedBackend: "codex",
        },
        {
          id: "B",
          description: "Pending step",
          dependsOn: ["A"],
          status: "pending",
          durationMinutes: 2,
          backend: "pi",
          executedBackend: "claude_code",
        },
      ]);
      const cpm = computeCpm(plan);
      const statuses = new Map<string, ExecutionDisplayStatus>([
        ["A", "done"],
        ["B", "pending"],
      ]);
      const stepResults = new Map<string, StepResult>([
        ["A", { stepId: "A", success: true, output: "ok", durationMs: 42_000 }],
      ]);

      const out = renderMermaid(plan, cpm, statuses, stepResults);
      expect(out).toContain("Done<br/>42s | Codex");
      expect(out).toContain("Pending<br/>~2 min | Claude Code");
      expect(out).not.toContain("42s | Pi");
      expect(out).not.toContain("~2 min | Pi");
    });
  });

  describe("approved status/diagram visual rules (usage-limit + resume)", () => {
    it("a usage-limit unresolved step follows the approved blocked rule end-to-end", () => {
      const plan = makePlan([
        step({
          id: "A",
          description: "Out of credits",
          status: "blocked",
          blockedReason: "out_of_credits",
        }),
      ]);
      const statuses = computeDisplayStatuses(plan.steps);
      // Logical display status is preserved (resume/backend-recheck needs it)...
      expect(statuses.get("A")).toBe("usage_limited");
      const out = renderMermaid(plan, undefined, statuses);
      // ...but the VISUAL mapping is the approved blocked style/icon only — no
      // invented amber/dashed `usagelimited` class, no battery icon, no colors.
      expect(out).toContain("⛔ 1.");
      expect(out).toContain(`class ${nodeId(plan, "A")} blocked;`);
      expect(out).not.toContain("usagelimited");
      expect(out).not.toContain("🪫");
      expect(out).not.toContain("#FBBF24");
      expect(out).not.toContain("#713F12");
    });

    it("a dependent step renders waiting (not hard-blocked) when upstream is unresolved", () => {
      const plan = makePlan([
        step({
          id: "A",
          description: "Exhausted",
          status: "blocked",
          blockedReason: "usage_limit",
        }),
        step({ id: "B", description: "Downstream", status: "pending", dependsOn: ["A"] }),
      ]);
      const statuses = computeDisplayStatuses(plan.steps);
      const out = renderMermaid(plan, undefined, statuses);
      expect(out).toContain(`class ${nodeId(plan, "A")} blocked;`);
      expect(out).toContain(`class ${nodeId(plan, "B")} waiting;`);
      expect(out).toContain("⏳");
    });

    it("an independent runnable sibling stays pending while a sibling is usage-limited", () => {
      const plan = makePlan([
        step({
          id: "A",
          description: "Exhausted",
          status: "blocked",
          blockedReason: "out_of_credits",
        }),
        step({ id: "B", description: "Independent", status: "pending" }),
      ]);
      const statuses = computeDisplayStatuses(plan.steps);
      const out = renderMermaid(plan, undefined, statuses);
      expect(out).toContain(`class ${nodeId(plan, "A")} blocked;`);
      expect(out).toContain(`class ${nodeId(plan, "B")} pending;`);
    });

    it("recomputes ALL node display states (resume), not just the first node", () => {
      // done stays done; usage-limit -> approved blocked visual; retryable
      // technical -> pending; hard block stays blocked; downstream of hard -> waiting.
      const plan = makePlan([
        step({ id: "A", description: "Done", status: "done" }),
        step({
          id: "B",
          description: "Exhausted",
          status: "blocked",
          blockedReason: "usage_limit",
        }),
        step({ id: "C", description: "Retryable", status: "blocked", blockedReason: "error" }),
        step({
          id: "D",
          description: "Needs input",
          status: "blocked",
          blockedReason: "user_input",
          blockedQuestion: "q",
        }),
        step({ id: "E", description: "Downstream", status: "pending", dependsOn: ["D"] }),
      ]);
      const statuses = computeDisplayStatuses(plan.steps);
      const out = renderMermaid(plan, undefined, statuses);
      expect(out).toContain(`class ${nodeId(plan, "A")} done;`);
      expect(out).toContain(`class ${nodeId(plan, "B")} blocked;`);
      expect(out).toContain(`class ${nodeId(plan, "C")} pending;`);
      expect(out).toContain(`class ${nodeId(plan, "D")} blocked;`);
      expect(out).toContain(`class ${nodeId(plan, "E")} waiting;`);
      // No stale invented usage-limited styling anywhere.
      expect(out).not.toContain("usagelimited");
      expect(out).not.toContain("🪫");
    });

    it("a done goal graph has no stale blocked or usage-limited nodes", () => {
      const plan = makePlan([
        step({ id: "A", description: "First", status: "done" }),
        step({ id: "B", description: "Second", status: "done", dependsOn: ["A"] }),
      ]);
      const statuses = computeDisplayStatuses(plan.steps);
      const out = renderMermaid(plan, undefined, statuses);
      expect(out).toContain(`class ${nodeId(plan, "A")} done;`);
      expect(out).toContain(`class ${nodeId(plan, "B")} done;`);
      expect(out).not.toContain(`class ${nodeId(plan, "A")} blocked;`);
      expect(out).not.toContain(`class ${nodeId(plan, "B")} blocked;`);
      expect(out).not.toContain("usagelimited");
      expect(out).not.toContain("⛔");
      expect(out).not.toContain("🪫");
    });

    it("a cancelled goal graph shows step states correctly with no stale blocked nodes", () => {
      // A cancelled goal has no per-step "cancelled" display status; the graph
      // renders underlying step states (completed stay done, remaining stay
      // pending) and must leave no stale blocked/usage-limited styling.
      const plan = makePlan([
        step({ id: "A", description: "Completed before cancel", status: "done" }),
        step({ id: "B", description: "Not started", status: "pending", dependsOn: ["A"] }),
      ]);
      const statuses = computeDisplayStatuses(plan.steps);
      const out = renderMermaid(plan, undefined, statuses);
      expect(out).toContain(`class ${nodeId(plan, "A")} done;`);
      expect(out).toContain(`class ${nodeId(plan, "B")} pending;`);
      expect(out).not.toContain("usagelimited");
      expect(out).not.toContain("⛔");
      expect(out).not.toContain("🪫");
    });

    it("preserves transitive-arrow reduction with display statuses applied (no regression)", () => {
      const plan = makePlan([
        step({ id: "a", description: "A", status: "done" }),
        step({ id: "b", description: "B", status: "done", dependsOn: ["a"] }),
        step({ id: "c", description: "C", status: "pending", dependsOn: ["b", "a"] }),
      ]);
      const statuses = computeDisplayStatuses(plan.steps);
      const out = renderMermaid(plan, undefined, statuses);
      expect(visibleEdges(out)).toEqual([
        `${nodeId(plan, "a")} --> ${nodeId(plan, "b")}`,
        `${nodeId(plan, "b")} --> ${nodeId(plan, "c")}`,
      ]);
      expect(out).not.toContain(`${nodeId(plan, "a")} --> ${nodeId(plan, "c")}`);
    });
  });

  describe("actual duration formatting edge cases", () => {
    function durationPlan(id: string, durationMinutes = 5): Plan {
      return makePlan([step({ id, description: "Task", status: "done", durationMinutes })]);
    }

    function renderWithDuration(durationMs: number, durationMinutes = 5): string {
      const plan = durationPlan("A", durationMinutes);
      const cpm = computeCpm(plan);
      const statuses = new Map<string, ExecutionDisplayStatus>([["A", "done"]]);
      const stepResults = new Map<string, StepResult>([
        ["A", { stepId: "A", success: true, output: "ok", durationMs }],
      ]);
      return renderMermaid(plan, cpm, statuses, stepResults);
    }

    it("formats sub-second duration as 1s (minimum)", () => {
      const out = renderWithDuration(500);
      expect(out).toContain("<br/>1s");
    });

    it("formats exactly 1 second", () => {
      const out = renderWithDuration(1000);
      expect(out).toContain("<br/>1s");
    });

    it("formats 59 seconds without minutes", () => {
      const out = renderWithDuration(59_000);
      expect(out).toContain("<br/>59s");
    });

    it("formats exactly 60 seconds as minutes", () => {
      const out = renderWithDuration(60_000);
      expect(out).toContain("<br/>1 min");
    });

    it("formats 90 seconds as 1m 30s", () => {
      const out = renderWithDuration(90_000);
      expect(out).toContain("<br/>1m 30s");
    });

    it("formats exact minutes without seconds", () => {
      const out = renderWithDuration(300_000);
      expect(out).toContain("<br/>5 min");
    });

    it("formats large duration (10+ minutes)", () => {
      const out = renderWithDuration(639_000);
      expect(out).toContain("<br/>10m 39s");
    });

    it("falls back to CPM estimate when stepResults are not provided", () => {
      const plan = durationPlan("A");
      const cpm = computeCpm(plan);
      const statuses = new Map<string, ExecutionDisplayStatus>([["A", "done"]]);
      const out = renderMermaid(plan, cpm, statuses);
      expect(out).toContain("~5 min");
      expect(out).not.toMatch(/<br\/>\d+s/);
    });

    it("falls back to CPM estimate when step is missing from stepResults", () => {
      const plan = durationPlan("A");
      const cpm = computeCpm(plan);
      const statuses = new Map<string, ExecutionDisplayStatus>([["A", "done"]]);
      const stepResults = new Map<string, StepResult>();
      const out = renderMermaid(plan, cpm, statuses, stepResults);
      expect(out).toContain("~5 min");
    });

    it("does not use actual duration for non-done steps even if stepResults has an entry", () => {
      const plan = makePlan([
        step({ id: "A", description: "In progress", status: "in_progress", durationMinutes: 3 }),
      ]);
      const cpm = computeCpm(plan);
      const statuses = new Map<string, ExecutionDisplayStatus>([["A", "in_progress"]]);
      const stepResults = new Map<string, StepResult>([
        ["A", { stepId: "A", success: false, output: "", durationMs: 15_000 }],
      ]);
      const out = renderMermaid(plan, cpm, statuses, stepResults);
      expect(out).toContain("~3 min");
      expect(out).not.toContain("15s");
    });

    it("handles multiple done steps each with their own actual durations", () => {
      const plan = makePlan([
        step({ id: "A", description: "First", status: "done", durationMinutes: 10 }),
        step({
          id: "B",
          description: "Second",
          status: "done",
          dependsOn: ["A"],
          durationMinutes: 8,
        }),
        step({
          id: "C",
          description: "Third",
          status: "pending",
          dependsOn: ["B"],
          durationMinutes: 5,
        }),
      ]);
      const cpm = computeCpm(plan);
      const statuses = new Map<string, ExecutionDisplayStatus>([
        ["A", "done"],
        ["B", "done"],
        ["C", "pending"],
      ]);
      const stepResults = new Map<string, StepResult>([
        ["A", { stepId: "A", success: true, output: "ok", durationMs: 42_000 }],
        ["B", { stepId: "B", success: true, output: "ok", durationMs: 125_000 }],
      ]);
      const out = renderMermaid(plan, cpm, statuses, stepResults);
      expect(out).toContain("First<br/>42s");
      expect(out).toContain("Second<br/>2m 5s");
      expect(out).toContain("Third<br/>~5 min");
    });

    it("handles zero durationMs gracefully", () => {
      const out = renderWithDuration(0);
      // 0ms rounds to max(1, 0) = 1s minimum
      expect(out).toContain("<br/>1s");
    });

    it("uses actual duration without CPM (no estimate fallback)", () => {
      const plan = makePlan([step({ id: "A", description: "Task", status: "done" })]);
      const statuses = new Map<string, ExecutionDisplayStatus>([["A", "done"]]);
      const stepResults = new Map<string, StepResult>([
        ["A", { stepId: "A", success: true, output: "ok", durationMs: 7_000 }],
      ]);
      // No CPM passed
      const out = renderMermaid(plan, undefined, statuses, stepResults);
      expect(out).toContain("<br/>7s");
    });
  });

  it("uses critical-path-first numbering even with out-of-order step IDs", () => {
    // Steps in reverse order in the array, but deps create: Z→Y→X
    const plan = makePlan([
      {
        id: "X",
        description: "Last task",
        dependsOn: ["Y"],
        status: "pending",
      },
      {
        id: "Y",
        description: "Middle task",
        dependsOn: ["Z"],
        status: "pending",
      },
      {
        id: "Z",
        description: "First task",
        dependsOn: [],
        status: "pending",
      },
    ]);
    const out = renderMermaid(plan);
    // Z should be #1 (root), Y #2, X #3 in dependency order
    expect(out).toContain(`${nodeId(plan, "Z")}["1. First task"]`);
    expect(out).toContain(`${nodeId(plan, "Y")}["2. Middle task"]`);
    expect(out).toContain(`${nodeId(plan, "X")}["3. Last task"]`);
  });

  it("normalizes LLM-prefixed descriptions in labels", () => {
    const plan = makePlan([
      {
        id: "1",
        description: "A. Create the project directory in parallel",
        dependsOn: [],
        status: "pending",
      },
    ]);
    const out = renderMermaid(plan);
    // "A." prefix stripped, "in parallel" stripped
    expect(out).toContain("1. Create the project directory");
    expect(out).not.toContain("A.");
    expect(out).not.toContain("in parallel");
  });

  it("includes style header with init directive", () => {
    const plan = makePlan([
      {
        id: "1",
        description: "Test",
        dependsOn: [],
        status: "pending",
      },
    ]);
    const out = renderMermaid(plan);
    expect(out).toContain("%%{init:");
    expect(out).toContain('"theme": "base"');
    expect(out).toContain("linkStyle default");
  });

  it("places init directive before graph TD and classDefs after", () => {
    const plan = makePlan([
      {
        id: "1",
        description: "Test",
        dependsOn: [],
        status: "pending",
      },
    ]);
    const out = renderMermaid(plan);
    const initIdx = out.indexOf("%%{init:");
    const graphIdx = out.indexOf("flowchart TD");
    const classDefIdx = out.indexOf("classDef pending");
    expect(initIdx).toBeLessThan(graphIdx);
    expect(graphIdx).toBeLessThan(classDefIdx);
  });

  it("fontFamily ends with sans-serif", () => {
    const plan = makePlan([
      {
        id: "1",
        description: "Test",
        dependsOn: [],
        status: "pending",
      },
    ]);
    const out = renderMermaid(plan);
    expect(out).toMatch(/fontFamily.*serif"/);
  });

  describe("transitive edge reduction", () => {
    it("drops a redundant a->c edge implied by a->b->c", () => {
      const plan = makePlan([
        step({ id: "a", description: "A" }),
        step({ id: "b", description: "B", dependsOn: ["a"] }),
        step({ id: "c", description: "C", dependsOn: ["b", "a"] }),
      ]);
      const out = renderMermaid(plan);
      expect(visibleEdges(out)).toEqual([
        `${nodeId(plan, "a")} --> ${nodeId(plan, "b")}`,
        `${nodeId(plan, "b")} --> ${nodeId(plan, "c")}`,
      ]);
      expect(out).not.toContain(`${nodeId(plan, "a")} --> ${nodeId(plan, "c")}`);
    });

    it("drops a redundant edge spanning a longer chain (a->b->c->d, a->d)", () => {
      const plan = makePlan([
        step({ id: "a", description: "A" }),
        step({ id: "b", description: "B", dependsOn: ["a"] }),
        step({ id: "c", description: "C", dependsOn: ["b"] }),
        step({ id: "d", description: "D", dependsOn: ["c", "a"] }),
      ]);
      const out = renderMermaid(plan);
      expect(out).not.toContain(`${nodeId(plan, "a")} --> ${nodeId(plan, "d")}`);
      expect(visibleEdges(out)).toEqual([
        `${nodeId(plan, "a")} --> ${nodeId(plan, "b")}`,
        `${nodeId(plan, "b")} --> ${nodeId(plan, "c")}`,
        `${nodeId(plan, "c")} --> ${nodeId(plan, "d")}`,
      ]);
    });

    it("keeps all diamond edges (none are transitively implied)", () => {
      const plan = makePlan([
        step({ id: "A", description: "Root" }),
        step({ id: "B", description: "Left", dependsOn: ["A"] }),
        step({ id: "C", description: "Right", dependsOn: ["A"] }),
        step({ id: "D", description: "Join", dependsOn: ["B", "C"] }),
      ]);
      const out = renderMermaid(plan);
      const edges = visibleEdges(out);
      expect(edges).toContain(`${nodeId(plan, "A")} --> ${nodeId(plan, "B")}`);
      expect(edges).toContain(`${nodeId(plan, "A")} --> ${nodeId(plan, "C")}`);
      expect(edges).toContain(`${nodeId(plan, "B")} --> ${nodeId(plan, "D")}`);
      expect(edges).toContain(`${nodeId(plan, "C")} --> ${nodeId(plan, "D")}`);
      // The diamond has exactly four edges; nothing should be added or removed.
      expect(edges).toHaveLength(4);
      expect(out).not.toContain(`${nodeId(plan, "A")} --> ${nodeId(plan, "D")}`);
    });

    it("keeps independent dependency chains intact", () => {
      const plan = makePlan([
        step({ id: "a", description: "A" }),
        step({ id: "b", description: "B", dependsOn: ["a"] }),
        step({ id: "x", description: "X" }),
        step({ id: "y", description: "Y", dependsOn: ["x"] }),
      ]);
      const out = renderMermaid(plan);
      const edges = visibleEdges(out);
      expect(edges).toContain(`${nodeId(plan, "a")} --> ${nodeId(plan, "b")}`);
      expect(edges).toContain(`${nodeId(plan, "x")} --> ${nodeId(plan, "y")}`);
      expect(edges).toHaveLength(2);
    });

    it("keeps a shortcut edge that is NOT implied by another dependency", () => {
      // c depends only on a (not on b), so a->c is a genuine edge and stays.
      const plan = makePlan([
        step({ id: "a", description: "A" }),
        step({ id: "b", description: "B", dependsOn: ["a"] }),
        step({ id: "c", description: "C", dependsOn: ["a"] }),
      ]);
      const out = renderMermaid(plan);
      const edges = visibleEdges(out);
      expect(edges).toContain(`${nodeId(plan, "a")} --> ${nodeId(plan, "b")}`);
      expect(edges).toContain(`${nodeId(plan, "a")} --> ${nodeId(plan, "c")}`);
      expect(edges).toHaveLength(2);
    });

    it("realigns critical-path linkStyle indices after dropping a redundant edge", () => {
      // a->b->c->d critical chain plus a redundant a->d. After reduction the
      // emitted edges are a->b(0), b->c(1), c->d(2); all are on the critical path.
      const plan = makePlan([
        step({ id: "a", description: "A", durationMinutes: 1 }),
        step({ id: "b", description: "B", dependsOn: ["a"], durationMinutes: 1 }),
        step({ id: "c", description: "C", dependsOn: ["b"], durationMinutes: 1 }),
        step({ id: "d", description: "D", dependsOn: ["c", "a"], durationMinutes: 1 }),
      ]);
      const cpm = computeCpm(plan);
      const out = renderMermaid(plan, cpm);
      expect(visibleEdges(out)).toEqual([
        `${nodeId(plan, "a")} --> ${nodeId(plan, "b")}`,
        `${nodeId(plan, "b")} --> ${nodeId(plan, "c")}`,
        `${nodeId(plan, "c")} --> ${nodeId(plan, "d")}`,
      ]);
      expect(out).toContain("linkStyle 0 stroke:#718096,stroke-width:4px;");
      expect(out).toContain("linkStyle 1 stroke:#718096,stroke-width:4px;");
      expect(out).toContain("linkStyle 2 stroke:#718096,stroke-width:4px;");
      // No index 3 — the redundant fourth edge is gone.
      expect(out).not.toContain("linkStyle 3 stroke:#718096,stroke-width:4px;");
    });

    it("does not drop connecting edges on cyclic input (no cycle regression)", () => {
      // a <-> b mutual cycle, with c depending on both. Neither a->c nor b->c
      // may be removed: each "alternate path" loops back through the cycle.
      const plan = makePlan([
        step({ id: "a", description: "A", dependsOn: ["b"] }),
        step({ id: "b", description: "B", dependsOn: ["a"] }),
        step({ id: "c", description: "C", dependsOn: ["a", "b"] }),
      ]);
      const out = renderMermaid(plan);
      const edges = visibleEdges(out);
      expect(edges).toContain(`${nodeId(plan, "a")} --> ${nodeId(plan, "c")}`);
      expect(edges).toContain(`${nodeId(plan, "b")} --> ${nodeId(plan, "c")}`);
      expect(edges).toContain(`${nodeId(plan, "a")} --> ${nodeId(plan, "b")}`);
      expect(edges).toContain(`${nodeId(plan, "b")} --> ${nodeId(plan, "a")}`);
    });
  });
});
