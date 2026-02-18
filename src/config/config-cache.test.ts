import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearConfigCacheForTest, loadConfig, writeConfigFile } from "./io.js";

function setEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

describe("config cache", () => {
  let testDir = "";
  let configPath = "";
  let originalConfigPath: string | undefined;
  let originalCacheMs: string | undefined;
  let originalDisableCache: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "moltbot-config-cache-"));
    configPath = path.join(testDir, "moltbot.json");

    originalConfigPath = process.env.CLAWDBOT_CONFIG_PATH;
    originalCacheMs = process.env.CLAWDBOT_CONFIG_CACHE_MS;
    originalDisableCache = process.env.CLAWDBOT_DISABLE_CONFIG_CACHE;

    setEnvVar("CLAWDBOT_CONFIG_PATH", configPath);
    setEnvVar("CLAWDBOT_CONFIG_CACHE_MS", "1000");
    setEnvVar("CLAWDBOT_DISABLE_CONFIG_CACHE", undefined);

    clearConfigCacheForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearConfigCacheForTest();

    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }

    setEnvVar("CLAWDBOT_CONFIG_PATH", originalConfigPath);
    setEnvVar("CLAWDBOT_CONFIG_CACHE_MS", originalCacheMs);
    setEnvVar("CLAWDBOT_DISABLE_CONFIG_CACHE", originalDisableCache);
  });

  async function writeGatewayConfig(port: number): Promise<void> {
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    await fs.promises.writeFile(
      configPath,
      JSON.stringify({ gateway: { port } }, null, 2),
      "utf-8",
    );
  }

  it("returns cached config when mtime is unchanged", async () => {
    await writeGatewayConfig(19001);
    expect(loadConfig().gateway?.port).toBe(19001);
    expect(loadConfig().gateway?.port).toBe(19001);
  });

  it("invalidates cache when mtime changes within TTL", async () => {
    await writeGatewayConfig(19011);
    expect(loadConfig().gateway?.port).toBe(19011);

    await writeGatewayConfig(19012);
    const nextMtimeMs = fs.statSync(configPath).mtimeMs + 2_000;
    fs.utimesSync(configPath, nextMtimeMs / 1000, nextMtimeMs / 1000);

    expect(loadConfig().gateway?.port).toBe(19012);
  });

  it("keeps cache valid when mtime is preserved", async () => {
    await writeGatewayConfig(19007);
    const fixedMtimeMs = fs.statSync(configPath).mtimeMs;
    fs.utimesSync(configPath, fixedMtimeMs / 1000, fixedMtimeMs / 1000);
    expect(loadConfig().gateway?.port).toBe(19007);

    await writeGatewayConfig(19017);
    fs.utimesSync(configPath, fixedMtimeMs / 1000, fixedMtimeMs / 1000);
    expect(loadConfig().gateway?.port).toBe(19007);
  });

  it("reloads config after TTL expires", async () => {
    setEnvVar("CLAWDBOT_CONFIG_CACHE_MS", "10");
    await writeGatewayConfig(19002);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    expect(loadConfig().gateway?.port).toBe(19002);
    await writeGatewayConfig(19012);
    vi.advanceTimersByTime(11);
    expect(loadConfig().gateway?.port).toBe(19012);
  });

  it("skips cache when CLAWDBOT_DISABLE_CONFIG_CACHE is set", async () => {
    setEnvVar("CLAWDBOT_DISABLE_CONFIG_CACHE", "1");
    await writeGatewayConfig(19003);
    expect(loadConfig().gateway?.port).toBe(19003);

    await writeGatewayConfig(19013);
    expect(loadConfig().gateway?.port).toBe(19013);
  });

  it("clears cached config on writeConfigFile", async () => {
    await writeGatewayConfig(19004);
    expect(loadConfig().gateway?.port).toBe(19004);

    await writeConfigFile({ gateway: { port: 19005 } });
    expect(loadConfig().gateway?.port).toBe(19005);
  });

  it("does not leak caller mutations across cached loads", async () => {
    await writeGatewayConfig(19006);
    const first = loadConfig();
    if (!first.gateway) throw new Error("expected gateway config");
    first.gateway.port = 19999;

    const second = loadConfig();
    expect(second.gateway?.port).toBe(19006);
  });

  it("gracefully handles config file deletion", async () => {
    await writeGatewayConfig(19008);
    expect(loadConfig().gateway?.port).toBe(19008);

    await fs.promises.unlink(configPath);
    expect(loadConfig()).toEqual({});
  });
});
