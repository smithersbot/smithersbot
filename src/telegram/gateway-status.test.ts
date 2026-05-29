import { afterEach, describe, expect, it, vi } from "vitest";

import type { MoltbotConfig } from "../config/config.js";
import {
  buildGatewayStatusMessage,
  buildGatewayStatusSnapshot,
  isManagedWorkspaceCwd,
} from "./gateway-status.js";

const okSystemd = vi.fn(() => ({
  status: 0,
  signal: null,
  output: [null, "ActiveState=active\nSubState=running\nMainPID=4242\n", ""],
  pid: 1,
  stdout: "ActiveState=active\nSubState=running\nMainPID=4242\n",
  stderr: "",
}));

describe("gateway status", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders compact bold PID, start time, uptime, unit, cwd summary, port, profile, version, and systemd", () => {
    const cwd = "/home/test/smithersbot-goals/agent/workspaces/smithersbot/repo";
    const env = {
      ...process.env,
      SMITHERSBOT_GOALS_ROOT: "/home/test/smithersbot-goals",
      CLAWDBOT_SYSTEMD_UNIT: "moltbot-gateway-dev.service",
      CLAWDBOT_GATEWAY_PORT: "19001",
      CLAWDBOT_PROFILE: "dev",
      CLAWDBOT_SERVICE_MARKER: "moltbot",
      CLAWDBOT_SERVICE_KIND: "gateway",
      GIT_COMMIT: "abcdef123456",
    };

    const text = buildGatewayStatusMessage({
      cfg: {} as MoltbotConfig,
      env,
      cwd,
      nowMs: Date.parse("2026-05-22T12:00:00.000Z"),
      uptimeSeconds: 65,
      pid: 12345,
      hostname: "test-host",
      spawnSync: okSystemd,
    });

    expect(text).toContain("**Gateway status**");
    expect(text).toMatch(/^\*\*Unit:\*\* moltbot-gateway-dev\.service$/m);
    expect(text).toMatch(/^\*\*PID:\*\* 12345$/m);
    expect(text).not.toContain("Host:");
    expect(text).toMatch(/^\*\*Started:\*\* 2026-05-22T11:58:55\.000Z$/m);
    expect(text).toMatch(/^\*\*Uptime:\*\* 1m 5s$/m);
    expect(text).toMatch(/^\*\*CWD:\*\* managed workspace repo$/m);
    expect(text).toMatch(/^\*\*Port:\*\* 19001$/m);
    expect(text).toMatch(/^\*\*Profile:\*\* dev$/m);
    expect(text).not.toContain("Managed workspace:");
    expect(text).not.toContain("Service marker:");
    expect(text).toContain("**Version:**");
    expect(text).toContain("abcdef1");
    expect(text).toMatch(/^\*\*Systemd:\*\* active\/running$/m);
    expect(text).not.toMatch(/\n\n/);
  });

  it("displays the legacy moltbot-gateway-dev.service unit", () => {
    const snapshot = buildGatewayStatusSnapshot({
      env: {
        ...process.env,
        CLAWDBOT_SYSTEMD_UNIT: "moltbot-gateway-dev.service",
      },
      cwd: "/tmp/repo",
      spawnSync: okSystemd,
    });

    expect(snapshot.unit).toBe("moltbot-gateway-dev.service");
  });

  it("reports the dev unit and port for an explicitly-dev process", () => {
    const snapshot = buildGatewayStatusSnapshot({
      cfg: {} as MoltbotConfig,
      env: {
        ...process.env,
        SMITHERSBOT_INSTANCE: "dev",
        // No explicit unit/port override: both should derive from the instance.
        SMITHERSBOT_SYSTEMD_UNIT: undefined,
        MOLTBOT_SYSTEMD_UNIT: undefined,
        CLAWDBOT_SYSTEMD_UNIT: undefined,
        SMITHERSBOT_GATEWAY_PORT: undefined,
        MOLTBOT_GATEWAY_PORT: undefined,
        CLAWDBOT_GATEWAY_PORT: undefined,
      },
      cwd: "/home/test/smithersbot-home/agent/workspaces/smithersbot-dev",
      spawnSync: okSystemd,
    });

    expect(snapshot.unit).toBe("smithersbot-dev-gateway.service");
    expect(snapshot.port).toBe(18790);
    expect(snapshot.systemd).toMatchObject({ activeState: "active", subState: "running" });
  });

  it("reports the stable unit and port for an explicit stable process", () => {
    const snapshot = buildGatewayStatusSnapshot({
      cfg: {} as MoltbotConfig,
      env: {
        ...process.env,
        SMITHERSBOT_INSTANCE: "stable",
        SMITHERSBOT_SYSTEMD_UNIT: undefined,
        MOLTBOT_SYSTEMD_UNIT: undefined,
        CLAWDBOT_SYSTEMD_UNIT: undefined,
        SMITHERSBOT_GATEWAY_PORT: undefined,
        MOLTBOT_GATEWAY_PORT: undefined,
        CLAWDBOT_GATEWAY_PORT: undefined,
      },
      cwd: "/tmp/repo",
      spawnSync: okSystemd,
    });

    expect(snapshot.unit).toBe("smithersbot-gateway.service");
    expect(snapshot.port).toBe(18789);
  });

  it("detects cwd inside the managed workspace", () => {
    const env = {
      ...process.env,
      SMITHERSBOT_GOALS_ROOT: "/home/test/smithersbot-goals",
    };

    expect(
      isManagedWorkspaceCwd("/home/test/smithersbot-goals/agent/workspaces/smithersbot/repo", env),
    ).toBe(true);
    expect(
      isManagedWorkspaceCwd(
        "/home/test/smithersbot-goals/agent/workspaces/smithersbot/repo/src",
        env,
      ),
    ).toBe(true);
    expect(isManagedWorkspaceCwd("/home/test/other/repo", env)).toBe(false);
  });

  it("falls back to process and env info when systemd is unavailable", () => {
    const spawnSync = vi.fn(() => ({
      error: Object.assign(new Error("not found"), { code: "ENOENT" }),
      status: null,
      signal: null,
      output: [null, "", ""],
      pid: 0,
      stdout: "",
      stderr: "",
    }));

    const text = buildGatewayStatusMessage({
      env: {
        ...process.env,
        CLAWDBOT_SYSTEMD_UNIT: "moltbot-gateway-dev.service",
        CLAWDBOT_GATEWAY_PORT: "19001",
      },
      cwd: "/tmp/repo",
      pid: 987,
      hostname: "fallback-host",
      uptimeSeconds: 1,
      nowMs: Date.parse("2026-05-22T12:00:00.000Z"),
      spawnSync,
    });

    expect(text).toContain("**Unit:** moltbot-gateway-dev.service");
    expect(text).toContain("**PID:** 987");
    expect(text).not.toContain("Host:");
    expect(text).toContain("**Port:** 19001");
    expect(text).toContain("**Systemd:** unavailable; using process fallback");
    expect(text).not.toMatch(/\n\n/);
  });

  it("does not include token-like env values", () => {
    const secretValues = {
      TOKEN: "root-token-secret",
      BOT_TOKEN: "bot-token-secret",
      TELEGRAM_TOKEN: "telegram-token-secret",
      CLAWDBOT_GATEWAY_TOKEN: "clawdbot-gateway-secret",
      SMITHERSBOT_GATEWAY_TOKEN: "smithersbot-gateway-secret",
    };
    for (const [key, value] of Object.entries(secretValues)) {
      vi.stubEnv(key, value);
    }

    const text = buildGatewayStatusMessage({
      env: {
        ...process.env,
        CLAWDBOT_SYSTEMD_UNIT: "moltbot-gateway-dev.service",
        CLAWDBOT_GATEWAY_PORT: "19001",
      },
      cwd: "/tmp/repo",
      spawnSync: okSystemd,
    });

    for (const value of Object.values(secretValues)) {
      expect(text).not.toContain(value);
    }
    expect(text).not.toContain("TOKEN=");
    expect(text).not.toContain("GATEWAY_TOKEN");
  });
});
