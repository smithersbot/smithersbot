import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the host/systemd layer so dispatch drives the genuine mediated operation
// path (dispatch -> runDevGatewayCliAction -> executeDevGatewayOperation ->
// systemd helpers) without ever touching the user systemd bus.
const systemdMock = vi.hoisted(() => ({
  restartSystemdService: vi.fn(),
  readSystemdServiceActiveState: vi.fn(),
  readSystemdServiceRecentLogs: vi.fn(),
  readSystemdServiceRuntime: vi.fn(),
}));
vi.mock("../daemon/systemd.js", () => systemdMock);

// Spy on the stable-config readers. The whole point of the dev-gateway path is
// that NONE of these run before the subcommand dispatches, so we assert they
// were never called. importActual keeps every other export live for the broad
// command-registry import graph exercised by the routing test.
const configMock = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
}));
vi.mock("../config/config.js", async (importActual) => {
  const actual = await importActual<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: configMock.loadConfig,
    readConfigFileSnapshot: configMock.readConfigFileSnapshot,
  };
});
const doctorFlowMock = vi.hoisted(() => ({ loadAndMaybeMigrateDoctorConfig: vi.fn() }));
vi.mock("../commands/doctor-config-flow.js", () => doctorFlowMock);

// Force an active dev context so the routing test (which calls the real action
// runner with default deps) does not depend on whether the dev unit file
// happens to exist on the test host. importActual keeps the other exports live.
vi.mock("./dev-gateway-workspace.js", async (importActual) => {
  const actual = await importActual<typeof import("./dev-gateway-workspace.js")>();
  return {
    ...actual,
    resolveDevGatewayWorkerContext: () => ({
      isDevWorkspace: true,
      servicePresent: true,
      active: true,
    }),
  };
});

import { resolveGatewayInstanceIdentity } from "../config/gateway-instance.js";
import { tryRouteCli } from "../cli/route.js";
import type { DevGatewayCliDeps } from "../cli/program/register.dev-gateway.js";
import type { DevGatewayWorkerContext } from "./dev-gateway-workspace.js";
import {
  dispatchDevGatewayCli,
  isDevGatewayCliInvocation,
  parseDevGatewayCliArgs,
} from "./dev-gateway-cli.js";

const DEV_UNIT = resolveGatewayInstanceIdentity("dev").serviceUnit;
const STABLE_UNIT = resolveGatewayInstanceIdentity("stable").serviceUnit;

function activeDevContext(): DevGatewayWorkerContext {
  return { isDevWorkspace: true, servicePresent: true, active: true };
}

function makeDispatchDeps(cliOverrides: Partial<DevGatewayCliDeps> = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  const cliDeps: Partial<DevGatewayCliDeps> = {
    resolveContext: () => activeDevContext(),
    cwd: () => "/home/matt/smithersbot-home/agent/workspaces/smithersbot-dev",
    env: {},
    log: (message) => logs.push(message),
    ...cliOverrides,
  };
  return {
    deps: {
      cliDeps,
      error: (m: string) => errors.push(m),
      exit: (code: number) => exits.push(code),
    },
    logs,
    errors,
    exits,
  };
}

function argvFor(...rest: string[]): string[] {
  return ["/usr/bin/node", "/app/smithersbot.mjs", ...rest];
}

function resetSystemdMock() {
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
}

describe("parse + match helpers", () => {
  it("recognizes the dev-gateway subcommand and ignores flags when parsing the action", () => {
    expect(isDevGatewayCliInvocation(argvFor("dev-gateway", "status"))).toBe(true);
    expect(isDevGatewayCliInvocation(argvFor("goal", "run"))).toBe(false);
    expect(parseDevGatewayCliArgs(argvFor("dev-gateway", "--json", "logs"))).toEqual({
      action: "logs",
      extra: [],
    });
    expect(parseDevGatewayCliArgs(argvFor("dev-gateway", "restart", STABLE_UNIT))).toEqual({
      action: "restart",
      extra: [STABLE_UNIT],
    });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("dispatchDevGatewayCli", () => {
  beforeEach(() => {
    resetSystemdMock();
    configMock.loadConfig.mockReset();
    configMock.readConfigFileSnapshot.mockReset();
    doctorFlowMock.loadAndMaybeMigrateDoctorConfig.mockReset();
  });

  it("returns false (unhandled) for non-dev-gateway argv", async () => {
    const { deps } = makeDispatchDeps();
    expect(await dispatchDevGatewayCli(argvFor("status"), deps)).toBe(false);
    expect(systemdMock.restartSystemdService).not.toHaveBeenCalled();
  });

  it("restarts only the fixed dev unit through the safe operation", async () => {
    const { deps, logs } = makeDispatchDeps();
    expect(await dispatchDevGatewayCli(argvFor("dev-gateway", "restart"), deps)).toBe(true);

    expect(systemdMock.restartSystemdService).toHaveBeenCalledTimes(1);
    expect(systemdMock.restartSystemdService.mock.calls[0]![0]).toMatchObject({
      env: { CLAWDBOT_SYSTEMD_UNIT: DEV_UNIT },
    });
    expect(logs.join("\n")).toContain(DEV_UNIT);
    expect(logs.join("\n")).not.toContain(STABLE_UNIT);
  });

  it("reads status/is-active and logs for the dev unit", async () => {
    const status = makeDispatchDeps();
    await dispatchDevGatewayCli(argvFor("dev-gateway", "status"), status.deps);
    expect(systemdMock.readSystemdServiceActiveState).toHaveBeenCalledTimes(1);
    expect(systemdMock.readSystemdServiceRuntime).toHaveBeenCalledTimes(1);
    expect(systemdMock.readSystemdServiceActiveState.mock.calls[0]![0]).toMatchObject({
      env: { CLAWDBOT_SYSTEMD_UNIT: DEV_UNIT },
    });

    const logs = makeDispatchDeps();
    await dispatchDevGatewayCli(argvFor("dev-gateway", "logs"), logs.deps);
    expect(systemdMock.readSystemdServiceRecentLogs).toHaveBeenCalledTimes(1);
  });

  it("uses mediation from a sandboxed worker and never calls systemctl in-process", async () => {
    const requestMediated = vi.fn(async () => ({
      action: "logs" as const,
      ok: true,
      serviceUnit: DEV_UNIT,
      devPort: 18790,
      message: `Mediated logs completed for ${DEV_UNIT}.`,
      stdout: "recent log line",
      evidence: {
        mediated: true as const,
        responder: "smithersbot-dev-gateway" as const,
        serviceUnit: DEV_UNIT,
        action: "logs" as const,
        completedAt: "2026-06-01T00:00:00.000Z",
      },
    }));
    const { deps, logs, exits } = makeDispatchDeps({
      env: {
        SMITHERSBOT_GOAL_WORKER: "1",
        SMITHERSBOT_GOAL_RUN_ID: "goal-1",
        SMITHERSBOT_GOAL_TASK_ID: "task-logs",
      } as NodeJS.ProcessEnv,
      requestMediated,
    });

    expect(await dispatchDevGatewayCli(argvFor("dev-gateway", "logs"), deps)).toBe(true);

    expect(requestMediated).toHaveBeenCalledWith({
      action: "logs",
      runId: "goal-1",
      taskId: "task-logs",
    });
    expect(systemdMock.readSystemdServiceRecentLogs).not.toHaveBeenCalled();
    expect(systemdMock.readSystemdServiceActiveState).not.toHaveBeenCalled();
    expect(systemdMock.restartSystemdService).not.toHaveBeenCalled();
    expect(exits).toEqual([]);
    expect(logs.join("\n")).toContain("Mediated logs completed");
  });

  it("reports unavailable mediation without leaking raw systemd stderr", async () => {
    const requestMediated = vi.fn(async () => ({
      action: "status" as const,
      ok: false,
      serviceUnit: DEV_UNIT,
      devPort: 18790,
      message: "Dev-gateway host mediation is unavailable: managed scratch root is not present.",
      stderr: "[host-control unavailable]",
      errorCode: "capability_blocked",
    }));
    const { deps, logs, errors, exits } = makeDispatchDeps({
      env: {
        SMITHERSBOT_GOAL_WORKER: "1",
        SMITHERSBOT_GOAL_RUN_ID: "goal-1",
        SMITHERSBOT_GOAL_TASK_ID: "task-status",
      } as NodeJS.ProcessEnv,
      requestMediated,
    });

    expect(await dispatchDevGatewayCli(argvFor("dev-gateway", "status", "--json"), deps)).toBe(
      true,
    );

    expect(exits).toEqual([1]);
    expect(errors.join("\n")).toContain("Dev-gateway host mediation is unavailable");
    expect(`${logs.join("\n")}\n${errors.join("\n")}`).not.toMatch(
      /Failed to connect to bus|D-Bus|systemctl --user|No data available/i,
    );
    expect(systemdMock.readSystemdServiceActiveState).not.toHaveBeenCalled();
  });

  it("scrubs managed filesystem paths from mediated CLI output and errors", async () => {
    const managedRoot = "/home/matt/smithersbot-home";
    const rawPath = `${managedRoot}/scratch/goal-1/task-status/dev-gateway-control/request.json`;
    const requestMediated = vi.fn(async () => ({
      action: "status" as const,
      ok: false,
      serviceUnit: DEV_UNIT,
      devPort: 18790,
      message: `ENOENT: no such file or directory, open '${rawPath}'`,
      stdout: `request path: ${rawPath}`,
      stderr: `EROFS: read-only file system, mkdir '${rawPath}'`,
      errorCode: "capability_blocked",
    }));
    const { deps, logs, errors, exits } = makeDispatchDeps({
      env: {
        SMITHERSBOT_GOAL_WORKER: "1",
        SMITHERSBOT_GOAL_RUN_ID: "goal-1",
        SMITHERSBOT_GOAL_TASK_ID: "task-status",
        SMITHERSBOT_GOALS_ROOT: managedRoot,
      } as NodeJS.ProcessEnv,
      requestMediated,
    });

    expect(await dispatchDevGatewayCli(argvFor("dev-gateway", "status", "--json"), deps)).toBe(
      true,
    );

    const combined = `${logs.join("\n")}\n${errors.join("\n")}`;
    expect(exits).toEqual([1]);
    expect(combined).toContain("[managed-path]");
    expect(combined).not.toContain(rawPath);
    expect(combined).not.toContain(`${managedRoot}/scratch`);
    const output = JSON.parse(logs.join("\n")) as {
      message: string;
      stdout?: string;
      stderr?: string;
    };
    expect(`${output.message}\n${output.stdout ?? ""}\n${output.stderr ?? ""}`).toContain(
      "[managed-path]",
    );
    expect(`${output.message}\n${output.stdout ?? ""}\n${output.stderr ?? ""}`).not.toContain(
      rawPath,
    );
    expect(systemdMock.readSystemdServiceActiveState).not.toHaveBeenCalled();
  });

  it("never reads stable config (~/.smithersbot/smithersbot.json) while dispatching", async () => {
    const { deps } = makeDispatchDeps();
    await dispatchDevGatewayCli(argvFor("dev-gateway", "status"), deps);
    expect(configMock.loadConfig).not.toHaveBeenCalled();
    expect(configMock.readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(doctorFlowMock.loadAndMaybeMigrateDoctorConfig).not.toHaveBeenCalled();
  });

  it("rejects unknown actions with a clean error and no host call", async () => {
    for (const action of ["frobnicate", "stop", "enable", "disable", "reinstall", ""]) {
      const { deps, errors, exits } = makeDispatchDeps();
      expect(await dispatchDevGatewayCli(argvFor("dev-gateway", action), deps)).toBe(true);
      expect(errors).toHaveLength(1);
      expect(exits).toEqual([1]);
    }
    expect(systemdMock.restartSystemdService).not.toHaveBeenCalled();
    expect(systemdMock.readSystemdServiceActiveState).not.toHaveBeenCalled();
  });

  it("rejects a bare service name passed as the action, with no host call", async () => {
    const { deps, exits } = makeDispatchDeps();
    expect(await dispatchDevGatewayCli(argvFor("dev-gateway", STABLE_UNIT), deps)).toBe(true);
    expect(exits).toEqual([1]);
    expect(systemdMock.restartSystemdService).not.toHaveBeenCalled();
  });

  it("rejects a service name smuggled as a second positional, with no host call", async () => {
    const { deps, errors, exits } = makeDispatchDeps();
    expect(await dispatchDevGatewayCli(argvFor("dev-gateway", "restart", STABLE_UNIT), deps)).toBe(
      true,
    );
    expect(exits).toEqual([1]);
    expect(errors[0]).toContain(STABLE_UNIT);
    expect(systemdMock.restartSystemdService).not.toHaveBeenCalled();
  });

  it("refuses outside the dev context and performs no host work", async () => {
    const outside = makeDispatchDeps({
      resolveContext: () => ({ isDevWorkspace: false, servicePresent: false, active: false }),
    });
    expect(await dispatchDevGatewayCli(argvFor("dev-gateway", "restart"), outside.deps)).toBe(true);
    expect(outside.exits).toEqual([1]);

    const noService = makeDispatchDeps({
      resolveContext: () => ({ isDevWorkspace: true, servicePresent: false, active: false }),
    });
    expect(await dispatchDevGatewayCli(argvFor("dev-gateway", "status"), noService.deps)).toBe(
      true,
    );
    expect(noService.exits).toEqual([1]);

    expect(systemdMock.restartSystemdService).not.toHaveBeenCalled();
    expect(systemdMock.readSystemdServiceActiveState).not.toHaveBeenCalled();
  });
});

// Wire-up: the fast-path router dispatches dev-gateway BEFORE the global config
// bootstrap. This proves end-to-end that `node smithersbot.mjs dev-gateway
// <action>` routes through the sanctioned path without reading stable config.
describe("dev-gateway fast route (tryRouteCli)", () => {
  beforeEach(() => {
    resetSystemdMock();
    configMock.loadConfig.mockReset();
    configMock.readConfigFileSnapshot.mockReset();
    doctorFlowMock.loadAndMaybeMigrateDoctorConfig.mockReset();
  });

  it("dispatches status to the dev unit without reading stable config", async () => {
    vi.stubEnv("SMITHERSBOT_GOAL_WORKER", undefined);
    vi.stubEnv("SMITHERSBOT_GOAL_RUN_ID", undefined);
    vi.stubEnv("SMITHERSBOT_GOAL_TASK_ID", undefined);

    const handled = await tryRouteCli(argvFor("dev-gateway", "status"));
    expect(handled).toBe(true);
    expect(systemdMock.readSystemdServiceActiveState).toHaveBeenCalledTimes(1);
    expect(systemdMock.readSystemdServiceActiveState.mock.calls[0]![0]).toMatchObject({
      env: { CLAWDBOT_SYSTEMD_UNIT: DEV_UNIT },
    });
    // The global doctor/config bootstrap (which reads the hard-denied stable
    // config) must NOT have run before the subcommand dispatched.
    expect(doctorFlowMock.loadAndMaybeMigrateDoctorConfig).not.toHaveBeenCalled();
    expect(configMock.readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(configMock.loadConfig).not.toHaveBeenCalled();
  });
});
