import { describe, expect, it } from "vitest";
import {
  classifyProviderError,
  classifyUsageLimit,
  extractUsageLimitResetHint,
  isUsageLimitClassReason,
} from "./error-patterns.js";
import {
  describeUsageLimitEvent,
  formatResetSummary,
  formatUsageLimitExhaustedMessage,
  formatUsageLimitFallbackMessage,
  formatUsageLimitRecoveryMessage,
  type UsageLimitEvent,
} from "./usage-limit-message.js";

describe("classifyProviderError (existing consumers)", () => {
  it("classifies rate-limit text", () => {
    expect(classifyProviderError({ text: "API 429: too many requests" })).toBe("rate_limit");
    expect(classifyProviderError({ text: "You've hit your usage limit" })).toBe("rate_limit");
  });

  it("prefers credits when requested", () => {
    expect(
      classifyProviderError({ text: "insufficient funds, also rate limit", preferCredits: true }),
    ).toBe("out_of_credits");
  });

  it("returns undefined for unrelated text", () => {
    expect(classifyProviderError({ text: "syntax error in file" })).toBeUndefined();
  });
});

describe("classifyUsageLimit (backend attribution)", () => {
  it("attributes a Claude Code org/monthly limit to Claude Code, not generic", () => {
    const result = classifyUsageLimit({
      backend: "claude_code",
      text: "API 429: You've hit your org's monthly usage limit",
    });
    expect(result.backend).toBe("claude_code");
    expect(result.limitType).toBe("monthly_extra");
  });

  it("classifies a Claude Code 5-hour window", () => {
    const result = classifyUsageLimit({
      backend: "claude_code",
      text: "Claude usage limit reached for your 5-hour window. Resets at 3:00pm.",
    });
    expect(result.backend).toBe("claude_code");
    expect(result.limitType).toBe("five_hour");
    expect(result.resetHint).toBe("Resets at 3:00pm");
  });

  it("classifies a Claude Code weekly window", () => {
    const result = classifyUsageLimit({
      backend: "claude_code",
      text: "You've hit your weekly usage limit.",
    });
    expect(result.limitType).toBe("weekly");
  });

  it("attributes a Codex burst limit to Codex", () => {
    const result = classifyUsageLimit({
      backend: "codex",
      text: "Codex burst limit exceeded; slow down.",
    });
    expect(result.backend).toBe("codex");
    expect(result.limitType).toBe("burst");
  });

  it("falls back to unknown limit type when no hint is present", () => {
    const result = classifyUsageLimit({ backend: "codex", text: "Rate limited." });
    expect(result.limitType).toBe("unknown");
    expect(result.resetHint).toBeUndefined();
  });
});

describe("isUsageLimitClassReason", () => {
  it("treats out_of_credits, usage_limit, and rate_limit uniformly as usage-limit-class", () => {
    expect(isUsageLimitClassReason("out_of_credits")).toBe(true);
    expect(isUsageLimitClassReason("usage_limit")).toBe(true);
    expect(isUsageLimitClassReason("rate_limit")).toBe(true);
  });

  it("excludes auth and other non-usage-limit reasons", () => {
    expect(isUsageLimitClassReason("auth")).toBe(false);
    expect(isUsageLimitClassReason("user_input")).toBe(false);
    expect(isUsageLimitClassReason("process_lost")).toBe(false);
    expect(isUsageLimitClassReason("task_failed")).toBe(false);
    expect(isUsageLimitClassReason("error")).toBe(false);
    expect(isUsageLimitClassReason(undefined)).toBe(false);
    expect(isUsageLimitClassReason(null)).toBe(false);
  });
});

describe("extractUsageLimitResetHint", () => {
  it("extracts a reset-at phrase", () => {
    expect(extractUsageLimitResetHint("Limit reached. Resets at 9am tomorrow.")).toBe(
      "Resets at 9am tomorrow",
    );
  });

  it("extracts a resets-in phrase", () => {
    expect(extractUsageLimitResetHint("Try later — resets in 2 hours")).toBe("resets in 2 hours");
  });

  it("returns undefined when there is no reset hint", () => {
    expect(extractUsageLimitResetHint("usage limit hit")).toBeUndefined();
  });
});

describe("usage-limit message formatting", () => {
  it("describes an event with backend, limit type, and reset time", () => {
    const event: UsageLimitEvent = {
      backend: "claude_code",
      kind: "usage_limit",
      limitType: "five_hour",
      resetHint: "Resets at 3pm",
    };
    expect(describeUsageLimitEvent(event)).toBe(
      "Claude Code hit a usage limit (5-hour limit, resets at 3pm)",
    );
  });

  it("omits unknown limit type and missing reset time", () => {
    const event: UsageLimitEvent = {
      backend: "codex",
      kind: "rate_limit",
      limitType: "unknown",
    };
    expect(describeUsageLimitEvent(event)).toBe("Codex hit a rate limit");
  });

  it("renders fallback intent", () => {
    const event: UsageLimitEvent = {
      backend: "claude_code",
      kind: "usage_limit",
      limitType: "unknown",
      resetHint: "resets at 3pm",
    };
    expect(formatUsageLimitFallbackMessage({ event, fallbackBackend: "codex" })).toBe(
      "Claude Code hit a usage limit (resets at 3pm). Falling back to Codex.",
    );
  });

  it("renders recovery history after a successful fallback", () => {
    const event: UsageLimitEvent = {
      backend: "claude_code",
      kind: "usage_limit",
      limitType: "unknown",
      resetHint: "resets at 3pm",
    };
    expect(formatUsageLimitRecoveryMessage({ events: [event], succeededBackend: "codex" })).toBe(
      "Claude Code hit a usage limit (resets at 3pm). Fell back to Codex. Codex succeeded.",
    );
  });

  it("renders an exhausted message with reset times across backends", () => {
    const events: UsageLimitEvent[] = [
      {
        backend: "claude_code",
        kind: "usage_limit",
        limitType: "five_hour",
        resetHint: "resets at 3pm",
      },
      { backend: "codex", kind: "usage_limit", limitType: "weekly", resetHint: "resets Monday" },
    ];
    const message = formatUsageLimitExhaustedMessage({
      events,
      noFallbackReason: "the fallback backend already hit a usage or rate limit",
      originalQuestion: "Task blocked.",
    });
    expect(message).toContain("Claude Code hit a usage limit (5-hour limit, resets at 3pm).");
    expect(message).toContain("Codex hit a usage limit (weekly limit, resets Monday).");
    expect(message).toContain("No fallback backend was used because");
    expect(message).toContain("Reset times: Claude Code resets at 3pm; Codex resets Monday.");
    expect(message).toContain("Task blocked.");
  });

  it("omits the reset summary when no event carries a reset hint", () => {
    const events: UsageLimitEvent[] = [
      { backend: "codex", kind: "rate_limit", limitType: "unknown" },
    ];
    expect(formatResetSummary(events)).toBeUndefined();
  });
});
