// Config-free CLI dispatch for the worker-invocable dev-gateway subcommand.
//
// The dev-gateway command is the ONE sanctioned host-mediated path a stable
// worker uses to drive smithersbot-dev-gateway.service (restart | status |
// logs). It must reach the user systemd bus WITHOUT first running the global
// doctor/config bootstrap, which reads the hard-denied stable config file
// ~/.smithersbot/smithersbot.json. This module provides a minimal preflight +
// dispatch that the fast-path router invokes before any config is loaded:
//
//   1. confirm the invocation targets the dev-gateway subcommand,
//   2. parse exactly one action (restart | status | logs) — no service name,
//   3. delegate to runDevGatewayCliAction, which gates on the dev context and
//      drives the safe, fixed-unit operation (the unit comes from the gateway
//      instance resolver, never from the caller).
//
// No code path here imports or reads stable config; that is the whole point.

import { getCommandPath, hasFlag } from "../cli/argv.js";
import {
  DevGatewayCommandError,
  runDevGatewayCliAction,
  type DevGatewayCliDeps,
} from "../cli/program/register.dev-gateway.js";
import { DEV_GATEWAY_COMMAND_NAME } from "./dev-gateway-operation.js";

export { DEV_GATEWAY_COMMAND_NAME } from "./dev-gateway-operation.js";

export type DevGatewayCliDispatchDeps = {
  /** Runs the gated, fixed-unit dev-gateway action (defaults to the real one). */
  run: (
    action: string,
    options: { json?: boolean },
    deps?: Partial<DevGatewayCliDeps>,
  ) => Promise<unknown>;
  /** Deps forwarded to the action runner (dev-context gate + safe operation). */
  cliDeps: Partial<DevGatewayCliDeps>;
  /** Clean, app-authored error sink (never raw systemd/bus stderr). */
  error: (message: string) => void;
  /** Non-zero exit for a refused/invalid invocation. */
  exit: (code: number) => void;
};

const defaultDispatchDeps: DevGatewayCliDispatchDeps = {
  run: runDevGatewayCliAction,
  cliDeps: {},
  error: (message) => process.stderr.write(`${message}\n`),
  exit: (code) => process.exit(code),
};

/** True when argv targets the worker-invocable dev-gateway subcommand. */
export function isDevGatewayCliInvocation(argv: string[]): boolean {
  return getCommandPath(argv, 1)[0] === DEV_GATEWAY_COMMAND_NAME;
}

/**
 * The positional arguments of a dev-gateway invocation: the action and any
 * extra positionals (flags such as --json are excluded). `action` is "" when
 * none was supplied so the action allowlist rejects it cleanly.
 */
export function parseDevGatewayCliArgs(argv: string[]): { action: string; extra: string[] } {
  const positionals = argv.slice(2).filter((arg) => arg && arg !== "--" && !arg.startsWith("-"));
  // positionals[0] is the subcommand name itself.
  const [, action = "", ...extra] = positionals;
  return { action, extra };
}

/**
 * Config-free dispatch for `node smithersbot.mjs dev-gateway <action>`.
 *
 * Returns true when the invocation was a dev-gateway command (handled here),
 * false otherwise (so the caller can fall through to normal routing). A refused
 * or invalid invocation is reported with a clean, app-authored message and a
 * non-zero exit — never raw host/systemd stderr, and never by reading stable
 * config.
 */
export async function dispatchDevGatewayCli(
  argv: string[],
  deps: Partial<DevGatewayCliDispatchDeps> = {},
): Promise<boolean> {
  if (!isDevGatewayCliInvocation(argv)) return false;
  const d = { ...defaultDispatchDeps, ...deps };
  const { action, extra } = parseDevGatewayCliArgs(argv);
  const json = hasFlag(argv, "--json");

  // Exactly one positional (the action) is accepted. A second positional — e.g.
  // a smuggled service name in `dev-gateway restart smithersbot-gateway.service`
  // — is refused before any host work; the unit is never caller-supplied.
  if (extra.length > 0) {
    d.error(
      `Dev gateway control accepts a single action (restart | status | logs) and no service name; unexpected argument "${extra[0]}".`,
    );
    d.exit(1);
    return true;
  }

  try {
    await d.run(action, { json }, d.cliDeps);
  } catch (err) {
    if (err instanceof DevGatewayCommandError) {
      d.error(err.message);
      d.exit(1);
      return true;
    }
    throw err;
  }
  return true;
}
