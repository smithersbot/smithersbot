import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => {
  const execFile = vi.fn();
  const execFileAsync = vi.fn();
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
    value: execFileAsync,
  });
  return { execFile, execFileAsync };
});

vi.mock("node:child_process", () => ({
  execFile: childProcessMock.execFile,
}));

import { resolveGatewayInstanceIdentity } from "../config/gateway-instance.js";
import {
  DEV_GATEWAY_OPERATION_ACTIONS,
  DevGatewayCommandError,
  executeDevGatewayOperation,
} from "./dev-gateway-operation.js";

const DEV_UNIT = resolveGatewayInstanceIdentity("dev").serviceUnit;
const STABLE_UNIT = resolveGatewayInstanceIdentity("stable").serviceUnit;

type ExecFileResponse = {
  status: number;
  stdout?: string;
  stderr?: string;
};

function ok(stdout = "", stderr = ""): ExecFileResponse {
  return { status: 0, stdout, stderr };
}

function matches(args: readonly string[], expected: readonly string[]): boolean {
  return args.length === expected.length && args.every((arg, index) => arg === expected[index]);
}

function responseFor(command: string, args: readonly string[]): ExecFileResponse {
  if (command === "systemctl" && matches(args, ["--user", "status"])) {
    return ok();
  }
  if (command === "systemctl" && matches(args, ["--user", "restart", DEV_UNIT])) {
    return ok("restarted dev\n");
  }
  if (command === "systemctl" && matches(args, ["--user", "is-active", DEV_UNIT])) {
    return ok("active\n");
  }
  if (
    command === "systemctl" &&
    matches(args, [
      "--user",
      "show",
      DEV_UNIT,
      "--no-page",
      "--property",
      "ActiveState,SubState,MainPID,ExecMainStatus,ExecMainCode",
    ])
  ) {
    return ok(["ActiveState=active", "SubState=running", "MainPID=4242"].join("\n"));
  }
  if (
    command === "journalctl" &&
    matches(args, ["--user", "-u", DEV_UNIT, "-n", "80", "--no-pager"])
  ) {
    return ok("line one\nline two\n");
  }
  throw new Error(`Unexpected execFile call: ${command} ${args.join(" ")}`);
}

function installExecFileMock() {
  childProcessMock.execFileAsync.mockImplementation(
    async (command: string, args: readonly string[]) => {
      const response = responseFor(command, args);
      if (response.status === 0) {
        return {
          stdout: response.stdout ?? "",
          stderr: response.stderr ?? "",
        };
      }
      const error = new Error(response.stderr || "execFile failed") as Error & {
        stdout?: string;
        stderr?: string;
        code?: number;
      };
      error.stdout = response.stdout ?? "";
      error.stderr = response.stderr ?? "";
      error.code = response.status;
      throw error;
    },
  );
}

function execFileCalls(): Array<{ command: string; args: string[] }> {
  return childProcessMock.execFileAsync.mock.calls.map(([command, args]) => ({
    command: String(command),
    args: Array.isArray(args) ? args.map(String) : [],
  }));
}

function callsReferencing(unit: string): Array<{ command: string; args: string[] }> {
  return execFileCalls().filter((call) => call.args.includes(unit));
}

describe("executeDevGatewayOperation", () => {
  beforeEach(() => {
    childProcessMock.execFile.mockReset();
    childProcessMock.execFileAsync.mockReset();
    installExecFileMock();
  });

  it("exposes exactly the dev gateway action allowlist", () => {
    expect(DEV_GATEWAY_OPERATION_ACTIONS).toEqual(["restart", "status", "logs"]);
  });

  it("restarts only the dev gateway unit", async () => {
    const result = await executeDevGatewayOperation({ action: "restart" });

    expect(result).toMatchObject({
      action: "restart",
      serviceUnit: DEV_UNIT,
      output: expect.stringContaining("Restarted systemd service"),
    });
    expect(execFileCalls()).toContainEqual({
      command: "systemctl",
      args: ["--user", "restart", DEV_UNIT],
    });
    expect(callsReferencing(STABLE_UNIT)).toHaveLength(0);
  });

  it("reads status and active state only for the dev gateway unit", async () => {
    const result = await executeDevGatewayOperation({ action: "status" });

    expect(result).toMatchObject({
      action: "status",
      serviceUnit: DEV_UNIT,
      activeState: {
        active: true,
        state: "active",
        exitCode: 0,
      },
      runtime: {
        status: "running",
        state: "active",
        subState: "running",
        pid: 4242,
      },
    });
    expect(execFileCalls()).toContainEqual({
      command: "systemctl",
      args: ["--user", "is-active", DEV_UNIT],
    });
    expect(execFileCalls()).toContainEqual({
      command: "systemctl",
      args: [
        "--user",
        "show",
        DEV_UNIT,
        "--no-page",
        "--property",
        "ActiveState,SubState,MainPID,ExecMainStatus,ExecMainCode",
      ],
    });
    expect(callsReferencing(STABLE_UNIT)).toHaveLength(0);
  });

  it("reads recent logs only for the dev gateway unit", async () => {
    const result = await executeDevGatewayOperation({ action: "logs" });

    expect(result).toEqual({
      action: "logs",
      serviceUnit: DEV_UNIT,
      logs: "line one\nline two\n",
    });
    expect(execFileCalls()).toContainEqual({
      command: "journalctl",
      args: ["--user", "-u", DEV_UNIT, "-n", "80", "--no-pager"],
    });
    expect(callsReferencing(STABLE_UNIT)).toHaveLength(0);
  });

  it("rejects unsupported actions without calling systemctl or journalctl", async () => {
    await expect(executeDevGatewayOperation({ action: "stop" })).rejects.toThrow(
      /Unsupported dev gateway operation/,
    );
    await expect(executeDevGatewayOperation("restart smithersbot-gateway.service")).rejects.toThrow(
      /Unsupported dev gateway operation/,
    );

    expect(childProcessMock.execFileAsync).not.toHaveBeenCalled();
  });

  it("rejects caller-supplied stable or arbitrary units without host calls", async () => {
    await expect(
      executeDevGatewayOperation({ action: "restart", serviceUnit: STABLE_UNIT }),
    ).rejects.toThrow(/service unit is fixed/);
    await expect(
      executeDevGatewayOperation({ action: "status", unit: "custom-gateway.service" }),
    ).rejects.toThrow(/service unit is fixed/);
    await expect(
      executeDevGatewayOperation({ action: "logs", serviceUnit: DEV_UNIT }),
    ).rejects.toThrow(/service unit is fixed/);

    expect(childProcessMock.execFileAsync).not.toHaveBeenCalled();
    expect(callsReferencing(STABLE_UNIT)).toHaveLength(0);
  });

  it("wraps systemd bus failures without leaking raw D-Bus stderr in the public message", async () => {
    childProcessMock.execFileAsync.mockImplementation(async () => {
      const error = new Error(
        "systemctl --user unavailable: Failed to connect to bus: No data available",
      ) as Error & { stderr?: string; code?: number };
      error.stderr = "Failed to connect to bus: No data available";
      error.code = 1;
      throw error;
    });

    let thrown: unknown;
    try {
      await executeDevGatewayOperation({ action: "status" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DevGatewayCommandError);
    expect(thrown).toMatchObject({
      name: "DevGatewayCommandError",
      code: "dev_gateway_host_control_unavailable",
    });
    const error = thrown as DevGatewayCommandError;
    expect(error.message).not.toMatch(
      /Failed to connect to bus|D-Bus|systemctl --user unavailable|No data available/,
    );
    expect(error.diagnostics).toMatch(/Failed to connect to bus/);
  });
});
