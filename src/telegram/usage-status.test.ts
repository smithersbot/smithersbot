import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelGroupPolicy } from "../config/group-policy.js";
import type { MoltbotConfig } from "../config/config.js";
import type { TelegramAccountConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  buildClaudeStatuslineRefreshCommand,
  buildUsageStatusMessage,
  clearUsageStatusCachesForTest,
  refreshClaudeStatuslineCache,
  registerUsageStatusCommand,
  resolveClaudeStatuslineCachePath,
  USAGE_STATUS_COMMAND_SPEC,
  type StatuslineCacheEntry,
} from "./usage-status.js";
import { PUBLIC_TELEGRAM_MENU } from "./public-menu.js";

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

const CCUSAGE_CLAUDE = JSON.stringify({
  daily: [{ date: "2026-05-22" }, { date: "2026-05-23" }],
  totals: { totalCost: 12.5, totalTokens: 123456 },
});

const NOW = Date.parse("2026-05-23T12:00:00Z");

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

    expect(text).toContain("Claude Code — live subscription quota");
    expect(text).toContain("Status: current");
    expect(text).toContain("Updated 2026-05-23T11:59:59.000Z (1s ago)");
    expect(text).toContain("5-hour: 42% used, resets 2026-05-23T18:00:00Z");
    expect(text).toContain("7-day: 10% used, resets 2026-05-30T00:00:00Z");
    expect(text).toContain("only updates while Claude Code is running");
  });

  it("marks the Claude cache stale only after refresh fails", () => {
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader({ raw: CLAUDE_CACHE, mtimeMs: NOW - 60 * 60 * 1000 }),
      spawnSync: makeSpawnSync({}),
      refreshClaudeStatusline: () => ({ status: "timeout", reason: "refresh timed out" }),
    });

    expect(text).toContain("Status: stale");
    expect(text).toContain("stale values shown");
    expect(text).toContain("Refresh failed: refresh timed out.");
    expect(text).toContain("5-hour: 42% used");
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

    expect(text).toContain("Status: unavailable (pseudo-TTY refresh unavailable).");
    expect(text).toContain("No live quota cache found");
    expect(text).toContain("only updates while Claude Code is running");
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

    expect(text).toContain("Status: refreshed/current");
    expect(text).toContain("5-hour: 90% used, resets 2026-05-23T12:40:00.000Z");
    expect(text).toContain("7-day: 23% used, resets 2026-05-28T00:00:00.000Z");
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

    expect(text).toContain("5-hour: 12% used");
    expect(text).not.toContain("session_id");
    expect(text).not.toContain("auth");
    expect(text).not.toContain(leakedToken);
    expect(text).not.toContain("sk-ant-abcdef0123456789");
  });

  it("parses Codex live quota from codex-limit --json", () => {
    const spawnSync = makeSpawnSync({ codexLimit: okResult(CODEX_LIMIT) });
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader(undefined),
      spawnSync,
      refreshClaudeStatusline: false,
    });

    expect(text).toContain("Codex — live subscription quota");
    expect(text).toContain("Status: current");
    expect(text).toContain("Primary (4h): 30% used, resets 2026-05-23T16:00:00.000Z");
    expect(text).toContain("Secondary (7d): 5% used, resets 2026-05-28T00:00:00.000Z");
    expect(text).toContain("Details: plan pro; credits available, balance 12.5.");
    // External CLI is invoked with an argv array, never a shell string.
    const call = (spawnSync as unknown as { mock: { calls: unknown[][] } }).mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes("codex-limit"),
    );
    expect(call?.[0]).toBe("npx");
    expect(call?.[1]).toEqual(["-y", "codex-limit", "--json"]);
    expect(call?.[2]).toMatchObject({ timeout: 15_000 });
  });

  it("shows a concise message when codex-limit is unavailable", () => {
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader(undefined),
      spawnSync: makeSpawnSync({ codexLimit: errResult("ENOENT") }),
      refreshClaudeStatusline: false,
    });

    expect(text).toContain("Codex — live subscription quota");
    expect(text).toContain("Live quota unavailable (codex-limit command not found)");
  });

  it("uses a stale cached Codex live quota when codex-limit times out", () => {
    buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader(undefined),
      spawnSync: makeSpawnSync({ codexLimit: okResult(CODEX_LIMIT) }),
      refreshClaudeStatusline: false,
    });

    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW + 60_000,
      readCache: cacheReader(undefined),
      spawnSync: makeSpawnSync({ codexLimit: errResult("ETIMEDOUT") }),
      refreshClaudeStatusline: false,
    });

    expect(text).toContain("Codex — live subscription quota");
    expect(text).toContain("Status: stale");
    expect(text).toContain("cached 2026-05-23T12:00:00.000Z (1m ago); codex-limit timed out");
    expect(text).toContain("Primary (4h): 30% used, resets 2026-05-23T16:00:00.000Z");
  });

  it("shows codex-limit timeout as unavailable when there is no cached live quota", () => {
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader(undefined),
      spawnSync: makeSpawnSync({ codexLimit: errResult("ETIMEDOUT") }),
      refreshClaudeStatusline: false,
    });

    expect(text).toContain("Live quota unavailable (codex-limit timed out)");
  });

  it("renders Codex exhausted state from rateLimitReachedType", () => {
    const exhausted = JSON.stringify({
      primary: { usedPercent: 100, windowDurationMins: 240, resetsAt: 1779552000 },
      secondary: { usedPercent: 84, windowDurationMins: 10080, resetsAt: 1779926400 },
      rateLimitReachedType: "primary",
    });
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader(undefined),
      spawnSync: makeSpawnSync({ codexLimit: okResult(exhausted) }),
      refreshClaudeStatusline: false,
    });

    expect(text).toContain("Status: exhausted/rate-limit reached (primary).");
    expect(text).toContain("Primary (4h): 100% used");
  });

  it("shows historical ccusage separately from live quota", () => {
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader({ raw: CLAUDE_CACHE, mtimeMs: NOW - 1000 }),
      spawnSync: makeSpawnSync({
        codexLimit: okResult(CODEX_LIMIT),
        ccusageClaude: okResult(CCUSAGE_CLAUDE),
        ccusageCodex: okResult(
          JSON.stringify({
            daily: [{ date: "2026-05-23" }],
            totals: { totalCost: 1.25, totalTokens: 9876 },
          }),
        ),
      }),
      refreshClaudeStatusline: false,
    });

    expect(text).toContain("Historical usage — local logs, not remaining quota");
    expect(text).toContain("Claude Code: 2 day(s), 123,456 tokens, $12.50");
    expect(text).toContain("Codex: 1 day(s), 9,876 tokens, $1.25");
    // The historical section is rendered after (separate from) the live sections.
    expect(text.indexOf("live subscription quota")).toBeLessThan(
      text.indexOf("Historical usage — local logs"),
    );
  });

  it("uses stale cached historical ccusage when later calls time out", () => {
    buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader(undefined),
      spawnSync: makeSpawnSync({
        ccusageClaude: okResult(CCUSAGE_CLAUDE),
        ccusageCodex: okResult(
          JSON.stringify({
            daily: [{ date: "2026-05-23" }],
            totals: { totalCost: 1.25, totalTokens: 9876 },
          }),
        ),
      }),
      refreshClaudeStatusline: false,
    });

    const spawnSync = makeSpawnSync({
      ccusageClaude: errResult("ETIMEDOUT"),
      ccusageCodex: errResult("ETIMEDOUT"),
    });
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW + 120_000,
      readCache: cacheReader(undefined),
      spawnSync,
      refreshClaudeStatusline: false,
    });

    expect(text).toContain("Claude Code: 2 day(s), 123,456 tokens, $12.50 (stale;");
    expect(text).toContain("Codex: 1 day(s), 9,876 tokens, $1.25 (stale;");
    expect(text).toContain("ccusage timed out");
    const ccusageCall = (spawnSync as unknown as { mock: { calls: unknown[][] } }).mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes("ccusage@latest"),
    );
    expect(ccusageCall?.[2]).toMatchObject({ timeout: 20_000 });
  });

  it("redacts token-like values that would otherwise leak into the output", () => {
    const leakedToken = "topsecrettokenvalue1234";
    const codexWithLeak = JSON.stringify({
      burst: { used_percentage: 30, resets_at: leakedToken },
      weekly: { used_percentage: 5, resets_at: "sk-ant-abcdef0123456789" },
    });
    const text = buildUsageStatusMessage({
      env: { CLAWDBOT_GATEWAY_TOKEN: leakedToken },
      nowMs: NOW,
      readCache: cacheReader(undefined),
      spawnSync: makeSpawnSync({ codexLimit: okResult(codexWithLeak) }),
      refreshClaudeStatusline: false,
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
    const listeners: Record<string, Array<(err: Error) => void>> = {};
    return {
      pid,
      kill: vi.fn(),
      unref: vi.fn(),
      once: vi.fn((event: string, handler: (err: Error) => void) => {
        listeners[event] = [...(listeners[event] ?? []), handler];
        return undefined;
      }),
      emitError: (err: Error) => {
        for (const handler of listeners.error ?? []) handler(err);
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

  it("appears in the public Telegram menu", () => {
    expect(PUBLIC_TELEGRAM_MENU.map((entry) => entry.command)).toContain("usage_status");
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
    expect(handlers.usage_status).toBeTypeOf("function");
  });

  it("sends the usage status message to the requesting chat", async () => {
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
      buildMessage: () => "USAGE STATUS BODY",
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

    expect(bot.api.sendMessage).toHaveBeenCalledWith(555, "USAGE STATUS BODY");
  });
});
