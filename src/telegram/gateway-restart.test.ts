import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  spawnSyncMock,
  triggerMoltbotRestartMock,
  scheduleGatewaySigusr1RestartMock,
  writeRestartSentinelMock,
  onUpdateProcessedMock,
} = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
  triggerMoltbotRestartMock: vi.fn(),
  scheduleGatewaySigusr1RestartMock: vi.fn(),
  writeRestartSentinelMock: vi.fn(),
  onUpdateProcessedMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
  };
});
vi.mock("../infra/restart.js", () => ({
  resolveGatewaySystemdRestartUnit: () => "moltbot-gateway-dev.service",
  scheduleGatewaySigusr1Restart: (...args: unknown[]) => scheduleGatewaySigusr1RestartMock(...args),
  triggerMoltbotRestart: (...args: unknown[]) => triggerMoltbotRestartMock(...args),
}));
vi.mock("../infra/restart-sentinel.js", () => ({
  writeRestartSentinel: (...args: unknown[]) => writeRestartSentinelMock(...args),
}));

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
let previousGatewayPort: string | undefined;

function createHarness(params?: {
  allowFrom?: Array<string | number>;
  accountId?: string;
  onUpdateProcessed?: (updateId: number) => void | Promise<void>;
}) {
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
    accountId: params?.accountId ?? "test-account",
    onUpdateProcessed: params?.onUpdateProcessed ?? onUpdateProcessedMock,
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

function createCtx(params?: {
  chatId?: number;
  chatType?: string;
  userId?: number;
  updateId?: number;
  messageThreadId?: number;
}) {
  const userId = params?.userId;
  return {
    update: {
      update_id: params?.updateId ?? 1,
    },
    message: {
      chat: {
        id: params?.chatId ?? 123,
        type: params?.chatType ?? "private",
      },
      ...(params?.messageThreadId != null ? { message_thread_id: params.messageThreadId } : {}),
      ...(userId != null ? { from: { id: userId } } : {}),
    },
  };
}

function listTriggerRequests(): string[] {
  const triggerDir = path.join(testStateDir, TRIGGER_DIRNAME);
  if (!fs.existsSync(triggerDir)) return [];
  return fs.readdirSync(triggerDir).filter((entry) => entry.endsWith(".req"));
}

function listRequestStates(): string[] {
  const triggerDir = path.join(testStateDir, TRIGGER_DIRNAME);
  if (!fs.existsSync(triggerDir)) return [];
  return fs.readdirSync(triggerDir).filter((entry) => entry.endsWith(".json"));
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
    previousGatewayPort = process.env.SMITHERSBOT_GATEWAY_PORT;
    testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-restart-test-"));
    process.env.CLAWDBOT_STATE_DIR = testStateDir;
    process.env.SMITHERSBOT_GATEWAY_PORT = "19001";
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({
      status: 1,
      signal: null,
      output: [null, "", ""],
      pid: 0,
      stdout: "",
      stderr: "",
    });
    scheduleGatewaySigusr1RestartMock.mockReset();
    scheduleGatewaySigusr1RestartMock.mockReturnValue({
      ok: true,
      pid: process.pid,
      signal: "SIGUSR1",
      delayMs: 2000,
      reason: "telegram /gateway_restart",
      mode: "emit",
    });
    triggerMoltbotRestartMock.mockReset();
    triggerMoltbotRestartMock.mockReturnValue({ ok: true, method: "systemd", tried: [] });
    writeRestartSentinelMock.mockReset();
    writeRestartSentinelMock.mockResolvedValue(undefined);
    onUpdateProcessedMock.mockReset();
    onUpdateProcessedMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (previousStateDir === undefined) delete process.env.CLAWDBOT_STATE_DIR;
    else process.env.CLAWDBOT_STATE_DIR = previousStateDir;
    if (previousGatewayPort === undefined) delete process.env.SMITHERSBOT_GATEWAY_PORT;
    else process.env.SMITHERSBOT_GATEWAY_PORT = previousGatewayPort;
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

    await handler(createCtx({ chatId: 7, userId: authorizedUserId, updateId: 1001 }));
    await handler(createCtx({ chatId: 7, userId: authorizedUserId, updateId: 1002 }));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[1]).toContain("cooldown");
    expect(listTriggerRequests()).toHaveLength(0);
    expect(triggerMoltbotRestartMock).toHaveBeenCalledTimes(1);
    expect(writeRestartSentinelMock).toHaveBeenCalledTimes(1);
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();

    const entries = readAuditEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ accepted: true, reason: "accepted" });
    expect(entries[1]).toMatchObject({ accepted: false, reason: "cooldown" });
    expect((entries[1]?.cooldownSecondsRemaining ?? 0) > 0).toBe(true);
  });

  it("records cooldown timestamp and triggers full restart when accepted", async () => {
    const { handler, sendMessage } = createHarness();
    const authorizedUserId = AUTHORIZED_USER_ID;

    await handler(createCtx({ chatId: 88, userId: authorizedUserId, updateId: 9001 }));

    expect(sendMessage).not.toHaveBeenCalled();
    expect(onUpdateProcessedMock).toHaveBeenCalledWith(9001);
    expect(writeRestartSentinelMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      onUpdateProcessedMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(triggerMoltbotRestartMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      onUpdateProcessedMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(triggerMoltbotRestartMock).toHaveBeenCalledTimes(1);
    expect(writeRestartSentinelMock).toHaveBeenCalledWith({
      kind: "restart",
      status: "ok",
      ts: expect.any(Number),
      sessionKey: "telegram:88",
      deliveryContext: {
        channel: "telegram",
        to: "88",
        accountId: "test-account",
      },
      message: "Gateway restarted.",
    });
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(listTriggerRequests()).toHaveLength(0);
    expect(listRequestStates()).toHaveLength(1);

    const lastRestartPath = path.join(testStateDir, TRIGGER_DIRNAME, ".last-restart-ts");
    expect(fs.existsSync(lastRestartPath)).toBe(true);
  });

  it("persists restart request state before triggering restart", async () => {
    triggerMoltbotRestartMock.mockImplementationOnce(() => {
      expect(listRequestStates()).toHaveLength(1);
      const statePath = path.join(testStateDir, TRIGGER_DIRNAME, listRequestStates()[0] as string);
      const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
        accountId: string;
        chatId: number;
        updateId: number;
        sentinel?: unknown;
        timestamp?: string;
      };
      expect(state).toMatchObject({
        accountId: "test-account",
        chatId: 88,
        updateId: 9002,
      });
      expect(state.sentinel).toBeTruthy();
      expect(typeof state.timestamp).toBe("string");
      return { ok: true, method: "systemd", tried: [] };
    });

    const { handler } = createHarness();

    await handler(createCtx({ chatId: 88, userId: AUTHORIZED_USER_ID, updateId: 9002 }));

    expect(triggerMoltbotRestartMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses duplicate accepted update_id without a second user-facing reply", async () => {
    const { handler, sendMessage } = createHarness();
    const ctx = createCtx({ chatId: 91, userId: AUTHORIZED_USER_ID, updateId: 7001 });

    await handler(ctx);
    await handler(ctx);

    expect(triggerMoltbotRestartMock).toHaveBeenCalledTimes(1);
    expect(writeRestartSentinelMock).toHaveBeenCalledTimes(1);
    expect(onUpdateProcessedMock).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(listRequestStates()).toHaveLength(1);
  });

  it("reports stale PID when the gateway port remains bound after restart success", async () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      signal: null,
      output: [null, "4242\n", ""],
      pid: 0,
      stdout: "4242\n",
      stderr: "",
    });

    const { handler, sendMessage } = createHarness();

    await handler(
      createCtx({
        chatId: 44,
        userId: AUTHORIZED_USER_ID,
        updateId: 4401,
        messageThreadId: 19,
      }),
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(44, expect.stringContaining("stale PID 4242"), {
      message_thread_id: 19,
    });
    expect(sendMessage.mock.calls[0]?.[1]).toContain("moltbot-gateway-dev.service");
    expect(sendMessage.mock.calls[0]?.[1]).toContain("port 19001");
  });

  it("falls back to SIGUSR1 restart when full restart fails", async () => {
    triggerMoltbotRestartMock.mockReturnValueOnce({
      ok: false,
      method: "systemd",
      detail: "permission denied",
      tried: ["systemctl --user restart moltbot-gateway-dev.service"],
    });

    const { handler, sendMessage } = createHarness();
    const authorizedUserId = AUTHORIZED_USER_ID;

    await handler(createCtx({ chatId: 77, userId: authorizedUserId }));

    expect(triggerMoltbotRestartMock).toHaveBeenCalledTimes(1);
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(listTriggerRequests()).toHaveLength(0);
  });

  it("queues fallback trigger when both restart methods fail", async () => {
    triggerMoltbotRestartMock.mockReturnValueOnce({
      ok: false,
      method: "systemd",
      detail: "permission denied",
      tried: ["systemctl --user restart moltbot-gateway-dev.service"],
    });
    scheduleGatewaySigusr1RestartMock.mockReturnValueOnce({
      ok: false,
      pid: process.pid,
      signal: "SIGUSR1",
      delayMs: 2000,
      reason: "telegram /gateway_restart",
      mode: "emit",
    });

    const { handler, sendMessage } = createHarness();
    const authorizedUserId = AUTHORIZED_USER_ID;

    await handler(createCtx({ chatId: 77, userId: authorizedUserId }));

    expect(triggerMoltbotRestartMock).toHaveBeenCalledTimes(1);
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[1]).toContain("direct restart failed");
    expect(sendMessage.mock.calls[0]?.[1]).toContain("Fallback queued");

    const triggerFiles = listTriggerRequests();
    expect(triggerFiles).toHaveLength(1);
    expect(triggerFiles[0]).toMatch(/^restart-\d+-[a-f0-9]+\.req$/);
  });

  it("appends audit log entries for each request", async () => {
    const { handler } = createHarness();
    const authorizedUserId = AUTHORIZED_USER_ID;

    await handler(createCtx({ chatId: 101, userId: authorizedUserId, updateId: 1011 }));
    await handler(createCtx({ chatId: 101, userId: authorizedUserId + 1, updateId: 1012 }));

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
