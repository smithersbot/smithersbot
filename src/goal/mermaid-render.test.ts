import { describe, expect, it } from "vitest";
import { computeCpm } from "./cpm.js";
import type { ExecutionDisplayStatus } from "./execution-status.js";
import { normalizeLabel, renderMermaid, topologicalSort } from "./mermaid-render.js";
import type { Plan, PlanStep } from "./types.js";

function makePlan(steps: Plan["steps"]): Plan {
  return { goal: "test", summary: "Test plan", steps };
}

function step(overrides: Partial<PlanStep> & { id: string }): PlanStep {
  return {
    description: `Step ${overrides.id}`,
    dependsOn: [],
    tool: { name: "mkdir", args: {} },
    status: "pending",
    ...overrides,
  };
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

describe("topologicalSort", () => {
  it("sorts a linear chain", () => {
    const steps = [
      step({ id: "1" }),
      step({ id: "2", dependsOn: ["1"] }),
      step({ id: "3", dependsOn: ["2"] }),
    ];
    expect(topologicalSort(steps)).toEqual(["1", "2", "3"]);
  });

  it("handles independent roots in input order", () => {
    const steps = [step({ id: "a" }), step({ id: "b" }), step({ id: "c" })];
    expect(topologicalSort(steps)).toEqual(["a", "b", "c"]);
  });

  it("handles diamond graph", () => {
    const steps = [
      step({ id: "A" }),
      step({ id: "B", dependsOn: ["A"] }),
      step({ id: "C", dependsOn: ["A"] }),
      step({ id: "D", dependsOn: ["B", "C"] }),
    ];
    expect(topologicalSort(steps)).toEqual(["A", "B", "C", "D"]);
  });

  it("produces correct numbering with out-of-order input", () => {
    // Steps provided out of dependency order
    const steps = [
      step({ id: "D", dependsOn: ["B", "C"] }),
      step({ id: "B", dependsOn: ["A"] }),
      step({ id: "A" }),
      step({ id: "C", dependsOn: ["A"] }),
    ];
    const sorted = topologicalSort(steps);
    // A must come first; B and C after A; D last
    expect(sorted.indexOf("A")).toBe(0);
    expect(sorted.indexOf("D")).toBe(3);
    expect(sorted.indexOf("B")).toBeLessThan(sorted.indexOf("D"));
    expect(sorted.indexOf("C")).toBeLessThan(sorted.indexOf("D"));
  });

  it("emits labels 1., 2., 3. in topo order for out-of-order input", () => {
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
        tool: { name: "mkdir", args: { path: "d" } },
        status: "pending",
      },
      {
        id: "2",
        description: "Write file",
        dependsOn: ["1"],
        tool: { name: "file_write", args: {} },
        status: "pending",
      },
      {
        id: "3",
        description: "Stage",
        dependsOn: ["2"],
        tool: { name: "git_add", args: {} },
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

  it("renders independent roots with no edges", () => {
    const plan = makePlan([
      {
        id: "a",
        description: "Task A",
        dependsOn: [],
        tool: { name: "mkdir", args: {} },
        status: "pending",
      },
      {
        id: "b",
        description: "Task B",
        dependsOn: [],
        tool: { name: "mkdir", args: {} },
        status: "pending",
      },
    ]);

    const out = renderMermaid(plan);
    expect(out).toContain("flowchart TD");
    expect(out).not.toContain("-->");
  });

  it("renders a diamond dependency pattern", () => {
    const plan = makePlan([
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
        tool: { name: "mkdir", args: {} },
        status: "pending",
      },
      {
        id: "C",
        description: "Right",
        dependsOn: ["A"],
        tool: { name: "mkdir", args: {} },
        status: "pending",
      },
      {
        id: "D",
        description: "Join",
        dependsOn: ["B", "C"],
        tool: { name: "mkdir", args: {} },
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
        tool: { name: "file_write", args: {} },
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
        tool: { name: "file_write", args: {} },
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
        tool: { name: "mkdir", args: {} },
        status: "pending",
        durationMinutes: 3,
      },
      {
        id: "2",
        description: "Write file",
        dependsOn: ["1"],
        tool: { name: "file_write", args: {} },
        status: "pending",
        durationMinutes: 5,
      },
    ]);
    const cpm = computeCpm(plan);
    const out = renderMermaid(plan, cpm);
    expect(out).toContain("~3 min");
    expect(out).toContain("~5 min");
  });

  it("uses linkStyle for critical path instead of classDef critical", () => {
    const plan = makePlan([
      {
        id: "A",
        description: "Root",
        dependsOn: [],
        tool: { name: "mkdir", args: {} },
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
        tool: { name: "mkdir", args: {} },
        status: "pending",
        durationMinutes: 2,
      },
      {
        id: "B",
        description: "Long path",
        dependsOn: ["A"],
        tool: { name: "mkdir", args: {} },
        status: "pending",
        durationMinutes: 3,
      },
      {
        id: "C",
        description: "Short path",
        dependsOn: ["A"],
        tool: { name: "mkdir", args: {} },
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
        tool: { name: "mkdir", args: {} },
        status: "pending",
        durationMinutes: 1,
      },
      {
        id: "B",
        description: "Left",
        dependsOn: ["A"],
        tool: { name: "mkdir", args: {} },
        status: "pending",
        durationMinutes: 1,
      },
      {
        id: "C",
        description: "Right",
        dependsOn: ["A"],
        tool: { name: "mkdir", args: {} },
        status: "pending",
        durationMinutes: 1,
      },
      {
        id: "D",
        description: "Join",
        dependsOn: ["B", "C"],
        tool: { name: "mkdir", args: {} },
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
    // Topo order: A=1, B=4 (deps:A, processed after all roots), C=2, D=3
    // Wait — let me trace through: roots sorted by index = A(0), C(2), D(3).
    // Process A → B's in-degree drops to 0, queued. Queue now: [C, D, B].
    // Sort by original index: B(idx=1), C(idx=2), D(idx=3) → process B first.
    // So topo: A=1, B=2, C=3, D=4.
    const statusPlan = makePlan([
      {
        id: "A",
        description: "Done step",
        dependsOn: [],
        tool: { name: "mkdir", args: {} },
        status: "done",
      },
      {
        id: "B",
        description: "Blocked step",
        dependsOn: ["A"],
        tool: { name: "mkdir", args: {} },
        status: "blocked",
        blockedQuestion: "q",
      },
      {
        id: "C",
        description: "Pending step",
        dependsOn: [],
        tool: { name: "mkdir", args: {} },
        status: "pending",
      },
      {
        id: "D",
        description: "In-progress step",
        dependsOn: [],
        tool: { name: "mkdir", args: {} },
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
      expect(out).toContain("classDef inprog fill:#1F2937");
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
      expect(out).not.toContain("🏃");
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
      expect(out).toContain("🏃 4.");
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
          tool: { name: "mkdir", args: {} },
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
  });

  it("uses topo-sorted numbering even with out-of-order step IDs", () => {
    // Steps in reverse order in the array, but deps create: Z→Y→X
    const plan = makePlan([
      {
        id: "X",
        description: "Last task",
        dependsOn: ["Y"],
        tool: { name: "mkdir", args: {} },
        status: "pending",
      },
      {
        id: "Y",
        description: "Middle task",
        dependsOn: ["Z"],
        tool: { name: "mkdir", args: {} },
        status: "pending",
      },
      {
        id: "Z",
        description: "First task",
        dependsOn: [],
        tool: { name: "mkdir", args: {} },
        status: "pending",
      },
    ]);
    const out = renderMermaid(plan);
    // Z should be #1 (root), Y #2, X #3 in topo order
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
        tool: { name: "mkdir", args: {} },
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
        tool: { name: "mkdir", args: {} },
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
        tool: { name: "mkdir", args: {} },
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
        tool: { name: "mkdir", args: {} },
        status: "pending",
      },
    ]);
    const out = renderMermaid(plan);
    expect(out).toMatch(/fontFamily.*serif"/);
  });
});
