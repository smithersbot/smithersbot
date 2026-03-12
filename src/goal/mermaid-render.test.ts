import { describe, expect, it } from "vitest";
import { computeCpm } from "./cpm.js";
import type { ExecutionDisplayStatus } from "./execution-status.js";
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

function expectedNodeDeclarations(plan: Plan): string[] {
  const stepById = new Map(plan.steps.map((step) => [step.id, step]));
  return orderedStepIds(plan).map((stepId, index) => {
    const orderedStep = stepById.get(stepId);
    expect(orderedStep).toBeDefined();
    return `  ${stepId}["${index + 1}. ${orderedStep!.shortSummary}"]`;
  });
}

function expectedInvisibleEdges(plan: Plan): string[] {
  const order = orderedStepIds(plan);
  return order.slice(0, -1).map((stepId, index) => `  ${stepId} ~~~ ${order[index + 1]}`);
}

function nodeDeclarations(out: string): string[] {
  return out.split("\n").filter((line) => /^\s+\S+\["/.test(line));
}

function invisibleEdges(out: string): string[] {
  return out.split("\n").filter((line) => line.includes("~~~"));
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
    expect(out).toContain('A["1. First"]');
    expect(out).toContain('B["2. Second"]');
    expect(out).toContain('C["3. Third"]');
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
    expect(out).toContain("1 --> 2");
    expect(out).toContain("2 --> 3");
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
    expect(out).toContain('1["1. ');
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
    expect(out).toContain('1["1. Readable task label"]');
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
    expect(out).toContain("A --> B");
    expect(out).toContain("A --> C");
    expect(out).toContain("B --> D");
    expect(out).toContain("C --> D");
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
      expect(out).toContain("class A done;");
      expect(out).toContain("class B blocked;");
      expect(out).toContain("class C waiting;");
      expect(out).toContain("class D inprog;");
    });

    it("uses done class directly for done status", () => {
      const statuses = new Map<string, ExecutionDisplayStatus>([["A", "done"]]);
      const out = renderMermaid(statusPlan, undefined, statuses);
      expect(out).toContain("class A done;");
    });

    it("assigns pending class to all nodes when displayStatuses is omitted (plan mode: no emojis)", () => {
      const out = renderMermaid(statusPlan);
      // All nodes get pending class by default
      expect(out).toContain("class A pending;");
      expect(out).toContain("class B pending;");
      expect(out).toContain("class C pending;");
      expect(out).toContain("class D pending;");
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
      expect(out).toContain("class C waiting;");
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
      expect(out).toContain("class X done;");
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
    expect(out).toContain('Z["1. First task"]');
    expect(out).toContain('Y["2. Middle task"]');
    expect(out).toContain('X["3. Last task"]');
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
});
