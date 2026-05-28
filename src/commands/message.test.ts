import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ChannelMessageActionAdapter,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../channels/plugins/types.js";
import type { CliDeps } from "../cli/deps.js";
import type { RuntimeEnv } from "../runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
const loadMessageCommand = async () => await import("./message.js");

let testConfig: Record<string, unknown> = {};
vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => testConfig,
  };
});

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
  randomIdempotencyKey: () => "idem-1",
}));

const handleTelegramAction = vi.fn(async () => ({ details: { ok: true } }));
vi.mock("../agents/tools/telegram-actions.js", () => ({
  handleTelegramAction: (...args: unknown[]) => handleTelegramAction(...args),
}));

const originalTelegramToken = process.env.TELEGRAM_BOT_TOKEN;

const setRegistry = async (registry: ReturnType<typeof createTestRegistry>) => {
  const { setActivePluginRegistry } = await import("../plugins/runtime.js");
  setActivePluginRegistry(registry);
};

beforeEach(async () => {
  process.env.TELEGRAM_BOT_TOKEN = "";
  testConfig = {};
  vi.resetModules();
  await setRegistry(createTestRegistry([]));
  callGatewayMock.mockReset();
  handleTelegramAction.mockReset();
});

afterAll(() => {
  process.env.TELEGRAM_BOT_TOKEN = originalTelegramToken;
});

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

const makeDeps = (overrides: Partial<CliDeps> = {}): CliDeps => ({
  sendMessageTelegram: vi.fn(),
  ...overrides,
});

const createStubPlugin = (params: {
  id: ChannelPlugin["id"];
  label?: string;
  actions?: ChannelMessageActionAdapter;
  outbound?: ChannelOutboundAdapter;
}): ChannelPlugin => ({
  id: params.id,
  meta: {
    id: params.id,
    label: params.label ?? String(params.id),
    selectionLabel: params.label ?? String(params.id),
    docsPath: `/channels/${params.id}`,
    blurb: "test stub.",
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({}),
    isConfigured: async () => true,
  },
  actions: params.actions,
  outbound: params.outbound,
});

describe("messageCommand", () => {
  it("defaults channel when only one configured", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "token-abc";
    await setRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: createStubPlugin({
            id: "telegram",
            label: "Telegram",
            actions: {
              listActions: () => ["send"],
              handleAction: async ({ action, params, cfg, accountId }) =>
                await handleTelegramAction(
                  { action, to: params.to, accountId: accountId ?? undefined },
                  cfg,
                ),
            },
          }),
        },
      ]),
    );
    const deps = makeDeps();
    const { messageCommand } = await loadMessageCommand();
    await messageCommand(
      {
        target: "123456",
        message: "hi",
      },
      deps,
      runtime,
    );
    expect(handleTelegramAction).toHaveBeenCalled();
  });

  it("requires channel when multiple configured", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "token-abc";
    await setRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: createStubPlugin({
            id: "telegram",
            label: "Telegram",
            actions: {
              listActions: () => ["send"],
              handleAction: async ({ action, params, cfg, accountId }) =>
                await handleTelegramAction(
                  { action, to: params.to, accountId: accountId ?? undefined },
                  cfg,
                ),
            },
          }),
        },
        {
          pluginId: "imessage",
          source: "test",
          plugin: createStubPlugin({
            id: "imessage",
            label: "iMessage",
            actions: {
              listActions: () => ["send"],
              handleAction: async () => ({ details: { ok: true } }),
            },
          }),
        },
      ]),
    );
    const deps = makeDeps();
    const { messageCommand } = await loadMessageCommand();
    await expect(
      messageCommand(
        {
          target: "123",
          message: "hi",
        },
        deps,
        runtime,
      ),
    ).rejects.toThrow(/Channel is required/);
  });
});
