import { randomBytes } from "node:crypto";
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
import { scheduleGatewaySigusr1Restart, triggerMoltbotRestart } from "../infra/restart.js";
import { writeRestartSentinel, type RestartSentinelPayload } from "../infra/restart-sentinel.js";
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

function appendAuditLog(auditLogPath: string, entry: GatewayRestartAuditEntry): void {
  fsSync.mkdirSync(path.dirname(auditLogPath), { recursive: true });
  fsSync.appendFileSync(auditLogPath, `${JSON.stringify(entry)}\n`, "utf8");
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
    const { triggerDir, lastRestartPath, auditLogPath } = resolveGatewayRestartPaths();

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
      await bot.api.sendMessage(chatId, decision.message);
      return;
    }

    await onUpdateProcessed?.(ctx.update.update_id);

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
      await writeRestartSentinel(sentinelPayload);
    } catch {
      // ignore: sentinel is best-effort
    }

    const restartAttempt = triggerMoltbotRestart();
    if (restartAttempt.ok) return;

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
    await bot.api
      .sendMessage(
        chatId,
        `gateway_restart warning: direct restart failed via ${restartAttempt.method}${details}.${fallback}`,
      )
      .catch(() => undefined);
  });
}
