import { describe, expect, it } from "vitest";

import { resolveGatewayInstanceIdentity } from "../config/gateway-instance.js";
import type { DevGatewayWorkerContext } from "./dev-gateway-workspace.js";
import {
  DEV_GATEWAY_HOST_MEDIATED_COMMANDS,
  isAllowedHostMediatedDevGatewayCommand,
  resolveHostMediatedDevGatewayCommand,
  type HostMediatedDevGatewayOptions,
} from "./dev-gateway-host-mediated.js";

const DEV_UNIT = resolveGatewayInstanceIdentity("dev").serviceUnit;
const STABLE_UNIT = resolveGatewayInstanceIdentity("stable").serviceUnit;

// Active dev context: a worker on the smithersbot-dev checkout with the dev
// gateway present. servicePresent is injected so no filesystem/systemd is read.
const DEV_ACTIVE: HostMediatedDevGatewayOptions = {
  workingDir: "/home/worker/smithersbot-home/agent/workspaces/smithersbot-dev",
  servicePresent: true,
};

const ctx = (overrides: Partial<DevGatewayWorkerContext>): DevGatewayWorkerContext => ({
  isDevWorkspace: true,
  servicePresent: true,
  active: true,
  ...overrides,
});

describe("dev-gateway host-mediated allowlist", () => {
  it("derives exactly the three literal commands from the operation source of truth", () => {
    expect([...DEV_GATEWAY_HOST_MEDIATED_COMMANDS]).toEqual([
      "node smithersbot.mjs dev-gateway restart",
      "node smithersbot.mjs dev-gateway status",
      "node smithersbot.mjs dev-gateway logs",
    ]);
  });

  describe("allows the three exact commands ONLY in the dev context", () => {
    for (const command of DEV_GATEWAY_HOST_MEDIATED_COMMANDS) {
      const action = command.split(" ").at(-1)!;

      it(`allows "${command}" in active dev context, fixed to the dev unit`, () => {
        const decision = resolveHostMediatedDevGatewayCommand(command, DEV_ACTIVE);
        expect(decision.allowed).toBe(true);
        if (!decision.allowed) return;
        expect(decision.action).toBe(action);
        expect(decision.serviceUnit).toBe(DEV_UNIT);
        expect(decision.serviceUnit).not.toBe(STABLE_UNIT);
        expect(decision.command).toBe(command);
      });

      it(`denies "${command}" outside the dev context (not the dev workspace)`, () => {
        const decision = resolveHostMediatedDevGatewayCommand(command, {
          workingDir: "/home/worker/smithersbot-home/agent/workspaces/smithersbot-stable",
          servicePresent: true,
        });
        expect(decision.allowed).toBe(false);
        if (decision.allowed) return;
        expect(decision.reason).toBe("outside-dev-context");
      });

      it(`denies "${command}" when the dev gateway is not installed`, () => {
        const decision = resolveHostMediatedDevGatewayCommand(command, {
          workingDir: DEV_ACTIVE.workingDir,
          servicePresent: false,
        });
        expect(decision.allowed).toBe(false);
        if (decision.allowed) return;
        expect(decision.reason).toBe("dev-gateway-not-installed");
      });
    }
  });

  it("denies arbitrary node execution", () => {
    for (const command of [
      "node build.js",
      "node ./smithersbot.mjs dev-gateway restart",
      "node -e console.log",
      "node smithersbot.mjs",
    ]) {
      const decision = resolveHostMediatedDevGatewayCommand(command, DEV_ACTIVE);
      expect(decision.allowed, command).toBe(false);
    }
  });

  it("denies an arbitrary (non-smithersbot.mjs) entrypoint script", () => {
    const decision = resolveHostMediatedDevGatewayCommand(
      "node evil.mjs dev-gateway restart",
      DEV_ACTIVE,
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe("non-entrypoint-script");
  });

  it("denies any CLI command other than dev-gateway (including the stable gateway command)", () => {
    const decision = resolveHostMediatedDevGatewayCommand(
      "node smithersbot.mjs gateway restart",
      DEV_ACTIVE,
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe("non-dev-gateway-command");
  });

  it("denies arbitrary / caller-supplied service names", () => {
    for (const command of [
      `node smithersbot.mjs dev-gateway ${STABLE_UNIT}`,
      `node smithersbot.mjs dev-gateway ${DEV_UNIT}`,
      `node smithersbot.mjs dev-gateway restart ${STABLE_UNIT}`,
      `node smithersbot.mjs dev-gateway restart ${DEV_UNIT}`,
    ]) {
      const decision = resolveHostMediatedDevGatewayCommand(command, DEV_ACTIVE);
      expect(decision.allowed, command).toBe(false);
    }
  });

  it("denies stable-unit control through the dev-gateway command", () => {
    // No action accepts a unit, and stable control is never a dev-gateway action.
    const decision = resolveHostMediatedDevGatewayCommand(
      `node smithersbot.mjs dev-gateway restart ${STABLE_UNIT}`,
      DEV_ACTIVE,
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe("excess-arguments");
  });

  it("denies stop / enable / disable / reinstall actions", () => {
    for (const action of ["stop", "enable", "disable", "reinstall", "start", "kill"]) {
      const decision = resolveHostMediatedDevGatewayCommand(
        `node smithersbot.mjs dev-gateway ${action}`,
        DEV_ACTIVE,
      );
      expect(decision.allowed, action).toBe(false);
      if (decision.allowed) continue;
      expect(decision.reason).toBe("unsupported-action");
    }
  });

  it("denies arbitrary systemctl access", () => {
    for (const command of [
      `systemctl --user restart ${DEV_UNIT}`,
      `systemctl --user restart ${STABLE_UNIT}`,
      "systemctl --user daemon-reload",
    ]) {
      const decision = resolveHostMediatedDevGatewayCommand(command, DEV_ACTIVE);
      expect(decision.allowed, command).toBe(false);
    }
  });

  it("denies command chaining / shell metacharacters that wrap an allowed command", () => {
    for (const command of [
      "node smithersbot.mjs dev-gateway status; rm -rf /",
      "node smithersbot.mjs dev-gateway status && systemctl --user restart smithersbot-gateway.service",
      "node smithersbot.mjs dev-gateway status | tee out",
      "node smithersbot.mjs dev-gateway $(echo restart)",
      "node smithersbot.mjs dev-gateway restart > /tmp/x",
      "FOO=bar node smithersbot.mjs dev-gateway restart",
    ]) {
      const decision = resolveHostMediatedDevGatewayCommand(command, DEV_ACTIVE);
      expect(decision.allowed, command).toBe(false);
      if (decision.allowed) continue;
      expect(decision.reason).toBe("shell-metacharacters");
    }
  });

  it("denies an allowed-looking command with trailing excess arguments", () => {
    const decision = resolveHostMediatedDevGatewayCommand(
      "node smithersbot.mjs dev-gateway status --now",
      DEV_ACTIVE,
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    // "--now" trips the metacharacter gate (leading dash is fine, but it is an
    // excess token); assert it is denied for one of the strict reasons.
    expect(["excess-arguments", "shell-metacharacters"]).toContain(decision.reason);
  });

  it("treats whitespace variants of the literal commands as allowed in dev context", () => {
    const decision = resolveHostMediatedDevGatewayCommand(
      "  node   smithersbot.mjs   dev-gateway   logs  ",
      DEV_ACTIVE,
    );
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.action).toBe("logs");
    expect(decision.command).toBe("node smithersbot.mjs dev-gateway logs");
  });

  it("accepts a pre-resolved active dev context and rejects an inactive one", () => {
    const allowed = resolveHostMediatedDevGatewayCommand(
      "node smithersbot.mjs dev-gateway restart",
      {
        context: ctx({ active: true }),
      },
    );
    expect(allowed.allowed).toBe(true);

    const inactive = resolveHostMediatedDevGatewayCommand(
      "node smithersbot.mjs dev-gateway restart",
      { context: ctx({ servicePresent: false, active: false }) },
    );
    expect(inactive.allowed).toBe(false);
    if (inactive.allowed) return;
    expect(inactive.reason).toBe("dev-gateway-not-installed");

    const nonDev = resolveHostMediatedDevGatewayCommand(
      "node smithersbot.mjs dev-gateway restart",
      {
        context: ctx({ isDevWorkspace: false, active: false }),
      },
    );
    expect(nonDev.allowed).toBe(false);
    if (nonDev.allowed) return;
    expect(nonDev.reason).toBe("outside-dev-context");
  });

  it("denies an empty or non-string command", () => {
    expect(resolveHostMediatedDevGatewayCommand("", DEV_ACTIVE).allowed).toBe(false);
    expect(resolveHostMediatedDevGatewayCommand("   ", DEV_ACTIVE).allowed).toBe(false);
    expect(resolveHostMediatedDevGatewayCommand(undefined, DEV_ACTIVE).allowed).toBe(false);
  });

  it("exposes a convenience boolean matching the full decision", () => {
    expect(
      isAllowedHostMediatedDevGatewayCommand("node smithersbot.mjs dev-gateway status", DEV_ACTIVE),
    ).toBe(true);
    expect(
      isAllowedHostMediatedDevGatewayCommand("node smithersbot.mjs dev-gateway stop", DEV_ACTIVE),
    ).toBe(false);
    expect(
      isAllowedHostMediatedDevGatewayCommand("node smithersbot.mjs dev-gateway status", {
        workingDir: "/srv/elsewhere",
      }),
    ).toBe(false);
  });
});
