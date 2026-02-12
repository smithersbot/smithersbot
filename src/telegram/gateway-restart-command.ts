import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveStateDir } from "../config/paths.js";

export const TELEGRAM_GATEWAY_RESTART_COMMAND_SPEC = {
  command: "gateway_restart",
  description: "Request restart of gateway dev service",
} as const;

export const TELEGRAM_GATEWAY_RESTART_COOLDOWN_MS = 60_000;

export type TelegramGatewayRestartReason =
  | "accepted"
  | "unauthorized"
  | "non_private_chat"
  | "cooldown"
  | "io_error";

export type TelegramGatewayRestartResult = {
  accepted: boolean;
  reason: TelegramGatewayRestartReason;
  ackText: string;
  requestFilePath?: string;
  cooldownRemainingSeconds?: number;
};

type TelegramGatewayRestartLogEntry = {
  timestamp: string;
  requestingUserId: string | null;
  result: "accepted" | "rejected";
  reason: TelegramGatewayRestartReason;
  requestFile?: string;
  cooldownRemainingSeconds?: number;
  error?: string;
};

export type TelegramGatewayRestartPaths = {
  baseDir: string;
  requestsDir: string;
  cooldownPath: string;
  logPath: string;
};

export function resolveTelegramGatewayRestartPaths(params?: {
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): TelegramGatewayRestartPaths {
  const stateDir =
    params?.stateDir ?? resolveStateDir(params?.env ?? process.env, params?.homedir ?? os.homedir);
  const baseDir = path.join(stateDir, "telegram", "gateway-restart");
  return {
    baseDir,
    requestsDir: path.join(baseDir, "requests"),
    cooldownPath: path.join(baseDir, "last-accepted-ms"),
    logPath: path.join(baseDir, "requests.log"),
  };
}

function normalizeTelegramUserId(input: string | number | undefined): string | null {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    return String(Math.trunc(input));
  }
  if (typeof input !== "string") return null;
  let normalized = input.trim();
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  if (lower.startsWith("telegram:")) {
    normalized = normalized.slice("telegram:".length).trim();
  } else if (lower.startsWith("tg:")) {
    normalized = normalized.slice("tg:".length).trim();
  }
  if (!/^-?\d+$/.test(normalized)) return null;
  return normalized;
}

export function isTelegramGatewayRestartAdmin(params: {
  senderId: string | number | undefined;
  allowFrom?: Array<string | number>;
}): boolean {
  const senderId = normalizeTelegramUserId(params.senderId);
  if (!senderId) return false;
  const allowFrom = params.allowFrom ?? [];
  for (const entry of allowFrom) {
    if (normalizeTelegramUserId(entry) === senderId) return true;
  }
  return false;
}

async function readLastAcceptedMs(cooldownPath: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(cooldownPath, "utf8");
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function appendLogEntry(
  paths: TelegramGatewayRestartPaths,
  entry: TelegramGatewayRestartLogEntry,
): Promise<void> {
  await fs.mkdir(paths.baseDir, { recursive: true });
  await fs.appendFile(paths.logPath, `${JSON.stringify(entry)}\n`, "utf8");
}

function formatCooldownAck(remainingSeconds: number): string {
  return `Rejected: cooldown active (${remainingSeconds}s remaining).`;
}

export async function requestTelegramGatewayRestart(params: {
  chatType: string;
  senderId: string | number | undefined;
  allowFrom?: Array<string | number>;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  nowMs?: number;
  cooldownMs?: number;
  nonce?: () => string;
}): Promise<TelegramGatewayRestartResult> {
  const nowMs = params.nowMs ?? Date.now();
  const cooldownMs = params.cooldownMs ?? TELEGRAM_GATEWAY_RESTART_COOLDOWN_MS;
  const requestingUserId = normalizeTelegramUserId(params.senderId);
  const paths = resolveTelegramGatewayRestartPaths({
    stateDir: params.stateDir,
    env: params.env,
    homedir: params.homedir,
  });
  const timestamp = new Date(nowMs).toISOString();

  const log = async (
    entry: Omit<TelegramGatewayRestartLogEntry, "timestamp" | "requestingUserId">,
  ) => {
    await appendLogEntry(paths, {
      timestamp,
      requestingUserId,
      ...entry,
    }).catch(() => {});
  };

  if (params.chatType !== "private") {
    await log({ result: "rejected", reason: "non_private_chat" });
    return {
      accepted: false,
      reason: "non_private_chat",
      ackText: "Rejected: /gateway_restart only works in private chats.",
    };
  }

  if (
    !isTelegramGatewayRestartAdmin({
      senderId: params.senderId,
      allowFrom: params.allowFrom,
    })
  ) {
    await log({ result: "rejected", reason: "unauthorized" });
    return {
      accepted: false,
      reason: "unauthorized",
      ackText: "Rejected: unauthorized user.",
    };
  }

  try {
    await fs.mkdir(paths.requestsDir, { recursive: true });
    const lastAcceptedMs = await readLastAcceptedMs(paths.cooldownPath);
    if (lastAcceptedMs != null) {
      const elapsedMs = nowMs - lastAcceptedMs;
      if (elapsedMs >= 0 && elapsedMs < cooldownMs) {
        const remainingSeconds = Math.ceil((cooldownMs - elapsedMs) / 1000);
        await log({
          result: "rejected",
          reason: "cooldown",
          cooldownRemainingSeconds: remainingSeconds,
        });
        return {
          accepted: false,
          reason: "cooldown",
          cooldownRemainingSeconds: remainingSeconds,
          ackText: formatCooldownAck(remainingSeconds),
        };
      }
    }

    const nonce = params.nonce?.() ?? crypto.randomBytes(4).toString("hex");
    const requestFileName = `restart-${nowMs}-${nonce}.req`;
    const requestFilePath = path.join(paths.requestsDir, requestFileName);
    const requestBody = {
      requestedAt: timestamp,
      requestingUserId,
    };
    await fs.writeFile(requestFilePath, `${JSON.stringify(requestBody)}\n`, "utf8");
    await fs.writeFile(paths.cooldownPath, `${nowMs}\n`, "utf8");
    await log({
      result: "accepted",
      reason: "accepted",
      requestFile: requestFileName,
    });
    return {
      accepted: true,
      reason: "accepted",
      ackText: "Accepted: restart request queued.",
      requestFilePath,
    };
  } catch (error) {
    await log({
      result: "rejected",
      reason: "io_error",
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      accepted: false,
      reason: "io_error",
      ackText: "Rejected: failed to queue restart request.",
    };
  }
}
