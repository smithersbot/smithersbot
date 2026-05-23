import * as childProcess from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { Bot, Context } from "grammy";

import { resolveGatewaySystemdRestartUnit } from "../infra/restart.js";
import { resolveGatewayPort } from "../config/paths.js";
import type { MoltbotConfig } from "../config/config.js";
import type {
  TelegramAccountConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "../config/types.js";
import type { ChannelGroupPolicy } from "../config/group-policy.js";
import { resolveCommitHash } from "../infra/git-commit.js";
import { redactSecretValues } from "../security/secret-paths.js";
import { VERSION } from "../version.js";
import { renderTelegramHtmlText } from "./format.js";
import { boldLabel, formatStatusMessage } from "./status-format.js";
import { resolveTelegramCommandAuth } from "./telegram-auth.js";

const GATEWAY_STATUS_COMMAND = "gateway_status";
const SYSTEMD_TIMEOUT_MS = 1000;

export const GATEWAY_STATUS_COMMAND_SPEC = {
  command: GATEWAY_STATUS_COMMAND,
  description: "Show gateway process and service status",
} as const;

type TelegramGatewayStatusContext = Context & {
  message?: {
    chat: { id: number; type: string };
    from?: { id?: number };
    message_thread_id?: number;
  };
};

type RegisterGatewayStatusCommandParams = {
  bot: Bot;
  cfg: MoltbotConfig;
  telegramCfg: TelegramAccountConfig;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  useAccessGroups: boolean;
  resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId?: number,
  ) => { groupConfig?: TelegramGroupConfig; topicConfig?: TelegramTopicConfig };
  shouldSkipUpdate: (ctx: unknown) => boolean;
};

type SpawnSyncLike = typeof childProcess.spawnSync;

export type GatewayStatusSnapshot = {
  unit: string;
  pid: number;
  hostname: string;
  startTime: string;
  uptime: string;
  cwd: string;
  port: number;
  profile?: string;
  serviceMarker?: string;
  serviceKind?: string;
  version: string;
  commit?: string;
  managedWorkspace: boolean;
  systemd: {
    available: boolean;
    activeState?: string;
    subState?: string;
    mainPid?: number;
  };
};

export type BuildGatewayStatusOptions = {
  cfg?: MoltbotConfig;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  nowMs?: number;
  uptimeSeconds?: number;
  pid?: number;
  hostname?: string;
  spawnSync?: SpawnSyncLike;
};

function normalizeOptional(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours || parts.length) parts.push(`${hours}h`);
  if (minutes || parts.length) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}

function parseSystemdShow(raw: string): GatewayStatusSnapshot["systemd"] {
  const fields = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    fields.set(line.slice(0, index), line.slice(index + 1));
  }
  const mainPidRaw = fields.get("MainPID");
  const mainPid =
    mainPidRaw && /^\d+$/.test(mainPidRaw) ? Number.parseInt(mainPidRaw, 10) : undefined;
  return {
    available: true,
    activeState: normalizeOptional(fields.get("ActiveState")),
    subState: normalizeOptional(fields.get("SubState")),
    ...(mainPid && mainPid > 0 ? { mainPid } : {}),
  };
}

function inspectSystemdUnit(
  unit: string,
  spawnSyncImpl: SpawnSyncLike = childProcess.spawnSync,
): GatewayStatusSnapshot["systemd"] {
  const baseArgs = [
    "show",
    unit,
    "--property=ActiveState",
    "--property=SubState",
    "--property=MainPID",
  ];
  for (const args of [["--user", ...baseArgs], baseArgs]) {
    const result = spawnSyncImpl("systemctl", args, {
      encoding: "utf8",
      timeout: SYSTEMD_TIMEOUT_MS,
    });
    if (!result.error && result.status === 0) {
      return parseSystemdShow(typeof result.stdout === "string" ? result.stdout : "");
    }
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { available: false };
    }
  }
  return { available: false };
}

function isInsideDirectory(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isManagedWorkspaceCwd(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const goalsRoot =
    env.SMITHERSBOT_GOALS_ROOT?.trim() || path.join(os.homedir(), "smithersbot-goals");
  const workspacesRoot = path.resolve(goalsRoot, "agent", "workspaces");
  const resolvedCwd = path.resolve(cwd);
  if (!isInsideDirectory(resolvedCwd, workspacesRoot)) return false;
  const relativeParts = path.relative(workspacesRoot, resolvedCwd).split(path.sep).filter(Boolean);
  return relativeParts.length >= 2 && relativeParts[1] === "repo";
}

function collectTokenLikeEnvValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([key, value]) => /TOKEN/i.test(key) && typeof value === "string")
    .map(([, value]) => value)
    .filter((value): value is string => Boolean(value && value.trim().length >= 8));
}

export function buildGatewayStatusSnapshot(
  options: BuildGatewayStatusOptions = {},
): GatewayStatusSnapshot {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const uptimeSeconds = options.uptimeSeconds ?? process.uptime();
  const nowMs = options.nowMs ?? Date.now();
  const startTime = new Date(nowMs - Math.max(0, uptimeSeconds) * 1000).toISOString();
  const unit = resolveGatewaySystemdRestartUnit(env);
  const profile = normalizeOptional(
    env.SMITHERSBOT_PROFILE ?? env.MOLTBOT_PROFILE ?? env.CLAWDBOT_PROFILE,
  );
  const commit = resolveCommitHash({ cwd, env });

  return {
    unit,
    pid: options.pid ?? process.pid,
    hostname: options.hostname ?? os.hostname(),
    startTime,
    uptime: formatDuration(uptimeSeconds),
    cwd,
    port: resolveGatewayPort(options.cfg, env),
    ...(profile ? { profile } : {}),
    ...(normalizeOptional(env.CLAWDBOT_SERVICE_MARKER)
      ? { serviceMarker: normalizeOptional(env.CLAWDBOT_SERVICE_MARKER) }
      : {}),
    ...(normalizeOptional(env.CLAWDBOT_SERVICE_KIND)
      ? { serviceKind: normalizeOptional(env.CLAWDBOT_SERVICE_KIND) }
      : {}),
    version: VERSION,
    ...(commit ? { commit } : {}),
    managedWorkspace: isManagedWorkspaceCwd(cwd, env),
    systemd: inspectSystemdUnit(unit, options.spawnSync),
  };
}

export function formatGatewayStatus(snapshot: GatewayStatusSnapshot): string {
  const systemdLine = snapshot.systemd.available
    ? [snapshot.systemd.activeState, snapshot.systemd.subState].filter(Boolean).join("/") ||
      "available"
    : "unavailable; using process fallback";
  const version = snapshot.commit ? `${snapshot.version} (${snapshot.commit})` : snapshot.version;
  const cwdSummary = snapshot.managedWorkspace ? "managed workspace repo" : snapshot.cwd;

  return formatStatusMessage({
    title: "Gateway status",
    lines: [
      boldLabel("Unit", snapshot.unit),
      boldLabel("PID", String(snapshot.pid)),
      boldLabel("Started", snapshot.startTime),
      boldLabel("Uptime", snapshot.uptime),
      boldLabel("CWD", cwdSummary),
      boldLabel("Port", String(snapshot.port)),
      snapshot.profile ? boldLabel("Profile", snapshot.profile) : "",
      boldLabel("Version", version),
      boldLabel("Systemd", systemdLine),
    ].filter(Boolean),
  });
}

export function buildGatewayStatusMessage(options: BuildGatewayStatusOptions = {}): string {
  const env = options.env ?? process.env;
  const text = formatGatewayStatus(buildGatewayStatusSnapshot(options));
  return redactSecretValues(text, {
    includeConfigSecrets: false,
    secretValues: collectTokenLikeEnvValues(env),
  });
}

async function sendGatewayStatusMessage(
  bot: Bot,
  chatId: number,
  message: string,
  messageThreadId?: number,
): Promise<void> {
  const htmlMessage = renderTelegramHtmlText(message);
  const options =
    messageThreadId != null
      ? ({ message_thread_id: messageThreadId, parse_mode: "HTML" } as const)
      : ({ parse_mode: "HTML" } as const);
  await bot.api.sendMessage(chatId, htmlMessage, options);
}

export function registerGatewayStatusCommand({
  bot,
  cfg,
  telegramCfg,
  allowFrom,
  groupAllowFrom,
  useAccessGroups,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
}: RegisterGatewayStatusCommandParams): void {
  bot.command(GATEWAY_STATUS_COMMAND, async (ctx: TelegramGatewayStatusContext) => {
    const msg = ctx.message;
    if (!msg) return;
    if (shouldSkipUpdate(ctx)) return;

    const auth = await resolveTelegramCommandAuth({
      msg,
      bot,
      cfg,
      telegramCfg,
      allowFrom,
      groupAllowFrom,
      useAccessGroups,
      resolveGroupPolicy,
      resolveTelegramGroupConfig,
      requireAuth: true,
    });
    if (!auth) return;

    await sendGatewayStatusMessage(
      bot,
      msg.chat.id,
      buildGatewayStatusMessage({ cfg }),
      auth.isGroup ? auth.resolvedThreadId : msg.message_thread_id,
    );
  });
}
