import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the host/systemd layer so the entrypoint drives the genuine mediated
// operation path (register command -> executeDevGatewayOperation -> systemd
// helpers) without ever touching the user systemd bus.
const systemdMock = vi.hoisted(() => ({
  restartSystemdService: vi.fn(),
  readSystemdServiceActiveState: vi.fn(),
  readSystemdServiceRecentLogs: vi.fn(),
  readSystemdServiceRuntime: vi.fn(),
}));

vi.mock("../../daemon/systemd.js", () => systemdMock);

import { resolveGatewayInstanceIdentity } from "../../config/gateway-instance.js";
import type { DevGatewayWorkerContext } from "../../goal/dev-gateway-workspace.js";
import {
  DevGatewayCommandError,
  runDevGatewayCliAction,
  type DevGatewayCliDeps,
} from "./register.dev-gateway.js";

const DEV_UNIT = resolveGatewayInstanceIdentity("dev").serviceUnit;
const STABLE_UNIT = resolveGatewayInstanceIdentity("stable").serviceUnit;

function devContext(overrides: Partial<DevGatewayWorkerContext> = {}): DevGatewayWorkerContext {
  return { isDevWorkspace: true, servicePresent: true, active: true, ...overrides };
}

function makeDeps(overrides: Partial<DevGatewayCliDeps> = {}): {
  deps: Partial<DevGatewayCliDeps>;
  logs: string[];
  contextCalls: Array<{ workingDir: string }>;
} {
  const logs: string[] = [];
  const contextCalls: Array<{ workingDir: string; cfg?: { devCapabilities?: "auto" | "off" } }> =
    [];
  const deps: Partial<DevGatewayCliDeps> = {
    resolveContext: (params) => {
      contextCalls.push(params);
      return devContext();
    },
    cwd: () => "/home/matt/smithersbot-home/agent/workspaces/smithersbot-dev",
    loadGoalConfig: () => undefined,
    env: {} as NodeJS.ProcessEnv,
    log: (message) => logs.push(message),
    ...overrides,
  };
  return { deps, logs, contextCalls };
}

describe("runDevGatewayCliAction", () => {
  beforeEach(() => {
    systemdMock.restartSystemdService.mockReset();
    systemdMock.readSystemdServiceActiveState.mockReset();
    systemdMock.readSystemdServiceRecentLogs.mockReset();
    systemdMock.readSystemdServiceRuntime.mockReset();

    systemdMock.restartSystemdService.mockImplementation(
      async ({ stdout }: { stdout: NodeJS.WritableStream }) => {
        stdout.write(`Restarted systemd service ${DEV_UNIT}\n`);
      },
    );
    systemdMock.readSystemdServiceActiveState.mockResolvedValue({
      active: true,
      state: "active",
      exitCode: 0,
    });
    systemdMock.readSystemdServiceRuntime.mockResolvedValue({
      status: "running",
      state: "active",
      subState: "running",
      pid: 4242,
    });
    systemdMock.readSystemdServiceRecentLogs.mockResolvedValue("line one\nline two\n");
  });

  it("restarts only the dev unit through the real mediated operation", async () => {
    const { deps, logs, contextCalls } = makeDeps();
    const result = await runDevGatewayCliAction("restart", {}, deps);

    expect(result).toMatchObject({ action: "restart", serviceUnit: DEV_UNIT });
    expect(systemdMock.restartSystemdService).toHaveBeenCalledTimes(1);
    // The fixed dev unit is selected via env, never a caller-supplied name.
    expect(systemdMock.restartSystemdService.mock.calls[0]![0]).toMatchObject({
      env: { CLAWDBOT_SYSTEMD_UNIT: DEV_UNIT },
    });
    // The dev-context gate was consulted with the resolved working dir.
    expect(contextCalls).toHaveLength(1);
    expect(logs.join("\n")).toContain(DEV_UNIT);
    expect(logs.join("\n")).not.toContain(STABLE_UNIT);
  });

  it("reads status / is-active for the dev unit", async () => {
    const { deps } = makeDeps();
    const result = await runDevGatewayCliAction("status", {}, deps);

    expect(result).toMatchObject({
      action: "status",
      serviceUnit: DEV_UNIT,
      activeState: { active: true, state: "active" },
      runtime: { status: "running", pid: 4242 },
    });
    expect(systemdMock.readSystemdServiceActiveState).toHaveBeenCalledTimes(1);
    expect(systemdMock.readSystemdServiceRuntime).toHaveBeenCalledTimes(1);
  });

  it("reads recent logs for the dev unit", async () => {
    const { deps } = makeDeps();
    const result = await runDevGatewayCliAction("logs", {}, deps);

    expect(result).toEqual({ action: "logs", serviceUnit: DEV_UNIT, logs: "line one\nline two\n" });
    expect(systemdMock.readSystemdServiceRecentLogs).toHaveBeenCalledTimes(1);
  });

  it("routes sandboxed goal workers through file-drop mediation instead of in-process systemd", async () => {
    const requestMediated = vi.fn(async () => ({
      action: "status" as const,
      ok: true,
      serviceUnit: DEV_UNIT,
      devPort: 18790,
      message: `Mediated status completed for ${DEV_UNIT}: active.`,
      stdout: '{"activeState":{"state":"active"}}',
      evidence: {
        mediated: true as const,
        responder: "smithersbot-dev-gateway" as const,
        serviceUnit: DEV_UNIT,
        action: "status" as const,
        completedAt: "2026-06-01T00:00:00.000Z",
      },
    }));
    const { deps, logs } = makeDeps({
      env: {
        SMITHERSBOT_GOAL_WORKER: "1",
        SMITHERSBOT_GOAL_RUN_ID: "run-1",
        SMITHERSBOT_GOAL_TASK_ID: "task-1",
      } as NodeJS.ProcessEnv,
      requestMediated,
    });

    const result = await runDevGatewayCliAction("status", {}, deps);

    expect(result).toMatchObject({ action: "status", ok: true, serviceUnit: DEV_UNIT });
    expect(requestMediated).toHaveBeenCalledWith({
      action: "status",
      runId: "run-1",
      taskId: "task-1",
    });
    expect(systemdMock.readSystemdServiceActiveState).not.toHaveBeenCalled();
    expect(systemdMock.restartSystemdService).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("Mediated status completed");
  });

  it("returns a clean structured blocker when sandboxed mediation is unavailable", async () => {
    const requestMediated = vi.fn(async () => ({
      action: "restart" as const,
      ok: false,
      serviceUnit: DEV_UNIT,
      devPort: 18790,
      message:
        "Dev-gateway host mediation is unavailable: timed out waiting for the gateway responder.",
      stderr: "[host-control unavailable]",
      errorCode: "capability_blocked",
    }));
    const { deps, logs } = makeDeps({
      env: {
        SMITHERSBOT_GOAL_WORKER: "1",
        SMITHERSBOT_GOAL_RUN_ID: "run-1",
        SMITHERSBOT_GOAL_TASK_ID: "task-1",
      } as NodeJS.ProcessEnv,
      requestMediated,
    });

    await expect(runDevGatewayCliAction("restart", { json: true }, deps)).rejects.toMatchObject({
      name: "DevGatewayCommandError",
      message:
        "Dev-gateway host mediation is unavailable: timed out waiting for the gateway responder.",
    });

    const output = logs.join("\n");
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      errorCode: "capability_blocked",
      serviceUnit: DEV_UNIT,
    });
    expect(output).not.toMatch(
      /Failed to connect to bus|D-Bus|systemctl --user|No data available/i,
    );
    expect(systemdMock.restartSystemdService).not.toHaveBeenCalled();
  });

  it("emits the result as JSON when requested", async () => {
    const { deps, logs } = makeDeps();
    await runDevGatewayCliAction("status", { json: true }, deps);
    expect(() => JSON.parse(logs.join("\n"))).not.toThrow();
  });

  it("rejects an arbitrary service name passed as the action, with no host call", async () => {
    const { deps } = makeDeps();
    await expect(runDevGatewayCliAction("some-arbitrary.service", {}, deps)).rejects.toBeInstanceOf(
      DevGatewayCommandError,
    );
    expect(systemdMock.restartSystemdService).not.toHaveBeenCalled();
    expect(systemdMock.readSystemdServiceActiveState).not.toHaveBeenCalled();
  });

  it("rejects any attempt to target the stable unit, with no host call", async () => {
    const { deps } = makeDeps();
    await expect(runDevGatewayCliAction(STABLE_UNIT, {}, deps)).rejects.toBeInstanceOf(
      DevGatewayCommandError,
    );
    // A 'restart smithersbot-gateway.service' style string is also just an action,
    // and is refused before any host work.
    await expect(runDevGatewayCliAction(`restart ${STABLE_UNIT}`, {}, deps)).rejects.toBeInstanceOf(
      DevGatewayCommandError,
    );
    expect(systemdMock.restartSystemdService).not.toHaveBeenCalled();
  });

  it("rejects unsupported actions (no stop/enable/disable/reinstall), with no host call", async () => {
    const { deps } = makeDeps();
    for (const action of ["stop", "enable", "disable", "reinstall", ""]) {
      await expect(runDevGatewayCliAction(action, {}, deps)).rejects.toBeInstanceOf(
        DevGatewayCommandError,
      );
    }
    expect(systemdMock.restartSystemdService).not.toHaveBeenCalled();
  });

  it("refuses outside the dev context and performs no host work", async () => {
    const notDevWorkspace = makeDeps({
      resolveContext: () =>
        devContext({ isDevWorkspace: false, servicePresent: false, active: false }),
    });
    await expect(
      runDevGatewayCliAction("restart", {}, notDevWorkspace.deps),
    ).rejects.toBeInstanceOf(DevGatewayCommandError);

    const devWorkspaceNoService = makeDeps({
      resolveContext: () => devContext({ servicePresent: false, active: false }),
    });
    await expect(
      runDevGatewayCliAction("status", {}, devWorkspaceNoService.deps),
    ).rejects.toBeInstanceOf(DevGatewayCommandError);

    expect(systemdMock.restartSystemdService).not.toHaveBeenCalled();
    expect(systemdMock.readSystemdServiceActiveState).not.toHaveBeenCalled();
  });

  it("passes goal devCapabilities config into the dev-context gate", async () => {
    const { deps, contextCalls } = makeDeps({
      loadGoalConfig: () => ({ devCapabilities: "off" }),
      resolveContext: (params) => {
        contextCalls.push(params);
        return devContext({ servicePresent: false, active: false });
      },
    });

    await expect(runDevGatewayCliAction("status", {}, deps)).rejects.toBeInstanceOf(
      DevGatewayCommandError,
    );

    expect(contextCalls).toEqual([
      {
        workingDir: "/home/matt/smithersbot-home/agent/workspaces/smithersbot-dev",
        cfg: { devCapabilities: "off" },
      },
    ]);
    expect(systemdMock.readSystemdServiceActiveState).not.toHaveBeenCalled();
  });
});
