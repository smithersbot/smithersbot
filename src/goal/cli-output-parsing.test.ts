import { describe, expect, it } from "vitest";

import {
  collapseWhitespace,
  collectText,
  formatCliFailure,
  isRecord,
  parseJsonLines,
} from "./cli-output-parsing.js";

describe("isRecord", () => {
  it("returns true only for plain objects", () => {
    expect(isRecord({ ok: true })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(["x"])).toBe(false);
    expect(isRecord("x")).toBe(false);
  });
});

describe("collectText", () => {
  it("collects nested text from common response envelopes", () => {
    const value = {
      message: {
        delta: {
          item: {
            content: ["hello ", { text: "world" }],
          },
        },
      },
    };

    expect(collectText(value)).toBe("hello world");
  });

  it("supports result as either string or nested object", () => {
    expect(collectText({ result: "direct-result" })).toBe("direct-result");
    expect(collectText({ result: { text: "nested-result" } })).toBe("nested-result");
  });

  it("returns empty for unsupported values", () => {
    expect(collectText(42)).toBe("");
    expect(collectText(undefined)).toBe("");
  });
});

describe("collapseWhitespace", () => {
  it("normalizes whitespace and trims", () => {
    expect(collapseWhitespace(" line one\n\tline two  ")).toBe("line one line two");
  });

  it("returns empty string for non-string input", () => {
    expect(collapseWhitespace({ text: "nope" })).toBe("");
  });
});

describe("parseJsonLines", () => {
  it("parses line-delimited objects and repairs malformed JSON lines", () => {
    const raw = [
      "not json",
      '{"ok":true}',
      '{"broken":{"a":1,}}',
      '{"extra":true}}',
      '["ignored-array"]',
      "42",
    ].join("\n");

    expect(parseJsonLines(raw)).toEqual([{ ok: true }, { broken: { a: 1 } }, { extra: true }]);
  });

  it("ignores lines that do not decode to objects", () => {
    const raw = ['{"object":1}', "null", "[]", '"text"', "true"].join("\n");
    expect(parseJsonLines(raw)).toEqual([{ object: 1 }]);
  });
});

describe("formatCliFailure", () => {
  it("prefers stderr, collapses whitespace, and truncates to 260 chars", () => {
    expect(formatCliFailure("stdout fallback", " stderr\n detail \t", null)).toBe("stderr detail");

    const long = "x".repeat(500);
    expect(formatCliFailure(long, "", null)).toHaveLength(260);
  });

  it("falls back to signal or unknown message when output is empty", () => {
    expect(formatCliFailure("", "", "SIGTERM")).toBe("terminated by SIGTERM");
    expect(formatCliFailure("", "", null)).toBe("unknown CLI error");
  });
});
