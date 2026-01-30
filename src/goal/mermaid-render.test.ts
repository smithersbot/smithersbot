import { describe, expect, it } from "vitest";
import { computeCpm } from "./cpm.js";
import { renderMermaid } from "./mermaid-render.js";
import type { Plan } from "./types.js";

function makePlan(steps: Plan["steps"]): Plan {
  return { goal: "test", summary: "Test plan", steps };
}

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
    expect(out).toContain("graph TD");
    expect(out).toContain('1["1. Create dir (mkdir)"]');
    expect(out).toContain('2["2. Write file (file_write)"]');
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
    expect(out).toContain("graph TD");
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
    expect(out).toContain("[3m]");
    expect(out).toContain("[5m]");
  });

  it("includes classDef critical line when CPM is provided", () => {
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
    expect(out).toContain("classDef critical stroke-width:3px;");
  });

  it("marks critical nodes with class lines", () => {
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
    expect(out).toContain("class A critical;");
    expect(out).toContain("class B critical;");
    expect(out).not.toContain("class C critical;");
  });
});
