import { describe, expect, it, vi } from "vitest";

import { detectUsageLimitKind, runWithBackendFallback } from "./phase-fallback.js";
import type { CliWorkerId } from "../config/types.goal.js";

describe("detectUsageLimitKind", () => {
  it("classifies an explicit usage/monthly cap as a usage limit", () => {
    expect(
      detectUsageLimitKind("API 429: You've hit your org's monthly usage limit. Resets at 3pm."),
    ).toBe("usage_limit");
  });

  it("classifies a weekly cap as a usage limit", () => {
    expect(detectUsageLimitKind("Codex weekly limit reached. Resets on Monday.")).toBe(
      "usage_limit",
    );
  });

  it("classifies a bare 429 / overloaded as a transient rate limit", () => {
    expect(detectUsageLimitKind("HTTP 429 too many requests")).toBe("rate_limit");
    expect(detectUsageLimitKind("overloaded, please retry")).toBe("rate_limit");
  });

  it("returns undefined for unrelated errors", () => {
    expect(detectUsageLimitKind("Prompt is too long")).toBeUndefined();
    expect(detectUsageLimitKind("ENOENT: no such file")).toBeUndefined();
    expect(detectUsageLimitKind("")).toBeUndefined();
    expect(detectUsageLimitKind(undefined)).toBeUndefined();
  });
});

describe("runWithBackendFallback", () => {
  it("returns the first backend's success without trying others", async () => {
    const attempt = vi.fn(async () => ({ ok: true as const, value: "ok" }));
    const result = await runWithBackendFallback<string>({
      backends: ["claude_code", "codex"],
      attempt,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.value).toBe("ok");
    expect(result.backend).toBe("claude_code");
    expect(result.usageLimitEvents).toEqual([]);
    expect(result.recoveryMessage).toBeUndefined();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("falls back from Claude usage limit to Codex success and preserves history", async () => {
    const calls: CliWorkerId[] = [];
    const progress: string[] = [];
    const result = await runWithBackendFallback<string>({
      backends: ["claude_code", "codex"],
      onProgress: (text) => progress.push(text),
      attempt: async (backend) => {
        calls.push(backend);
        if (backend === "claude_code") {
          return { ok: false, errorText: "monthly usage limit reached. Resets at 3pm." };
        }
        return { ok: true, value: "codex-result" };
      },
    });

    expect(calls).toEqual(["claude_code", "codex"]);
    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.value).toBe("codex-result");
    expect(result.backend).toBe("codex");
    expect(result.usageLimitEvents).toHaveLength(1);
    expect(result.usageLimitEvents[0]?.backend).toBe("claude_code");
    expect(result.recoveryMessage).toContain("Claude Code hit a usage limit");
    expect(result.recoveryMessage).toContain("Fell back to Codex");
    expect(result.recoveryMessage).toContain("Codex succeeded");
    expect(progress.some((p) => p.includes("Falling back to Codex"))).toBe(true);
  });

  it("falls back from Codex usage limit to Claude success", async () => {
    const calls: CliWorkerId[] = [];
    const result = await runWithBackendFallback<string>({
      backends: ["codex", "claude_code"],
      attempt: async (backend) => {
        calls.push(backend);
        if (backend === "codex") {
          return { ok: false, errorText: "Codex usage limit (weekly). Resets on Monday." };
        }
        return { ok: true, value: "claude-result" };
      },
    });

    expect(calls).toEqual(["codex", "claude_code"]);
    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.backend).toBe("claude_code");
    expect(result.recoveryMessage).toContain("Codex hit a usage limit");
  });

  it("surfaces one clear exhausted message with reset times when both are limited", async () => {
    const result = await runWithBackendFallback<string>({
      backends: ["claude_code", "codex"],
      attempt: async (backend) =>
        backend === "claude_code"
          ? { ok: false, errorText: "monthly usage limit. Resets at 3pm." }
          : { ok: false, errorText: "weekly usage limit. Resets on Monday." },
    });

    expect(result.status).toBe("exhausted");
    if (result.status !== "exhausted") throw new Error("expected exhausted");
    expect(result.usageLimitEvents).toHaveLength(2);
    expect(result.message).toContain("Claude Code hit a usage limit");
    expect(result.message).toContain("Codex hit a usage limit");
    expect(result.message).toContain("All compatible backends are exhausted");
    expect(result.message).toContain("Reset times:");
    expect(result.message).toContain("resets at 3pm");
    expect(result.message).toContain("resets on Monday");
  });

  it("does not fall back on a non-usage error by default", async () => {
    const attempt = vi.fn(async () => ({ ok: false as const, errorText: "boom: crash" }));
    const result = await runWithBackendFallback<string>({
      backends: ["claude_code", "codex"],
      attempt,
    });

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("exhausted");
    if (result.status !== "exhausted") throw new Error("expected exhausted");
    expect(result.usageLimitEvents).toEqual([]);
    expect(result.message).toBe("boom: crash");
  });

  it("falls back on any error when fallbackOnAnyError is set", async () => {
    const calls: CliWorkerId[] = [];
    const result = await runWithBackendFallback<string>({
      backends: ["claude_code", "codex"],
      fallbackOnAnyError: true,
      attempt: async (backend) => {
        calls.push(backend);
        if (backend === "claude_code") return { ok: false, errorText: "boom: crash" };
        return { ok: true, value: "recovered" };
      },
    });

    expect(calls).toEqual(["claude_code", "codex"]);
    expect(result.status).toBe("success");
  });

  it("tries each backend at most once even if the list repeats one", async () => {
    const attempt = vi.fn(async () => ({ ok: false as const, errorText: "usage limit reached" }));
    await runWithBackendFallback<string>({
      backends: ["codex", "codex", "codex"],
      attempt,
    });
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
