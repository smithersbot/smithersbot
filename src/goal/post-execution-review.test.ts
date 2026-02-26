import { describe, expect, it } from "vitest";

import {
  parsePostExecutionReviewDecision,
  parsePostExecutionReviewDecisionFromText,
} from "./post-execution-review.js";

describe("parsePostExecutionReviewDecisionFromText", () => {
  it("parses valid JSON decisions", () => {
    const decision = parsePostExecutionReviewDecisionFromText(
      '{"approved":true,"issues":["Looks good"]}',
    );

    expect(decision).toEqual({ approved: true, issues: ["Looks good"] });
  });

  it("repairs a trailing extra closing brace", () => {
    const decision = parsePostExecutionReviewDecisionFromText(
      '{"approved":false,"issues":["Missing tests"]}}',
    );

    expect(decision).toEqual({ approved: false, issues: ["Missing tests"] });
  });

  it("repairs malformed JSONL lines", () => {
    const decision = parsePostExecutionReviewDecisionFromText(
      ["status update", '{"approved":true,"issues":[]}}', "done"].join("\n"),
    );

    expect(decision).toEqual({ approved: true, issues: [] });
  });

  it("extracts and repairs prose-wrapped JSON candidates", () => {
    const decision = parsePostExecutionReviewDecisionFromText(
      'Decision: {"approved":false,"issues":["Handle ENOENT",],} please address.',
    );

    expect(decision).toEqual({ approved: false, issues: ["Handle ENOENT"] });
  });
});

describe("parsePostExecutionReviewDecision", () => {
  it("repairs malformed stream-json lines before parsing", () => {
    const stdout = [
      '{"type":"assistant","content":[{"text":"reviewing"}]}',
      '{"type":"result","result":{"approved":true,"issues":[]}}}',
    ].join("\n");

    const decision = parsePostExecutionReviewDecision(stdout);

    expect(decision).toEqual({ approved: true, issues: [] });
  });
});
