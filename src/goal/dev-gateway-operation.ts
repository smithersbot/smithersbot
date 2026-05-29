import { Writable } from "node:stream";

import { resolveGatewayInstanceIdentity } from "../config/gateway-instance.js";
import {
  readSystemdServiceActiveState,
  readSystemdServiceRecentLogs,
  readSystemdServiceRuntime,
  restartSystemdService,
  type SystemdServiceActiveState,
} from "../daemon/systemd.js";
import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";

export const DEV_GATEWAY_OPERATION_ACTIONS = ["restart", "status", "logs"] as const;

export type DevGatewayOperationAction = (typeof DEV_GATEWAY_OPERATION_ACTIONS)[number];

export type DevGatewayRestartResult = {
  action: "restart";
  serviceUnit: string;
  output: string;
};

export type DevGatewayStatusResult = {
  action: "status";
  serviceUnit: string;
  activeState: SystemdServiceActiveState;
  runtime: GatewayServiceRuntime;
};

export type DevGatewayLogsResult = {
  action: "logs";
  serviceUnit: string;
  logs: string;
};

export type DevGatewayOperationResult =
  | DevGatewayRestartResult
  | DevGatewayStatusResult
  | DevGatewayLogsResult;

const DEV_GATEWAY_SERVICE_UNIT = resolveGatewayInstanceIdentity("dev").serviceUnit;
const STABLE_GATEWAY_SERVICE_UNIT = resolveGatewayInstanceIdentity("stable").serviceUnit;
const DEV_GATEWAY_OPERATION_ENV: Record<string, string | undefined> = {
  CLAWDBOT_SYSTEMD_UNIT: DEV_GATEWAY_SERVICE_UNIT,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDevGatewayOperationAction(input: unknown): DevGatewayOperationAction {
  const action = (() => {
    if (typeof input === "string") return input;
    if (!isRecord(input)) return undefined;
    const keys = Object.keys(input);
    if (keys.length !== 1 || !Object.hasOwn(input, "action")) {
      throw new Error(
        "Dev gateway operation accepts only an action; the service unit is fixed to the dev gateway.",
      );
    }
    return input.action;
  })();

  if (typeof action !== "string") {
    throw new Error("Dev gateway operation action must be a string.");
  }
  if (DEV_GATEWAY_OPERATION_ACTIONS.includes(action as DevGatewayOperationAction)) {
    return action as DevGatewayOperationAction;
  }
  throw new Error(
    `Unsupported dev gateway operation "${action}". Allowed actions: ${DEV_GATEWAY_OPERATION_ACTIONS.join(
      ", ",
    )}.`,
  );
}

function assertDevGatewayUnitOnly() {
  if (DEV_GATEWAY_SERVICE_UNIT === STABLE_GATEWAY_SERVICE_UNIT) {
    throw new Error("Refusing dev gateway operation because dev and stable units resolve equally.");
  }
}

function createWritableCapture(): { stream: NodeJS.WritableStream; read: () => string } {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      callback();
    },
  });
  return { stream, read: () => output };
}

export async function executeDevGatewayOperation(
  request: unknown,
): Promise<DevGatewayOperationResult> {
  const action = parseDevGatewayOperationAction(request);
  assertDevGatewayUnitOnly();

  if (action === "restart") {
    const stdout = createWritableCapture();
    await restartSystemdService({
      env: DEV_GATEWAY_OPERATION_ENV,
      stdout: stdout.stream,
    });
    return {
      action,
      serviceUnit: DEV_GATEWAY_SERVICE_UNIT,
      output: stdout.read(),
    };
  }

  if (action === "status") {
    const activeState = await readSystemdServiceActiveState({
      env: DEV_GATEWAY_OPERATION_ENV,
    });
    const runtime = await readSystemdServiceRuntime(DEV_GATEWAY_OPERATION_ENV);
    return {
      action,
      serviceUnit: DEV_GATEWAY_SERVICE_UNIT,
      activeState,
      runtime,
    };
  }

  const logs = await readSystemdServiceRecentLogs({
    env: DEV_GATEWAY_OPERATION_ENV,
    lines: 80,
  });
  return {
    action,
    serviceUnit: DEV_GATEWAY_SERVICE_UNIT,
    logs,
  };
}
