import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isSmithersbotDevWorkspace,
  devGatewayServicePresent,
  resolveDevGatewayWorkerContext,
} from "./dev-gateway-workspace.js";

describe("isSmithersbotDevWorkspace", () => {
  it("detects the dev checkout under managed workspaces", () => {
    expect(
      isSmithersbotDevWorkspace("/home/u/smithersbot-home/agent/workspaces/smithersbot-dev"),
    ).toBe(true);
    expect(
      isSmithersbotDevWorkspace("/home/u/smithersbot-home/agent/workspaces/smithersbot-dev/repo"),
    ).toBe(true);
  });

  it("does not match the stable checkout or unrelated workspaces", () => {
    expect(
      isSmithersbotDevWorkspace("/home/u/smithersbot-home/agent/workspaces/smithersbot-stable"),
    ).toBe(false);
    expect(isSmithersbotDevWorkspace("/tmp/some-other-project")).toBe(false);
  });
});

describe("devGatewayServicePresent", () => {
  it("treats the installed dev unit file as present", () => {
    const home = "/home/u";
    const expectedUnitFile = path.join(
      home,
      ".config",
      "systemd",
      "user",
      "smithersbot-dev-gateway.service",
    );
    const seen: string[] = [];
    const present = devGatewayServicePresent({
      homedir: () => home,
      fileExists: (filePath) => {
        seen.push(filePath);
        return filePath === expectedUnitFile;
      },
    });
    expect(present).toBe(true);
    expect(seen).toContain(expectedUnitFile);
  });

  it("returns false when the dev unit file is absent", () => {
    expect(devGatewayServicePresent({ homedir: () => "/home/u", fileExists: () => false })).toBe(
      false,
    );
  });
});

describe("resolveDevGatewayWorkerContext", () => {
  it("is active only when both the dev workspace and dev service are present", () => {
    const ctx = resolveDevGatewayWorkerContext({
      workingDir: "/home/u/smithersbot-home/agent/workspaces/smithersbot-dev",
      servicePresent: true,
    });
    expect(ctx).toEqual({ isDevWorkspace: true, servicePresent: true, active: true });
  });

  it("is inactive in the dev workspace when the dev service is absent", () => {
    const ctx = resolveDevGatewayWorkerContext({
      workingDir: "/home/u/smithersbot-home/agent/workspaces/smithersbot-dev",
      servicePresent: false,
    });
    expect(ctx).toEqual({ isDevWorkspace: true, servicePresent: false, active: false });
  });

  it("never infers dev from a non-dev checkout and skips the service probe", () => {
    let probed = false;
    const ctx = resolveDevGatewayWorkerContext({
      workingDir: "/home/u/smithersbot-home/agent/workspaces/smithersbot-stable",
      fileExists: () => {
        probed = true;
        return true;
      },
    });
    expect(ctx).toEqual({ isDevWorkspace: false, servicePresent: false, active: false });
    expect(probed).toBe(false);
  });
});
