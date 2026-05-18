import { resolveAgentIdFromSessionKey } from "../agent-scope.js";
import type { MoltbotConfig } from "../../config/config.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { resolveSandboxToolPolicyForAgent } from "./tool-policy.js";
import type { SandboxContext, SandboxToolPolicyResolved, SandboxWorkspaceInfo } from "./types.js";

export type SandboxRuntimeStatus = {
  mode: "off";
  sandboxed: false;
  sessionKey?: string;
  agentId: string;
  toolPolicy: SandboxToolPolicyResolved;
};

export function resolveSandboxRuntimeStatus(params: {
  cfg?: MoltbotConfig;
  sessionKey?: string;
}): SandboxRuntimeStatus {
  const sessionKey = params.sessionKey?.trim();
  const agentId = sessionKey ? resolveAgentIdFromSessionKey(sessionKey) : "main";
  return {
    mode: "off",
    sandboxed: false,
    sessionKey,
    agentId,
    toolPolicy: resolveSandboxToolPolicyForAgent(params.cfg, agentId),
  };
}

export function formatSandboxToolPolicyBlockedMessage(params: {
  cfg?: MoltbotConfig;
  sessionKey?: string;
  tool?: string;
  toolName?: string;
}): string | undefined {
  const runtime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  if (!runtime.sandboxed) return undefined;
  return [
    `Tool "${params.tool ?? params.toolName ?? "unknown"}" blocked by sandbox tool policy (mode=${runtime.mode}).`,
    `- See: ${formatCliCommand("moltbot security")}`,
  ].join("\n");
}

export async function resolveSandboxContext(_params: {
  config?: MoltbotConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<SandboxContext | null> {
  return null;
}

export async function ensureSandboxWorkspaceForSession(_params: {
  config?: MoltbotConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<SandboxWorkspaceInfo | null> {
  return null;
}
