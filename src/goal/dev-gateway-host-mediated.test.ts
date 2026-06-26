import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveGatewayInstanceIdentity } from "../config/gateway-instance.js";
import {
  executeHostMediatedDevGatewayRequest,
  parseDevGatewayMediationRequest,
  processDevGatewayMediationRequestsOnce,
  requestHostMediatedDevGatewayOperation,
  resolveDevGatewayMediationPaths,
} from "./dev-gateway-mediation.js";
import type { DevGatewayWorkerContext } from "./dev-gateway-workspace.js";
import {
  DEV_GATEWAY_HOST_MEDIATED_COMMANDS,
  isAllowedHostMediatedDevGatewayCommand,
  resolveHostMediatedDevGatewayCommand,
  type HostMediatedDevGatewayOptions,
} from "./dev-gateway-host-mediated.js";

const DEV_UNIT = resolveGatewayInstanceIdentity("dev").serviceUnit;
const STABLE_UNIT = resolveGatewayInstanceIdentity("stable").serviceUnit;
let tmpDirs: string[] = [];
const ORIGINAL_DEV_CAPS_ENV = process.env.SMITHERSBOT_DEV_CAPS;

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-gateway-mediation-test-"));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  delete process.env.SMITHERSBOT_DEV_CAPS;
});

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
  if (ORIGINAL_DEV_CAPS_ENV === undefined) {
    delete process.env.SMITHERSBOT_DEV_CAPS;
  } else {
    process.env.SMITHERSBOT_DEV_CAPS = ORIGINAL_DEV_CAPS_ENV;
  }
});

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

  it("threads cfg.devCapabilities=off into context resolution and denies the command", () => {
    const decision = resolveHostMediatedDevGatewayCommand(
      "node smithersbot.mjs dev-gateway status",
      {
        workingDir: DEV_ACTIVE.workingDir,
        servicePresent: true,
        cfg: { devCapabilities: "off" },
      },
    );

    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe("dev-gateway-not-installed");
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

describe("dev-gateway file-drop mediation transport", () => {
  it("accepts only the action enum plus optional run/task correlation", () => {
    expect(parseDevGatewayMediationRequest({ action: "status" })).toEqual({ action: "status" });
    expect(
      parseDevGatewayMediationRequest({
        action: "restart",
        runId: "run-1",
        taskId: "task-1",
      }),
    ).toEqual({
      action: "restart",
      runId: "run-1",
      taskId: "task-1",
    });

    for (const request of [
      { action: "stop" },
      { action: "status", serviceUnit: STABLE_UNIT },
      { action: "logs", unit: DEV_UNIT },
      { action: "restart", command: `systemctl --user restart ${DEV_UNIT}` },
      { action: "restart", env: { CLAWDBOT_SYSTEMD_UNIT: STABLE_UNIT } },
      "status",
    ]) {
      expect(() => parseDevGatewayMediationRequest(request), JSON.stringify(request)).toThrow();
    }
  });

  it("runs host-side requests with the dev unit hard-pinned and no caller-supplied service", async () => {
    const execute = vi.fn(async (_request: unknown) => ({
      action: "status" as const,
      serviceUnit: DEV_UNIT,
      activeState: { active: true, state: "active", exitCode: 0 },
      runtime: { status: "running" as const, state: "active", pid: 1234 },
    }));

    const result = await executeHostMediatedDevGatewayRequest(
      { action: "status", runId: "run-1", taskId: "task-1" },
      { execute },
    );

    expect(execute).toHaveBeenCalledWith({ action: "status" });
    expect(result).toMatchObject({
      action: "status",
      ok: true,
      serviceUnit: DEV_UNIT,
      devPort: 18790,
      evidence: {
        mediated: true,
        responder: "smithersbot-dev-gateway",
        serviceUnit: DEV_UNIT,
        action: "status",
      },
    });
    expect(result.serviceUnit).not.toBe(STABLE_UNIT);
  });

  it("cannot target the stable unit through mediated request processing", async () => {
    const execute = vi.fn();
    const result = await executeHostMediatedDevGatewayRequest(
      { action: "restart", serviceUnit: STABLE_UNIT },
      { execute },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      action: "restart",
      ok: false,
      serviceUnit: DEV_UNIT,
      errorCode: "dev_gateway_mediation_failed",
    });
    expect(result.message).not.toContain(STABLE_UNIT);
  });

  it("returns a clean structured blocker when the mediator is unavailable", async () => {
    const root = path.join(makeTmpDir(), "missing-root");
    const result = await requestHostMediatedDevGatewayOperation({
      action: "logs",
      runId: "run-1",
      taskId: "task-1",
      timeoutMs: 5,
      env: { SMITHERSBOT_GOALS_ROOT: root } as NodeJS.ProcessEnv,
    });

    expect(result).toMatchObject({
      action: "logs",
      ok: false,
      serviceUnit: DEV_UNIT,
      errorCode: "capability_blocked",
    });
    expect(result.message).toContain("host mediation is unavailable");
    expect(result.message).not.toMatch(
      /Failed to connect to bus|D-Bus|systemctl --user unavailable/,
    );
  });

  it("returns a clean structured blocker when the channel dir has not been created", async () => {
    const root = makeTmpDir();
    const env = { SMITHERSBOT_GOALS_ROOT: root } as NodeJS.ProcessEnv;
    const paths = resolveDevGatewayMediationPaths({ runId: "run-1", taskId: "task-1", env });
    fs.mkdirSync(paths.scratchRoot, { recursive: true });

    const result = await requestHostMediatedDevGatewayOperation({
      action: "status",
      runId: "run-1",
      taskId: "task-1",
      timeoutMs: 5,
      env,
    });

    expect(result).toMatchObject({
      action: "status",
      ok: false,
      serviceUnit: DEV_UNIT,
      errorCode: "capability_blocked",
    });
    expect(result.message).toContain("mediation channel is not ready");
    expect(result.message).not.toContain(paths.channelDir);
    expect(result.message).not.toContain(paths.scratchRoot);
    expect(result.message).not.toContain(root);
  });

  it("returns a clean blocker (no fs path/error-code leak) when the channel is not writable", async () => {
    // Scratch root exists but the per-task channel cannot be created/written —
    // exactly the case where a sandboxed worker's writable set excludes the
    // gateway-controlled scratch dir, so mkdir/write fails with EROFS.
    const rawPath =
      "/home/matt/smithersbot-home/scratch/run-1/task-1/dev-gateway-control/request.json";
    const fsError = Object.assign(
      new Error(
        `ENOENT: no such file or directory, open '${rawPath}'\nEROFS: read-only file system, mkdir '${rawPath}'\nEACCES: permission denied, open '${rawPath}'`,
      ),
      { code: "ENOENT", path: rawPath },
    );
    const fsImpl = {
      existsSync: () => true,
      mkdirSync: () => {
        throw fsError;
      },
      writeFileSync: () => {
        throw fsError;
      },
      renameSync: () => {},
      readdirSync: () => [],
      readFileSync: () => "",
      unlinkSync: () => {},
    } as unknown as Parameters<typeof requestHostMediatedDevGatewayOperation>[0]["fsImpl"];

    const result = await requestHostMediatedDevGatewayOperation({
      action: "status",
      runId: "run-1",
      taskId: "task-1",
      timeoutMs: 5,
      env: { SMITHERSBOT_GOALS_ROOT: makeTmpDir() } as NodeJS.ProcessEnv,
      fsImpl,
    });

    expect(result).toMatchObject({
      action: "status",
      ok: false,
      serviceUnit: DEV_UNIT,
      errorCode: "capability_blocked",
    });
    expect(result.message).toContain("host mediation is unavailable");
    expect(result.message).not.toContain(rawPath);
    expect(result.message).not.toContain("ENOENT");
    expect(result.message).not.toContain("EROFS");
    expect(result.message).not.toContain("EACCES");
    expect(result.message).not.toContain("read-only");
    expect(result.message).not.toContain("/scratch/");
  });

  it("sanitizes raw systemd and D-Bus stderr from mediated result fields", async () => {
    const result = await executeHostMediatedDevGatewayRequest(
      { action: "status" },
      {
        execute: async () => {
          throw new Error(
            "systemctl --user unavailable: Failed to connect to bus: No data available",
          );
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(`${result.message}\n${result.stderr ?? ""}`).not.toMatch(
      /Failed to connect to bus|D-Bus|systemctl --user unavailable|No data available/,
    );
  });

  it("discovers requests only under the gateway-controlled scratch root", async () => {
    const managedRoot = makeTmpDir();
    const env = { SMITHERSBOT_GOALS_ROOT: managedRoot } as NodeJS.ProcessEnv;
    const paths = resolveDevGatewayMediationPaths({ runId: "run-1", taskId: "task-1", env });
    fs.mkdirSync(paths.channelDir, { recursive: true });
    fs.writeFileSync(
      path.join(paths.channelDir, "allowed.request.json"),
      JSON.stringify({ action: "logs", runId: "run-1", taskId: "task-1" }),
      "utf8",
    );

    const privateDir = path.join(
      managedRoot,
      "private",
      "env",
      "smithersbot-dev",
      "dev-gateway-control",
    );
    fs.mkdirSync(privateDir, { recursive: true });
    fs.writeFileSync(
      path.join(privateDir, "denied.request.json"),
      JSON.stringify({ action: "restart" }),
      "utf8",
    );

    const execute = vi.fn(async () => ({
      action: "logs" as const,
      serviceUnit: DEV_UNIT,
      logs: "dev log line\n",
    }));

    const processed = await processDevGatewayMediationRequestsOnce({
      scratchRoot: paths.scratchRoot,
      execute,
    });

    expect(processed).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ action: "logs" });
    expect(fs.existsSync(path.join(paths.channelDir, "allowed.result.json"))).toBe(true);
    expect(fs.existsSync(path.join(privateDir, "denied.result.json"))).toBe(false);
    expect(fs.existsSync(path.join(privateDir, "denied.request.json"))).toBe(true);
  });
});
