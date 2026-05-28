import type { SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildCodexQuotaCommand,
  buildCodexQuotaEnv,
  readLastCodexQuotaCache,
  refreshCodexQuota,
  resetCodexQuotaRunnerForTest,
  resolveCodexQuotaCachePath,
} from "./codex-quota-runner.js";

const NOW = Date.parse("2026-05-23T12:00:00Z");
const VALID_LIMIT = JSON.stringify({
  primary: { usedPercent: 30, windowDurationMins: 240, resetsAt: 1779552000 },
  secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: "1779926400" },
  credits: { hasCredits: true, balance: 12.5 },
  planType: "pro",
  rateLimitReachedType: null,
  rawToken: "sk-proj-should-not-be-stored",
});

function spawnResult(params: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> {
  return {
    status: 0,
    signal: null,
    output: [null, params.stdout ?? "", params.stderr ?? ""],
    pid: 123,
    stdout: "",
    stderr: "",
    ...params,
  };
}

function spawnError(code: string): SpawnSyncReturns<string> {
  return spawnResult({
    status: null,
    error: Object.assign(new Error(code), { code }),
  });
}

describe("codex quota runner", () => {
  let tmpDir: string;
  let cachePath: string;

  beforeEach(() => {
    resetCodexQuotaRunnerForTest();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "smithersbot-codex-quota-test-"));
    cachePath = path.join(tmpDir, "cache", "smithersbot", "codex-quota.json");
  });

  afterEach(() => {
    resetCodexQuotaRunnerForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("constructs npm exec command instead of hot-path npx -y", () => {
    expect(buildCodexQuotaCommand()).toEqual({
      command: "npm",
      args: ["exec", "--yes", "codex-limit", "--", "--json"],
    });
  });

  it("augments PATH and sets a writable npm cache while preserving HOME and CODEX_HOME", () => {
    const env = buildCodexQuotaEnv({
      env: {
        PATH: "/usr/bin",
        HOME: "/home/test",
        CODEX_HOME: "/home/test/.codex-custom",
        XDG_CACHE_HOME: path.join(tmpDir, "xdg-cache"),
      },
      cachePath,
    });

    expect(env.PATH?.split(path.delimiter)[0]).toBe(path.dirname(process.execPath));
    expect(env.PATH).toContain("/usr/bin");
    expect(env.HOME).toBe("/home/test");
    expect(env.CODEX_HOME).toBe("/home/test/.codex-custom");
    expect(env.npm_config_cache).toBe(path.join(path.dirname(cachePath), "npm"));
  });

  it("resolves the file cache under XDG_CACHE_HOME or home .cache", () => {
    expect(resolveCodexQuotaCachePath("/home/test", { XDG_CACHE_HOME: "/tmp/xdg" })).toBe(
      "/tmp/xdg/smithersbot/codex-quota.json",
    );
    expect(resolveCodexQuotaCachePath("/home/test", {})).toBe(
      "/home/test/.cache/smithersbot/codex-quota.json",
    );
  });

  it("writes only sanitized parsed quota fields and timestamp after valid JSON", () => {
    const spawnSync = vi.fn(() =>
      spawnResult({
        stdout: VALID_LIMIT,
        stderr: "stderr-token-value-should-not-be-stored",
      }),
    );

    const result = refreshCodexQuota({
      env: { PATH: "/usr/bin", HOME: "/home/test" },
      nowMs: NOW,
      spawnSync: spawnSync as never,
      cachePath,
    });

    expect(result.ok).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith(
      "npm",
      ["exec", "--yes", "codex-limit", "--", "--json"],
      expect.objectContaining({
        timeout: 20_000,
        maxBuffer: 4 * 1024 * 1024,
        env: expect.objectContaining({
          npm_config_cache: path.join(path.dirname(cachePath), "npm"),
        }),
      }),
    );
    const stored = JSON.parse(fs.readFileSync(cachePath, "utf8")) as Record<string, unknown>;
    expect(stored).toEqual({
      cachedAtMs: NOW,
      quota: {
        primary: {
          usedPercentage: 30,
          windowDurationMins: 240,
          resetsAt: "1779552000",
        },
        secondary: {
          usedPercentage: 5,
          windowDurationMins: 10080,
          resetsAt: "1779926400",
        },
        credits: { hasCredits: true, balance: 12.5 },
        planType: "pro",
      },
    });
    expect(JSON.stringify(stored)).not.toContain("rawToken");
    expect(JSON.stringify(stored)).not.toContain("stderr-token");
    expect(JSON.stringify(result)).not.toContain("stdout");
    expect(JSON.stringify(result)).not.toContain("stderr");
    expect(JSON.stringify(result)).not.toContain("sk-proj");
  });

  it("does not overwrite a valid cache on invalid or incomplete JSON", () => {
    const first = refreshCodexQuota({
      nowMs: NOW,
      spawnSync: vi.fn(() => spawnResult({ stdout: VALID_LIMIT })) as never,
      cachePath,
    });
    expect(first.ok).toBe(true);
    const before = fs.readFileSync(cachePath, "utf8");

    const invalid = refreshCodexQuota({
      nowMs: NOW + 1000,
      spawnSync: vi.fn(() => spawnResult({ stdout: "{not json" })) as never,
      cachePath,
    });
    const incomplete = refreshCodexQuota({
      nowMs: NOW + 2000,
      spawnSync: vi.fn(() =>
        spawnResult({ stdout: JSON.stringify({ rawToken: "tok_12345678" }) }),
      ) as never,
      cachePath,
    });

    expect(invalid).toMatchObject({ ok: false, reason: "unavailable" });
    expect(incomplete).toMatchObject({ ok: false, reason: "unavailable" });
    expect(fs.readFileSync(cachePath, "utf8")).toBe(before);
  });

  it("classifies timeout, ENOENT, and non-zero exit without overwriting cache", () => {
    refreshCodexQuota({
      nowMs: NOW,
      spawnSync: vi.fn(() => spawnResult({ stdout: VALID_LIMIT })) as never,
      cachePath,
    });
    const before = fs.readFileSync(cachePath, "utf8");

    const timeout = refreshCodexQuota({
      spawnSync: vi.fn(() => spawnError("ETIMEDOUT")) as never,
      cachePath,
    });
    const missing = refreshCodexQuota({
      spawnSync: vi.fn(() => spawnError("ENOENT")) as never,
      cachePath,
    });
    const failed = refreshCodexQuota({
      spawnSync: vi.fn(() => spawnResult({ status: 1, stderr: "secret-ish-stderr" })) as never,
      cachePath,
    });

    expect(timeout).toMatchObject({ ok: false, reason: "timed out" });
    expect(missing).toMatchObject({ ok: false, reason: "command not found" });
    expect(failed).toMatchObject({ ok: false, reason: "command failed" });
    expect(fs.readFileSync(cachePath, "utf8")).toBe(before);
    expect(JSON.stringify(failed)).not.toContain("secret-ish-stderr");
  });

  it("returns cached quota on failures without returning raw helper output", () => {
    refreshCodexQuota({
      nowMs: NOW,
      spawnSync: vi.fn(() => spawnResult({ stdout: VALID_LIMIT })) as never,
      cachePath,
    });

    const result = refreshCodexQuota({
      spawnSync: vi.fn(() =>
        spawnResult({
          status: 1,
          stdout: "raw stdout with sk-proj-123456789",
          stderr: "raw stderr",
        }),
      ) as never,
      cachePath,
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      cachedQuota: { cachedAtMs: NOW, quota: { planType: "pro" } },
    });
    expect(JSON.stringify(result)).not.toContain("raw stdout");
    expect(JSON.stringify(result)).not.toContain("raw stderr");
    expect(JSON.stringify(result)).not.toContain("sk-proj");
  });

  it("reads surviving file cache after in-memory state is reset", () => {
    refreshCodexQuota({
      nowMs: NOW,
      spawnSync: vi.fn(() => spawnResult({ stdout: VALID_LIMIT })) as never,
      cachePath,
    });
    resetCodexQuotaRunnerForTest();

    expect(readLastCodexQuotaCache(cachePath)).toMatchObject({
      cachedAtMs: NOW,
      quota: {
        planType: "pro",
        credits: { hasCredits: true, balance: 12.5 },
      },
    });

    const result = refreshCodexQuota({
      spawnSync: vi.fn(() => spawnError("ETIMEDOUT")) as never,
      cachePath,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "timed out",
      cachedQuota: { cachedAtMs: NOW, quota: { planType: "pro" } },
    });
  });
});
