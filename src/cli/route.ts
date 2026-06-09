import { defaultRuntime } from "../runtime.js";
import { ensurePluginRegistryLoaded } from "./plugin-registry.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { emitCliBanner } from "./banner.js";
import { VERSION } from "../version.js";
import { getCommandPath, hasHelpOrVersion } from "./argv.js";
import { ensureConfigReady } from "./program/config-guard.js";
import { DEV_GATEWAY_COMMAND_NAME, dispatchDevGatewayCli } from "../goal/dev-gateway-cli.js";

async function prepareRoutedCommand(params: {
  argv: string[];
  commandPath: string[];
  loadPlugins?: boolean;
  skipConfig?: boolean;
}) {
  emitCliBanner(VERSION, { argv: params.argv });
  // Some routes (the host-mediated dev-gateway path) must never read the stable
  // config file before dispatching; they run their own minimal preflight.
  if (!params.skipConfig) {
    await ensureConfigReady({ runtime: defaultRuntime, commandPath: params.commandPath });
  }
  if (params.loadPlugins) {
    ensurePluginRegistryLoaded();
  }
}

export async function tryRouteCli(argv: string[]): Promise<boolean> {
  if (isTruthyEnvValue(process.env.CLAWDBOT_DISABLE_ROUTE_FIRST)) return false;
  if (hasHelpOrVersion(argv)) return false;

  const path = getCommandPath(argv, 2);
  if (!path[0]) return false;

  // The host-mediated dev-gateway route must stay config-free. Loading the full
  // command registry pulls in normal command modules with logging side effects,
  // which can touch the hard-denied stable config before skipConfig is honored.
  if (path[0] === DEV_GATEWAY_COMMAND_NAME) {
    emitCliBanner(VERSION, { argv });
    return dispatchDevGatewayCli(argv);
  }

  const { findRoutedCommand } = await import("./program/command-registry.js");
  const route = findRoutedCommand(path);
  if (!route) return false;
  await prepareRoutedCommand({
    argv,
    commandPath: path,
    loadPlugins: route.loadPlugins,
    skipConfig: route.skipConfig,
  });
  return route.run(argv);
}
