import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import type { MoltbotConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";

const writeConfigFileMock = vi.fn();
const readConfigFileSnapshotMock = vi.fn();
const reloadOnboardingPluginRegistryMock = vi.fn();

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshot: (...args: unknown[]) => readConfigFileSnapshotMock(...args),
    writeConfigFile: (...args: unknown[]) => writeConfigFileMock(...args),
  };
});

vi.mock("./onboarding/plugin-install.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./onboarding/plugin-install.js")>();
  return {
    ...actual,
    reloadOnboardingPluginRegistry: (...args: unknown[]) =>
      reloadOnboardingPluginRegistryMock(...args),
  };
});

const prevEnv = {
  home: process.env.HOME,
  stateDir: process.env.CLAWDBOT_STATE_DIR,
  configPath: process.env.CLAWDBOT_CONFIG_PATH,
  skipChannels: process.env.CLAWDBOT_SKIP_CHANNELS,
  skipGmail: process.env.CLAWDBOT_SKIP_GMAIL_WATCHER,
  skipCron: process.env.CLAWDBOT_SKIP_CRON,
  skipCanvas: process.env.CLAWDBOT_SKIP_CANVAS_HOST,
  gatewayToken: process.env.CLAWDBOT_GATEWAY_TOKEN,
  gatewayPassword: process.env.CLAWDBOT_GATEWAY_PASSWORD,
};

let tempHome = "";

function makeRuntime(): RuntimeEnv {
  return {
    log: () => {},
    error: (msg: string): never => {
      throw new Error(msg);
    },
    exit: (code: number): never => {
      throw new Error(`exit:${code}`);
    },
  };
}

function makeSnapshot(config: MoltbotConfig) {
  const configPath = process.env.CLAWDBOT_CONFIG_PATH ?? "";
  return {
    path: configPath,
    exists: true,
    raw: JSON.stringify(config),
    parsed: config,
    valid: true,
    config,
    hash: "test",
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

beforeEach(async () => {
  vi.resetModules();
  writeConfigFileMock.mockReset();
  readConfigFileSnapshotMock.mockReset();
  reloadOnboardingPluginRegistryMock.mockReset();

  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-onboard-telegram-"));
  process.env.HOME = tempHome;
  process.env.CLAWDBOT_STATE_DIR = tempHome;
  process.env.CLAWDBOT_CONFIG_PATH = path.join(tempHome, "moltbot.json");
  process.env.CLAWDBOT_SKIP_CHANNELS = "1";
  process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = "1";
  process.env.CLAWDBOT_SKIP_CRON = "1";
  process.env.CLAWDBOT_SKIP_CANVAS_HOST = "1";
  delete process.env.CLAWDBOT_GATEWAY_TOKEN;
  delete process.env.CLAWDBOT_GATEWAY_PASSWORD;

  const actualConfig =
    await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  readConfigFileSnapshotMock.mockImplementation(() => actualConfig.readConfigFileSnapshot());
  writeConfigFileMock.mockImplementation((cfg: MoltbotConfig) => actualConfig.writeConfigFile(cfg));
  reloadOnboardingPluginRegistryMock.mockImplementation(() => {});

  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
  );
});

afterEach(async () => {
  if (tempHome) {
    await fs.rm(tempHome, { recursive: true, force: true });
  }

  process.env.HOME = prevEnv.home;
  process.env.CLAWDBOT_STATE_DIR = prevEnv.stateDir;
  process.env.CLAWDBOT_CONFIG_PATH = prevEnv.configPath;
  process.env.CLAWDBOT_SKIP_CHANNELS = prevEnv.skipChannels;
  process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = prevEnv.skipGmail;
  process.env.CLAWDBOT_SKIP_CRON = prevEnv.skipCron;
  process.env.CLAWDBOT_SKIP_CANVAS_HOST = prevEnv.skipCanvas;
  process.env.CLAWDBOT_GATEWAY_TOKEN = prevEnv.gatewayToken;
  process.env.CLAWDBOT_GATEWAY_PASSWORD = prevEnv.gatewayPassword;

  setActivePluginRegistry(createTestRegistry());
});

describe("onboard (non-interactive): --telegram-token", () => {
  it("writes botToken, enables Telegram plugin, and sets dmPolicy to pairing", async () => {
    const token = "12345:telegram-token";
    const { runNonInteractiveOnboarding } = await import("./onboard-non-interactive.js");

    await runNonInteractiveOnboarding(
      {
        nonInteractive: true,
        mode: "local",
        authChoice: "skip",
        skipSkills: true,
        skipHealth: true,
        installDaemon: false,
        json: true,
        telegramToken: token,
      },
      makeRuntime(),
    );

    const configPath = process.env.CLAWDBOT_CONFIG_PATH as string;
    const raw = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
    const cfg = raw as MoltbotConfig;
    const routing = raw["routing"] as { dmPolicy?: string } | undefined;

    expect(cfg.channels?.telegram?.botToken).toBe(token);
    expect(cfg.channels?.telegram?.dmPolicy).toBe("pairing");
    expect(cfg.plugins?.entries?.telegram?.enabled).toBe(true);
    expect(routing?.dmPolicy).toBeUndefined();
  }, 60_000);

  it("writes merged config once with both base onboarding and Telegram setup", async () => {
    const token = "54321:telegram-single-write-token";
    const baseConfig: MoltbotConfig = {
      update: { channel: "beta" },
      channels: {
        defaults: {
          groupPolicy: "allowlist",
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4.1",
          },
        },
      },
    };
    readConfigFileSnapshotMock.mockResolvedValue(makeSnapshot(baseConfig));

    const { runNonInteractiveOnboarding } = await import("./onboard-non-interactive.js");
    await runNonInteractiveOnboarding(
      {
        nonInteractive: true,
        mode: "local",
        authChoice: "skip",
        skipSkills: true,
        skipHealth: true,
        installDaemon: false,
        json: true,
        telegramToken: token,
      },
      makeRuntime(),
    );

    expect(writeConfigFileMock).toHaveBeenCalledTimes(1);
    const writtenConfig = writeConfigFileMock.mock.calls[0]?.[0] as MoltbotConfig;
    expect(writtenConfig.gateway?.mode).toBe("local");
    expect(writtenConfig.update?.channel).toBe("beta");
    expect(writtenConfig.channels?.defaults?.groupPolicy).toBe("allowlist");
    expect(writtenConfig.channels?.telegram?.botToken).toBe(token);
    expect(writtenConfig.channels?.telegram?.dmPolicy).toBe("pairing");
    expect(writtenConfig.plugins?.entries?.telegram?.enabled).toBe(true);
  }, 60_000);

  it("preserves existing config fields when adding Telegram settings", async () => {
    const token = "99999:telegram-preserve-token";
    const configPath = process.env.CLAWDBOT_CONFIG_PATH as string;
    const existingConfig: MoltbotConfig = {
      agents: {
        defaults: {
          workspace: path.join(tempHome, "existing-workspace"),
          model: {
            primary: "anthropic/claude-3-7-sonnet",
          },
        },
      },
      gateway: {
        bind: "loopback",
        port: 19123,
      },
      skills: {
        install: {
          nodeManager: "pnpm",
        },
      },
      plugins: {
        allow: ["discord"],
        entries: {
          discord: {
            enabled: true,
          },
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(existingConfig, null, 2), "utf8");

    const { runNonInteractiveOnboarding } = await import("./onboard-non-interactive.js");
    await runNonInteractiveOnboarding(
      {
        nonInteractive: true,
        mode: "local",
        authChoice: "skip",
        skipSkills: true,
        skipHealth: true,
        installDaemon: false,
        json: true,
        telegramToken: token,
      },
      makeRuntime(),
    );

    const cfg = JSON.parse(await fs.readFile(configPath, "utf8")) as MoltbotConfig;
    const discordEntry = cfg.plugins?.entries?.discord as { enabled?: boolean } | undefined;

    expect(cfg.agents?.defaults?.model?.primary).toBe("anthropic/claude-3-7-sonnet");
    expect(cfg.gateway?.bind).toBe("loopback");
    expect(cfg.gateway?.port).toBe(19123);
    expect(cfg.skills?.install?.nodeManager).toBe("pnpm");
    expect(discordEntry?.enabled).toBe(true);
    expect(cfg.plugins?.allow).toEqual(expect.arrayContaining(["discord", "telegram"]));
    expect(cfg.channels?.telegram?.botToken).toBe(token);
    expect(cfg.channels?.telegram?.dmPolicy).toBe("pairing");
  }, 60_000);
});
