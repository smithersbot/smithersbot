import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  OBSERVED_INSTANCES_ENV,
  isInstanceObserved,
  resolveGatewayInstanceFromEnv,
  resolveGatewayInstanceIdentity,
  resolveObservedInstanceSet,
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

describe("observed-instance opt-in", () => {
  it("requires an explicit opt-in (empty set with no signal)", () => {
    expect(resolveObservedInstanceSet({ env: {} as NodeJS.ProcessEnv }).size).toBe(0);
    expect(isInstanceObserved("dev", { env: {} as NodeJS.ProcessEnv })).toBe(false);
  });

  it("parses the env opt-in signal and normalizes aliases", () => {
    const env = { [OBSERVED_INSTANCES_ENV]: "dev, default" } as unknown as NodeJS.ProcessEnv;
    const set = resolveObservedInstanceSet({ env });
    expect(set.has("dev")).toBe(true);
    expect(set.has("stable")).toBe(true);
    expect(isInstanceObserved("dev", { env })).toBe(true);
  });

  it("treats an explicit list as authoritative over env", () => {
    const env = { [OBSERVED_INSTANCES_ENV]: "dev" } as unknown as NodeJS.ProcessEnv;
    expect(resolveObservedInstanceSet({ observedInstances: [], env }).size).toBe(0);
  });

  it("rejects unknown observed instance names", () => {
    expect(() => resolveObservedInstanceSet({ observedInstances: ["prod"] })).toThrow(
      'Unknown SmithersBot gateway instance "prod". Allowed values: default, stable, dev.',
    );
  });
});
