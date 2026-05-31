// Exact, literal allowlist for the sanctioned host-mediated dev-gateway path.
//
// A stable worker running a goal on the smithersbot-dev checkout cannot reach
// the user systemd bus from inside its sandbox. The ONLY sanctioned escape is to
// run the product CLI's dev-gateway subcommand on the host so it can drive the
// dev unit. To keep that escape hatch from widening into broad host/node/systemd
// access, exactly three command lines may pass through it — and only when the
// worker is genuinely in the dev context:
//
//   node smithersbot.mjs dev-gateway restart
//   node smithersbot.mjs dev-gateway status
//   node smithersbot.mjs dev-gateway logs
//
// Everything else is denied: arbitrary node execution, arbitrary scripts,
// arbitrary service names, arbitrary systemctl, any operation on the stable
// unit, and stop/enable/disable/reinstall (none of those are dev-gateway
// actions, so they can never match). The allowed commands and the fixed dev
// unit are DERIVED from src/goal/dev-gateway-operation.ts so this allowlist can
// never drift from the mediated operation it guards.

import {
  DEV_GATEWAY_COMMAND_NAME,
  DEV_GATEWAY_OPERATION_ACTIONS,
  DEV_GATEWAY_OPERATION_UNIT,
  type DevGatewayOperationAction,
} from "./dev-gateway-operation.js";
import {
  resolveDevGatewayWorkerContext,
  type DevGatewayWorkerContext,
} from "./dev-gateway-workspace.js";

/** The Node binary token a host-mediated dev-gateway invocation must use, verbatim. */
export const DEV_GATEWAY_HOST_MEDIATED_NODE_BIN = "node";

/**
 * The CLI entrypoint script token, verbatim. A bare filename (no slashes, no
 * path) — the host-mediated path always runs from the dev checkout root, so the
 * entrypoint is never a caller-supplied path that could point elsewhere.
 */
export const DEV_GATEWAY_HOST_MEDIATED_ENTRYPOINT = "smithersbot.mjs";

/**
 * The exact, literal command lines permitted through the host-mediated path,
 * derived from the action allowlist + fixed command name. This is the single
 * source of truth for what may run out-of-sandbox to reach the user systemd bus.
 */
export const DEV_GATEWAY_HOST_MEDIATED_COMMANDS: readonly string[] = Object.freeze(
  DEV_GATEWAY_OPERATION_ACTIONS.map(
    (action) =>
      `${DEV_GATEWAY_HOST_MEDIATED_NODE_BIN} ${DEV_GATEWAY_HOST_MEDIATED_ENTRYPOINT} ${DEV_GATEWAY_COMMAND_NAME} ${action}`,
  ),
);

export type HostMediatedDenyReason =
  | "empty-command"
  | "shell-metacharacters"
  | "non-node-binary"
  | "non-entrypoint-script"
  | "non-dev-gateway-command"
  | "unsupported-action"
  | "excess-arguments"
  | "outside-dev-context"
  | "dev-gateway-not-installed";

export type HostMediatedDevGatewayDecision =
  | {
      allowed: true;
      /** The validated dev-gateway action. */
      action: DevGatewayOperationAction;
      /** Always the fixed dev unit — never caller-supplied. */
      serviceUnit: string;
      /** The normalized command line (single-spaced) that was allowed. */
      command: string;
    }
  | {
      allowed: false;
      reason: HostMediatedDenyReason;
      message: string;
    };

export type HostMediatedDevGatewayOptions = {
  /** Pre-resolved dev context. When omitted it is resolved from the other fields. */
  context?: DevGatewayWorkerContext;
  /** Working dir/checkout used to resolve the dev context when `context` is absent. */
  workingDir?: string;
  /** Inject dev-gateway service presence (avoids touching the filesystem in tests). */
  servicePresent?: boolean;
  homedir?: () => string;
  fileExists?: (filePath: string) => boolean;
};

// Allow ONLY the characters that appear in the three literal commands. Any shell
// metacharacter, quote, slash, glob, or substitution byte fails this gate, so a
// caller cannot smuggle a second command, redirect, env prefix, or alternate
// path past the token comparison below.
const SAFE_COMMAND_PATTERN = /^[A-Za-z0-9 ._-]+$/;

function deny(reason: HostMediatedDenyReason, message: string): HostMediatedDevGatewayDecision {
  return { allowed: false, reason, message };
}

/**
 * Decide whether `command` is a sanctioned host-mediated dev-gateway invocation.
 *
 * Returns `{ allowed: true, action, serviceUnit }` ONLY for one of the three
 * exact command lines AND only when the worker is in the active dev context.
 * Every other input — broad node execution, arbitrary scripts/services,
 * systemctl, stable-unit control, stop/enable/disable/reinstall, or any
 * non-dev context — is denied with a specific reason.
 */
export function resolveHostMediatedDevGatewayCommand(
  command: unknown,
  options: HostMediatedDevGatewayOptions = {},
): HostMediatedDevGatewayDecision {
  const raw = typeof command === "string" ? command.trim() : "";
  if (!raw) {
    return deny("empty-command", "No command was provided to the host-mediated dev-gateway path.");
  }

  if (!SAFE_COMMAND_PATTERN.test(raw)) {
    return deny(
      "shell-metacharacters",
      "Host-mediated dev-gateway invocation must be a single literal command with no shell metacharacters, quoting, paths, or substitutions.",
    );
  }

  const tokens = raw.split(/\s+/).filter(Boolean);

  if (tokens[0] !== DEV_GATEWAY_HOST_MEDIATED_NODE_BIN) {
    return deny(
      "non-node-binary",
      `Host-mediated dev-gateway invocation must start with "${DEV_GATEWAY_HOST_MEDIATED_NODE_BIN}".`,
    );
  }

  if (tokens[1] !== DEV_GATEWAY_HOST_MEDIATED_ENTRYPOINT) {
    return deny(
      "non-entrypoint-script",
      `Host-mediated dev-gateway invocation must run the "${DEV_GATEWAY_HOST_MEDIATED_ENTRYPOINT}" entrypoint; arbitrary scripts are not permitted.`,
    );
  }

  if (tokens[2] !== DEV_GATEWAY_COMMAND_NAME) {
    return deny(
      "non-dev-gateway-command",
      `Host-mediated invocation is limited to the "${DEV_GATEWAY_COMMAND_NAME}" subcommand; no other CLI command may run out-of-sandbox.`,
    );
  }

  const action = tokens[3];
  if (!action || !DEV_GATEWAY_OPERATION_ACTIONS.includes(action as DevGatewayOperationAction)) {
    return deny(
      "unsupported-action",
      `Unsupported dev-gateway action "${action ?? ""}". Allowed actions: ${DEV_GATEWAY_OPERATION_ACTIONS.join(
        ", ",
      )}. No service name is ever accepted; the unit is fixed to ${DEV_GATEWAY_OPERATION_UNIT}.`,
    );
  }

  if (tokens.length > 4) {
    return deny(
      "excess-arguments",
      "Host-mediated dev-gateway invocation accepts only an action; extra arguments (including service names or flags) are not permitted.",
    );
  }

  const context =
    options.context ??
    resolveDevGatewayWorkerContext({
      workingDir: options.workingDir ?? "",
      servicePresent: options.servicePresent,
      homedir: options.homedir,
      fileExists: options.fileExists,
    });

  if (!context.isDevWorkspace) {
    return deny(
      "outside-dev-context",
      "Host-mediated dev-gateway control is only available to a worker operating on the smithersbot-dev checkout.",
    );
  }

  if (!context.active) {
    return deny(
      "dev-gateway-not-installed",
      `Host-mediated dev-gateway control is unavailable: ${DEV_GATEWAY_OPERATION_UNIT} is not installed in this environment.`,
    );
  }

  return {
    allowed: true,
    action: action as DevGatewayOperationAction,
    serviceUnit: DEV_GATEWAY_OPERATION_UNIT,
    command: tokens.join(" "),
  };
}

/** Convenience boolean wrapper around {@link resolveHostMediatedDevGatewayCommand}. */
export function isAllowedHostMediatedDevGatewayCommand(
  command: unknown,
  options: HostMediatedDevGatewayOptions = {},
): boolean {
  return resolveHostMediatedDevGatewayCommand(command, options).allowed;
}
