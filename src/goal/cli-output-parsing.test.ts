import { describe, expect, it } from "vitest";

import {
  collapseWhitespace,
  collectText,
  extractCliTextAndSession,
  formatCliFailure,
  isRecord,
  parseCliJsonEvents,
  parseJsonLines,
  pickCliSessionId,
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

describe("parseCliJsonEvents", () => {
  it("parses JSONL, whole JSON arrays, and pretty JSON objects", () => {
    expect(parseCliJsonEvents('{"type":"system"}\n{"type":"assistant"}')).toHaveLength(2);
    expect(parseCliJsonEvents('[{"type":"system"},{"type":"assistant"}]')).toHaveLength(2);
    expect(parseCliJsonEvents('{\n  "type": "result",\n  "result": "ok"\n}')).toEqual([
      { type: "result", result: "ok" },
    ]);
  });
});

describe("pickCliSessionId", () => {
  it("accepts direct and camelCase transcript session fields", () => {
    expect(pickCliSessionId({ session_id: "snake" })).toBe("snake");
    expect(pickCliSessionId({ sessionId: "camel" })).toBe("camel");
  });

  it("accepts nested live transcript identity fields", () => {
    expect(pickCliSessionId({ session: { id: "nested" } })).toBe("nested");
    expect(pickCliSessionId({ thread: { threadId: "thread-camel" } })).toBe("thread-camel");
  });
});

describe("extractCliTextAndSession", () => {
  it("prefers final result text and latest live session id from transcript-derived stream JSON", () => {
    const raw = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "old-session" }),
      JSON.stringify({
        type: "assistant",
        sessionId: "live-session",
        message: { role: "assistant", content: [{ type: "text", text: "draft" }] },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "tool output should not become final text" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        session_id: "live-session",
        message: { role: "assistant", content: [{ type: "text", text: "final assistant" }] },
      }),
      JSON.stringify({
        type: "result",
        is_error: false,
        result: "final result",
        session_id: "live-session",
      }),
    ].join("\n");

    expect(extractCliTextAndSession(raw)).toEqual({
      text: "final result",
      sessionId: "live-session",
    });
  });

  it("falls back to assistant text when a transcript has no result envelope", () => {
    const raw = [
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "first" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "second" }] },
      }),
    ].join("\n");

    expect(extractCliTextAndSession(raw).text).toBe("second");
  });

  it("stringifies structured result payloads so JSON-only consumers can parse them", () => {
    const raw = JSON.stringify({
      type: "result",
      is_error: false,
      result: { approved: true },
      sessionId: "result-session",
    });

    expect(extractCliTextAndSession(raw)).toEqual({
      text: '{"approved":true}',
      sessionId: "result-session",
    });
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
