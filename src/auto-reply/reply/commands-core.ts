import { logVerbose } from "../../globals.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { shouldHandleTextCommands } from "../commands-registry.js";
import { handleCompactCommand } from "./commands-compact.js";
import { handleConfigCommand, handleDebugCommand } from "./commands-config.js";
import {
  handleCommandsListCommand,
  handleContextCommand,
  handleHelpCommand,
  handleStatusCommand,
  handleWhoamiCommand,
} from "./commands-info.js";
import { handleAllowlistCommand } from "./commands-allowlist.js";
import { handleSubagentsCommand } from "./commands-subagents.js";
import { handleModelsCommand } from "./commands-models.js";
import { handleTtsCommands } from "./commands-tts.js";
import {
  handleAbortTrigger,
  handleActivationCommand,
  handleSendPolicyCommand,
  handleUsageCommand,
} from "./commands-session.js";
import { handlePluginCommand } from "./commands-plugin.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";

const HANDLERS: CommandHandler[] = [
  // Plugin commands are processed first, before built-in commands
  handlePluginCommand,
  handleActivationCommand,
  handleSendPolicyCommand,
  handleUsageCommand,
  handleTtsCommands,
  handleHelpCommand,
  handleCommandsListCommand,
  handleStatusCommand,
  handleAllowlistCommand,
  handleContextCommand,
  handleWhoamiCommand,
  handleSubagentsCommand,
  handleConfigCommand,
  handleDebugCommand,
  handleModelsCommand,
  handleCompactCommand,
  handleAbortTrigger,
];

export async function handleCommands(params: HandleCommandsParams): Promise<CommandHandlerResult> {
  const allowTextCommands = shouldHandleTextCommands({
    cfg: params.cfg,
    surface: params.command.surface,
    commandSource: params.ctx.CommandSource,
  });

  for (const handler of HANDLERS) {
    const result = await handler(params, allowTextCommands);
    if (result) return result;
  }

  const sendPolicy = resolveSendPolicy({
    cfg: params.cfg,
    entry: params.sessionEntry,
    sessionKey: params.sessionKey,
    channel: params.sessionEntry?.channel ?? params.command.channel,
    chatType: params.sessionEntry?.chatType,
  });
  if (sendPolicy === "deny") {
    logVerbose(`Send blocked by policy for session ${params.sessionKey ?? "unknown"}`);
    return { shouldContinue: false };
  }

  return { shouldContinue: true };
}
