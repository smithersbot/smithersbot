import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { resolveGatewayInstanceIdentity } from "../config/gateway-instance.js";
import { resolveScratchDir, resolveScratchRoot } from "../config/managed-paths.js";
import {
  DEV_GATEWAY_OPERATION_ACTIONS,
  DEV_GATEWAY_OPERATION_UNIT,
  DevGatewayCommandError,
  executeDevGatewayOperation,
  type DevGatewayOperationAction,
  type DevGatewayOperationResult,
} from "./dev-gateway-operation.js";

const CHANNEL_DIRNAME = "dev-gateway-control";
const REQUEST_SUFFIX = ".request.json";
const RESULT_SUFFIX = ".result.json";
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_PUBLIC_FIELD_LENGTH = 16_000;

const RAW_SYSTEMD_PATTERNS = [
  /Failed to connect to bus/gi,
  /D-Bus/gi,
  /DBus/gi,
  /systemctl --user unavailable/gi,
  /No data available/gi,
];

export type DevGatewayMediationRequest = {
  action: DevGatewayOperationAction;
  runId?: string;
  taskId?: string;
};

export type DevGatewayMediatedResult = {
  action: DevGatewayOperationAction;
  ok: boolean;
  serviceUnit: string;
  devPort: number;
  message: string;
  stdout?: string;
  stderr?: string;
  evidence?: {
    mediated: true;
    responder: "smithersbot-dev-gateway";
    serviceUnit: string;
    action: DevGatewayOperationAction;
    completedAt: string;
  };
  errorCode?: string;
};

export type DevGatewayMediationPaths = {
  scratchRoot: string;
  taskScratchDir: string;
  channelDir: string;
};

export type DevGatewayMediatorHandle = {
  scratchRoot: string;
  stop: () => void;
};

type FsLike = Pick<
  typeof fs,
  | "existsSync"
  | "mkdirSync"
  | "readdirSync"
  | "readFileSync"
  | "renameSync"
  | "unlinkSync"
  | "writeFileSync"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizePublicText(input: unknown): string {
  let text =
    typeof input === "string"
      ? input
      : input == null
        ? ""
        : input instanceof Error
          ? input.message
          : JSON.stringify(input);
  if (typeof text !== "string") text = "";
  for (const pattern of RAW_SYSTEMD_PATTERNS) {
    text = text.replace(pattern, "[host-control unavailable]");
  }
  if (text.length > MAX_PUBLIC_FIELD_LENGTH) {
    text = `${text.slice(0, MAX_PUBLIC_FIELD_LENGTH)}\n[truncated]`;
  }
  return text;
}

function atomicWriteJson(fsImpl: FsLike, filePath: string, value: unknown): void {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fsImpl.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fsImpl.renameSync(tempPath, filePath);
}

function readJsonFile(fsImpl: FsLike, filePath: string): unknown {
  return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function assertInsideScratchRoot(candidate: string, scratchRoot: string): void {
  if (!isInside(candidate, scratchRoot)) {
    throw new Error("Dev-gateway mediation path must stay inside the managed scratch root.");
  }
}

export function resolveDevGatewayMediationPaths(params: {
  runId: string;
  taskId: string;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): DevGatewayMediationPaths {
  const scratchRoot = resolveScratchRoot(params.env, params.homedir);
  const taskScratchDir = resolveScratchDir(params.runId, params.taskId, params.env, params.homedir);
  const channelDir = path.join(taskScratchDir, CHANNEL_DIRNAME);
  assertInsideScratchRoot(channelDir, scratchRoot);
  return { scratchRoot, taskScratchDir, channelDir };
}

export function parseDevGatewayMediationRequest(input: unknown): DevGatewayMediationRequest {
  if (!isRecord(input)) {
    throw new Error("Dev-gateway mediation request must be a JSON object.");
  }
  const allowedKeys = new Set(["action", "runId", "taskId"]);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        "Dev-gateway mediation request accepts only action plus optional run/task correlation.",
      );
    }
  }
  const action = input.action;
  if (
    typeof action !== "string" ||
    !DEV_GATEWAY_OPERATION_ACTIONS.includes(action as DevGatewayOperationAction)
  ) {
    throw new Error(
      `Unsupported dev-gateway mediation action. Allowed actions: ${DEV_GATEWAY_OPERATION_ACTIONS.join(
        ", ",
      )}.`,
    );
  }
  const request: DevGatewayMediationRequest = { action: action as DevGatewayOperationAction };
  if (typeof input.runId === "string" && input.runId.trim()) request.runId = input.runId.trim();
  if (typeof input.taskId === "string" && input.taskId.trim()) request.taskId = input.taskId.trim();
  return request;
}

function resultFromOperation(
  request: DevGatewayMediationRequest,
  operation: DevGatewayOperationResult,
): DevGatewayMediatedResult {
  const identity = resolveGatewayInstanceIdentity("dev");
  const evidence = {
    mediated: true as const,
    responder: "smithersbot-dev-gateway" as const,
    serviceUnit: DEV_GATEWAY_OPERATION_UNIT,
    action: request.action,
    completedAt: new Date().toISOString(),
  };
  if (operation.action === "restart") {
    return {
      action: request.action,
      ok: true,
      serviceUnit: DEV_GATEWAY_OPERATION_UNIT,
      devPort: identity.defaultPort,
      message: `Mediated ${request.action} completed for ${DEV_GATEWAY_OPERATION_UNIT}.`,
      stdout: sanitizePublicText(operation.output),
      evidence,
    };
  }
  if (operation.action === "status") {
    return {
      action: request.action,
      ok: true,
      serviceUnit: DEV_GATEWAY_OPERATION_UNIT,
      devPort: identity.defaultPort,
      message: `Mediated status completed for ${DEV_GATEWAY_OPERATION_UNIT}: ${operation.activeState.state}.`,
      stdout: sanitizePublicText(
        JSON.stringify({ activeState: operation.activeState, runtime: operation.runtime }),
      ),
      evidence,
    };
  }
  return {
    action: request.action,
    ok: true,
    serviceUnit: DEV_GATEWAY_OPERATION_UNIT,
    devPort: identity.defaultPort,
    message: `Mediated logs completed for ${DEV_GATEWAY_OPERATION_UNIT}.`,
    stdout: sanitizePublicText(operation.logs),
    evidence,
  };
}

function blockedResult(
  action: DevGatewayOperationAction,
  message: string,
): DevGatewayMediatedResult {
  return {
    action,
    ok: false,
    serviceUnit: DEV_GATEWAY_OPERATION_UNIT,
    devPort: resolveGatewayInstanceIdentity("dev").defaultPort,
    message: sanitizePublicText(message),
    errorCode: "capability_blocked",
  };
}

function errorResult(action: DevGatewayOperationAction, error: unknown): DevGatewayMediatedResult {
  if (error instanceof DevGatewayCommandError) {
    return {
      action,
      ok: false,
      serviceUnit: DEV_GATEWAY_OPERATION_UNIT,
      devPort: resolveGatewayInstanceIdentity("dev").defaultPort,
      message: sanitizePublicText(error.message),
      stderr: sanitizePublicText(error.message),
      errorCode: error.code,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    action,
    ok: false,
    serviceUnit: DEV_GATEWAY_OPERATION_UNIT,
    devPort: resolveGatewayInstanceIdentity("dev").defaultPort,
    message: sanitizePublicText(message),
    stderr: sanitizePublicText(message),
    errorCode: "dev_gateway_mediation_failed",
  };
}

export async function executeHostMediatedDevGatewayRequest(
  input: unknown,
  deps: {
    execute?: (request: unknown) => Promise<DevGatewayOperationResult>;
  } = {},
): Promise<DevGatewayMediatedResult> {
  let request: DevGatewayMediationRequest;
  try {
    request = parseDevGatewayMediationRequest(input);
  } catch (error) {
    const fallbackAction =
      isRecord(input) &&
      typeof input.action === "string" &&
      DEV_GATEWAY_OPERATION_ACTIONS.includes(input.action as DevGatewayOperationAction)
        ? (input.action as DevGatewayOperationAction)
        : "status";
    return errorResult(fallbackAction, error);
  }
  try {
    const operation = await (deps.execute ?? executeDevGatewayOperation)({
      action: request.action,
    });
    return resultFromOperation(request, operation);
  } catch (error) {
    return errorResult(request.action, error);
  }
}

function listRequestFiles(fsImpl: FsLike, scratchRoot: string): string[] {
  if (!fsImpl.existsSync(scratchRoot)) return [];
  const requestFiles: string[] = [];
  for (const runEntry of fsImpl.readdirSync(scratchRoot, { withFileTypes: true })) {
    if (!runEntry.isDirectory()) continue;
    const runDir = path.join(scratchRoot, runEntry.name);
    assertInsideScratchRoot(runDir, scratchRoot);
    for (const taskEntry of fsImpl.readdirSync(runDir, { withFileTypes: true })) {
      if (!taskEntry.isDirectory()) continue;
      const channelDir = path.join(runDir, taskEntry.name, CHANNEL_DIRNAME);
      assertInsideScratchRoot(channelDir, scratchRoot);
      if (!fsImpl.existsSync(channelDir)) continue;
      for (const requestEntry of fsImpl.readdirSync(channelDir, { withFileTypes: true })) {
        if (!requestEntry.isFile() || !requestEntry.name.endsWith(REQUEST_SUFFIX)) continue;
        const requestPath = path.join(channelDir, requestEntry.name);
        assertInsideScratchRoot(requestPath, scratchRoot);
        requestFiles.push(requestPath);
      }
    }
  }
  return requestFiles;
}

export async function processDevGatewayMediationRequestsOnce(
  params: {
    scratchRoot?: string;
    fsImpl?: FsLike;
    execute?: (request: unknown) => Promise<DevGatewayOperationResult>;
    log?: { warn: (message: string) => void };
  } = {},
): Promise<number> {
  const fsImpl = params.fsImpl ?? fs;
  const scratchRoot = params.scratchRoot ?? resolveScratchRoot();
  let processed = 0;
  for (const requestPath of listRequestFiles(fsImpl, scratchRoot)) {
    const inFlightPath = requestPath.replace(REQUEST_SUFFIX, ".processing.json");
    try {
      fsImpl.renameSync(requestPath, inFlightPath);
    } catch {
      continue;
    }
    const resultPath = requestPath.replace(REQUEST_SUFFIX, RESULT_SUFFIX);
    let action: DevGatewayOperationAction = "status";
    try {
      const request = parseDevGatewayMediationRequest(readJsonFile(fsImpl, inFlightPath));
      action = request.action;
      const result = await executeHostMediatedDevGatewayRequest(request, {
        execute: params.execute,
      });
      atomicWriteJson(fsImpl, resultPath, result);
      processed += 1;
    } catch (error) {
      atomicWriteJson(fsImpl, resultPath, errorResult(action, error));
      processed += 1;
      params.log?.warn(
        `dev-gateway mediation request failed: ${sanitizePublicText(
          error instanceof Error ? error.message : String(error),
        )}`,
      );
    } finally {
      try {
        fsImpl.unlinkSync(inFlightPath);
      } catch {
        // best-effort cleanup
      }
    }
  }
  return processed;
}

export function startDevGatewayHostMediator(
  params: {
    scratchRoot?: string;
    pollIntervalMs?: number;
    fsImpl?: FsLike;
    execute?: (request: unknown) => Promise<DevGatewayOperationResult>;
    log?: { info?: (message: string) => void; warn: (message: string) => void };
  } = {},
): DevGatewayMediatorHandle {
  const scratchRoot = params.scratchRoot ?? resolveScratchRoot();
  fs.mkdirSync(scratchRoot, { recursive: true });
  params.log?.info?.(`dev-gateway host mediator watching scratch root ${scratchRoot}`);
  const timer = setInterval(() => {
    void processDevGatewayMediationRequestsOnce({
      scratchRoot,
      fsImpl: params.fsImpl,
      execute: params.execute,
      log: params.log,
    });
  }, params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  timer.unref();
  return {
    scratchRoot,
    stop: () => clearInterval(timer),
  };
}

export async function requestHostMediatedDevGatewayOperation(params: {
  action: DevGatewayOperationAction;
  runId: string;
  taskId: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  fsImpl?: FsLike;
}): Promise<DevGatewayMediatedResult> {
  const fsImpl = params.fsImpl ?? fs;
  const paths = resolveDevGatewayMediationPaths(params);
  if (!fsImpl.existsSync(paths.scratchRoot)) {
    return blockedResult(
      params.action,
      "Dev-gateway host mediation is unavailable: managed scratch root is not present.",
    );
  }
  if (!fsImpl.existsSync(paths.channelDir)) {
    return blockedResult(
      params.action,
      "Dev-gateway host mediation is unavailable: the mediation channel is not ready.",
    );
  }
  const requestId = randomUUID();
  const requestPath = path.join(paths.channelDir, `${requestId}${REQUEST_SUFFIX}`);
  const resultPath = path.join(paths.channelDir, `${requestId}${RESULT_SUFFIX}`);
  try {
    atomicWriteJson(fsImpl, requestPath, {
      action: params.action,
      runId: params.runId,
      taskId: params.taskId,
    } satisfies DevGatewayMediationRequest);
  } catch {
    // The scratch root exists but the worker cannot create/write its per-task
    // mediation channel (e.g. the gateway-controlled scratch dir is not in the
    // worker sandbox's writable set, so mkdir/write fails with EROFS/EACCES).
    // Return a clean capability_blocked result; never let the raw fs error or the
    // scratch path leak into a user-facing goal message.
    return blockedResult(
      params.action,
      "Dev-gateway host mediation is unavailable: the worker cannot write to the mediation channel.",
    );
  }

  const deadline = Date.now() + (params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (fsImpl.existsSync(resultPath)) {
      const result = readJsonFile(fsImpl, resultPath);
      if (isRecord(result) && result.ok !== undefined && result.action === params.action) {
        return result as DevGatewayMediatedResult;
      }
      return blockedResult(params.action, "Dev-gateway host mediation returned an invalid result.");
    }
    await new Promise((resolve) =>
      setTimeout(resolve, params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
    );
  }
  return blockedResult(
    params.action,
    "Dev-gateway host mediation is unavailable: timed out waiting for the gateway responder.",
  );
}
