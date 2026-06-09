import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetClaudeBinaryCache,
  SCOUT_NEEDS_DECISION_FILE,
  classifyScoutError,
  parseScoutNeedsDecisionArtifact,
  renderScoutTemplate,
  resolveScoutDir,
  validateScoutOutput,
} from "./scout.js";
import { detectUsageLimitKind } from "./phase-fallback.js";

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

function sectionBetween(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(endMarker, start + startMarker.length);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

function expectComputerBasedCapabilityFraming(text: string): void {
  expect(text).toContain("full user-requested outcome");
  expect(text).toContain("broad, real-world, long-running");
  expect(text).toContain("not fully observable by SmithersBot");
  expect(text).toContain("Do not shrink");
  expect(text).toContain("only what SmithersBot can finish on a computer");
  expect(text).toContain(
    "computer-based work, including software, research, writing, analysis, automation, repo work, workflow automation, structured planning",
  );
}

function expectNoSoftwareOnlyLimitingFraming(text: string): void {
  expect(text).not.toMatch(
    /autonomous coding agent|coding-agent|coding agent|software-only|software only|software tasks|coding tasks/i,
  );
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

  it("carries full-Goal, first-Plan, and computer-based capability framing", () => {
    const template = fs.readFileSync(
      new URL("../prompts/scout/scout_prompt_template.md", import.meta.url),
      "utf8",
    );
    const rendered = renderScoutTemplate({
      template,
      goalId: "business-goal",
      goalText:
        "my goal is to start a business that makes $10m per year in revenue that I own the majority of",
      outputDir: "/tmp/scout",
      wikiDir: "/tmp/wiki",
    });

    const gateSection = sectionBetween(rendered, "## Needs Decision Gate", "## Goal Brief");
    const goalBriefSection = sectionBetween(rendered, "## Goal Brief", "## Required Output Files");

    expectComputerBasedCapabilityFraming(gateSection);
    expect(gateSection).toContain(
      "A Plan is bounded work SmithersBot can do now toward that Goal, stopping at an Observation Point.",
    );
    expect(gateSection).toContain("the first Plan toward the Goal");
    expect(gateSection).toContain("what the first Plan should do");
    expect(gateSection).toContain(
      "Only proceed to create a Plan when the goal is specific, measurable, and attainable; otherwise surface Decision(s) needed.",
    );
    expect(gateSection).toContain(
      "If a question can be answered by exploring the codebase, explore instead of asking.",
    );
    expect(gateSection).toContain(
      "Present all open Decisions in one message, each as multiple-choice with a recommended option.",
    );
    expect(gateSection).not.toContain("docs/goal-engine-guides/testing-guidance.md");
    expect(gateSection).not.toContain("docs/goal-engine-guides/diagnosis-guide.md");
    expect(gateSection).toContain(
      "time, market response, human action, external feedback, or real-world events",
    );
    expect(gateSection).toContain("preserve the full Goal");
    expectNoSoftwareOnlyLimitingFraming(gateSection);

    expect(goalBriefSection).toContain("Original User Ask");
    expect(goalBriefSection).toContain("First Plan Intent");
    expect(goalBriefSection).toContain(
      "separate the full Goal from the First Plan Intent and Observation Point",
    );
    expect(goalBriefSection).toContain("Original User Ask and Long Goal Summary preserve");
    expect(goalBriefSection).toContain("First Plan Intent describes only the bounded first Plan");
    expect(goalBriefSection).toContain(
      "First Plan Intent must explain what the first Plan should do",
    );
    expect(goalBriefSection).toContain("toward the full Goal");
    expectNoSoftwareOnlyLimitingFraming(goalBriefSection);
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

  it("returns needs_decision for a single decision artifact", () => {
    fs.writeFileSync(
      path.join(tmpDir, SCOUT_NEEDS_DECISION_FILE),
      JSON.stringify(
        {
          version: 1,
          decisions: [
            {
              id: "deployment-target",
              question: "Which deployment target should this use?",
              options: [
                { key: "A", label: "Staging", recommended: true },
                { key: "B", label: "Production" },
              ],
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    const result = validateScoutOutput(tmpDir);
    expect(result).toEqual({
      status: "needs_decision",
      decisions: [
        {
          id: "deployment-target",
          question: "Which deployment target should this use?",
          options: [
            { key: "A", label: "Staging", recommended: true },
            { key: "B", label: "Production" },
          ],
        },
      ],
    });
  });

  it("parses one or multiple decisions from the same decision artifact shape", () => {
    const singleDecision = parseScoutNeedsDecisionArtifact(
      JSON.stringify({
        version: 1,
        decisions: [
          {
            id: "ui-mode",
            question: "Which UI mode should be implemented?",
            options: [
              { key: "A", label: "Compact" },
              { key: "B", label: "Expanded", recommended: true },
            ],
          },
        ],
      }),
    );
    expect(singleDecision.decisions).toHaveLength(1);

    const multiDecision = parseScoutNeedsDecisionArtifact(
      JSON.stringify({
        version: 1,
        decisions: [
          {
            id: "ui-mode",
            question: "Which UI mode should be implemented?",
            options: [
              { key: "A", label: "Compact" },
              { key: "B", label: "Expanded", recommended: true },
            ],
          },
          {
            id: "test-scope",
            question: "Which tests should define success?",
            options: [
              { key: "A", label: "Focused tests", recommended: true },
              { key: "B", label: "Full suite" },
            ],
          },
        ],
      }),
    );
    expect(multiDecision.decisions.map((decision) => decision.id)).toEqual([
      "ui-mode",
      "test-scope",
    ]);
  });

  it("returns a clear validation error when decision JSON is malformed", () => {
    fs.writeFileSync(path.join(tmpDir, SCOUT_NEEDS_DECISION_FILE), "{ nope", "utf8");
    const result = validateScoutOutput(tmpDir);
    expect(result).toEqual({
      status: "error",
      error: `${SCOUT_NEEDS_DECISION_FILE} is not valid JSON`,
      errorKind: "validation",
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

  it("repairs scout_report.json with trailing extra brace", () => {
    writeValidScoutOutput(tmpDir, { goalId: "x", nodeIds: ["node-a"] });
    const reportPath = path.join(tmpDir, "scout_report.json");
    const report = fs.readFileSync(reportPath, "utf8");
    fs.writeFileSync(reportPath, `${report}}`, "utf8");

    const result = validateScoutOutput(tmpDir);
    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("Expected success");
    expect(result.report.goal_id).toBe("x");
    expect(result.report.nodes).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// Scout/planner error classification (drives the planner's claude->codex
// usage-limit fallback, which is exercised end-to-end in cli-planner.test.ts).
// ---------------------------------------------------------------------------

describe("classifyScoutError + usage-limit detection", () => {
  it("classifies an Anthropic usage-limit message as rate_limit and usage_limit", () => {
    const text = "Planning execution failed: You've hit your usage limit · resets 6pm";
    expect(classifyScoutError(text)).toBe("rate_limit");
    expect(detectUsageLimitKind(text)).toBe("usage_limit");
  });

  it("classifies a bare 429 as rate_limit and a transient rate limit", () => {
    const text = "HTTP 429 too many requests";
    expect(classifyScoutError(text)).toBe("rate_limit");
    expect(detectUsageLimitKind(text)).toBe("rate_limit");
  });

  it("classifies timeouts and unrelated errors away from usage limits", () => {
    expect(classifyScoutError("planner timed out")).toBe("timeout");
    expect(detectUsageLimitKind("planner timed out")).toBeUndefined();
    expect(classifyScoutError("some other failure")).toBe("other");
    expect(detectUsageLimitKind("some other failure")).toBeUndefined();
  });
});
