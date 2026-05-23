import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelGroupPolicy } from "../config/group-policy.js";
import type { MoltbotConfig } from "../config/config.js";
import type { TelegramAccountConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  buildUsageStatusMessage,
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
  burst: { used_percentage: 30, resets_at: "2026-05-23T16:00:00Z" },
  weekly: { used_percentage: 5, resets_at: "2026-05-28T00:00:00Z" },
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
  it("renders Claude live quota from the statusline cache", () => {
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader({ raw: CLAUDE_CACHE, mtimeMs: NOW - 1000 }),
      spawnSync: makeSpawnSync({}),
    });

    expect(text).toContain("Claude Code — live subscription quota");
    expect(text).toContain("5-hour: 42% used, resets 2026-05-23T18:00:00Z");
    expect(text).toContain("7-day: 10% used, resets 2026-05-30T00:00:00Z");
    expect(text).toContain("only updates while Claude Code is running");
  });

  it("marks the Claude cache stale when it has not refreshed recently", () => {
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader({ raw: CLAUDE_CACHE, mtimeMs: NOW - 60 * 60 * 1000 }),
      spawnSync: makeSpawnSync({}),
    });

    expect(text).toContain("stale");
    expect(text).toContain("5-hour: 42% used");
  });

  it("reports gracefully when the Claude cache is missing", () => {
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader(undefined),
      spawnSync: makeSpawnSync({}),
    });

    expect(text).toContain("No live quota cache found");
    expect(text).toContain("only updates while Claude Code is running");
  });

  it("parses Codex live quota from codex-limit --json", () => {
    const spawnSync = makeSpawnSync({ codexLimit: okResult(CODEX_LIMIT) });
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader(undefined),
      spawnSync,
    });

    expect(text).toContain("Codex — live subscription quota");
    expect(text).toContain("Burst: 30% used, resets 2026-05-23T16:00:00Z");
    expect(text).toContain("Weekly: 5% used, resets 2026-05-28T00:00:00Z");
    // External CLI is invoked with an argv array, never a shell string.
    const call = (spawnSync as unknown as { mock: { calls: unknown[][] } }).mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes("codex-limit"),
    );
    expect(call?.[0]).toBe("npx");
    expect(call?.[1]).toEqual(["-y", "codex-limit", "--json"]);
  });

  it("shows a concise message when codex-limit is unavailable", () => {
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader(undefined),
      spawnSync: makeSpawnSync({ codexLimit: errResult("ENOENT") }),
    });

    expect(text).toContain("Codex — live subscription quota");
    expect(text).toContain("Live quota unavailable (codex-limit command not found)");
  });

  it("shows historical ccusage separately from live quota", () => {
    const text = buildUsageStatusMessage({
      env: {},
      nowMs: NOW,
      readCache: cacheReader({ raw: CLAUDE_CACHE, mtimeMs: NOW - 1000 }),
      spawnSync: makeSpawnSync({
        codexLimit: okResult(CODEX_LIMIT),
        ccusageClaude: okResult(CCUSAGE_CLAUDE),
      }),
    });

    expect(text).toContain("Historical usage — local logs, not remaining quota");
    expect(text).toContain("Claude Code: 2 day(s), 123,456 tokens, $12.50");
    expect(text).toContain("Codex: unavailable");
    // The historical section is rendered after (separate from) the live sections.
    expect(text.indexOf("live subscription quota")).toBeLessThan(
      text.indexOf("Historical usage — local logs"),
    );
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
