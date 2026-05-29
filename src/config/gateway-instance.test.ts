import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  resolveGatewayInstanceFromEnv,
  resolveGatewayInstanceIdentity,
} from "./gateway-instance.js";

describe("gateway instance resolver", () => {
  it("maps default and stable aliases to the stable gateway identity", () => {
    const home = "/home/test";
    const fromDefault = resolveGatewayInstanceIdentity("default", () => home);
    const fromStable = resolveGatewayInstanceIdentity("stable", () => home);
    const fromNoSelection = resolveGatewayInstanceIdentity(undefined, () => home);

    for (const identity of [fromDefault, fromStable, fromNoSelection]) {
      expect(identity.name).toBe("stable");
      expect(identity.serviceUnit).toBe("smithersbot-gateway.service");
      expect(identity.stateDir).toBe(path.join(home, ".smithersbot"));
      expect(identity.managedRoot).toBe(path.join(home, "smithersbot-home"));
      expect(identity.defaultPort).toBe(18789);
      expect(identity.legacyStateFallbacks).toBe(true);
    }
  });

  it("maps dev to the dev gateway identity", () => {
    const home = "/home/test";
    const identity = resolveGatewayInstanceIdentity("dev", () => home);

    expect(identity.name).toBe("dev");
    expect(identity.serviceUnit).toBe("smithersbot-dev-gateway.service");
    expect(identity.stateDir).toBe(path.join(home, ".smithersbot-dev"));
    expect(identity.managedRoot).toBe(path.join(home, "smithersbot-dev-home"));
    expect(identity.defaultPort).toBe(18790);
    expect(identity.legacyStateFallbacks).toBe(false);
  });

  it("rejects unknown instance names with the allowed set", () => {
    expect(() => resolveGatewayInstanceIdentity("prod", () => "/home/test")).toThrow(
      'Unknown SmithersBot gateway instance "prod". Allowed values: default, stable, dev.',
    );
  });

  it("defaults a no-instance process to stable paths", () => {
    const home = "/home/test";
    const identity = resolveGatewayInstanceFromEnv({} as NodeJS.ProcessEnv, () => home);

    expect(identity.name).toBe("stable");
    expect(identity.stateDir).toBe(path.join(home, ".smithersbot"));
    expect(identity.managedRoot).toBe(path.join(home, "smithersbot-home"));
  });

  it("uses SMITHERSBOT_INSTANCE=dev as the explicit dev signal", () => {
    const home = "/home/test";
    const identity = resolveGatewayInstanceFromEnv(
      { SMITHERSBOT_INSTANCE: "dev" } as NodeJS.ProcessEnv,
      () => home,
    );

    expect(identity.name).toBe("dev");
    expect(identity.stateDir).toBe(path.join(home, ".smithersbot-dev"));
    expect(identity.managedRoot).toBe(path.join(home, "smithersbot-dev-home"));
  });

  it("does not infer dev from a smithersbot-dev working directory", async () => {
    const prevCwd = process.cwd();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-instance-cwd-"));
    const devCheckout = path.join(
      root,
      "smithersbot-home",
      "agent",
      "workspaces",
      "smithersbot-dev",
    );
    try {
      await fs.mkdir(devCheckout, { recursive: true });
      process.chdir(devCheckout);

      const identity = resolveGatewayInstanceFromEnv({} as NodeJS.ProcessEnv, () => root);

      expect(identity.name).toBe("stable");
      expect(identity.stateDir).toBe(path.join(root, ".smithersbot"));
      expect(identity.managedRoot).toBe(path.join(root, "smithersbot-home"));
    } finally {
      process.chdir(prevCwd);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
