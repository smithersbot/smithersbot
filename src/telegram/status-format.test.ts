import { describe, expect, it } from "vitest";

import { boldLabel, collapseBlankLines, formatStatusMessage } from "./status-format.js";

describe("status-format", () => {
  it("bolds the header", () => {
    expect(formatStatusMessage({ title: "Gateway status", lines: [] })).toBe("**Gateway status**");
  });

  it("bolds a label before a colon", () => {
    expect(boldLabel("PID", "43987")).toBe("**PID:** 43987");
  });

  it("collapses runs of double-or-more blank lines to one blank line", () => {
    expect(collapseBlankLines("Header\n\n\nRow\n\n\n\nNext")).toBe("Header\n\nRow\n\nNext");
  });

  it("renders a compact row on a single line", () => {
    const text = formatStatusMessage({
      title: "SmithersBot usage status",
      lines: [boldLabel("Codex", "current"), boldLabel("5-hour", "1% used, resets 5:00 PM")],
    });

    expect(text).toContain("**Codex:** current\n**5-hour:** 1% used, resets 5:00 PM");
    expect(text.split("\n")[1]).toBe("**Codex:** current");
  });
});
