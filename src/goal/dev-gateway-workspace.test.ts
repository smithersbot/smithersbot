import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDotEnv } from "../infra/dotenv.js";
import {
  isSmithersbotDevWorkspace,
  devGatewayServicePresent,
  resolveDevCapabilitiesMode,
  resolveDevGatewayWorkerContext,
  shouldInjectDevGatewayGuidance,
} from "./dev-gateway-workspace.js";

const DEV_WORKSPACE = "/home/u/smithersbot-home/agent/workspaces/smithersbot-dev";
const NON_DEV_WORKSPACE = "/home/u/smithersbot-home/agent/workspaces/smithersbot-stable";
const ORIGINAL_DEV_CAPS_ENV = process.env.SMITHERSBOT_DEV_CAPS;

afterEach(() => {
  if (ORIGINAL_DEV_CAPS_ENV === undefined) {
    delete process.env.SMITHERSBOT_DEV_CAPS;
  } else {
    process.env.SMITHERSBOT_DEV_CAPS = ORIGINAL_DEV_CAPS_ENV;
  }
});

describe("isSmithersbotDevWorkspace", () => {
  it("detects the dev checkout under managed workspaces", () => {
    expect(isSmithersbotDevWorkspace(DEV_WORKSPACE)).toBe(true);
    expect(isSmithersbotDevWorkspace(`${DEV_WORKSPACE}/repo`)).toBe(true);
  });

  it("does not match the stable checkout or unrelated workspaces", () => {
    expect(isSmithersbotDevWorkspace(NON_DEV_WORKSPACE)).toBe(false);
    expect(isSmithersbotDevWorkspace("/tmp/some-other-project")).toBe(false);
  });
});

describe("resolveDevCapabilitiesMode", () => {
  it("defaults to auto when config and env are unset", () => {
    delete process.env.SMITHERSBOT_DEV_CAPS;

    expect(resolveDevCapabilitiesMode()).toBe("auto");
    expect(shouldInjectDevGatewayGuidance(DEV_WORKSPACE)).toBe(false);
  });

  it("uses config off to suppress dev guidance for a dev workspace", () => {
    delete process.env.SMITHERSBOT_DEV_CAPS;

    expect(resolveDevCapabilitiesMode({ devCapabilities: "off" })).toBe("off");
    expect(shouldInjectDevGatewayGuidance(DEV_WORKSPACE, { devCapabilities: "off" })).toBe(false);
  });

  it("lets SMITHERSBOT_DEV_CAPS=off win over config auto", () => {
    process.env.SMITHERSBOT_DEV_CAPS = "off";

    expect(resolveDevCapabilitiesMode({ devCapabilities: "auto" })).toBe("off");
    expect(shouldInjectDevGatewayGuidance(DEV_WORKSPACE, { devCapabilities: "auto" })).toBe(false);
  });

  it("ignores unrecognized env values and falls through to config/default", () => {
    process.env.SMITHERSBOT_DEV_CAPS = "disabled";

    expect(resolveDevCapabilitiesMode({ devCapabilities: "off" })).toBe("off");
    expect(resolveDevCapabilitiesMode()).toBe("auto");
  });

  it("loads SMITHERSBOT_DEV_CAPS=off from the explicit dev instance env before resolving mode", async () => {
    const prevEnv = { ...process.env };
    const prevCwd = process.cwd();
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "smithersbot-dev-caps-env-"));
    const cwd = path.join(home, "work");
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(home);

    try {
      await fs.mkdir(cwd, { recursive: true });
      await fs.mkdir(path.join(home, ".smithersbot-dev"), { recursive: true });
      await fs.writeFile(
        path.join(home, ".smithersbot-dev", ".env"),
        "SMITHERSBOT_DEV_CAPS=off\n",
        "utf8",
      );

      process.chdir(cwd);
      process.env.SMITHERSBOT_INSTANCE = "dev";
      delete process.env.SMITHERSBOT_DEV_CAPS;

      loadDotEnv({ quiet: true });

      expect(process.env.SMITHERSBOT_DEV_CAPS).toBe("off");
      expect(resolveDevCapabilitiesMode({ devCapabilities: "auto" })).toBe("off");
      expect(
        resolveDevGatewayWorkerContext({
          workingDir: DEV_WORKSPACE,
          cfg: { devCapabilities: "auto" },
          servicePresent: true,
        }),
      ).toEqual({ isDevWorkspace: true, servicePresent: false, active: false });
    } finally {
      homedirSpy.mockRestore();
      process.chdir(prevCwd);
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      for (const [key, value] of Object.entries(prevEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fs.rm(home, { recursive: true, force: true });
    }
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
    delete process.env.SMITHERSBOT_DEV_CAPS;

    const ctx = resolveDevGatewayWorkerContext({
      workingDir: DEV_WORKSPACE,
      servicePresent: true,
    });
    expect(ctx).toEqual({ isDevWorkspace: true, servicePresent: true, active: true });
  });

  it("is inactive in the dev workspace when the dev service is absent", () => {
    const ctx = resolveDevGatewayWorkerContext({
      workingDir: DEV_WORKSPACE,
      servicePresent: false,
    });
    expect(ctx).toEqual({ isDevWorkspace: true, servicePresent: false, active: false });
  });

  it("never infers dev from a non-dev checkout and skips the service probe", () => {
    let probed = false;
    const ctx = resolveDevGatewayWorkerContext({
      workingDir: NON_DEV_WORKSPACE,
      fileExists: () => {
        probed = true;
        return true;
      },
    });
    expect(ctx).toEqual({ isDevWorkspace: false, servicePresent: false, active: false });
    expect(probed).toBe(false);
  });

  it("forces inactive worker context when config turns dev capabilities off", () => {
    delete process.env.SMITHERSBOT_DEV_CAPS;

    const ctx = resolveDevGatewayWorkerContext({
      workingDir: DEV_WORKSPACE,
      cfg: { devCapabilities: "off" },
      servicePresent: true,
    });

    expect(ctx).toEqual({ isDevWorkspace: true, servicePresent: false, active: false });
  });

  it("lets SMITHERSBOT_DEV_CAPS=off force inactive worker context over config auto", () => {
    process.env.SMITHERSBOT_DEV_CAPS = "off";

    const ctx = resolveDevGatewayWorkerContext({
      workingDir: DEV_WORKSPACE,
      cfg: { devCapabilities: "auto" },
      servicePresent: true,
    });

    expect(ctx).toEqual({ isDevWorkspace: true, servicePresent: false, active: false });
  });

  it("preserves auto worker behavior as isDevWorkspace && servicePresent", () => {
    delete process.env.SMITHERSBOT_DEV_CAPS;

    expect(
      resolveDevGatewayWorkerContext({
        workingDir: DEV_WORKSPACE,
        cfg: { devCapabilities: "auto" },
        servicePresent: true,
      }),
    ).toEqual({ isDevWorkspace: true, servicePresent: true, active: true });
    expect(
      resolveDevGatewayWorkerContext({
        workingDir: DEV_WORKSPACE,
        cfg: { devCapabilities: "auto" },
        servicePresent: false,
      }),
    ).toEqual({ isDevWorkspace: true, servicePresent: false, active: false });
    expect(
      resolveDevGatewayWorkerContext({
        workingDir: NON_DEV_WORKSPACE,
        cfg: { devCapabilities: "auto" },
        servicePresent: true,
      }),
    ).toEqual({ isDevWorkspace: false, servicePresent: false, active: false });
  });
});
