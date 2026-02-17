import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { MoltbotConfig } from "../../config/config.js";
import { resolveGatewayPort, writeConfigFile } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import { enablePluginInConfig } from "../../plugins/enable.js";
import type { RuntimeEnv } from "../../runtime.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { DEFAULT_GATEWAY_DAEMON_RUNTIME } from "../daemon-runtime.js";
import { applyChannelAccountConfig } from "../channels/add-mutators.js";
import { healthCommand } from "../health.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  ensureWorkspaceAndSessions,
  resolveControlUiLinks,
  waitForGatewayReachable,
} from "../onboard-helpers.js";
import type { OnboardOptions } from "../onboard-types.js";
import { getChannelOnboardingAdapter } from "../onboarding/registry.js";
import { reloadOnboardingPluginRegistry } from "../onboarding/plugin-install.js";

import { applyNonInteractiveAuthChoice } from "./local/auth-choice.js";
import { installGatewayDaemonNonInteractive } from "./local/daemon-install.js";
import { applyNonInteractiveGatewayConfig } from "./local/gateway-config.js";
import { logNonInteractiveOnboardingJson } from "./local/output.js";
import { applyNonInteractiveSkillsConfig } from "./local/skills-config.js";
import { resolveNonInteractiveWorkspaceDir } from "./local/workspace.js";

export async function runNonInteractiveOnboardingLocal(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: MoltbotConfig;
}) {
  const { opts, runtime, baseConfig } = params;
  const mode = "local" as const;

  const workspaceDir = resolveNonInteractiveWorkspaceDir({
    opts,
    baseConfig,
    defaultWorkspaceDir: DEFAULT_WORKSPACE,
  });

  let nextConfig: MoltbotConfig = {
    ...baseConfig,
    agents: {
      ...baseConfig.agents,
      defaults: {
        ...baseConfig.agents?.defaults,
        workspace: workspaceDir,
      },
    },
    gateway: {
      ...baseConfig.gateway,
      mode: "local",
    },
  };

  const authChoice = opts.authChoice ?? "skip";
  const nextConfigAfterAuth = await applyNonInteractiveAuthChoice({
    nextConfig,
    authChoice,
    opts,
    runtime,
    baseConfig,
  });
  if (!nextConfigAfterAuth) return;
  nextConfig = nextConfigAfterAuth;

  const gatewayBasePort = resolveGatewayPort(baseConfig);
  const gatewayResult = applyNonInteractiveGatewayConfig({
    nextConfig,
    opts,
    runtime,
    defaultPort: gatewayBasePort,
  });
  if (!gatewayResult) return;
  nextConfig = gatewayResult.nextConfig;

  nextConfig = applyNonInteractiveSkillsConfig({ nextConfig, opts, runtime });

  nextConfig = applyWizardMetadata(nextConfig, { command: "onboard", mode });
  if (opts.telegramToken) {
    const enableResult = enablePluginInConfig(nextConfig, "telegram");
    nextConfig = enableResult.config;
    if (!enableResult.enabled) {
      runtime.error(`Failed to enable Telegram plugin: ${enableResult.reason ?? "unknown error"}.`);
      runtime.exit(1);
      return;
    }

    reloadOnboardingPluginRegistry({
      cfg: nextConfig,
      runtime,
      workspaceDir,
    });
    if (!getChannelPlugin("telegram")) {
      runtime.error("Failed to load Telegram plugin. Ensure the telegram extension is installed.");
      runtime.exit(1);
      return;
    }

    nextConfig = applyChannelAccountConfig({
      cfg: nextConfig,
      channel: "telegram",
      accountId: "default",
      token: opts.telegramToken,
    });

    const telegramOnboardingAdapter = getChannelOnboardingAdapter("telegram");
    if (telegramOnboardingAdapter?.dmPolicy?.setPolicy) {
      nextConfig = telegramOnboardingAdapter.dmPolicy.setPolicy(nextConfig, "pairing");
    } else {
      nextConfig = {
        ...nextConfig,
        channels: {
          ...nextConfig.channels,
          telegram: {
            ...nextConfig.channels?.telegram,
            dmPolicy: "pairing",
          },
        },
      };
    }
  }
  await writeConfigFile(nextConfig);
  logConfigUpdated(runtime);

  await ensureWorkspaceAndSessions(workspaceDir, runtime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
  });

  await installGatewayDaemonNonInteractive({
    nextConfig,
    opts,
    runtime,
    port: gatewayResult.port,
    gatewayToken: gatewayResult.gatewayToken,
  });

  const daemonRuntimeRaw = opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME;
  if (!opts.skipHealth) {
    const links = resolveControlUiLinks({
      bind: gatewayResult.bind as "auto" | "lan" | "loopback" | "custom" | "tailnet",
      port: gatewayResult.port,
      customBindHost: nextConfig.gateway?.customBindHost,
      basePath: undefined,
    });
    await waitForGatewayReachable({
      url: links.wsUrl,
      token: gatewayResult.gatewayToken,
      deadlineMs: 15_000,
    });
    await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
  }

  logNonInteractiveOnboardingJson({
    opts,
    runtime,
    mode,
    workspaceDir,
    authChoice,
    gateway: {
      port: gatewayResult.port,
      bind: gatewayResult.bind,
      authMode: gatewayResult.authMode,
      tailscaleMode: gatewayResult.tailscaleMode,
    },
    installDaemon: Boolean(opts.installDaemon),
    daemonRuntime: opts.installDaemon ? daemonRuntimeRaw : undefined,
    skipSkills: Boolean(opts.skipSkills),
    skipHealth: Boolean(opts.skipHealth),
  });

  if (!opts.json) {
    runtime.log(
      `Tip: run \`${formatCliCommand("moltbot configure --section web")}\` to store your Brave API key for web_search. Docs: https://docs.molt.bot/tools/web`,
    );
  }
}
