import type { Command } from "commander";

import { defaultRuntime } from "../../runtime.js";
import {
  DEV_GATEWAY_COMMAND_NAME,
  DEV_GATEWAY_OPERATION_ACTIONS,
  DEV_GATEWAY_OPERATION_UNIT,
  describeDevGatewayMediatedActions,
  executeDevGatewayOperation,
  type DevGatewayOperationAction,
  type DevGatewayOperationResult,
} from "../../goal/dev-gateway-operation.js";
import {
  resolveDevGatewayWorkerContext,
  type DevGatewayWorkerContext,
} from "../../goal/dev-gateway-workspace.js";
import { runCommandWithRuntime } from "../cli-utils.js";

/**
 * Raised when the dev-gateway command is invoked outside its allowed context or
 * with a disallowed action. Carries a clean, worker-facing message (never raw
 * systemd/bus stderr) so the entrypoint authors the error, not the host tools.
 */
export class DevGatewayCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevGatewayCommandError";
  }
}

export type DevGatewayCliDeps = {
  /** Dev-context gate: same resolver that drives DEV_GATEWAY_WORKER_INSTRUCTION. */
  resolveContext: (params: { workingDir: string }) => DevGatewayWorkerContext;
  /** The mediated operation; hard-fixed to the dev unit, action-only. */
  execute: (request: unknown) => Promise<DevGatewayOperationResult>;
  cwd: () => string;
  log: (message: string) => void;
};

const defaultDeps: DevGatewayCliDeps = {
  resolveContext: resolveDevGatewayWorkerContext,
  execute: executeDevGatewayOperation,
  cwd: () => process.cwd(),
  log: (message: string) => process.stdout.write(`${message}\n`),
};

function renderResult(result: DevGatewayOperationResult): string {
  if (result.action === "restart") {
    return `restart ${result.serviceUnit}: ${result.output.trim() || "ok"}`;
  }
  if (result.action === "status") {
    const { activeState, runtime } = result;
    return [
      `status ${result.serviceUnit}`,
      `  is-active: ${activeState.state} (active=${activeState.active})`,
      `  runtime: ${runtime.status}${runtime.subState ? ` (${runtime.subState})` : ""}${
        runtime.pid ? ` pid=${runtime.pid}` : ""
      }`,
    ].join("\n");
  }
  return `logs ${result.serviceUnit}:\n${result.logs}`;
}

/**
 * Worker-invocable dev-gateway control action.
 *
 * Hard guarantees (each enforced here AND again inside executeDevGatewayOperation):
 * - Only restart | status | logs are accepted; anything else (including a service
 *   name such as smithersbot-gateway.service) is rejected before any host call.
 * - The unit is never caller-supplied; the operation is hard-fixed to
 *   DEV_GATEWAY_OPERATION_UNIT (smithersbot-dev-gateway.service).
 * - Available only in the dev context (stable worker on the smithersbot-dev
 *   checkout with the dev gateway present); refused otherwise.
 *
 * The systemd work runs in this CLI process (the host holds the user-bus
 * session), so a worker invokes `moltbot dev-gateway <action>` rather than
 * touching the user systemd bus directly.
 */
export async function runDevGatewayCliAction(
  action: string,
  options: { json?: boolean } = {},
  deps: Partial<DevGatewayCliDeps> = {},
): Promise<DevGatewayOperationResult> {
  const d = { ...defaultDeps, ...deps };

  const context = d.resolveContext({ workingDir: d.cwd() });
  if (!context.active) {
    throw new DevGatewayCommandError(
      context.isDevWorkspace
        ? `Dev gateway control is unavailable: ${DEV_GATEWAY_OPERATION_UNIT} is not installed in this environment.`
        : "Dev gateway control is only available to a worker operating on the smithersbot-dev checkout.",
    );
  }

  // Validate the action up-front so an arbitrary/stable service name passed as
  // the action is refused with a clean message before any host work. The unit is
  // never forwarded — only the action is, and executeDevGatewayOperation keeps
  // the unit hard-fixed to the dev gateway.
  if (!DEV_GATEWAY_OPERATION_ACTIONS.includes(action as DevGatewayOperationAction)) {
    throw new DevGatewayCommandError(
      `Unsupported dev gateway action "${action}". Allowed actions: ${DEV_GATEWAY_OPERATION_ACTIONS.join(
        ", ",
      )}. The unit is fixed to ${DEV_GATEWAY_OPERATION_UNIT}; no service name is accepted.`,
    );
  }

  const result = await d.execute({ action });
  d.log(options.json ? JSON.stringify(result, null, 2) : renderResult(result));
  return result;
}

export function registerDevGatewayCommand(program: Command) {
  program
    .command(`${DEV_GATEWAY_COMMAND_NAME} <action>`)
    .description(
      `Safe, fixed-unit control for ${DEV_GATEWAY_OPERATION_UNIT} (dev workspace only): restart | status | logs`,
    )
    .allowExcessArguments(false)
    .option("--json", "Output the operation result as JSON", false)
    .addHelpText(
      "after",
      () =>
        `\nMediated actions (fixed to ${DEV_GATEWAY_OPERATION_UNIT}; no service name is ever accepted):\n` +
        describeDevGatewayMediatedActions()
          .map((line) => `  - ${line}`)
          .join("\n") +
        "\n",
    )
    .action(async (action: string, opts: { json?: boolean }) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await runDevGatewayCliAction(String(action), { json: Boolean(opts.json) });
      });
    });
}
