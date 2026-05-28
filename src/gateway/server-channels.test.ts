import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { MoltbotConfig } from "../config/config.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import { createChannelManager } from "./server-channels.js";

const { computeBackoff, sleepWithAbort } = vi.hoisted(() => ({
  computeBackoff: vi.fn(() => 0),
  sleepWithAbort: vi.fn(async () => undefined),
}));

vi.mock("../infra/backoff.js", () => ({
  computeBackoff,
  sleepWithAbort,
}));

type Deferred<T = void> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type StartAccount = NonNullable<NonNullable<ChannelPlugin["gateway"]>["startAccount"]>;
type StartAccountContext = Parameters<StartAccount>[0];

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createRegistry(plugin: ChannelPlugin): PluginRegistry {
  return {
    plugins: [],
    tools: [],
    hooks: [],
    typedHooks: [],
    channels: [{ pluginId: plugin.id, source: "test", plugin }],
    providers: [],
    gatewayHandlers: {},
    httpHandlers: [],
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    commands: [],
    diagnostics: [],
  };
}

function createTelegramPlugin(startAccount: StartAccount): ChannelPlugin {
  return {
    id: "telegram",
    meta: {
      id: "telegram",
      label: "Telegram",
      selectionLabel: "Telegram",
      docsPath: "/channels/telegram",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({ token: "123:test" }),
      isConfigured: async () => true,
    },
    gateway: { startAccount },
  };
}

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

function createLog(): SubsystemLogger {
  const log = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(),
  } as unknown as SubsystemLogger;
  vi.mocked(log.child).mockReturnValue(log);
  return log;
}

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: (code): never => {
    throw new Error(`exit ${code}`);
  },
};

describe("createChannelManager channel recovery", () => {
  beforeEach(() => {
    computeBackoff.mockReset();
    computeBackoff.mockReturnValue(0);
    sleepWithAbort.mockReset();
    sleepWithAbort.mockResolvedValue(undefined);
  });

  afterEach(() => {
    setActivePluginRegistry(createRegistry(createTelegramPlugin(vi.fn(async () => undefined))));
  });

  it("restarts a channel account after a recoverable polling exit", async () => {
    const firstRun = createDeferred();
    const secondRun = createDeferred();
    const startAccount = vi
      .fn()
      .mockImplementationOnce(() => firstRun.promise)
      .mockImplementationOnce(() => secondRun.promise);
    const plugin = createTelegramPlugin(startAccount);
    setActivePluginRegistry(createRegistry(plugin));
    const log = createLog();
    const manager = createChannelManager({
      loadConfig: () => ({ channels: { telegram: {} } }) as MoltbotConfig,
      channelLogs: { telegram: log },
      channelRuntimeEnvs: { telegram: runtime },
    });

    await manager.startChannel("telegram", "default");
    firstRun.reject(new Error("Request to 'getUpdates' timed out after 500 seconds"));

    await vi.waitFor(() => expect(startAccount).toHaveBeenCalledTimes(2));

    expect(computeBackoff).toHaveBeenCalledTimes(1);
    expect(sleepWithAbort).toHaveBeenCalledWith(0, expect.any(AbortSignal));
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("classification=recoverable"));
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("provider restart-attempt"));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("provider restart-success"));

    secondRun.resolve();
    await vi.waitFor(() =>
      expect(manager.getRuntimeSnapshot().channelAccounts.telegram?.default?.running).toBe(false),
    );
  });

  it("does not restart after a controlled AbortError from a signaled abort", async () => {
    const startAccount = vi.fn((ctx: StartAccountContext) => {
      return new Promise<void>((_resolve, reject) => {
        ctx.abortSignal.addEventListener(
          "abort",
          () => {
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
          },
          { once: true },
        );
      });
    });
    const plugin = createTelegramPlugin(startAccount);
    setActivePluginRegistry(createRegistry(plugin));
    const log = createLog();
    const manager = createChannelManager({
      loadConfig: () => ({ channels: { telegram: {} } }) as MoltbotConfig,
      channelLogs: { telegram: log },
      channelRuntimeEnvs: { telegram: runtime },
    });

    await manager.startChannel("telegram", "default");
    await manager.stopChannel("telegram", "default");

    expect(startAccount).toHaveBeenCalledTimes(1);
    expect(computeBackoff).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("classification=fatal"));
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("aborted=true"));
  });
});
