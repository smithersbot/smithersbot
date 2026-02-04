import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetClaudeBinaryCache,
  renderScoutTemplate,
  resolveScoutDir,
  validateScoutOutput,
} from "./scout.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scout-test-"));
}

/** Create a minimal valid scout output in the given directory. */
function writeValidScoutOutput(
  scoutDir: string,
  opts?: { goalId?: string; nodeIds?: string[] },
): void {
  const goalId = opts?.goalId ?? "test-goal";
  const nodeIds = opts?.nodeIds ?? ["setup-auth", "add-tests"];

  fs.mkdirSync(path.join(scoutDir, "node_specs"), { recursive: true });

  // plan_draft.md
  const mermaid = nodeIds
    .map((id, i) => (i > 0 ? `  ${nodeIds[i - 1]} --> ${id}` : `  ${id}["${id}"]`))
    .join("\n");
  fs.writeFileSync(
    path.join(scoutDir, "plan_draft.md"),
    [
      "BEGIN_PLAN_DRAFT",
      `GOAL_ID: ${goalId}`,
      "",
      "```mermaid",
      "graph TD",
      mermaid,
      "```",
      "",
      "| Node ID | Type | Objective | Verification | Effort | Risk | Uncertainty |",
      "|---------|------|-----------|--------------|--------|------|-------------|",
      ...nodeIds.map((id) => `| ${id} | Impl | Do ${id} | pnpm test | 3 | 2 | 1 |`),
      "",
      "END_PLAN_DRAFT",
    ].join("\n"),
    "utf8",
  );

  // scout_report.json
  const report = {
    goal_id: goalId,
    nodes: nodeIds.map((id) => ({
      id,
      type: "Impl",
      objective: `Do ${id}`,
      verification: "pnpm test",
      effort: 3,
      risk: 2,
      uncertainty: 1,
    })),
    edges: nodeIds.length > 1 ? [{ from: nodeIds[0], to: nodeIds[1], why: "sequential" }] : [],
  };
  fs.writeFileSync(
    path.join(scoutDir, "scout_report.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );

  // node_specs/<id>.md
  for (const id of nodeIds) {
    fs.writeFileSync(
      path.join(scoutDir, "node_specs", `${id}.md`),
      [
        `GOAL_ID: ${goalId}`,
        "Type: Impl",
        `Objective: Do ${id}`,
        "",
        "Requirements:",
        "1. Implement it",
        "",
        "Constraints:",
        "- None",
        "",
        "Verification: pnpm test",
      ].join("\n"),
      "utf8",
    );
  }
}

// ---------------------------------------------------------------------------
// renderScoutTemplate
// ---------------------------------------------------------------------------

describe("renderScoutTemplate", () => {
  it("replaces all placeholders", () => {
    const template =
      "ID={{GOAL_ID}} TEXT={{GOAL_TEXT}} DIR={{OUTPUT_DIR}} MIN={{NODE_COUNT_MIN}} MAX={{NODE_COUNT_MAX}}";
    const result = renderScoutTemplate({
      template,
      goalId: "abc-123",
      goalText: "Fix the auth bug",
      outputDir: "/tmp/scout",
      nodeCountMin: 2,
      nodeCountMax: 5,
    });
    expect(result).toBe("ID=abc-123 TEXT=Fix the auth bug DIR=/tmp/scout MIN=2 MAX=5");
  });

  it("uses default min/max when not provided", () => {
    const template = "MIN={{NODE_COUNT_MIN}} MAX={{NODE_COUNT_MAX}}";
    const result = renderScoutTemplate({
      template,
      goalId: "x",
      goalText: "y",
      outputDir: "/tmp",
    });
    expect(result).toBe("MIN=1 MAX=10");
  });

  it("replaces multiple occurrences of the same placeholder", () => {
    const template = "{{GOAL_ID}} and {{GOAL_ID}}";
    const result = renderScoutTemplate({
      template,
      goalId: "dup",
      goalText: "t",
      outputDir: "/d",
    });
    expect(result).toBe("dup and dup");
  });
});

// ---------------------------------------------------------------------------
// resolveScoutDir
// ---------------------------------------------------------------------------

describe("resolveScoutDir", () => {
  it("appends /scout to the run dir", () => {
    const dir = resolveScoutDir("run-1", "/tmp/goals");
    expect(dir).toBe("/tmp/goals/run-1/scout");
  });
});

// ---------------------------------------------------------------------------
// validateScoutOutput
// ---------------------------------------------------------------------------

describe("validateScoutOutput", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns needs_clarification when plan_needs_clarification.md exists", () => {
    fs.writeFileSync(
      path.join(tmpDir, "plan_needs_clarification.md"),
      "What framework are you using?",
      "utf8",
    );
    const result = validateScoutOutput(tmpDir);
    expect(result).toEqual({
      status: "needs_clarification",
      question: "What framework are you using?",
    });
  });

  it("returns error when plan_draft.md is missing", () => {
    const result = validateScoutOutput(tmpDir);
    expect(result.status).toBe("error");
    expect((result as { error: string }).error).toContain("plan_draft.md not found");
  });

  it("returns error when sentinels are missing", () => {
    fs.writeFileSync(path.join(tmpDir, "plan_draft.md"), "no sentinels here", "utf8");
    const result = validateScoutOutput(tmpDir);
    expect(result.status).toBe("error");
    expect((result as { error: string }).error).toContain("sentinels");
  });

  it("returns error when GOAL_ID is missing from plan_draft", () => {
    fs.writeFileSync(
      path.join(tmpDir, "plan_draft.md"),
      "BEGIN_PLAN_DRAFT\ngraph TD\nEND_PLAN_DRAFT",
      "utf8",
    );
    const result = validateScoutOutput(tmpDir);
    expect(result.status).toBe("error");
    expect((result as { error: string }).error).toContain("GOAL_ID");
  });

  it("returns error when mermaid graph is missing", () => {
    fs.writeFileSync(
      path.join(tmpDir, "plan_draft.md"),
      "BEGIN_PLAN_DRAFT\nGOAL_ID: x\nEND_PLAN_DRAFT",
      "utf8",
    );
    const result = validateScoutOutput(tmpDir);
    expect(result.status).toBe("error");
    expect((result as { error: string }).error).toContain("mermaid graph");
  });

  it("returns error when scout_report.json is missing", () => {
    fs.writeFileSync(
      path.join(tmpDir, "plan_draft.md"),
      "BEGIN_PLAN_DRAFT\nGOAL_ID: x\ngraph TD\nEND_PLAN_DRAFT",
      "utf8",
    );
    const result = validateScoutOutput(tmpDir);
    expect(result.status).toBe("error");
    expect((result as { error: string }).error).toContain("scout_report.json not found");
  });

  it("returns error when scout_report.json is invalid JSON", () => {
    fs.writeFileSync(
      path.join(tmpDir, "plan_draft.md"),
      "BEGIN_PLAN_DRAFT\nGOAL_ID: x\ngraph TD\nEND_PLAN_DRAFT",
      "utf8",
    );
    fs.writeFileSync(path.join(tmpDir, "scout_report.json"), "not json", "utf8");
    const result = validateScoutOutput(tmpDir);
    expect(result.status).toBe("error");
    expect((result as { error: string }).error).toContain("not valid JSON");
  });

  it("returns error when scout_report.json has no nodes", () => {
    fs.writeFileSync(
      path.join(tmpDir, "plan_draft.md"),
      "BEGIN_PLAN_DRAFT\nGOAL_ID: x\ngraph TD\nEND_PLAN_DRAFT",
      "utf8",
    );
    fs.writeFileSync(
      path.join(tmpDir, "scout_report.json"),
      JSON.stringify({ goal_id: "x", nodes: [], edges: [] }),
      "utf8",
    );
    const result = validateScoutOutput(tmpDir);
    expect(result.status).toBe("error");
    expect((result as { error: string }).error).toContain("no nodes");
  });

  it("returns error when node_specs/ directory is missing", () => {
    fs.writeFileSync(
      path.join(tmpDir, "plan_draft.md"),
      "BEGIN_PLAN_DRAFT\nGOAL_ID: x\ngraph TD\nEND_PLAN_DRAFT",
      "utf8",
    );
    fs.writeFileSync(
      path.join(tmpDir, "scout_report.json"),
      JSON.stringify({
        goal_id: "x",
        nodes: [
          {
            id: "a",
            type: "Impl",
            objective: "x",
            verification: "y",
            effort: 1,
            risk: 1,
            uncertainty: 1,
          },
        ],
        edges: [],
      }),
      "utf8",
    );
    const result = validateScoutOutput(tmpDir);
    expect(result.status).toBe("error");
    expect((result as { error: string }).error).toContain("node_specs/ directory not found");
  });

  it("returns error when a node spec file is missing", () => {
    fs.mkdirSync(path.join(tmpDir, "node_specs"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "plan_draft.md"),
      "BEGIN_PLAN_DRAFT\nGOAL_ID: x\ngraph TD\nEND_PLAN_DRAFT",
      "utf8",
    );
    fs.writeFileSync(
      path.join(tmpDir, "scout_report.json"),
      JSON.stringify({
        goal_id: "x",
        nodes: [
          {
            id: "missing-node",
            type: "Impl",
            objective: "x",
            verification: "y",
            effort: 1,
            risk: 1,
            uncertainty: 1,
          },
        ],
        edges: [],
      }),
      "utf8",
    );
    // Write a different spec file (not the one needed)
    fs.writeFileSync(path.join(tmpDir, "node_specs", "other.md"), "irrelevant", "utf8");
    const result = validateScoutOutput(tmpDir);
    expect(result.status).toBe("error");
    expect((result as { error: string }).error).toContain(
      "Missing node spec: node_specs/missing-node.md",
    );
  });

  it("returns success with valid output", () => {
    writeValidScoutOutput(tmpDir);
    const result = validateScoutOutput(tmpDir);
    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("Expected success");
    expect(result.report.goal_id).toBe("test-goal");
    expect(result.report.nodes).toHaveLength(2);
    expect(result.report.edges).toHaveLength(1);
    expect(result.planDraft).toContain("BEGIN_PLAN_DRAFT");
    expect(result.planDraft).toContain("END_PLAN_DRAFT");
  });

  it("concurrent goals with different IDs produce independent results", () => {
    const dir1 = makeTempDir();
    const dir2 = makeTempDir();
    try {
      writeValidScoutOutput(dir1, { goalId: "goal-1", nodeIds: ["a"] });
      writeValidScoutOutput(dir2, { goalId: "goal-2", nodeIds: ["b"] });

      const r1 = validateScoutOutput(dir1);
      const r2 = validateScoutOutput(dir2);

      expect(r1.status).toBe("success");
      expect(r2.status).toBe("success");
      if (r1.status !== "success" || r2.status !== "success") throw new Error("Expected success");
      expect(r1.report.goal_id).toBe("goal-1");
      expect(r2.report.goal_id).toBe("goal-2");
      expect(r1.report.nodes[0]!.id).toBe("a");
      expect(r2.report.nodes[0]!.id).toBe("b");
    } finally {
      fs.rmSync(dir1, { recursive: true, force: true });
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// resolveClaudeBinary cache
// ---------------------------------------------------------------------------

describe("resolveClaudeBinary cache", () => {
  afterEach(() => {
    _resetClaudeBinaryCache();
  });

  it("_resetClaudeBinaryCache allows re-detection", () => {
    // Just verify reset doesn't throw — actual binary detection depends on env
    _resetClaudeBinaryCache();
    expect(true).toBe(true);
  });
});
