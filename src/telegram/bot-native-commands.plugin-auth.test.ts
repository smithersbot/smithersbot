import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelGroupPolicy } from "../config/group-policy.js";
import type { MoltbotConfig } from "../config/config.js";
import type { TelegramAccountConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";
import { PUBLIC_TELEGRAM_MENU } from "./public-menu.js";

const getPluginCommandSpecs = vi.hoisted(() => vi.fn());
const listPluginCommands = vi.hoisted(() => vi.fn(() => []));
const matchPluginCommand = vi.hoisted(() => vi.fn());
const executePluginCommand = vi.hoisted(() => vi.fn());

vi.mock("../plugins/commands.js", () => ({
  getPluginCommandSpecs,
  listPluginCommands,
  matchPluginCommand,
  executePluginCommand,
}));

const deliverReplies = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./bot/delivery.js", () => ({ deliverReplies }));

const dispatchReplyWithBufferedBlockDispatcher = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithBufferedBlockDispatcher,
}));

vi.mock("./pairing-store.js", () => ({
  readTelegramAllowFromStore: vi.fn(async () => []),
}));

describe("registerTelegramNativeCommands (plugin auth)", () => {
  beforeEach(() => {
    getPluginCommandSpecs.mockReset();
    listPluginCommands.mockReset();
    listPluginCommands.mockReturnValue([]);
    matchPluginCommand.mockReset();
    executePluginCommand.mockReset();
    deliverReplies.mockClear();
    dispatchReplyWithBufferedBlockDispatcher.mockClear();
  });

  it("allows requireAuth:false plugin command even when sender is unauthorized", async () => {
    const command = {
      name: "plugin",
      description: "Plugin command",
      requireAuth: false,
      handler: vi.fn(),
    } as const;

    getPluginCommandSpecs.mockReturnValue([{ name: "plugin", description: "Plugin command" }]);
    matchPluginCommand.mockReturnValue({ command, args: undefined });
    executePluginCommand.mockResolvedValue({ text: "ok" });

    const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
    const bot = {
      api: {
        setMyCommands: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn(),
      },
      command: (name: string, handler: (ctx: unknown) => Promise<void>) => {
        handlers[name] = handler;
      },
    } as const;

    const cfg = {} as MoltbotConfig;
    const telegramCfg = {} as TelegramAccountConfig;
    const resolveGroupPolicy = () =>
      ({
        allowlistEnabled: false,
        allowed: true,
      }) as ChannelGroupPolicy;

    registerTelegramNativeCommands({
      bot: bot as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      cfg,
      runtime: {} as RuntimeEnv,
      accountId: "default",
      telegramCfg,
      allowFrom: ["999"],
      groupAllowFrom: [],
      replyToMode: "off",
      textLimit: 4000,
      useAccessGroups: false,
      nativeEnabled: false,
      nativeSkillsEnabled: false,
      nativeDisabledExplicit: false,
      resolveGroupPolicy,
      resolveTelegramGroupConfig: () => ({
        groupConfig: undefined,
        topicConfig: undefined,
      }),
      shouldSkipUpdate: () => false,
      opts: { token: "token" },
    });

    const ctx = {
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 111, username: "nope" },
        message_id: 10,
        date: 123456,
      },
      match: "",
    };

    await handlers.plugin?.(ctx);

    expect(matchPluginCommand).toHaveBeenCalled();
    expect(executePluginCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        isAuthorizedSender: false,
      }),
    );
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [{ text: "ok" }],
      }),
    );
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it("publishes only the SmithersBot public menu while retaining hidden handlers", () => {
    getPluginCommandSpecs.mockReturnValue([{ name: "plugin", description: "Plugin command" }]);

    const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
    const bot = {
      api: {
        setMyCommands: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn(),
      },
      on: vi.fn(),
      command: (name: string | string[], handler: (ctx: unknown) => Promise<void>) => {
        const names = Array.isArray(name) ? name : [name];
        for (const commandName of names) {
          handlers[commandName] = handler;
        }
      },
    } as const;

    const cfg = {} as MoltbotConfig;
    const telegramCfg = {} as TelegramAccountConfig;
    const resolveGroupPolicy = () =>
      ({
        allowlistEnabled: false,
        allowed: true,
      }) as ChannelGroupPolicy;

    registerTelegramNativeCommands({
      bot: bot as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      cfg,
      runtime: {} as RuntimeEnv,
      accountId: "default",
      telegramCfg,
      allowFrom: ["999"],
      groupAllowFrom: [],
      replyToMode: "off",
      textLimit: 4000,
      useAccessGroups: false,
      nativeEnabled: true,
      nativeSkillsEnabled: false,
      nativeDisabledExplicit: false,
      resolveGroupPolicy,
      resolveTelegramGroupConfig: () => ({
        groupConfig: undefined,
        topicConfig: undefined,
      }),
      shouldSkipUpdate: () => false,
      opts: { token: "token" },
    });

    expect(bot.api.setMyCommands).toHaveBeenCalledWith(
      PUBLIC_TELEGRAM_MENU.map(({ command }) => expect.objectContaining({ command })),
    );
    expect(
      bot.api.setMyCommands.mock.calls[0]?.[0].map((entry: { command: string }) => entry.command),
    ).toEqual(PUBLIC_TELEGRAM_MENU.map(({ command }) => command));
    expect(handlers.goal_approve).toBeTypeOf("function");
    expect(handlers.whoami).toBeTypeOf("function");
    expect(handlers.goal).toBeTypeOf("function");
    expect(handlers.rc).toBeTypeOf("function");
    expect(bot.api.setMyCommands.mock.calls[0]?.[0]).not.toContainEqual(
      expect.objectContaining({ command: "goal_approve" }),
    );
    expect(bot.api.setMyCommands.mock.calls[0]?.[0]).not.toContainEqual(
      expect.objectContaining({ command: "whoami" }),
    );
    expect(bot.api.setMyCommands.mock.calls[0]?.[0]).not.toContainEqual(
      expect.objectContaining({ command: "plugin" }),
    );
  });

  it("replies directly from registered native /help and /commands handlers", async () => {
    getPluginCommandSpecs.mockReturnValue([]);

    const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
    const bot = {
      api: {
        setMyCommands: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn(),
      },
      on: vi.fn(),
      command: (name: string | string[], handler: (ctx: unknown) => Promise<void>) => {
        const names = Array.isArray(name) ? name : [name];
        for (const commandName of names) {
          handlers[commandName] = handler;
        }
      },
    } as const;

    const cfg = {} as MoltbotConfig;
    const telegramCfg = {} as TelegramAccountConfig;
    const resolveGroupPolicy = () =>
      ({
        allowlistEnabled: false,
        allowed: true,
      }) as ChannelGroupPolicy;

    registerTelegramNativeCommands({
      bot: bot as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      cfg,
      runtime: {} as RuntimeEnv,
      accountId: "default",
      telegramCfg,
      allowFrom: ["111"],
      groupAllowFrom: [],
      replyToMode: "off",
      textLimit: 4000,
      useAccessGroups: false,
      nativeEnabled: true,
      nativeSkillsEnabled: false,
      nativeDisabledExplicit: false,
      resolveGroupPolicy,
      resolveTelegramGroupConfig: () => ({
        groupConfig: undefined,
        topicConfig: undefined,
      }),
      shouldSkipUpdate: () => false,
      opts: { token: "token" },
    });

    const baseMessage = {
      chat: { id: 123, type: "private" },
      from: { id: 111, username: "allowed" },
      date: 123456,
    };

    await handlers.help?.({
      message: { ...baseMessage, message_id: 10, text: "/help" },
      match: "",
    });
    await handlers.commands?.({
      message: { ...baseMessage, message_id: 11, text: "/commands" },
      match: "",
    });

    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expect(deliverReplies.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        chatId: "123",
        messageThreadId: undefined,
        replies: [expect.objectContaining({ text: expect.stringContaining("ℹ️ Help") })],
      }),
    );
    expect(deliverReplies.mock.calls[0]?.[0].replies[0].text).toContain("/commands");
    expect(deliverReplies.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        chatId: "123",
        messageThreadId: undefined,
        replies: [expect.objectContaining({ text: expect.stringContaining("ℹ️ Commands") })],
      }),
    );
    expect(deliverReplies.mock.calls[1]?.[0].replies[0].text).toContain(
      "/new_goal - Create a new goal",
    );
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });
});
