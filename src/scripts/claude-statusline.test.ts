import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(repoRoot, "scripts", "claude-statusline.mjs");

const completePayload = (fiveHour = 42, sevenDay = 10) =>
  JSON.stringify({
    rate_limits: {
      five_hour: {
        used_percentage: fiveHour,
        resets_at: "2026-05-23T18:00:00Z",
      },
      seven_day: {
        used_percentage: sevenDay,
        resets_at: "2026-05-30T00:00:00Z",
      },
    },
  });

const runStatusline = async (input: string, cacheHome: string) =>
  Promise.resolve().then(async () => {
    const stdinFile = path.join(
      cacheHome,
      `claude-statusline-stdin-${process.pid}-${Math.random().toString(16).slice(2)}.json`,
    );
    await fs.writeFile(stdinFile, input, "utf8");
    const stdinFd = fsSync.openSync(stdinFile, "r");
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        XDG_CACHE_HOME: cacheHome,
      },
      stdio: [stdinFd, "pipe", "pipe"],
      timeout: 2_000,
    });
    fsSync.closeSync(stdinFd);
    void fs.rm(stdinFile, { force: true });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`claude-statusline.mjs exited with ${result.status ?? result.signal}`);
    }
    return {
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
  });

const cacheFileFor = (cacheHome: string) => path.join(cacheHome, "claude-code", "statusline.json");

const withTempCache = async (fn: (cacheHome: string) => Promise<void>) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smithersbot-claude-statusline-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};

describe("claude statusline cache script", () => {
  it("writes complete statusline input and echoes the compact status line", async () => {
    await withTempCache(async (cacheHome) => {
      const input = completePayload(42.4, 9.6);

      const result = await runStatusline(input, cacheHome);

      expect(result.stdout).toBe("Claude usage: 5h 42% · 7d 10%");
      await expect(fs.readFile(cacheFileFor(cacheHome), "utf8")).resolves.toBe(input);
    });
  });

  it("replaces an existing cache only when the new input is complete", async () => {
    await withTempCache(async (cacheHome) => {
      const first = completePayload(12, 34);
      const second = completePayload(56, 78);

      await runStatusline(first, cacheHome);
      await runStatusline(second, cacheHome);

      await expect(fs.readFile(cacheFileFor(cacheHome), "utf8")).resolves.toBe(second);
    });
  });

  it("does not overwrite a good cache with incomplete statusline input", async () => {
    await withTempCache(async (cacheHome) => {
      const original = completePayload(25, 50);
      const incomplete = JSON.stringify({
        rate_limits: {
          five_hour: {
            used_percentage: 99,
            resets_at: "2026-05-23T18:00:00Z",
          },
        },
      });

      await runStatusline(original, cacheHome);
      const result = await runStatusline(incomplete, cacheHome);

      expect(result.stdout).toBe("");
      await expect(fs.readFile(cacheFileFor(cacheHome), "utf8")).resolves.toBe(original);
    });
  });

  it("does not overwrite a good cache with invalid or empty input", async () => {
    await withTempCache(async (cacheHome) => {
      const original = completePayload(31, 62);

      await runStatusline(original, cacheHome);
      await runStatusline("{not json", cacheHome);
      await expect(fs.readFile(cacheFileFor(cacheHome), "utf8")).resolves.toBe(original);

      await runStatusline("", cacheHome);
      await expect(fs.readFile(cacheFileFor(cacheHome), "utf8")).resolves.toBe(original);
    });
  });
});
