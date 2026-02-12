import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelGroupPolicy } from "../config/group-policy.js";
import type { MoltbotConfig } from "../config/config.js";
import type { TelegramAccountConfig } from "../config/types.js";
import { registerGatewayRestartCommand } from "./gateway-restart.js";

const TRIGGER_DIRNAME = "gateway-restart-triggers";
const AUDIT_LOG_FILENAME = "gateway-restart.log";
const AUTHORIZED_USER_ID = 5232990709;

type AuditEntry = {
  timestamp: string;
  userId: number | null;
  accepted: boolean;
  reason: string;
  cooldownSecondsRemaining?: number;
  triggerFile?: string;
};

let testStateDir = "";
let previousStateDir: string | undefined;

function createHarness(params?: { allowFrom?: Array<string | number> }) {
  const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const bot = {
    api: { sendMessage },
    command: (name: string, handler: (ctx: unknown) => Promise<void>) => {
      handlers[name] = handler;
    },
  } as unknown as Parameters<typeof registerGatewayRestartCommand>[0]["bot"];

  registerGatewayRestartCommand({
    bot,
    cfg: {} as MoltbotConfig,
    telegramCfg: {} as TelegramAccountConfig,
    allowFrom: params?.allowFrom ?? [AUTHORIZED_USER_ID],
    groupAllowFrom: [],
    useAccessGroups: true,
    resolveGroupPolicy: () =>
      ({
        allowlistEnabled: false,
        allowed: true,
      }) as ChannelGroupPolicy,
    resolveTelegramGroupConfig: () => ({
      groupConfig: undefined,
      topicConfig: undefined,
    }),
    shouldSkipUpdate: () => false,
  });

  const handler = handlers.gateway_restart;
  if (!handler) {
    throw new Error("gateway_restart handler was not registered");
  }

  return { handler, sendMessage };
}

function createCtx(params?: { chatId?: number; chatType?: string; userId?: number }) {
  const userId = params?.userId;
  return {
    message: {
      chat: {
        id: params?.chatId ?? 123,
        type: params?.chatType ?? "private",
      },
      ...(userId != null ? { from: { id: userId } } : {}),
    },
  };
}

function listTriggerRequests(): string[] {
  const triggerDir = path.join(testStateDir, TRIGGER_DIRNAME);
  if (!fs.existsSync(triggerDir)) return [];
  return fs.readdirSync(triggerDir).filter((entry) => entry.endsWith(".req"));
}

function readAuditEntries(): AuditEntry[] {
  const auditPath = path.join(testStateDir, AUDIT_LOG_FILENAME);
  if (!fs.existsSync(auditPath)) return [];
  const raw = fs.readFileSync(auditPath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AuditEntry);
}

describe("gateway_restart telegram command", () => {
  beforeEach(() => {
    previousStateDir = process.env.CLAWDBOT_STATE_DIR;
    testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-restart-test-"));
    process.env.CLAWDBOT_STATE_DIR = testStateDir;
  });

  afterEach(() => {
    if (previousStateDir === undefined) delete process.env.CLAWDBOT_STATE_DIR;
    else process.env.CLAWDBOT_STATE_DIR = previousStateDir;
    fs.rmSync(testStateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("rejects unauthorized users", async () => {
    const { handler, sendMessage } = createHarness();
    const unauthorizedUserId = AUTHORIZED_USER_ID + 1;

    await handler(createCtx({ userId: unauthorizedUserId }));

    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining("rejected"));
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining("unauthorized"));
    expect(listTriggerRequests()).toHaveLength(0);

    const entries = readAuditEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      userId: unauthorizedUserId,
      accepted: false,
      reason: "unauthorized",
    });
  });

  it("rejects non-private chats", async () => {
    const { handler, sendMessage } = createHarness();
    const authorizedUserId = AUTHORIZED_USER_ID;

    await handler(createCtx({ chatId: -99, chatType: "group", userId: authorizedUserId }));

    expect(sendMessage).toHaveBeenCalledWith(-99, expect.stringContaining("private chat only"));
    expect(listTriggerRequests()).toHaveLength(0);

    const entries = readAuditEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      userId: authorizedUserId,
      accepted: false,
      reason: "non_private_chat",
    });
  });

  it("enforces cooldown for repeated accepted requests", async () => {
    const { handler, sendMessage } = createHarness();
    const authorizedUserId = AUTHORIZED_USER_ID;

    await handler(createCtx({ chatId: 7, userId: authorizedUserId }));
    await handler(createCtx({ chatId: 7, userId: authorizedUserId }));

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]?.[1]).toContain("accepted");
    expect(sendMessage.mock.calls[1]?.[1]).toContain("cooldown");
    expect(listTriggerRequests()).toHaveLength(1);

    const entries = readAuditEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ accepted: true, reason: "accepted" });
    expect(entries[1]).toMatchObject({ accepted: false, reason: "cooldown" });
    expect((entries[1]?.cooldownSecondsRemaining ?? 0) > 0).toBe(true);
  });

  it("writes a trigger file when accepted", async () => {
    const { handler, sendMessage } = createHarness();
    const authorizedUserId = AUTHORIZED_USER_ID;

    await handler(createCtx({ chatId: 88, userId: authorizedUserId }));

    expect(sendMessage).toHaveBeenCalledWith(88, expect.stringContaining("accepted"));

    const triggerFiles = listTriggerRequests();
    expect(triggerFiles).toHaveLength(1);
    expect(triggerFiles[0]).toMatch(/^restart-\d+-[a-f0-9]+\.req$/);

    const triggerPath = path.join(testStateDir, TRIGGER_DIRNAME, triggerFiles[0] as string);
    const payload = JSON.parse(fs.readFileSync(triggerPath, "utf8")) as {
      requestedAt?: string;
      userId?: number;
    };
    expect(payload.userId).toBe(authorizedUserId);
    expect(typeof payload.requestedAt).toBe("string");

    const lastRestartPath = path.join(testStateDir, TRIGGER_DIRNAME, ".last-restart-ts");
    expect(fs.existsSync(lastRestartPath)).toBe(true);
  });

  it("appends audit log entries for each request", async () => {
    const { handler } = createHarness();
    const authorizedUserId = AUTHORIZED_USER_ID;

    await handler(createCtx({ chatId: 101, userId: authorizedUserId }));
    await handler(createCtx({ chatId: 101, userId: authorizedUserId + 1 }));

    const auditPath = path.join(testStateDir, AUDIT_LOG_FILENAME);
    expect(fs.existsSync(auditPath)).toBe(true);

    const lines = fs
      .readFileSync(auditPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0] as string) as AuditEntry;
    const second = JSON.parse(lines[1] as string) as AuditEntry;

    expect(first.reason).toBe("accepted");
    expect(first.accepted).toBe(true);
    expect(second.reason).toBe("unauthorized");
    expect(second.accepted).toBe(false);
    expect(typeof first.timestamp).toBe("string");
    expect(typeof second.timestamp).toBe("string");
  });
});
