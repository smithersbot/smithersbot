import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelGroupPolicy } from "../config/group-policy.js";
import type { MoltbotConfig } from "../config/config.js";
import type { TelegramAccountConfig } from "../config/types.js";
import { NIGHTWATCH_DEFAULTS } from "../cron/nightwatch.js";
import {
  NIGHTWATCH_COMMAND_SPECS,
  registerTelegramNightwatchCommand,
} from "./nightwatch-commands.js";

const mockResolveChannelConfigWrites = vi.hoisted(() => vi.fn(() => true));
vi.mock("../channels/plugins/config-writes.js", () => ({
  resolveChannelConfigWrites: (...args: unknown[]) => mockResolveChannelConfigWrites(...args),
}));

const mockLoadConfig = vi.hoisted(() => vi.fn(() => ({})));
vi.mock("../config/config.js", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

const mockWriteConfigFile = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../config/io.js", () => ({
  writeConfigFile: (...args: unknown[]) => mockWriteConfigFile(...args),
}));

const mockResolveTelegramCommandAuth = vi.hoisted(() => vi.fn());
vi.mock("./telegram-auth.js", () => ({
  resolveTelegramCommandAuth: (...args: unknown[]) => mockResolveTelegramCommandAuth(...args),
}));

function makeHarness(params?: { cfg?: MoltbotConfig; accountId?: string }) {
  const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 99 });
  const bot = {
    api: {
      sendMessage,
    },
    command: (name: string | string[], handler: (ctx: unknown) => Promise<void>) => {
      if (Array.isArray(name)) {
        for (const entry of name) handlers[entry] = handler;
        return;
      }
      handlers[name] = handler;
    },
  } as unknown as import("grammy").Bot;

  registerTelegramNightwatchCommand({
    bot,
    cfg: (params?.cfg ?? {}) as MoltbotConfig,
    accountId: params?.accountId ?? "default",
    telegramCfg: {} as TelegramAccountConfig,
    allowFrom: ["42"],
    groupAllowFrom: [],
    useAccessGroups: false,
    resolveGroupPolicy: () =>
      ({
        allowlistEnabled: false,
        allowed: true,
      }) as ChannelGroupPolicy,
    resolveTelegramGroupConfig: () => ({
      groupConfig: undefined,
      topicConfig: undefined,
    }),
    shouldSkipUpdate: () => false,
  });

  const handler = handlers.nightwatch;
  if (!handler) {
    throw new Error("nightwatch handler was not registered");
  }

  return {
    handler,
    sendMessage,
  };
}

function makeCtx(params?: {
  match?: string;
  chatId?: number;
  chatType?: "private" | "group" | "supergroup";
  messageThreadId?: number;
}) {
  const ctxMessage: Record<string, unknown> = {
    chat: {
      id: params?.chatId ?? 42,
      type: params?.chatType ?? "private",
    },
    from: {
      id: 42,
      username: "tester",
    },
    message_id: 7,
    date: 123_456,
  };
  if (typeof params?.messageThreadId === "number") {
    ctxMessage.message_thread_id = params.messageThreadId;
  }
  return {
    match: params?.match ?? "",
    message: ctxMessage,
  };
}

function latestSentText(sendMessage: ReturnType<typeof vi.fn>): string {
  return String(sendMessage.mock.calls.at(-1)?.[1] ?? "");
}

function baseNightwatchConfig(): MoltbotConfig {
  return {
    cron: {
      nightwatch: {
        enabled: true,
        cronExpr: "15 4 * * *",
        timezone: "America/Chicago",
        repoPath: "~/moltbot",
        telegramChatId: "1000",
        telegramAccountId: "default",
      },
    },
  };
}

describe("nightwatch Telegram command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveChannelConfigWrites.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({});
    mockWriteConfigFile.mockResolvedValue(undefined);
    mockResolveTelegramCommandAuth.mockResolvedValue({
      chatId: 42,
      isGroup: false,
      isForum: false,
      senderId: "42",
      senderUsername: "tester",
      commandAuthorized: true,
    });
  });

  it("exports the /nightwatch command spec", () => {
    expect(NIGHTWATCH_COMMAND_SPECS).toEqual([
      {
        command: "nightwatch",
        description: "Configure nightwatch daily code review schedule",
      },
    ]);
  });

  it("shows status defaults with no args and omits last-run details", async () => {
    mockLoadConfig.mockReturnValue({});
    const harness = makeHarness();

    await harness.handler(makeCtx());

    const sentText = latestSentText(harness.sendMessage);
    expect(sentText).toContain("Nightwatch: disabled");
    expect(sentText).toContain(`Schedule: 3:00 AM (${NIGHTWATCH_DEFAULTS.cronExpr})`);
    expect(sentText).toContain(`Timezone: ${NIGHTWATCH_DEFAULTS.timezone}`);
    expect(sentText).toContain(`Repo path: ${NIGHTWATCH_DEFAULTS.repoPath}`);
    expect(sentText).toContain("Telegram chat: (not set)");
    expect(sentText.toLowerCase()).not.toContain("last run");
    expect(mockWriteConfigFile).not.toHaveBeenCalled();
  });

  it("shows configured status values and stringifies numeric telegramChatId", async () => {
    mockLoadConfig.mockReturnValue({
      cron: {
        nightwatch: {
          enabled: true,
          cronExpr: "30 15 * * *",
          timezone: "America/Denver",
          repoPath: "/repo",
          telegramChatId: 123456,
        },
      },
    });
    const harness = makeHarness();

    await harness.handler(makeCtx());

    const sentText = latestSentText(harness.sendMessage);
    expect(sentText).toContain("Nightwatch: enabled");
    expect(sentText).toContain("Schedule: 3:30 PM (30 15 * * *)");
    expect(sentText).toContain("Timezone: America/Denver");
    expect(sentText).toContain("Repo path: /repo");
    expect(sentText).toContain("Telegram chat: 123456");
  });

  it("blocks unauthorized senders via resolveTelegramCommandAuth", async () => {
    mockResolveTelegramCommandAuth.mockResolvedValue(null);
    const harness = makeHarness();

    await harness.handler(makeCtx({ match: "on" }));

    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(mockWriteConfigFile).not.toHaveBeenCalled();
  });

  it.each([
    ["on", "enabled", true],
    ["off", "enabled", false],
  ])("handles %s and preserves existing fields", async (match, key, value) => {
    const stored = baseNightwatchConfig();
    mockLoadConfig.mockReturnValue(stored);
    const cfg = {} as MoltbotConfig;
    const harness = makeHarness({ cfg });

    await harness.handler(makeCtx({ match }));

    expect(mockResolveChannelConfigWrites).toHaveBeenCalledWith({
      cfg,
      channelId: "telegram",
      accountId: "default",
    });
    expect(mockWriteConfigFile).toHaveBeenCalledOnce();
    const written = mockWriteConfigFile.mock.calls[0]?.[0] as MoltbotConfig;
    expect(written.cron?.nightwatch).toMatchObject({
      [key]: value,
      cronExpr: "15 4 * * *",
      timezone: "America/Chicago",
      repoPath: "~/moltbot",
      telegramChatId: "1000",
      telegramAccountId: "default",
    });
    const gateOrder = mockResolveChannelConfigWrites.mock.invocationCallOrder[0] ?? 0;
    const writeOrder = mockWriteConfigFile.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    expect(gateOrder).toBeLessThan(writeOrder);
  });

  it.each([
    ["time 03:00", "0 3 * * *"],
    ["time 15:30", "30 15 * * *"],
    ["time 00:00", "0 0 * * *"],
    ["time 3:00", "0 3 * * *"],
  ])("converts %s to %s and preserves other fields", async (match, cronExpr) => {
    const stored = baseNightwatchConfig();
    mockLoadConfig.mockReturnValue(stored);
    const cfg = {} as MoltbotConfig;
    const harness = makeHarness({ cfg });

    await harness.handler(makeCtx({ match }));

    expect(mockResolveChannelConfigWrites).toHaveBeenCalledWith({
      cfg,
      channelId: "telegram",
      accountId: "default",
    });
    expect(mockWriteConfigFile).toHaveBeenCalledOnce();
    const written = mockWriteConfigFile.mock.calls[0]?.[0] as MoltbotConfig;
    expect(written.cron?.nightwatch).toMatchObject({
      enabled: true,
      cronExpr,
      timezone: "America/Chicago",
      repoPath: "~/moltbot",
      telegramChatId: "1000",
      telegramAccountId: "default",
    });
    const gateOrder = mockResolveChannelConfigWrites.mock.invocationCallOrder[0] ?? 0;
    const writeOrder = mockWriteConfigFile.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    expect(gateOrder).toBeLessThan(writeOrder);
  });

  it("rejects invalid time values", async () => {
    const harness = makeHarness();

    await harness.handler(makeCtx({ match: "time 25:00" }));
    await harness.handler(makeCtx({ match: "time abc" }));

    expect(mockWriteConfigFile).not.toHaveBeenCalled();
    const sent = harness.sendMessage.mock.calls.map((call) => String(call[1] ?? ""));
    expect(sent.some((text) => text.includes("Invalid time"))).toBe(true);
  });

  it("updates timezone and preserves existing fields", async () => {
    const stored = baseNightwatchConfig();
    mockLoadConfig.mockReturnValue(stored);
    const cfg = {} as MoltbotConfig;
    const harness = makeHarness({ cfg });

    await harness.handler(makeCtx({ match: "tz America/New_York" }));

    expect(mockResolveChannelConfigWrites).toHaveBeenCalledWith({
      cfg,
      channelId: "telegram",
      accountId: "default",
    });
    const written = mockWriteConfigFile.mock.calls[0]?.[0] as MoltbotConfig;
    expect(written.cron?.nightwatch).toMatchObject({
      enabled: true,
      cronExpr: "15 4 * * *",
      timezone: "America/New_York",
      repoPath: "~/moltbot",
      telegramChatId: "1000",
      telegramAccountId: "default",
    });
    const gateOrder = mockResolveChannelConfigWrites.mock.invocationCallOrder[0] ?? 0;
    const writeOrder = mockWriteConfigFile.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    expect(gateOrder).toBeLessThan(writeOrder);
  });

  it("rejects invalid timezone values", async () => {
    const harness = makeHarness();

    await harness.handler(makeCtx({ match: "tz Invalid/Zone" }));

    expect(mockWriteConfigFile).not.toHaveBeenCalled();
    expect(latestSentText(harness.sendMessage)).toContain("Invalid timezone");
  });

  it("chat subcommand sets chat/account and preserves schedule fields", async () => {
    const stored = baseNightwatchConfig();
    mockLoadConfig.mockReturnValue(stored);
    const cfg = {} as MoltbotConfig;
    const harness = makeHarness({ cfg, accountId: "ops-account" });

    await harness.handler(makeCtx({ match: "chat", chatId: 777777 }));

    expect(mockResolveChannelConfigWrites).toHaveBeenCalledWith({
      cfg,
      channelId: "telegram",
      accountId: "ops-account",
    });
    const written = mockWriteConfigFile.mock.calls[0]?.[0] as MoltbotConfig;
    expect(written.cron?.nightwatch).toMatchObject({
      enabled: true,
      cronExpr: "15 4 * * *",
      timezone: "America/Chicago",
      repoPath: "~/moltbot",
      telegramChatId: "777777",
      telegramAccountId: "ops-account",
    });
    const gateOrder = mockResolveChannelConfigWrites.mock.invocationCallOrder[0] ?? 0;
    const writeOrder = mockWriteConfigFile.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    expect(gateOrder).toBeLessThan(writeOrder);
    expect(latestSentText(harness.sendMessage)).toContain(
      "Nightwatch plans will be sent to this chat.",
    );
  });

  it("chat subcommand stores thread id when command is used in a thread", async () => {
    const stored = baseNightwatchConfig();
    mockLoadConfig.mockReturnValue(stored);
    const harness = makeHarness({ accountId: "ops-account" });

    await harness.handler(makeCtx({ match: "chat", chatId: 444, messageThreadId: 99 }));

    const written = mockWriteConfigFile.mock.calls[0]?.[0] as MoltbotConfig;
    expect(written.cron?.nightwatch).toMatchObject({
      telegramChatId: "444",
      telegramAccountId: "ops-account",
      telegramThreadId: 99,
    });
    const gateOrder = mockResolveChannelConfigWrites.mock.invocationCallOrder[0] ?? 0;
    const writeOrder = mockWriteConfigFile.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    expect(gateOrder).toBeLessThan(writeOrder);
  });

  it.each(["on", "off", "time 03:00", "tz America/New_York", "chat"])(
    "rejects %s when config writes are disabled",
    async (match) => {
      mockResolveChannelConfigWrites.mockReturnValue(false);
      mockLoadConfig.mockReturnValue(baseNightwatchConfig());
      const cfg = {} as MoltbotConfig;
      const harness = makeHarness({ cfg });

      await harness.handler(makeCtx({ match }));

      expect(mockResolveChannelConfigWrites).toHaveBeenCalledWith({
        cfg,
        channelId: "telegram",
        accountId: "default",
      });
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(latestSentText(harness.sendMessage)).toContain(
        "Config writes are disabled for this Telegram account.",
      );
    },
  );
});
