import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createConfigIO, resolveStateEnvFileCandidates } from "./io.js";

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "smithersbot-config-io-"));
  try {
    await run(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function writeFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

describe("config io instance env loading", () => {
  it("keeps stable env candidates unchanged even from a smithersbot-dev cwd", async () => {
    await withTempHome(async (home) => {
      const prevCwd = process.cwd();
      const devCheckout = path.join(
        home,
        "smithersbot-home",
        "agent",
        "workspaces",
        "smithersbot-dev",
      );
      try {
        await fs.mkdir(devCheckout, { recursive: true });
        process.chdir(devCheckout);

        expect(resolveStateEnvFileCandidates({} as NodeJS.ProcessEnv, () => home)).toEqual([
          path.join(home, ".smithersbot", ".env"),
          path.join(home, ".moltbot", ".env"),
          path.join(home, ".clawdbot", ".env"),
        ]);
      } finally {
        process.chdir(prevCwd);
      }
    });
  });

  it("uses dev state and managed-home env candidates only for explicit dev", async () => {
    await withTempHome(async (home) => {
      const candidates = resolveStateEnvFileCandidates(
        { SMITHERSBOT_INSTANCE: "dev" } as NodeJS.ProcessEnv,
        () => home,
      );

      expect(candidates).toEqual([
        path.join(home, ".smithersbot-dev", ".env"),
        path.join(home, "smithersbot-dev-home", ".env"),
      ]);
      expect(candidates).not.toContain(path.join(home, ".smithersbot", ".env"));
    });
  });

  it("loads dev config env without importing stable env", async () => {
    await withTempHome(async (home) => {
      await writeFile(
        path.join(home, ".smithersbot", "smithersbot.json"),
        JSON.stringify({
          channels: { telegram: { botToken: "${STABLE_ONLY}" } },
        }),
      );
      await writeFile(path.join(home, ".smithersbot", ".env"), "STABLE_ONLY=from-stable\n");
      await writeFile(
        path.join(home, ".smithersbot-dev", "smithersbot.json"),
        JSON.stringify({
          channels: { telegram: { botToken: "${DEV_ONLY}" } },
        }),
      );
      await writeFile(path.join(home, ".smithersbot-dev", ".env"), "DEV_ONLY=from-dev\n");

      const env = { SMITHERSBOT_INSTANCE: "dev" } as NodeJS.ProcessEnv;
      const io = createConfigIO({ env, homedir: () => home });

      expect(io.configPath).toBe(path.join(home, ".smithersbot-dev", "smithersbot.json"));
      expect(io.loadConfig().channels?.telegram?.botToken).toBe("from-dev");
      expect(env.DEV_ONLY).toBe("from-dev");
      expect(env.STABLE_ONLY).toBeUndefined();
    });
  });

  it("does not fall back to stable config when explicit dev config is absent", async () => {
    await withTempHome(async (home) => {
      await writeFile(
        path.join(home, ".smithersbot", "smithersbot.json"),
        JSON.stringify({ gateway: { port: 19001 } }),
      );
      await writeFile(path.join(home, ".smithersbot", ".env"), "STABLE_ONLY=from-stable\n");

      const env = { SMITHERSBOT_INSTANCE: "dev" } as NodeJS.ProcessEnv;
      const io = createConfigIO({ env, homedir: () => home });

      expect(io.configPath).toBe(path.join(home, ".smithersbot-dev", "smithersbot.json"));
      expect(io.loadConfig()).toEqual({});
      expect(env.STABLE_ONLY).toBeUndefined();
    });
  });
});
