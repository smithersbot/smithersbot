import { beforeEach, describe, expect, it, vi } from "vitest";

import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";

const resolveAnnounceTargetFromKeyMock = vi.fn();
const normalizeChannelIdMock = vi.fn();
const createOutboundSendDepsMock = vi.fn();
const agentCommandMock = vi.fn();
const resolveMainSessionKeyFromConfigMock = vi.fn();
const runMessageActionMock = vi.fn();
const resolveOutboundTargetMock = vi.fn();
const consumeRestartSentinelMock = vi.fn();
const formatRestartSentinelMessageMock = vi.fn();
const summarizeRestartSentinelMock = vi.fn();
const enqueueSystemEventMock = vi.fn();
const deliveryContextFromSessionMock = vi.fn();
const mergeDeliveryContextMock = vi.fn();
const loadSessionEntryMock = vi.fn();

const defaultRuntimeMock = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock("../agents/tools/sessions-send-helpers.js", () => ({
  resolveAnnounceTargetFromKey: (...args: unknown[]) => resolveAnnounceTargetFromKeyMock(...args),
}));
vi.mock("../channels/plugins/index.js", () => ({
  normalizeChannelId: (...args: unknown[]) => normalizeChannelIdMock(...args),
}));
vi.mock("../cli/outbound-send-deps.js", () => ({
  createOutboundSendDeps: (...args: unknown[]) => createOutboundSendDepsMock(...args),
}));
vi.mock("../commands/agent.js", () => ({
  agentCommand: (...args: unknown[]) => agentCommandMock(...args),
}));
vi.mock("../config/sessions.js", () => ({
  resolveMainSessionKeyFromConfig: (...args: unknown[]) =>
    resolveMainSessionKeyFromConfigMock(...args),
}));
vi.mock("../infra/outbound/message-action-runner.js", () => ({
  runMessageAction: (...args: unknown[]) => runMessageActionMock(...args),
}));
vi.mock("../infra/outbound/targets.js", () => ({
  resolveOutboundTarget: (...args: unknown[]) => resolveOutboundTargetMock(...args),
}));
vi.mock("../infra/restart-sentinel.js", () => ({
  consumeRestartSentinel: (...args: unknown[]) => consumeRestartSentinelMock(...args),
  formatRestartSentinelMessage: (...args: unknown[]) => formatRestartSentinelMessageMock(...args),
  summarizeRestartSentinel: (...args: unknown[]) => summarizeRestartSentinelMock(...args),
}));
vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));
vi.mock("../runtime.js", () => ({
  defaultRuntime: defaultRuntimeMock,
}));
vi.mock("../utils/delivery-context.js", () => ({
  deliveryContextFromSession: (...args: unknown[]) => deliveryContextFromSessionMock(...args),
  mergeDeliveryContext: (...args: unknown[]) => mergeDeliveryContextMock(...args),
}));
vi.mock("./session-utils.js", () => ({
  loadSessionEntry: (...args: unknown[]) => loadSessionEntryMock(...args),
}));

const { scheduleRestartSentinelWake } = await import("./server-restart-sentinel.js");

function makeDeps() {
  return {
    sendMessageWhatsApp: vi.fn(),
    sendMessageTelegram: vi.fn(),
    sendMessageDiscord: vi.fn(),
    sendMessageSlack: vi.fn(),
    sendMessageSignal: vi.fn(),
    sendMessageIMessage: vi.fn(),
  };
}

describe("scheduleRestartSentinelWake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveMainSessionKeyFromConfigMock.mockReturnValue("agent:main:webchat");
    resolveAnnounceTargetFromKeyMock.mockReturnValue(undefined);
    normalizeChannelIdMock.mockImplementation((channel: string) => channel);
    resolveOutboundTargetMock.mockReturnValue({ ok: true, to: "123" });
    formatRestartSentinelMessageMock.mockImplementation(
      (payload: { kind: string }) => `formatted:${payload.kind}`,
    );
    summarizeRestartSentinelMock.mockImplementation(
      (payload: { kind: string; status: string }) => `${payload.kind}:${payload.status}`,
    );
    deliveryContextFromSessionMock.mockReturnValue(undefined);
    mergeDeliveryContextMock.mockImplementation(
      (
        primary?: { channel?: string; to?: string; accountId?: string; threadId?: string },
        fallback?: { channel?: string; to?: string; accountId?: string; threadId?: string },
      ) => primary ?? fallback,
    );
    loadSessionEntryMock.mockReturnValue({ cfg: {}, entry: {} });
    createOutboundSendDepsMock.mockReturnValue({
      sendTelegram: vi.fn(),
    });
    runMessageActionMock.mockResolvedValue({ kind: "send" });
    agentCommandMock.mockResolvedValue(undefined);
  });

  it("uses direct outbound send for restart sentinels", async () => {
    const deps = makeDeps();
    consumeRestartSentinelMock.mockResolvedValue({
      version: 1,
      payload: {
        kind: "restart",
        status: "ok",
        ts: Date.now(),
        sessionKey: "telegram:123",
        deliveryContext: {
          channel: "telegram",
          to: "123",
          accountId: "acct-1",
        },
        message: "Gateway restarted.",
      },
    });

    await scheduleRestartSentinelWake({ deps });

    expect(createOutboundSendDepsMock).toHaveBeenCalledWith(deps);
    expect(runMessageActionMock).toHaveBeenCalledTimes(1);
    expect(runMessageActionMock).toHaveBeenCalledWith({
      cfg: {},
      action: "send",
      params: {
        channel: "telegram",
        to: "123",
        message: "Gateway restarted.",
        accountId: "acct-1",
        threadId: undefined,
      },
      deps: {
        sendTelegram: expect.any(Function),
      },
      gateway: {
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
    });
    expect(agentCommandMock).not.toHaveBeenCalled();
  });

  it("falls back to agentCommand for non-restart sentinels", async () => {
    const deps = makeDeps();
    consumeRestartSentinelMock.mockResolvedValue({
      version: 1,
      payload: {
        kind: "config-apply",
        status: "ok",
        ts: Date.now(),
        sessionKey: "telegram:123",
        deliveryContext: {
          channel: "telegram",
          to: "123",
          accountId: "acct-1",
        },
        message: "Applied config.",
      },
    });

    await scheduleRestartSentinelWake({ deps });

    expect(runMessageActionMock).not.toHaveBeenCalled();
    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    expect(agentCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "formatted:config-apply",
        sessionKey: "telegram:123",
        to: "123",
        channel: "telegram",
        deliver: true,
        bestEffortDeliver: true,
        messageChannel: "telegram",
      }),
      defaultRuntimeMock,
      deps,
    );
  });

  it("falls back to agentCommand when direct outbound send fails", async () => {
    const deps = makeDeps();
    runMessageActionMock.mockRejectedValueOnce(new Error("send failed"));
    consumeRestartSentinelMock.mockResolvedValue({
      version: 1,
      payload: {
        kind: "restart",
        status: "ok",
        ts: Date.now(),
        sessionKey: "telegram:123",
        deliveryContext: {
          channel: "telegram",
          to: "123",
          accountId: "acct-1",
        },
        message: "Gateway restarted.",
      },
    });

    await scheduleRestartSentinelWake({ deps });

    expect(runMessageActionMock).toHaveBeenCalledTimes(1);
    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });
});
