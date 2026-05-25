import { describe, expect, it } from "vitest";

import { classifyUsageLimitEvent } from "./usage-limit-classifier.js";
import { describeUsageLimitEvent } from "./usage-limit-message.js";

describe("classifyUsageLimitEvent", () => {
  it("classifies a Claude usage limit with reset text", () => {
    const event = classifyUsageLimitEvent({
      backend: "claude_code",
      text: "Claude usage limit reached for your 5-hour window. Resets at 5:50 PM.",
    });

    expect(event).toEqual({
      backend: "claude_code",
      kind: "usage_limit",
      limitType: "five_hour",
      resetHint: "Resets at 5:50 PM",
    });
    expect(event ? describeUsageLimitEvent(event) : "").toBe(
      "Claude Code hit a usage limit (5-hour limit, resets at 5:50 PM)",
    );
  });

  it("classifies bare 429 text as a rate limit", () => {
    expect(
      classifyUsageLimitEvent({
        backend: "codex",
        text: "HTTP 429: too many requests",
      }),
    ).toEqual({
      backend: "codex",
      kind: "rate_limit",
      limitType: "unknown",
    });
  });

  it("extracts reset-at phrasing", () => {
    const event = classifyUsageLimitEvent({
      backend: "claude_code",
      text: "You've hit your weekly usage limit. Resets at 9am tomorrow.",
    });

    expect(event?.kind).toBe("usage_limit");
    expect(event?.limitType).toBe("weekly");
    expect(event?.resetHint).toBe("Resets at 9am tomorrow");
  });

  it("extracts reset-in phrasing", () => {
    const event = classifyUsageLimitEvent({
      backend: "claude_code",
      text: "You've hit your usage limit. Resets in 2 hours.",
    });

    expect(event?.kind).toBe("usage_limit");
    expect(event?.resetHint).toBe("Resets in 2 hours");
  });

  it("extracts reset-on phrasing", () => {
    const event = classifyUsageLimitEvent({
      backend: "codex",
      text: "Codex weekly limit reached. Resets on Monday.",
    });

    expect(event?.backend).toBe("codex");
    expect(event?.kind).toBe("usage_limit");
    expect(event?.limitType).toBe("weekly");
    expect(event?.resetHint).toBe("Resets on Monday");
  });

  it("returns undefined for unrelated timeout text", () => {
    expect(
      classifyUsageLimitEvent({
        backend: "claude_code",
        text: "refresh timed out waiting for statusline cache",
      }),
    ).toBeUndefined();
  });

  it("returns undefined for ENOENT and binary-missing text", () => {
    expect(
      classifyUsageLimitEvent({
        backend: "claude_code",
        text: "spawn claude ENOENT",
      }),
    ).toBeUndefined();
    expect(
      classifyUsageLimitEvent({
        backend: "codex",
        text: "codex: command not found",
      }),
    ).toBeUndefined();
  });

  it("returns undefined for auth-missing text", () => {
    expect(
      classifyUsageLimitEvent({
        backend: "claude_code",
        text: "Authentication required. Please log in to continue.",
      }),
    ).toBeUndefined();
    expect(
      classifyUsageLimitEvent({
        backend: "codex",
        text: "401 unauthorized: invalid API key",
      }),
    ).toBeUndefined();
  });
});
