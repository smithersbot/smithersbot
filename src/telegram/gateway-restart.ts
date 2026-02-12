import { randomBytes } from "node:crypto";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Bot, Context } from "grammy";

import { resolveStateDir } from "../config/paths.js";

const GATEWAY_RESTART_COMMAND = "gateway_restart";
const GATEWAY_RESTART_COOLDOWN_MS = 60_000;
const GATEWAY_RESTART_TRIGGER_DIR = "gateway-restart-triggers";
const GATEWAY_RESTART_AUDIT_LOG = "gateway-restart.log";
const LAST_RESTART_FILENAME = ".last-restart-ts";

// Replace with your own Telegram user id if this ever changes.
export const ADMIN_USER_IDS = [5232990709];

export const GATEWAY_RESTART_COMMAND_SPEC = {
  command: GATEWAY_RESTART_COMMAND,
  description: "Restart the local dev gateway service",
} as const;

type TelegramGatewayRestartContext = Context & {
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
  shouldSkipUpdate: (ctx: unknown) => boolean;
};

function isAdminUser(userId: number | null): boolean {
  if (userId == null) return false;
  return ADMIN_USER_IDS.includes(userId);
}

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

  if (!isAdminUser(params.userId)) {
    return {
      accepted: false,
      reason: "unauthorized",
      message: "gateway_restart rejected: unauthorized user.",
    };
  }
  const authorizedUserId = params.userId;
  if (authorizedUserId == null) {
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

  const triggerPath = writeRestartTrigger(params.triggerDir, params.nowMs, authorizedUserId);
  fsSync.writeFileSync(params.lastRestartPath, `${params.nowMs}\n`, "utf8");

  return {
    accepted: true,
    reason: "accepted",
    triggerFile: path.basename(triggerPath),
    message: "gateway_restart accepted: restart requested.",
  };
}

export function registerGatewayRestartCommand({
  bot,
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
      decision = decideGatewayRestart({
        chatType,
        userId,
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

    await bot.api.sendMessage(chatId, decision.message);
  });
}
