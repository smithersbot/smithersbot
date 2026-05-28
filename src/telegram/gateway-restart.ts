import { randomBytes } from "node:crypto";
import * as childProcess from "node:child_process";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Bot, Context } from "grammy";

import type { ChannelGroupPolicy } from "../config/group-policy.js";
import type { MoltbotConfig } from "../config/config.js";
import type {
  TelegramAccountConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "../config/types.js";
import { resolveStateDir } from "../config/paths.js";
import {
  resolveGatewaySystemdRestartUnit,
  scheduleGatewaySigusr1Restart,
  triggerMoltbotRestart,
} from "../infra/restart.js";
import { writeRestartSentinel, type RestartSentinelPayload } from "../infra/restart-sentinel.js";
import { redactSecretValues } from "../security/secret-paths.js";
import { resolveTelegramCommandAuth } from "./telegram-auth.js";

const GATEWAY_RESTART_COMMAND = "gateway_restart";
const GATEWAY_RESTART_COOLDOWN_MS = 60_000;
const GATEWAY_RESTART_TRIGGER_DIR = "gateway-restart-triggers";
const GATEWAY_RESTART_AUDIT_LOG = "gateway-restart.log";
const LAST_RESTART_FILENAME = ".last-restart-ts";

export const GATEWAY_RESTART_COMMAND_SPEC = {
  command: GATEWAY_RESTART_COMMAND,
  description: "Restart the local dev gateway service",
} as const;

type TelegramGatewayRestartContext = Context & {
  update: { update_id: number };
  message?: {
    chat: { id: number; type: string };
    from?: { id?: number };
    message_thread_id?: number;
  };
};

type GatewayRestartReason = "accepted" | "non_private_chat" | "unauthorized" | "cooldown" | "error";

type GatewayRestartDecision = {
  accepted: boolean;
  reason: GatewayRestartReason;
  message: string;
  cooldownSecondsRemaining?: number;
  triggerFile?: string;
};

type GatewayRestartAuditEntry = {
  timestamp: string;
  userId: number | null;
  chatId: number;
  chatType: string;
  accepted: boolean;
  reason: GatewayRestartReason;
  cooldownSecondsRemaining?: number;
  triggerFile?: string;
};

type GatewayRestartRequestState = {
  version: 1;
  kind: "gateway_restart_request";
  accountId: string;
  chatId: number;
  updateId: number;
  sentinel: RestartSentinelPayload;
  timestamp: string;
};

type GatewayPortBinding = {
  port: number;
  pid: number;
};

type RegisterGatewayRestartCommandParams = {
  bot: Bot;
  cfg: MoltbotConfig;
  accountId: string;
  onUpdateProcessed?: (updateId: number) => void | Promise<void>;
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

function resolveGatewayRestartPaths(env: NodeJS.ProcessEnv = process.env) {
  const stateDir = resolveStateDir(env, os.homedir);
  const triggerDir = path.join(stateDir, GATEWAY_RESTART_TRIGGER_DIR);
  return {
    triggerDir,
    lastRestartPath: path.join(triggerDir, LAST_RESTART_FILENAME),
    auditLogPath: path.join(stateDir, GATEWAY_RESTART_AUDIT_LOG),
  };
}

function readLastRestartTs(lastRestartPath: string): number | null {
  try {
    const raw = fsSync.readFileSync(lastRestartPath, "utf8").trim();
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeRestartTrigger(triggerDir: string, nowMs: number, userId: number): string {
  // Write with exclusive create to keep trigger filenames unique under concurrent requests.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const nonce = randomBytes(5).toString("hex");
    const filename = `restart-${nowMs}-${nonce}.req`;
    const triggerPath = path.join(triggerDir, filename);
    try {
      const payload = {
        requestedAt: new Date(nowMs).toISOString(),
        userId,
      };
      fsSync.writeFileSync(triggerPath, `${JSON.stringify(payload)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      return triggerPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error("failed to create unique restart trigger file");
}

function safeStatePart(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 120) || "unknown";
}

function restartRequestStatePath(
  triggerDir: string,
  params: {
    accountId: string;
    chatId: number;
    updateId: number;
  },
): string {
  const account = safeStatePart(params.accountId);
  return path.join(triggerDir, `request-${account}-${params.chatId}-${params.updateId}.json`);
}

function writeRestartRequestState(
  triggerDir: string,
  state: GatewayRestartRequestState,
): {
  path: string;
  duplicate: boolean;
} {
  fsSync.mkdirSync(triggerDir, { recursive: true });
  const statePath = restartRequestStatePath(triggerDir, {
    accountId: state.accountId,
    chatId: state.chatId,
    updateId: state.updateId,
  });
  try {
    fsSync.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return { path: statePath, duplicate: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { path: statePath, duplicate: true };
    }
    throw err;
  }
}

function resolveGatewayRestartPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw =
    env.SMITHERSBOT_GATEWAY_PORT?.trim() ||
    env.MOLTBOT_GATEWAY_PORT?.trim() ||
    env.CLAWDBOT_GATEWAY_PORT?.trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed;
  }
  return 19001;
}

function parseFirstPid(raw: string | Buffer | null | undefined): number | null {
  const text = typeof raw === "string" ? raw : raw ? raw.toString() : "";
  const match = text.match(/\bpid=(\d+)\b/) ?? text.match(/\b(\d+)\b/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1] as string, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function inspectGatewayPortBinding(port = resolveGatewayRestartPort()): GatewayPortBinding | null {
  const lsof = childProcess.spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
    timeout: 1000,
  });
  if (!lsof.error && lsof.status === 0) {
    const pid = parseFirstPid(lsof.stdout);
    if (pid != null) return { port, pid };
  }

  const ss = childProcess.spawnSync("ss", ["-ltnp", `sport = :${port}`], {
    encoding: "utf8",
    timeout: 1000,
  });
  if (!ss.error && ss.status === 0) {
    const pid = parseFirstPid(ss.stdout);
    if (pid != null) return { port, pid };
  }

  return null;
}

function appendAuditLog(auditLogPath: string, entry: GatewayRestartAuditEntry): void {
  fsSync.mkdirSync(path.dirname(auditLogPath), { recursive: true });
  fsSync.appendFileSync(auditLogPath, `${JSON.stringify(entry)}\n`, "utf8");
}

async function sendGatewayRestartMessage(
  bot: Bot,
  chatId: number,
  message: string,
  messageThreadId?: number,
): Promise<void> {
  const options = messageThreadId != null ? { message_thread_id: messageThreadId } : undefined;
  const safeMessage = redactSecretValues(message);
  const sendPromise =
    options != null
      ? bot.api.sendMessage(chatId, safeMessage, options)
      : bot.api.sendMessage(chatId, safeMessage);
  await sendPromise.catch(() => undefined);
}

function decideGatewayRestart(params: {
  chatType: string;
  userId: number | null;
  commandAuthorized: boolean;
  nowMs: number;
  triggerDir: string;
  lastRestartPath: string;
}): GatewayRestartDecision {
  if (params.chatType !== "private") {
    return {
      accepted: false,
      reason: "non_private_chat",
      message: "gateway_restart rejected: private chat only.",
    };
  }

  if (!params.commandAuthorized || params.userId == null) {
    return {
      accepted: false,
      reason: "unauthorized",
      message: "gateway_restart rejected: unauthorized user.",
    };
  }

  fsSync.mkdirSync(params.triggerDir, { recursive: true });
  const lastRestartTs = readLastRestartTs(params.lastRestartPath);
  if (lastRestartTs != null) {
    const elapsedMs = params.nowMs - lastRestartTs;
    if (elapsedMs < GATEWAY_RESTART_COOLDOWN_MS) {
      const remainingMs = GATEWAY_RESTART_COOLDOWN_MS - elapsedMs;
      const remainingSeconds = Math.ceil(remainingMs / 1000);
      return {
        accepted: false,
        reason: "cooldown",
        cooldownSecondsRemaining: remainingSeconds,
        message: `gateway_restart rejected: cooldown active (${remainingSeconds}s remaining).`,
      };
    }
  }

  // Record accepted request timestamp for cooldown before we attempt the restart.
  fsSync.writeFileSync(params.lastRestartPath, `${params.nowMs}\n`, "utf8");

  return {
    accepted: true,
    reason: "accepted",
    message: "gateway_restart accepted: restart scheduled.",
  };
}

export function registerGatewayRestartCommand({
  bot,
  cfg,
  accountId,
  onUpdateProcessed,
  telegramCfg,
  allowFrom,
  groupAllowFrom,
  useAccessGroups,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
}: RegisterGatewayRestartCommandParams): void {
  bot.command(GATEWAY_RESTART_COMMAND, async (ctx: TelegramGatewayRestartContext) => {
    const msg = ctx.message;
    if (!msg) return;
    if (shouldSkipUpdate(ctx)) return;

    const nowMs = Date.now();
    const timestamp = new Date(nowMs).toISOString();
    const userId = msg.from?.id ?? null;
    const chatId = msg.chat.id;
    const chatType = msg.chat.type;
    const messageThreadId = msg.message_thread_id;
    const { triggerDir, lastRestartPath, auditLogPath } = resolveGatewayRestartPaths();
    if (
      fsSync.existsSync(
        restartRequestStatePath(triggerDir, {
          accountId,
          chatId,
          updateId: ctx.update.update_id,
        }),
      )
    ) {
      return;
    }

    let decision: GatewayRestartDecision;
    try {
      let commandAuthorized = false;
      if (chatType === "private") {
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
          requireAuth: false,
        });
        commandAuthorized = auth?.commandAuthorized === true;
      }
      decision = decideGatewayRestart({
        chatType,
        userId,
        commandAuthorized,
        nowMs,
        triggerDir,
        lastRestartPath,
      });
    } catch {
      decision = {
        accepted: false,
        reason: "error",
        message: "gateway_restart rejected: internal error.",
      };
    }

    const auditEntry: GatewayRestartAuditEntry = {
      timestamp,
      userId,
      chatId,
      chatType,
      accepted: decision.accepted,
      reason: decision.reason,
      ...(decision.cooldownSecondsRemaining != null
        ? { cooldownSecondsRemaining: decision.cooldownSecondsRemaining }
        : {}),
      ...(decision.triggerFile ? { triggerFile: decision.triggerFile } : {}),
    };

    try {
      appendAuditLog(auditLogPath, auditEntry);
    } catch {
      // Acknowledge command even if audit write fails.
    }

    if (!decision.accepted) {
      await sendGatewayRestartMessage(bot, chatId, decision.message, messageThreadId);
      return;
    }

    const sentinelPayload: RestartSentinelPayload = {
      kind: "restart",
      status: "ok",
      ts: Date.now(),
      sessionKey: `telegram:${chatId}`,
      deliveryContext: {
        channel: "telegram",
        to: String(chatId),
        accountId,
      },
      message: "Gateway restarted.",
    };
    try {
      const requestState = writeRestartRequestState(triggerDir, {
        version: 1,
        kind: "gateway_restart_request",
        accountId,
        chatId,
        updateId: ctx.update.update_id,
        sentinel: sentinelPayload,
        timestamp,
      });
      if (requestState.duplicate) return;
    } catch {
      await sendGatewayRestartMessage(
        bot,
        chatId,
        "gateway_restart rejected: failed to persist restart request state.",
        messageThreadId,
      );
      return;
    }

    await onUpdateProcessed?.(ctx.update.update_id);

    try {
      await writeRestartSentinel(sentinelPayload);
    } catch {
      // ignore: sentinel is best-effort
    }

    const preRestartBinding = inspectGatewayPortBinding();
    const restartAttempt = triggerMoltbotRestart();
    if (restartAttempt.ok) {
      const postRestartBinding = inspectGatewayPortBinding(preRestartBinding?.port);
      if (
        preRestartBinding != null &&
        postRestartBinding != null &&
        postRestartBinding.pid === preRestartBinding.pid
      ) {
        const unit = resolveGatewaySystemdRestartUnit();
        await sendGatewayRestartMessage(
          bot,
          chatId,
          `gateway_restart failed: ${unit} reported restart success, but port ${postRestartBinding.port} is still held by stale/orphaned process PID ${postRestartBinding.pid}.`,
          messageThreadId,
        );
      }
      return;
    }

    const scheduledRestart = scheduleGatewaySigusr1Restart({
      delayMs: 2000,
      reason: "telegram /gateway_restart",
    });
    if (scheduledRestart.ok) return;

    // Fallback path for environments where direct restart is unavailable:
    // keep compatibility with file-trigger restart workers if present.
    let fallbackTriggerFile: string | undefined;
    try {
      if (userId != null) {
        fsSync.mkdirSync(triggerDir, { recursive: true });
        const triggerPath = writeRestartTrigger(triggerDir, Date.now(), userId);
        fallbackTriggerFile = path.basename(triggerPath);
      }
    } catch {
      fallbackTriggerFile = undefined;
    }

    const details = restartAttempt.detail ? ` (${restartAttempt.detail})` : "";
    const fallback = fallbackTriggerFile
      ? ` Fallback queued: ${fallbackTriggerFile}.`
      : " No fallback trigger could be queued.";
    await sendGatewayRestartMessage(
      bot,
      chatId,
      `gateway_restart warning: direct restart failed via ${restartAttempt.method}${details}.${fallback}`,
      messageThreadId,
    );
  });
}
