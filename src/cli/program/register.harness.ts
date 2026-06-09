import type { Command } from "commander";
import { resolveGatewayInstanceIdentity } from "../../config/gateway-instance.js";
import type { MoltbotConfig } from "../../config/types.clawdbot.js";
import { callGateway } from "../../gateway/call.js";
import type { HarnessResult } from "../../gateway/server-methods/harness.js";
import { defaultRuntime } from "../../runtime.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { runCommandWithRuntime } from "../cli-utils.js";

type HarnessInstance = "stable" | "dev";

type HarnessCliOptions = {
  instance?: string;
  timeout?: string;
  json?: boolean;
};

type HarnessCliDeps = {
  callGateway: typeof callGateway;
  homedir?: () => string;
  log: (message: string) => void;
};

const defaultDeps: HarnessCliDeps = {
  callGateway,
  log: (message: string) => process.stdout.write(`${message}\n`),
};

const CALLBACK_ACTIONS = new Set([
  "approve_prompt",
  "more_details",
  "request_edit",
  "no_further_plan",
  "make_another_plan",
  "add_details",
  "resume",
]);

function requireInstance(value: string | undefined, homedir?: () => string): HarnessInstance {
  if (!value?.trim()) {
    throw new Error("Harness requires an explicit --instance stable|dev.");
  }
  const identity = resolveGatewayInstanceIdentity(value, homedir);
  return identity.name;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Commands that run real work synchronously on the gateway (planning, autocheck,
 * execution/resume) before responding. These legitimately take minutes, so the
 * harness must not abandon the RPC at the 10s default — doing so leaves the run
 * created on the gateway but returns no runId to the caller. An explicit
 * `--timeout` still overrides this.
 */
const SLOW_COMMAND_DEFAULT_TIMEOUT_MS = 600_000;
const SLOW_COMMANDS = new Set(["new_goal", "goal", "goal_resume", "goal_answer"]);

function defaultTimeoutForCommand(command: string | undefined): number {
  const normalized = (command ?? "").replace(/^\//, "");
  return SLOW_COMMANDS.has(normalized) ? SLOW_COMMAND_DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

function timeoutMs(value: string | undefined, command?: string): number {
  if (value === undefined) return defaultTimeoutForCommand(command);
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultTimeoutForCommand(command);
}

function textFrom(parts: readonly string[]): string {
  return parts.join(" ").trim();
}

function commandParams(commandInput: string, args: string[]): Record<string, string> {
  const command = commandInput.replace(/^\//, "");
  if (command === "new_goal" || command === "goal") {
    return { command, text: textFrom(args) };
  }
  if (command === "goal_status" || command === "goal_resume") {
    return { command, runId: args[0] ?? "" };
  }
  if (command === "goal_answer") {
    return { command, runId: args[0] ?? "", text: textFrom(args.slice(1)) };
  }
  if (command === "gateway_status" || command === "gateway_restart") {
    return { command };
  }
  return { command, args: textFrom(args) };
}

function ownershipLine(result: HarnessResult): string {
  const own = result.ownership;
  const parts = [
    `Ownership: ${own.instance}-owned`,
    `instance=${own.instance}`,
    `port=${own.port}`,
    `stateRoot=${own.stateRoot}`,
  ];
  if (own.runId) parts.push(`runId=${own.runId}`);
  if (own.runJsonPath) parts.push(`runJsonPath=${own.runJsonPath}`);
  return parts.join(" ");
}

function renderHarnessResult(result: HarnessResult): string {
  const messageLines = result.messages.map((message) => message.text).filter((text) => text.length);
  return [...messageLines, ownershipLine(result)].join("\n");
}

function minimalGatewayConfig(port: number): MoltbotConfig {
  return {
    gateway: {
      mode: "local",
      bind: "loopback",
      port,
    },
  };
}

async function callHarness(
  method: "harness.command" | "harness.callback" | "harness.reply" | "harness.gateway_restart",
  params: Record<string, unknown>,
  options: HarnessCliOptions,
  deps: HarnessCliDeps,
  slowCommand?: string,
): Promise<HarnessResult> {
  const instance = requireInstance(options.instance, deps.homedir);
  const identity = resolveGatewayInstanceIdentity(instance, deps.homedir);
  return await deps.callGateway<HarnessResult>({
    url: `ws://127.0.0.1:${identity.defaultPort}`,
    config: minimalGatewayConfig(identity.defaultPort),
    method,
    params,
    timeoutMs: timeoutMs(options.timeout, slowCommand),
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
    instanceId: `harness-${instance}`,
  });
}

async function emit(result: HarnessResult, options: HarnessCliOptions, deps: HarnessCliDeps) {
  deps.log(options.json ? JSON.stringify(result, null, 2) : renderHarnessResult(result));
}

export async function runHarnessCommandCli(
  command: string,
  args: string[],
  options: HarnessCliOptions,
  deps: Partial<HarnessCliDeps> = {},
): Promise<HarnessResult> {
  const d = { ...defaultDeps, ...deps };
  const params = commandParams(command, args);
  const method =
    params.command === "gateway_restart" ? "harness.gateway_restart" : "harness.command";
  const result = await callHarness(method, params, options, d, params.command);
  await emit(result, options, d);
  return result;
}

export async function runHarnessCallbackCli(
  action: string,
  runId: string,
  textParts: string[],
  options: HarnessCliOptions & { proposalId?: string },
  deps: Partial<HarnessCliDeps> = {},
): Promise<HarnessResult> {
  const d = { ...defaultDeps, ...deps };
  if (!CALLBACK_ACTIONS.has(action)) {
    throw new Error(`Unsupported harness callback "${action}".`);
  }
  const text = textFrom(textParts);
  const result = await callHarness(
    "harness.callback",
    {
      action,
      runId,
      ...(text ? { text } : {}),
      ...(options.proposalId ? { proposalId: options.proposalId } : {}),
    },
    options,
    d,
  );
  await emit(result, options, d);
  return result;
}

export async function runHarnessReplyCli(
  kind: string,
  runId: string,
  textParts: string[],
  options: HarnessCliOptions,
  deps: Partial<HarnessCliDeps> = {},
): Promise<HarnessResult> {
  const d = { ...defaultDeps, ...deps };
  const result = await callHarness(
    "harness.reply",
    {
      kind,
      runId,
      text: textFrom(textParts),
    },
    options,
    d,
  );
  await emit(result, options, d);
  return result;
}

function addHarnessOptions(command: Command): Command {
  return command
    .requiredOption("--instance <stable|dev>", "Target gateway instance: stable or dev")
    .option(
      "--timeout <ms>",
      "Gateway RPC timeout in ms (default: 10000; slow planning/resume commands default to 600000)",
    )
    .option("--json", "Output raw harness RPC result as JSON", false);
}

export function registerHarnessCommand(program: Command) {
  const harness = program
    .command("harness")
    .description("Trusted local RPC harness for Telegram-equivalent gateway flows");

  addHarnessOptions(
    harness
      .command("command <command> [args...]")
      .description("Invoke a supported slash-command equivalent on the selected gateway"),
  ).action(async (command: string, args: string[], opts: HarnessCliOptions) => {
    await runCommandWithRuntime(defaultRuntime, async () => {
      await runHarnessCommandCli(command, args, opts);
    });
  });

  addHarnessOptions(
    harness
      .command("callback <action> <runId> [text...]")
      .description("Invoke a supported callback equivalent on the selected gateway")
      .option("--proposal-id <id>", "Continuation proposal id/prefix for OODA callbacks"),
  ).action(
    async (
      action: string,
      runId: string,
      text: string[],
      opts: HarnessCliOptions & { proposalId?: string },
    ) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await runHarnessCallbackCli(action, runId, text, opts);
      });
    },
  );

  addHarnessOptions(
    harness
      .command("reply <kind> <runId> <text...>")
      .description("Send follow-up reply text for a pending harness action"),
  ).action(async (kind: string, runId: string, text: string[], opts: HarnessCliOptions) => {
    await runCommandWithRuntime(defaultRuntime, async () => {
      await runHarnessReplyCli(kind, runId, text, opts);
    });
  });
}
