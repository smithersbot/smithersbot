import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelGroupPolicy } from "../config/group-policy.js";
import type { MoltbotConfig } from "../config/config.js";
import type { TelegramAccountConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  buildClaudeStatuslineRefreshCommand,
  buildUsageStatusMessage,
  buildUsageStatusMessageWithClaudeRefresh,
  clearUsageStatusCachesForTest,
  refreshClaudeStatuslineCache,
  refreshClaudeUsageCacheViaApi,
  registerUsageStatusCommand,
  resolveClaudeStatuslineCachePath,
  USAGE_STATUS_COMMAND_SPEC,
  type ClaudeApiUsageRefreshResult,
  type StatuslineCacheEntry,
} from "./usage-status.js";
import type { ProviderUsageSnapshot } from "../infra/provider-usage.types.js";
import { PUBLIC_TELEGRAM_MENU } from "./public-menu.js";
import type { CodexQuota, CodexQuotaProbeResult } from "./codex-quota-runner.js";

// bot-native-commands pulls in plugins/delivery/dispatch; mock the same surface
// the gateway_status native test does so the registry can be exercised.
const getPluginCommandSpecs = vi.hoisted(() => vi.fn(() => []));
const matchPluginCommand = vi.hoisted(() => vi.fn());
const executePluginCommand = vi.hoisted(() => vi.fn());
vi.mock("../plugins/commands.js", () => ({
  getPluginCommandSpecs,
  matchPluginCommand,
  executePluginCommand,
}));
const deliverReplies = vi.hoisted(() => vi.fn(async () => ({ delivered: true })));
vi.mock("./bot/delivery.js", () => ({ deliverReplies }));
const dispatchReplyWithBufferedBlockDispatcher = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithBufferedBlockDispatcher,
}));
vi.mock("./pairing-store.js", () => ({
  readTelegramAllowFromStore: vi.fn(async () => []),
}));

type SpawnResult = ReturnType<typeof import("node:child_process").spawnSync>;

function okResult(stdout: string): SpawnResult {
  return {
    status: 0,
    signal: null,
    output: [null, stdout, ""],
    pid: 1,
    stdout,
    stderr: "",
  } as SpawnResult;
}

function errResult(code: string): SpawnResult {
  return {
    error: Object.assign(new Error(code), { code }),
    status: null,
    signal: null,
    output: [null, "", ""],
    pid: 0,
    stdout: "",
    stderr: "",
  } as SpawnResult;
}

type CliOutputs = {
  codexLimit?: SpawnResult;
  ccusageClaude?: SpawnResult;
  ccusageCodex?: SpawnResult;
};

function makeSpawnSync(outputs: CliOutputs) {
  return vi.fn((_command: string, args: readonly string[]) => {
    const argv = args.join(" ");
    if (argv.includes("codex-limit")) return outputs.codexLimit ?? errResult("ENOENT");
    if (argv.includes("ccusage") && argv.includes("claude"))
      return outputs.ccusageClaude ?? errResult("ENOENT");
    if (argv.includes("ccusage") && argv.includes("codex"))
      return outputs.ccusageCodex ?? errResult("ENOENT");
    return errResult("ENOENT");
  }) as unknown as typeof import("node:child_process").spawnSync;
}

const CLAUDE_CACHE = JSON.stringify({
  rate_limits: {
    five_hour: { used_percentage: 42, resets_at: "2026-05-23T18:00:00Z" },
    seven_day: { used_percentage: 10, resets_at: "2026-05-30T00:00:00Z" },
  },
});

const CODEX_LIMIT = JSON.stringify({
  primary: { usedPercent: 30, windowDurationMins: 240, resetsAt: 1779552000 },
  secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: "1779926400" },
  credits: { hasCredits: true, balance: 12.5 },
  planType: "pro",
  rateLimitReachedType: null,
});

const CODEX_QUOTA: CodexQuota = {
  primary: { usedPercentage: 30, windowDurationMins: 240, resetsAt: "1779552000" },
  secondary: { usedPercentage: 5, windowDurationMins: 10080, resetsAt: "1779926400" },
  credits: { hasCredits: true, balance: 12.5 },
  planType: "pro",
};

function codexOk(quota: CodexQuota = CODEX_QUOTA): CodexQuotaProbeResult {
  return {
    ok: true,
    quota,
    cachedAtMs: NOW,
    durationMs: 25,
    cachePath: "/tmp/codex-quota.json",
  };
}

function codexFailure(
  reason: "command not found" | "timed out" | "command failed" | "unavailable",
  cachedQuota?: { quota: CodexQuota; cachedAtMs: number },
): CodexQuotaProbeResult {
  return {
    ok: false,
    reason,
    durationMs: 25,
    cachePath: "/tmp/codex-quota.json",
    ...(cachedQuota ? { cachedQuota } : {}),
  };
}

const CCUSAGE_CLAUDE = JSON.stringify({
  daily: [{ date: "2026-05-22" }, { date: "2026-05-23" }],
  totals: { totalCost: 12.5, totalTokens: 123456 },
});

const NOW = Date.parse("2026-05-23T12:00:00Z");
const CLAUDE_USAGE_LIMIT_TEXT =
  "Claude Code hit a 5-hour usage limit. Resets at 2026-05-23T17:50:00-04:00.";

function cacheReader(entry: StatuslineCacheEntry | undefined) {
  return () => entry;
}

describe("buildUsageStatusMessage", () => {
  beforeEach(() => {
    clearUsageStatusCachesForTest();
  });

  it("renders Claude live quota from the statusline cache", () => {
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader({ raw: CLAUDE_CACHE, mtimeMs: NOW - 1000 }),
      spawnSync: makeSpawnSync({}),
      refreshClaudeStatusline: false,
    });

    expect(text).toContain("**SmithersBot usage status**");
    expect(text).toContain("**Claude Code:** current");
    expect(text).toContain("**Updated:** 2026-05-23T11:59:59.000Z (1s ago)");
    expect(text).toContain("**5-hour:** 42% used, resets 2026-05-23T18:00:00Z");
    expect(text).toContain("**7-day:** 10% used, resets 2026-05-30T00:00:00Z");
    expect(text).not.toMatch(/\n{3,}/);
  });

  it("bolds every compact label before a colon", () => {
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader({ raw: CLAUDE_CACHE, mtimeMs: NOW - 1000 }),
      spawnSync: makeSpawnSync({ codexLimit: okResult(CODEX_LIMIT) }),
      refreshClaudeStatusline: false,
    });

    for (const line of text.split("\n").filter((line) => line.includes(":"))) {
      expect(line).toMatch(/^\*\*[^*]+:\*\*/);
    }
  });

  it("marks the Claude cache stale only after refresh fails", () => {
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader({ raw: CLAUDE_CACHE, mtimeMs: NOW - 60 * 60 * 1000 }),
      spawnSync: makeSpawnSync({}),
      refreshClaudeStatusline: () => ({ status: "timeout", reason: "refresh timed out" }),
    });

    expect(text).toContain("**Claude Code:** stale");
    expect(text).toContain("stale values shown");
    expect(text).toContain("Refresh failed: refresh timed out.");
    expect(text).toContain("**5-hour:** 42% used");
  });

  it("renders Claude usage-limit refresh signal with last known quota instead of unavailable", () => {
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader({ raw: CLAUDE_CACHE, mtimeMs: NOW - 60 * 60 * 1000 }),
      spawnSync: makeSpawnSync({}),
      refreshClaudeStatusline: () => ({
        status: "rate_limited_with_reset",
        reason: "usage limited",
        event: {
          backend: "claude_code",
          kind: "usage_limit",
          limitType: "five_hour",
          resetHint: "Resets at 2026-05-23T17:50:00-04:00",
        },
      }),
    });

    expect(text).toContain("**Claude Code:** rate limited");
    expect(text).toContain(
      "**Note:** Claude Code hit a usage limit (5-hour limit, resets at 2026-05-23T17:50:00-04:00).",
    );
    expect(text).toContain("**Last known quota:** stale values shown; refresh is usage-limited.");
    expect(text).toContain("**5-hour:** 42% used");
    expect(text).not.toContain("**Claude Code:** unavailable");
  });

  it("renders classifiable Claude timeout output as rate limited with last known quota", () => {
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader({ raw: CLAUDE_CACHE, mtimeMs: NOW - 60 * 60 * 1000 }),
      spawnSync: makeSpawnSync({}),
      refreshClaudeStatusline: () => ({
        status: "rate_limited_with_reset",
        reason: "rate limited",
        event: {
          backend: "claude_code",
          kind: "rate_limit",
          limitType: "unknown",
          resetHint: "Resets in 45 minutes",
        },
      }),
    });

    expect(text).toContain("**Claude Code:** rate limited");
    expect(text).toContain("Claude Code hit a rate limit (resets in 45 minutes).");
    expect(text).toContain("**5-hour:** 42% used");
    expect(text).not.toContain("**Claude Code:** unavailable");
  });

  it("renders Claude usage-limit signal even when no valid cache exists", () => {
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader(undefined),
      spawnSync: makeSpawnSync({}),
      refreshClaudeStatusline: () => ({
        status: "rate_limited_with_reset",
        reason: "usage limited",
        event: {
          backend: "claude_code",
          kind: "usage_limit",
          limitType: "five_hour",
          resetHint: "Resets at 2026-05-23T17:50:00-04:00",
        },
      }),
    });

    expect(text).toContain("**Claude Code:** rate limited");
    expect(text).toContain("Claude Code hit a usage limit");
    expect(text).toContain("**Last known quota:** not available.");
    expect(text).not.toContain("**Claude Code:** unavailable");
    expect(text).not.toContain("**5-hour:**");
  });

  it("does not render an invalid Claude cache as quota when usage-limited", () => {
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader({
        raw: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 99 } } }),
        mtimeMs: NOW - 1000,
      }),
      spawnSync: makeSpawnSync({}),
      refreshClaudeStatusline: () => ({
        status: "rate_limited_with_reset",
        reason: "usage limited",
        event: {
          backend: "claude_code",
          kind: "usage_limit",
          limitType: "five_hour",
          resetHint: "Resets on 2026-05-24",
        },
      }),
    });

    expect(text).toContain("**Claude Code:** rate limited");
    expect(text).toContain("Claude Code hit a usage limit");
    expect(text).toContain("**Last known quota:** not available.");
    expect(text).not.toContain("99% used");
  });

  it("keeps a valid Claude cache when refresh rereads invalid statusline output", () => {
    const stale = { raw: CLAUDE_CACHE, mtimeMs: NOW - 60 * 60 * 1000 };
    const invalid = {
      raw: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 99 } } }),
      mtimeMs: NOW + 1,
    };
    let reads = 0;
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: () => (reads++ === 0 ? stale : invalid),
      spawnSync: makeSpawnSync({}),
      refreshClaudeStatusline: () => ({ status: "timeout", reason: "refresh timed out" }),
    });

    expect(text).toContain("**Claude Code:** stale");
    expect(text).toContain("Refresh failed: refresh timed out.");
    expect(text).toContain("**5-hour:** 42% used");
    expect(text).not.toContain("99% used");
  });

  it("reports gracefully when the Claude cache is missing", () => {
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader(undefined),
      spawnSync: makeSpawnSync({}),
      refreshClaudeStatusline: () => ({
        status: "unavailable",
        reason: "pseudo-TTY refresh unavailable",
      }),
    });

    expect(text).toContain("**Claude Code:** unavailable");
    expect(text).toContain("pseudo-TTY refresh unavailable");
    expect(text).toContain("No live quota cache found");
  });

  it("renders no-cache unknown Claude timeout as unavailable", () => {
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader(undefined),
      spawnSync: makeSpawnSync({}),
      refreshClaudeStatusline: () => ({ status: "timeout", reason: "refresh timed out" }),
    });

    expect(text).toContain("**Claude Code:** unavailable");
    expect(text).toContain("No live quota cache found (refresh timed out).");
  });

  it("refreshes a stale Claude cache and shows reset times from epoch seconds", () => {
    const stale = {
      raw: CLAUDE_CACHE,
      mtimeMs: NOW - 60 * 60 * 1000,
    };
    const refreshed = {
      raw: JSON.stringify({
        rate_limits: {
          five_hour: { used_percentage: 90, resets_at: 1779540000 },
          seven_day: { used_percentage: 23, resets_at: "1779926400" },
        },
      }),
      mtimeMs: NOW - 2000,
    };
    let calls = 0;
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: () => (calls++ === 0 ? stale : refreshed),
      spawnSync: makeSpawnSync({}),
      refreshClaudeStatusline: () => ({ status: "refreshed" }),
    });

    expect(text).toContain("**Claude Code:** current");
    expect(text).not.toContain("refreshed/current");
    expect(text).not.toContain("refreshed now");
    expect(text).toContain("**5-hour:** 90% used, resets 2026-05-23T12:40:00.000Z");
    expect(text).toContain("**7-day:** 23% used, resets 2026-05-28T00:00:00.000Z");
    expect(text).not.toContain("stale values shown");
  });

  it("does not print raw Claude statusline payload fields or token-like values", () => {
    const leakedToken = "topsecrettokenvalue1234";
    const raw = JSON.stringify({
      session_id: leakedToken,
      auth: "sk-ant-abcdef0123456789",
      rate_limits: {
        five_hour: { used_percentage: 12, resets_at: "2026-05-23T18:00:00Z" },
        seven_day: { used_percentage: 34, resets_at: "2026-05-30T00:00:00Z" },
      },
    });
    const text = buildUsageStatusMessage({
      env: { ANTHROPIC_API_KEY: leakedToken },
      nowMs: NOW,
      readCache: cacheReader({ raw, mtimeMs: NOW - 1000 }),
      spawnSync: makeSpawnSync({}),
      refreshClaudeStatusline: false,
    });

    expect(text).toContain("**5-hour:** 12% used");
    expect(text).not.toContain("session_id");
    expect(text).not.toContain("auth");
    expect(text).not.toContain(leakedToken);
    expect(text).not.toContain("sk-ant-abcdef0123456789");
  });

  it("renders Codex current quota from the deterministic quota runner", () => {
    const spawnSync = makeSpawnSync({});
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader(undefined),
      spawnSync,
      refreshClaudeStatusline: false,
      refreshCodexQuota: () => codexOk(),
    });

    expect(text).toContain("**Codex:** current");
    expect(text).toContain("**Primary (4h):** 30% used, resets 2026-05-23T16:00:00.000Z");
    expect(text).toContain("**Secondary (7d):** 5% used, resets 2026-05-28T00:00:00.000Z");
    expect(text).toContain("**Plan:** pro");
    expect(text).toContain("**Credits:** available, balance 12.5");
    expect(spawnSync).not.toHaveBeenCalledWith(
      "npx",
      expect.arrayContaining(["-y", "codex-limit", "--json"]),
      expect.anything(),
    );
  });

  it("shows telemetry unavailable without implying Codex backend execution is unavailable", () => {
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader(undefined),
      spawnSync: makeSpawnSync({}),
      refreshClaudeStatusline: false,
      refreshCodexQuota: () => codexFailure("timed out"),
    });

    expect(text).toContain("**Codex quota:** unavailable");
    expect(text).toContain("Quota probe timed out");
    expect(text).toContain("Codex may still be usable");
    expect(text).not.toContain("**Codex:** unavailable");
    expect(text).not.toContain("**Codex:** exhausted");
  });

  it("uses a stale cached Codex live quota when the quota probe times out", () => {
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW + 60_000,
      readCache: cacheReader(undefined),
      spawnSync: makeSpawnSync({}),
      refreshClaudeStatusline: false,
      refreshCodexQuota: () => codexFailure("timed out", { quota: CODEX_QUOTA, cachedAtMs: NOW }),
    });

    expect(text).toContain("**Codex:** stale");
    expect(text).toContain("Last known quota shown (cached 2026-05-23T12:00:00.000Z (1m ago))");
    expect(text).toContain("refresh timed out");
    expect(text).toContain("**Primary (4h):** 30% used, resets 2026-05-23T16:00:00.000Z");
  });

  it("survives a gateway restart by reading the file-backed Codex quota cache", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "smithersbot-usage-status-"));
    const codexCachePath = path.join(tmpDir, "cache", "smithersbot", "codex-quota.json");
    try {
      const first = buildUsageStatusMessage({
        env: {},
        nowMs: NOW,
        readCache: cacheReader(undefined),
        spawnSync: makeSpawnSync({ codexLimit: okResult(CODEX_LIMIT) }),
        refreshClaudeStatusline: false,
        codexCachePath,
      });
      expect(first).toContain("**Codex:** current");

      clearUsageStatusCachesForTest();
      const second = buildUsageStatusMessage({
        env: {},
        nowMs: NOW + 60_000,
        readCache: cacheReader(undefined),
        spawnSync: makeSpawnSync({ codexLimit: errResult("ETIMEDOUT") }),
        refreshClaudeStatusline: false,
        codexCachePath,
      });

      expect(second).toContain("**Codex:** stale");
      expect(second).toContain("Last known quota shown (cached 2026-05-23T12:00:00.000Z (1m ago))");
      expect(second).toContain("**Plan:** pro");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("shows quota timeout as telemetry unavailable when there is no cached live quota", () => {
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader(undefined),
      spawnSync: makeSpawnSync({}),
      refreshClaudeStatusline: false,
      refreshCodexQuota: () => codexFailure("timed out"),
    });

    expect(text).toContain("**Codex quota:** unavailable");
    expect(text).toContain("Quota probe timed out");
    expect(text).not.toContain("**Codex:** unavailable");
    expect(text).not.toContain("**Codex:** exhausted");
  });

  it("renders Codex rate-limited and exhausted headings from rateLimitReachedType", () => {
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader(undefined),
      spawnSync: makeSpawnSync({}),
      refreshClaudeStatusline: false,
      refreshCodexQuota: () =>
        codexOk({
          primary: { usedPercentage: 100, windowDurationMins: 240, resetsAt: "1779552000" },
          secondary: { usedPercentage: 84, windowDurationMins: 10080, resetsAt: "1779926400" },
          rateLimitReachedType: "primary",
        }),
    });

    expect(text).toContain("**Codex:** rate limited");
    expect(text).toContain("**Rate limit:** primary");
    expect(text).toContain("**Primary (4h):** 100% used");

    const exhausted = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader(undefined),
      spawnSync: makeSpawnSync({}),
      refreshClaudeStatusline: false,
      refreshCodexQuota: () =>
        codexOk({
          primary: { usedPercentage: 100, windowDurationMins: 240, resetsAt: "1779552000" },
          rateLimitReachedType: "out_of_credits",
        }),
    });

    expect(exhausted).toContain("**Codex:** exhausted");
    expect(exhausted).not.toContain("**Codex:** current");
  });

  it("excludes historical ccusage from the default live quota output", () => {
    const spawnSync = makeSpawnSync({
      codexLimit: okResult(CODEX_LIMIT),
      ccusageClaude: okResult(CCUSAGE_CLAUDE),
      ccusageCodex: okResult(
        JSON.stringify({
          daily: [{ date: "2026-05-23" }],
          totals: { totalCost: 1.25, totalTokens: 9876 },
        }),
      ),
    });
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader({ raw: CLAUDE_CACHE, mtimeMs: NOW - 1000 }),
      spawnSync,
      refreshClaudeStatusline: false,
      refreshCodexQuota: () => codexOk(),
    });

    expect(text).not.toContain("Historical usage");
    expect(text).not.toContain("local logs, not remaining quota");
    expect(text).not.toContain("123,456 tokens");
    expect(spawnSync).not.toHaveBeenCalledWith(
      "npx",
      expect.arrayContaining(["ccusage@latest"]),
      expect.anything(),
    );
  });

  it("redacts token-like values that would otherwise leak into the output", () => {
    const leakedToken = "topsecrettokenvalue1234";
    const text = buildUsageStatusMessage({
      env: { CLAWDBOT_GATEWAY_TOKEN: leakedToken },
      nowMs: NOW,
      readCache: cacheReader(undefined),
      spawnSync: makeSpawnSync({}),
      refreshClaudeStatusline: false,
      refreshCodexQuota: () =>
        codexOk({
          primary: { usedPercentage: 30, resetsAt: leakedToken },
          secondary: { usedPercentage: 5, resetsAt: "sk-ant-abcdef0123456789" },
        }),
    });

    expect(text).not.toContain(leakedToken);
    expect(text).not.toContain("sk-ant-abcdef0123456789");
    expect(text).toContain("[REDACTED]");
  });

  it("resolves the cache path under XDG_CACHE_HOME when set", () => {
    expect(resolveClaudeStatuslineCachePath("/home/u", { XDG_CACHE_HOME: "/xdg/cache" })).toBe(
      "/xdg/cache/claude-code/statusline.json",
    );
    expect(resolveClaudeStatuslineCachePath("/home/u", {})).toBe(
      "/home/u/.cache/claude-code/statusline.json",
    );
  });
});

describe("Claude statusline active refresh", () => {
  function makeChild(pid = 1234) {
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    const stdoutListeners: Array<(chunk: string) => void> = [];
    const stderrListeners: Array<(chunk: string) => void> = [];
    return {
      pid,
      kill: vi.fn(),
      unref: vi.fn(),
      stdout: {
        on: vi.fn((event: string, handler: (chunk: string) => void) => {
          if (event === "data") stdoutListeners.push(handler);
          return undefined;
        }),
      },
      stderr: {
        on: vi.fn((event: string, handler: (chunk: string) => void) => {
          if (event === "data") stderrListeners.push(handler);
          return undefined;
        }),
      },
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        listeners[event] = [...(listeners[event] ?? []), handler];
        return undefined;
      }),
      emitError: (err: Error) => {
        for (const handler of listeners.error ?? []) handler(err);
      },
      emitExit: (code: number | null, signal: NodeJS.Signals | null = null) => {
        for (const handler of listeners.exit ?? []) handler(code, signal);
        for (const handler of listeners.close ?? []) handler(code, signal);
      },
      emitStdout: (chunk: string) => {
        for (const handler of stdoutListeners) handler(chunk);
      },
      emitStderr: (chunk: string) => {
        for (const handler of stderrListeners) handler(chunk);
      },
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses a pseudo-TTY Claude command without -p or --bare", () => {
    const command = buildClaudeStatuslineRefreshCommand();
    const rendered = [command.command, ...command.args].join(" ");

    expect(command.command).toBe("script");
    expect(rendered).toContain('claude "respond with only a period"');
    expect(rendered).not.toContain("claude -p");
    expect(rendered).not.toContain("--bare");
  });

  it("waits for mtime change and all four rate_limit fields before succeeding", () => {
    const child = makeChild();
    const spawn = vi.fn(() => child);
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === 0) throw new Error(`not alive: ${String(pid)}`);
      return true;
    });
    const entries: Array<StatuslineCacheEntry | undefined> = [
      {
        raw: JSON.stringify({
          rate_limits: {
            five_hour: { used_percentage: 70 },
            seven_day: { used_percentage: 20, resets_at: 1779926400 },
          },
        }),
        mtimeMs: NOW + 1,
      },
      {
        raw: JSON.stringify({
          rate_limits: {
            five_hour: { used_percentage: 71, resets_at: 1779540000 },
            seven_day: { used_percentage: 21, resets_at: 1779926400 },
          },
        }),
        mtimeMs: NOW + 2,
      },
    ];
    let reads = 0;

    const result = refreshClaudeStatuslineCache({
      cachePath: "/tmp/statusline.json",
      beforeMtimeMs: NOW,
      env: {},
      nowMs: NOW,
      readCache: () => entries[Math.min(reads++, entries.length - 1)],
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
      sleepMs: vi.fn(),
      timeoutMs: 1000,
      pollMs: 100,
    });

    expect(result).toEqual({ status: "refreshed" });
    expect(reads).toBe(2);
    expect(kill).toHaveBeenCalledWith(-1234, "SIGTERM");
  });

  it("cleans up the process group on timeout", () => {
    const child = makeChild(4321);
    const spawn = vi.fn(() => child);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = refreshClaudeStatuslineCache({
      cachePath: "/tmp/statusline.json",
      beforeMtimeMs: NOW,
      env: {},
      nowMs: NOW,
      readCache: () => undefined,
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
      sleepMs: vi.fn(),
      timeoutMs: 200,
      pollMs: 100,
    });

    expect(result).toEqual({ status: "timeout", reason: "refresh timed out" });
    expect(kill).toHaveBeenCalledWith(-4321, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(-4321, "SIGKILL");
  });

  it("classifies captured Claude usage-limit output on timeout", () => {
    const child = makeChild(2468);
    const spawn = vi.fn(() => child);
    vi.spyOn(process, "kill").mockImplementation(() => true);
    const sleepMs = vi.fn(() => {
      child.emitStderr(CLAUDE_USAGE_LIMIT_TEXT);
    });

    const result = refreshClaudeStatuslineCache({
      cachePath: "/tmp/statusline.json",
      beforeMtimeMs: NOW,
      env: {},
      nowMs: NOW,
      readCache: () => undefined,
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
      sleepMs,
      timeoutMs: 200,
      pollMs: 100,
    });

    expect(result).toMatchObject({
      status: "rate_limited_with_reset",
      reason: "usage limited",
      event: {
        backend: "claude_code",
        kind: "usage_limit",
        limitType: "five_hour",
        resetHint: "Resets at 2026-05-23T17:50:00-04:00",
      },
    });
  });

  it("unsets Anthropic API credential env vars for the refresh process", () => {
    const child = makeChild();
    const spawn = vi.fn(() => child);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === 0) throw new Error(`not alive: ${String(pid)}`);
      return true;
    });

    refreshClaudeStatuslineCache({
      cachePath: "/tmp/statusline.json",
      beforeMtimeMs: NOW,
      env: {
        ANTHROPIC_API_KEY: "secret-key",
        ANTHROPIC_AUTH_TOKEN: "secret-token",
        ANTHROPIC_BASE_URL: "https://example.invalid",
        ANTHROPIC_API_KEY_OLD: "old-secret",
        SAFE_VALUE: "kept",
      },
      nowMs: NOW,
      readCache: () => ({
        raw: JSON.stringify({
          rate_limits: {
            five_hour: { used_percentage: 1, resets_at: 1779540000 },
            seven_day: { used_percentage: 2, resets_at: 1779926400 },
          },
        }),
        mtimeMs: NOW + 1,
      }),
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
      sleepMs: vi.fn(),
    });

    const options = spawn.mock.calls[0]?.[2] as { env: Record<string, string | undefined> };
    expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(options.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(options.env.ANTHROPIC_API_KEY_OLD).toBeUndefined();
    expect(options.env.SAFE_VALUE).toBe("kept");
  });
});

describe("Claude usage API refresh (deterministic OAuth path)", () => {
  const FIVE_HOUR_RESET = NOW + 3 * 60 * 60 * 1000;
  const WEEK_RESET = NOW + 5 * 24 * 60 * 60 * 1000;

  function usageSnapshot(overrides?: Partial<ProviderUsageSnapshot>): ProviderUsageSnapshot {
    return {
      provider: "anthropic",
      displayName: "Anthropic",
      windows: [
        { label: "5h", usedPercent: 37, resetAt: FIVE_HOUR_RESET },
        { label: "Week", usedPercent: 64, resetAt: WEEK_RESET },
      ],
      ...overrides,
    };
  }

  it("writes a complete statusline cache from the OAuth usage API", async () => {
    let written: { cachePath: string; raw: string } | undefined;
    const result = await refreshClaudeUsageCacheViaApi({
      cachePath: "/tmp/statusline.json",
      nowMs: NOW,
      readCredential: () => "oauth-access-token",
      fetchUsage: async () => usageSnapshot(),
      writeCache: (cachePath, raw) => {
        written = { cachePath, raw };
      },
    });

    expect(result).toEqual({ status: "refreshed" });
    expect(written?.cachePath).toBe("/tmp/statusline.json");
    const parsed = JSON.parse(written?.raw ?? "{}");
    expect(parsed.rate_limits.five_hour.used_percentage).toBe(37);
    expect(parsed.rate_limits.five_hour.resets_at).toBe(new Date(FIVE_HOUR_RESET).toISOString());
    expect(parsed.rate_limits.seven_day.used_percentage).toBe(64);
    expect(parsed.rate_limits.seven_day.resets_at).toBe(new Date(WEEK_RESET).toISOString());
  });

  it("reports auth_missing (not a stale/timeout) when Claude Code is not logged in", async () => {
    const writeCache = vi.fn();
    const result = await refreshClaudeUsageCacheViaApi({
      cachePath: "/tmp/statusline.json",
      nowMs: NOW,
      readCredential: () => null,
      fetchUsage: async () => usageSnapshot(),
      writeCache,
    });

    expect(result.status).toBe("auth_missing");
    expect((result as { reason: string }).reason).toContain("not logged in");
    expect(writeCache).not.toHaveBeenCalled();
  });

  it("classifies an OAuth scope/403 error as auth_missing without writing the cache", async () => {
    const writeCache = vi.fn();
    const result = await refreshClaudeUsageCacheViaApi({
      cachePath: "/tmp/statusline.json",
      nowMs: NOW,
      readCredential: () => "oauth-access-token",
      fetchUsage: async () =>
        usageSnapshot({ windows: [], error: "HTTP 403: scope requirement user:profile" }),
      writeCache,
    });

    expect(result.status).toBe("auth_missing");
    expect((result as { reason: string }).reason).toContain("403");
    expect(writeCache).not.toHaveBeenCalled();
  });

  it("reports unavailable when the API omits a required reset window", async () => {
    const result = await refreshClaudeUsageCacheViaApi({
      cachePath: "/tmp/statusline.json",
      nowMs: NOW,
      readCredential: () => "oauth-access-token",
      fetchUsage: async () =>
        usageSnapshot({ windows: [{ label: "5h", usedPercent: 37, resetAt: FIVE_HOUR_RESET }] }),
      writeCache: vi.fn(),
    });

    expect(result.status).toBe("unavailable");
    expect((result as { reason: string }).reason).toContain("5-hour and weekly");
  });

  it("renders fresh Claude usage after a successful API refresh (no spawn)", async () => {
    const stale = { raw: CLAUDE_CACHE, mtimeMs: NOW - 60 * 60 * 1000 };
    const fresh = {
      raw: JSON.stringify({
        rate_limits: {
          five_hour: { used_percentage: 37, resets_at: new Date(FIVE_HOUR_RESET).toISOString() },
          seven_day: { used_percentage: 64, resets_at: new Date(WEEK_RESET).toISOString() },
        },
      }),
      mtimeMs: NOW - 1000,
    };
    let reads = 0;
    const spawn = vi.fn();
    const text = await buildUsageStatusMessageWithClaudeRefresh({
      env: {},
      nowMs: NOW,
      readCache: () => (reads++ === 0 ? stale : fresh),
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
      refreshCodexQuota: () => codexOk(),
      refreshClaudeUsageViaApi: async () =>
        ({ status: "refreshed" }) as ClaudeApiUsageRefreshResult,
    });

    expect(text).toContain("**Claude Code:** current");
    expect(text).toContain("**5-hour:** 37% used");
    expect(text).toContain("**7-day:** 64% used");
    expect(text).not.toContain("Refresh failed");
    expect(spawn).not.toHaveBeenCalled();
    expect(text).toContain("**Codex:** current");
  });

  it("shows an actionable auth reason instead of masking stale values as fresh", async () => {
    const spawn = vi.fn();
    const text = await buildUsageStatusMessageWithClaudeRefresh({
      env: {},
      nowMs: NOW,
      readCache: cacheReader({ raw: CLAUDE_CACHE, mtimeMs: NOW - 60 * 60 * 1000 }),
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
      refreshCodexQuota: () => codexOk(),
      refreshClaudeUsageViaApi: async () =>
        ({
          status: "auth_missing",
          reason: "Claude Code is not logged in (no OAuth credentials found)",
        }) as ClaudeApiUsageRefreshResult,
    });

    expect(text).toContain("**Claude Code:** auth missing");
    expect(text).toContain("not logged in");
    expect(text).not.toContain("**Claude Code:** current");
    expect(spawn).not.toHaveBeenCalled();
    // Codex display preserved on the new async path.
    expect(text).toContain("**Codex:** current");
  });
});

describe("usage_status command registration", () => {
  beforeEach(() => {
    getPluginCommandSpecs.mockReset();
    getPluginCommandSpecs.mockReturnValue([]);
    matchPluginCommand.mockReset();
    executePluginCommand.mockReset();
    deliverReplies.mockClear();
    dispatchReplyWithBufferedBlockDispatcher.mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("appears in the public Telegram menu without usage_history", () => {
    const commands = PUBLIC_TELEGRAM_MENU.map((entry) => entry.command);
    expect(commands).toContain("usage_status");
    expect(commands).not.toContain("usage_history");
    expect(USAGE_STATUS_COMMAND_SPEC.command).toBe("usage_status");
  });

  it("is published and registered through the native command registry", async () => {
    const { registerTelegramNativeCommands } = await import("./bot-native-commands.js");
    const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
    const bot = {
      api: {
        setMyCommands: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
      on: vi.fn(),
      command: (name: string | string[], handler: (ctx: unknown) => Promise<void>) => {
        const names = Array.isArray(name) ? name : [name];
        for (const commandName of names) handlers[commandName] = handler;
      },
    } as const;

    registerTelegramNativeCommands({
      bot: bot as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      cfg: {} as MoltbotConfig,
      runtime: {} as RuntimeEnv,
      accountId: "default",
      telegramCfg: {} as TelegramAccountConfig,
      allowFrom: [111],
      groupAllowFrom: [],
      replyToMode: "off",
      textLimit: 4000,
      useAccessGroups: false,
      nativeEnabled: true,
      nativeSkillsEnabled: false,
      nativeDisabledExplicit: false,
      resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }) as ChannelGroupPolicy,
      resolveTelegramGroupConfig: () => ({ groupConfig: undefined, topicConfig: undefined }),
      shouldSkipUpdate: () => false,
      opts: { token: "test-telegram-token" },
    });

    const published = bot.api.setMyCommands.mock.calls[0]?.[0] as Array<{ command: string }>;
    expect(published.map((entry) => entry.command)).toContain("usage_status");
    expect(published.map((entry) => entry.command)).not.toContain("usage_history");
    expect(handlers.usage_status).toBeTypeOf("function");
    expect(handlers.usage_history).toBeUndefined();
  });

  it("sends the usage status message as Telegram HTML to the requesting chat", async () => {
    const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
    const bot = {
      api: { sendMessage: vi.fn().mockResolvedValue(undefined) },
      command: (name: string, handler: (ctx: unknown) => Promise<void>) => {
        handlers[name] = handler;
      },
    } as const;

    registerUsageStatusCommand({
      bot: bot as unknown as Parameters<typeof registerUsageStatusCommand>[0]["bot"],
      cfg: {} as MoltbotConfig,
      telegramCfg: {} as TelegramAccountConfig,
      allowFrom: [111],
      groupAllowFrom: [],
      useAccessGroups: false,
      resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }) as ChannelGroupPolicy,
      resolveTelegramGroupConfig: () => ({ groupConfig: undefined, topicConfig: undefined }),
      shouldSkipUpdate: () => false,
      buildMessage: () => "**USAGE STATUS:** body",
    });

    expect(handlers.usage_status).toBeTypeOf("function");
    await handlers.usage_status?.({
      message: {
        chat: { id: 555, type: "private" },
        from: { id: 111, username: "allowed" },
        message_id: 1,
        date: 123,
      },
      match: "",
    });

    expect(bot.api.sendMessage).toHaveBeenCalledWith(555, "<b>USAGE STATUS:</b> body", {
      parse_mode: "HTML",
    });
  });
});
