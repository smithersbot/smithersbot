import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

import {
  __testing,
  consumeGatewaySigusr1RestartAuthorization,
  isGatewaySigusr1RestartExternallyAllowed,
  resolveGatewaySystemdRestartUnit,
  scheduleGatewaySigusr1Restart,
  setGatewaySigusr1RestartPolicy,
} from "./restart.js";

function mockActiveUnits(activeUnits: Set<string>) {
  spawnSyncMock.mockImplementation((_command: string, args: string[]) => {
    const unit = args.at(-1);
    return {
      error: undefined,
      status: unit && activeUnits.has(unit) ? 0 : 3,
      stdout: "",
      stderr: "",
    };
  });
}

describe("restart authorization", () => {
  beforeEach(() => {
    __testing.resetSigusr1State();
    spawnSyncMock.mockReset();
    vi.useFakeTimers();
    vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.restoreAllMocks();
    __testing.resetSigusr1State();
  });

  it("consumes a scheduled authorization once", async () => {
    expect(consumeGatewaySigusr1RestartAuthorization()).toBe(false);

    scheduleGatewaySigusr1Restart({ delayMs: 0 });

    expect(consumeGatewaySigusr1RestartAuthorization()).toBe(true);
    expect(consumeGatewaySigusr1RestartAuthorization()).toBe(false);

    await vi.runAllTimersAsync();
  });

  it("tracks external restart policy", () => {
    expect(isGatewaySigusr1RestartExternallyAllowed()).toBe(false);
    setGatewaySigusr1RestartPolicy({ allowExternal: true });
    expect(isGatewaySigusr1RestartExternallyAllowed()).toBe(true);
  });
});

describe("gateway systemd restart unit resolution", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("honors explicit env vars in canonical then deprecated precedence", () => {
    expect(
      resolveGatewaySystemdRestartUnit({
        SMITHERSBOT_SYSTEMD_UNIT: "smithersbot-gateway.service",
        MOLTBOT_SYSTEMD_UNIT: "moltbot-gateway-dev.service",
        CLAWDBOT_SYSTEMD_UNIT: "moltbot-gateway",
      }),
    ).toBe("smithersbot-gateway.service");
    expect(
      resolveGatewaySystemdRestartUnit({
        MOLTBOT_SYSTEMD_UNIT: "moltbot-gateway-dev",
        CLAWDBOT_SYSTEMD_UNIT: "moltbot-gateway",
      }),
    ).toBe("moltbot-gateway-dev.service");
    expect(resolveGatewaySystemdRestartUnit({ CLAWDBOT_SYSTEMD_UNIT: "legacy-gateway" })).toBe(
      "legacy-gateway.service",
    );
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("detects the legacy unit when only the legacy unit is active", () => {
    mockActiveUnits(new Set(["moltbot-gateway-dev.service"]));

    expect(resolveGatewaySystemdRestartUnit({})).toBe("moltbot-gateway-dev.service");
  });

  it("detects the new unit when only the new unit is active", () => {
    mockActiveUnits(new Set(["smithersbot-gateway.service"]));

    expect(resolveGatewaySystemdRestartUnit({})).toBe("smithersbot-gateway.service");
  });

  it("does not double-suffix service names", () => {
    expect(
      resolveGatewaySystemdRestartUnit({
        SMITHERSBOT_SYSTEMD_UNIT: "smithersbot-gateway.service",
      }),
    ).toBe("smithersbot-gateway.service");
    expect(
      resolveGatewaySystemdRestartUnit({
        MOLTBOT_SYSTEMD_UNIT: "moltbot-gateway-dev.service",
      }),
    ).toBe("moltbot-gateway-dev.service");
  });

  it("resolves the dev unit only for an explicitly-dev process", () => {
    expect(resolveGatewaySystemdRestartUnit({ SMITHERSBOT_INSTANCE: "dev" })).toBe(
      "smithersbot-dev-gateway.service",
    );
    // Explicit instance short-circuits before any active-unit probing.
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("resolves the stable unit for an explicit default/stable instance", () => {
    expect(resolveGatewaySystemdRestartUnit({ SMITHERSBOT_INSTANCE: "stable" })).toBe(
      "smithersbot-gateway.service",
    );
    expect(resolveGatewaySystemdRestartUnit({ SMITHERSBOT_INSTANCE: "default" })).toBe(
      "smithersbot-gateway.service",
    );
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("keeps explicit unit env precedence over the instance signal", () => {
    expect(
      resolveGatewaySystemdRestartUnit({
        SMITHERSBOT_INSTANCE: "dev",
        CLAWDBOT_SYSTEMD_UNIT: "moltbot-gateway-dev",
      }),
    ).toBe("moltbot-gateway-dev.service");
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown instance signal with a clear error", () => {
    expect(() => resolveGatewaySystemdRestartUnit({ SMITHERSBOT_INSTANCE: "prod" })).toThrow(
      /prod/,
    );
  });

  it("ignores the checkout path and defaults to stable for a no-instance process", () => {
    mockActiveUnits(new Set(["smithersbot-gateway.service"]));

    expect(
      resolveGatewaySystemdRestartUnit({
        PWD: "/home/test/smithersbot-home/agent/workspaces/smithersbot-dev",
      }),
    ).toBe("smithersbot-gateway.service");
  });

  it("detects an active dev unit during probing when no signal is set", () => {
    mockActiveUnits(new Set(["smithersbot-dev-gateway.service"]));

    expect(resolveGatewaySystemdRestartUnit({})).toBe("smithersbot-dev-gateway.service");
  });
});
