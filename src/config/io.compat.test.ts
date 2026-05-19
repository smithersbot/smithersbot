import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createConfigIO } from "./io.js";

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-config-"));
  try {
    await run(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function writeConfig(
  home: string,
  dirname: ".smithersbot" | ".moltbot" | ".clawdbot",
  port: number,
  filename: "smithersbot.json" | "moltbot.json" | "clawdbot.json" = "smithersbot.json",
) {
  const dir = path.join(home, dirname);
  await fs.mkdir(dir, { recursive: true });
  const configPath = path.join(dir, filename);
  await fs.writeFile(configPath, JSON.stringify({ gateway: { port } }, null, 2));
  return configPath;
}

describe("config io compat (canonical + legacy folders)", () => {
  it("prefers ~/.smithersbot/smithersbot.json when multiple configs exist", async () => {
    await withTempHome(async (home) => {
      const newConfigPath = await writeConfig(home, ".smithersbot", 19001);
      await writeConfig(home, ".moltbot", 19002, "moltbot.json");
      await writeConfig(home, ".clawdbot", 18789);

      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
      });
      expect(io.configPath).toBe(newConfigPath);
      expect(io.loadConfig().gateway?.port).toBe(19001);
    });
  });

  it("falls back to ~/.moltbot/moltbot.json when only Moltbot config exists", async () => {
    await withTempHome(async (home) => {
      const legacyConfigPath = await writeConfig(home, ".moltbot", 20001, "moltbot.json");

      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
      });

      expect(io.configPath).toBe(legacyConfigPath);
      expect(io.loadConfig().gateway?.port).toBe(20001);
    });
  });

  it("falls back to ~/.clawdbot/moltbot.json when only legacy folder exists", async () => {
    await withTempHome(async (home) => {
      const legacyConfigPath = await writeConfig(home, ".clawdbot", 20005, "moltbot.json");

      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
      });

      expect(io.configPath).toBe(legacyConfigPath);
      expect(io.loadConfig().gateway?.port).toBe(20005);
    });
  });

  it("falls back to ~/.clawdbot/clawdbot.json when only legacy filename exists", async () => {
    await withTempHome(async (home) => {
      const legacyConfigPath = await writeConfig(home, ".clawdbot", 20002, "clawdbot.json");

      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
      });

      expect(io.configPath).toBe(legacyConfigPath);
      expect(io.loadConfig().gateway?.port).toBe(20002);
    });
  });

  it("prefers smithersbot.json over legacy filenames in the same dir", async () => {
    await withTempHome(async (home) => {
      const preferred = await writeConfig(home, ".clawdbot", 20003, "smithersbot.json");
      await writeConfig(home, ".clawdbot", 20004, "moltbot.json");
      await writeConfig(home, ".clawdbot", 20004, "clawdbot.json");

      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
      });

      expect(io.configPath).toBe(preferred);
      expect(io.loadConfig().gateway?.port).toBe(20003);
    });
  });

  it("honors explicit legacy config path env override", async () => {
    await withTempHome(async (home) => {
      const newConfigPath = await writeConfig(home, ".smithersbot", 19002);
      const legacyConfigPath = await writeConfig(home, ".clawdbot", 20002, "moltbot.json");

      const io = createConfigIO({
        env: { CLAWDBOT_CONFIG_PATH: legacyConfigPath } as NodeJS.ProcessEnv,
        homedir: () => home,
      });

      expect(io.configPath).not.toBe(newConfigPath);
      expect(io.configPath).toBe(legacyConfigPath);
      expect(io.loadConfig().gateway?.port).toBe(20002);
    });
  });
});
