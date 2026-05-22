import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelGroupPolicy } from "../config/group-policy.js";
import type { MoltbotConfig } from "../config/config.js";
import type { TelegramAccountConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";

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

describe("registerTelegramNativeCommands gateway_status", () => {
  beforeEach(() => {
    getPluginCommandSpecs.mockReset();
    getPluginCommandSpecs.mockReturnValue([]);
    matchPluginCommand.mockReset();
    executePluginCommand.mockReset();
    deliverReplies.mockClear();
    dispatchReplyWithBufferedBlockDispatcher.mockClear();
  });

  it("publishes and routes /gateway_status through the read-only native handler", async () => {
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
    const resolveGroupPolicy = () =>
      ({
        allowlistEnabled: false,
        allowed: true,
      }) as ChannelGroupPolicy;

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
      resolveGroupPolicy,
      resolveTelegramGroupConfig: () => ({
        groupConfig: undefined,
        topicConfig: undefined,
      }),
      shouldSkipUpdate: () => false,
      opts: { token: "test-telegram-token" },
    });

    const published = bot.api.setMyCommands.mock.calls[0]?.[0] as Array<{
      command: string;
      description: string;
    }>;
    expect(published).toContainEqual(
      expect.objectContaining({
        command: "gateway_status",
        description: "Show gateway process and service status",
      }),
    );
    expect(handlers.gateway_status).toBeTypeOf("function");

    await handlers.gateway_status?.({
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 111, username: "allowed" },
        message_id: 10,
        date: 123456,
      },
      match: "",
    });

    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      123,
      expect.stringContaining("Gateway status"),
    );
    expect(bot.api.sendMessage.mock.calls[0]?.[1]).toContain("PID:");
    expect(bot.api.sendMessage.mock.calls[0]?.[1]).not.toContain("test-telegram-token");
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: expect.stringContaining("Gateway status") })],
      }),
    );
  });
});
