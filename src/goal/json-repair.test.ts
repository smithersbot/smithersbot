import { describe, expect, it } from "vitest";

import { extractJsonObjectCandidates, repairJsonText, repairTruncatedJson } from "./json-repair.js";

describe("extractJsonObjectCandidates", () => {
  it("extracts brace-balanced JSON objects from mixed prose", () => {
    const text = [
      "intro text",
      '{"approved":true}}',
      "between",
      '{"plan":{"steps":[{"id":"1"}]}}',
      "tail",
    ].join("\n");

    expect(extractJsonObjectCandidates(text)).toEqual([
      '{"approved":true}',
      '{"plan":{"steps":[{"id":"1"}]}}',
    ]);
  });

  it("ignores braces inside JSON strings", () => {
    const text = '{"message":"literal { brace } text","approved":true}}';
    expect(extractJsonObjectCandidates(text)).toEqual([
      '{"message":"literal { brace } text","approved":true}',
    ]);
  });
});

describe("repairJsonText", () => {
  it("repairs a single trailing closing brace", () => {
    const repaired = repairJsonText('{"approved":true}}');
    expect(repaired).toBe('{"approved":true}');
    expect(JSON.parse(repaired)).toEqual({ approved: true });
  });

  it("repairs multiple trailing closing braces", () => {
    const repaired = repairJsonText('{"approved":false,"editInstructions":"Add tests"}}}');
    expect(repaired).toBe('{"approved":false,"editInstructions":"Add tests"}');
    expect(JSON.parse(repaired)).toEqual({ approved: false, editInstructions: "Add tests" });
  });

  it("repairs trailing commas before object/array closers", () => {
    const repaired = repairJsonText('{"items":[1,2,],"meta":{"ok":true,},}');
    expect(repaired).toBe('{"items":[1,2],"meta":{"ok":true}}');
    expect(JSON.parse(repaired)).toEqual({ items: [1, 2], meta: { ok: true } });
  });

  it("extracts and repairs JSON from prose preamble", () => {
    const repaired = repairJsonText(
      'Decision:\n{"approved":false,"editInstructions":"Add verification"}}\nThanks.',
    );

    expect(repaired).toBe('{"approved":false,"editInstructions":"Add verification"}');
    expect(JSON.parse(repaired)).toEqual({
      approved: false,
      editInstructions: "Add verification",
    });
  });

  it("extracts and repairs JSON from markdown code fences", () => {
    const repaired = repairJsonText(
      ["```json", '{"approved":false,"issues":["missing tests",],}', "```"].join("\n"),
    );

    expect(repaired).toBe('{"approved":false,"issues":["missing tests"]}');
    expect(JSON.parse(repaired)).toEqual({ approved: false, issues: ["missing tests"] });
  });

  it("passes through valid JSON unchanged", () => {
    const valid = '  {"approved":true,"issues":[]}\n';
    expect(repairJsonText(valid)).toBe(valid);
  });

  it("repairs nested JSON with trailing comma and extra brace", () => {
    const repaired = repairJsonText(
      '{"plan":{"summary":"Ship feature","steps":[{"id":"1","description":"Implement",}]}}}',
    );

    expect(repaired).toBe(
      '{"plan":{"summary":"Ship feature","steps":[{"id":"1","description":"Implement"}]}}',
    );
    expect(JSON.parse(repaired)).toEqual({
      plan: {
        summary: "Ship feature",
        steps: [{ id: "1", description: "Implement" }],
      },
    });
  });

  it("returns empty input unchanged", () => {
    expect(repairJsonText("")).toBe("");
    expect(repairJsonText("   \n\t")).toBe("   \n\t");
  });

  it("repairs a real-world plan payload with an extra trailing brace", () => {
    const raw = [
      "Planner output:",
      '{"goal":"Ship feature","summary":"Implement and verify","steps":[{"id":"step-1","description":"Audit current flow","dependsOn":[],"status":"pending","durationMinutes":15,"backend":"codex"},{"id":"step-2","description":"Add repair fallback","dependsOn":["step-1"],"status":"pending","durationMinutes":20,"backend":"claude_code"}]}}',
    ].join("\n");

    const repaired = repairJsonText(raw);
    const parsed = JSON.parse(repaired) as {
      goal: string;
      summary: string;
      steps: Array<{ id: string; backend: string }>;
    };

    expect(parsed.goal).toBe("Ship feature");
    expect(parsed.summary).toBe("Implement and verify");
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[0]?.id).toBe("step-1");
    expect(parsed.steps[1]?.backend).toBe("claude_code");
  });

  it("repairs truncated JSON via final fallback", () => {
    const repaired = repairJsonText(
      '{"tests":[{"description":"first"},{"description":"second","detail":"part',
    );

    expect(repaired).toBe('{"tests":[{"description":"first"},{"description":"second"}]}');
    expect(JSON.parse(repaired)).toEqual({
      tests: [{ description: "first" }, { description: "second" }],
    });
  });
});

describe("repairTruncatedJson", () => {
  it("repairs JSON truncated mid-string value", () => {
    const repaired = repairTruncatedJson(
      '{"tests":[{"description":"first"},{"description":"second","detail":"part',
    );

    expect(repaired).toBe('{"tests":[{"description":"first"},{"description":"second"}]}');
    expect(JSON.parse(repaired)).toEqual({
      tests: [{ description: "first" }, { description: "second" }],
    });
  });

  it("repairs JSON truncated mid-array with a partial trailing element", () => {
    const repaired = repairTruncatedJson('{"tests":[{"id":"1"},{"id":"2"},{"id":"3');

    expect(repaired).toBe('{"tests":[{"id":"1"},{"id":"2"}]}');
    expect(JSON.parse(repaired)).toEqual({
      tests: [{ id: "1" }, { id: "2" }],
    });
  });

  it("repairs truncated JSON with missing closing braces", () => {
    const repaired = repairTruncatedJson('{"plan":{"steps":[{"id":"1"},{"id":"2"}]');

    expect(repaired).toBe('{"plan":{"steps":[{"id":"1"},{"id":"2"}]}}');
    expect(JSON.parse(repaired)).toEqual({
      plan: { steps: [{ id: "1" }, { id: "2" }] },
    });
  });

  it("returns already-valid JSON unchanged", () => {
    const valid = '{"approved":true,"issues":[]}';
    expect(repairTruncatedJson(valid)).toBe(valid);
  });
});
