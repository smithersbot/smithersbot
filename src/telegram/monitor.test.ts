import { beforeEach, describe, expect, it, vi } from "vitest";

import { monitorTelegramProvider } from "./monitor.js";

type MockCtx = {
  message: {
    chat: { id: number; type: string; title?: string };
    text?: string;
    caption?: string;
  };
  me?: { username: string };
  getFile: () => Promise<unknown>;
};

// Fake bot to capture handler and API calls
const handlers: Record<string, (ctx: MockCtx) => Promise<void> | void> = {};
const api = {
  sendMessage: vi.fn(),
  sendPhoto: vi.fn(),
  sendVideo: vi.fn(),
  sendAudio: vi.fn(),
  sendDocument: vi.fn(),
  setWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
};
const { initSpy, runSpy, loadConfig } = vi.hoisted(() => ({
  initSpy: vi.fn(async () => undefined),
  runSpy: vi.fn(() => ({
    task: () => Promise.resolve(),
    stop: vi.fn(async () => undefined),
  })),
  loadConfig: vi.fn(() => ({
    agents: { defaults: { maxConcurrent: 2 } },
    channels: { telegram: {} },
  })),
}));

const { computeBackoff, sleepWithAbort } = vi.hoisted(() => ({
  computeBackoff: vi.fn(() => 0),
  sleepWithAbort: vi.fn(async () => undefined),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig,
  };
});

vi.mock("./bot.js", () => ({
  createTelegramBot: () => {
    handlers.message = async (ctx: MockCtx) => {
      const chatId = ctx.message.chat.id;
      const isGroup = ctx.message.chat.type !== "private";
      const text = ctx.message.text ?? ctx.message.caption ?? "";
      if (isGroup && !text.includes("@mybot")) return;
      if (!text.trim()) return;
      await api.sendMessage(chatId, `echo:${text}`, { parse_mode: "HTML" });
    };
    return {
      on: vi.fn(),
      api,
      me: { username: "mybot" },
      init: initSpy,
      stop: vi.fn(),
      start: vi.fn(),
    };
  },
  createTelegramWebhookCallback: vi.fn(),
}));

// Mock the grammyjs/runner to resolve immediately
vi.mock("@grammyjs/runner", () => ({
  run: runSpy,
}));

vi.mock("../infra/backoff.js", () => ({
  computeBackoff,
  sleepWithAbort,
}));

vi.mock("../auto-reply/reply.js", () => ({
  getReplyFromConfig: async (ctx: { Body?: string }) => ({
    text: `echo:${ctx.Body}`,
  }),
}));

describe("monitorTelegramProvider (grammY)", () => {
  beforeEach(() => {
    loadConfig.mockReturnValue({
      agents: { defaults: { maxConcurrent: 2 } },
      channels: { telegram: {} },
    });
    initSpy.mockClear();
    runSpy.mockReset();
    runSpy.mockImplementation(() => ({
      task: () => Promise.resolve(),
      stop: vi.fn(async () => undefined),
    }));
    computeBackoff.mockReset();
    computeBackoff.mockReturnValue(0);
    sleepWithAbort.mockReset();
    sleepWithAbort.mockResolvedValue(undefined);
    Object.values(api).forEach((fn) => {
      fn?.mockReset?.();
    });
  });

  it("processes a DM and sends reply", async () => {
    Object.values(api).forEach((fn) => {
      fn?.mockReset?.();
    });
    await monitorTelegramProvider({ token: "tok" });
    expect(handlers.message).toBeDefined();
    await handlers.message?.({
      message: {
        message_id: 1,
        chat: { id: 123, type: "private" },
        text: "hi",
      },
      me: { username: "mybot" },
      getFile: vi.fn(async () => ({})),
    });
    expect(api.sendMessage).toHaveBeenCalledWith(123, "echo:hi", {
      parse_mode: "HTML",
    });
  });

  it("uses agent maxConcurrent for runner concurrency", async () => {
    runSpy.mockClear();
    loadConfig.mockReturnValue({
      agents: { defaults: { maxConcurrent: 3 } },
      channels: { telegram: {} },
    });

    await monitorTelegramProvider({ token: "tok" });

    expect(runSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sink: { concurrency: 3 },
        runner: expect.objectContaining({
          silent: true,
          maxRetryTime: 5 * 60 * 1000,
          retryInterval: "exponential",
        }),
      }),
    );
  });

  it("requires mention in groups by default", async () => {
    Object.values(api).forEach((fn) => {
      fn?.mockReset?.();
    });
    await monitorTelegramProvider({ token: "tok" });
    await handlers.message?.({
      message: {
        message_id: 2,
        chat: { id: -99, type: "supergroup", title: "G" },
        text: "hello all",
      },
      me: { username: "mybot" },
      getFile: vi.fn(async () => ({})),
    });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("restarts once after a 500 second getUpdates timeout", async () => {
    const timeoutError = new Error("Request to 'getUpdates' timed out after 500 seconds");
    const logs: string[] = [];
    const errors: string[] = [];
    const firstStop = vi.fn(async () => undefined);
    computeBackoff.mockReturnValueOnce(1250);
    runSpy
      .mockImplementationOnce(() => ({
        task: () => Promise.reject(timeoutError),
        stop: firstStop,
      }))
      .mockImplementationOnce(() => ({
        task: () => Promise.resolve(),
        stop: vi.fn(async () => undefined),
      }));

    await monitorTelegramProvider({
      token: "tok",
      runtime: {
        log: (...args: unknown[]) => {
          logs.push(String(args[0]));
        },
        error: (...args: unknown[]) => {
          errors.push(String(args[0]));
        },
        exit: (code: number): never => {
          throw new Error(`exit ${code}`);
        },
      },
    });

    expect(computeBackoff).toHaveBeenCalledTimes(1);
    expect(sleepWithAbort).toHaveBeenCalledWith(1250, undefined);
    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(firstStop).toHaveBeenCalledTimes(1);
    expect(errors.some((line) => line.includes("classification=recoverable"))).toBe(true);
    expect(errors.some((line) => line.includes("restart-attempt") && line.includes("1250"))).toBe(
      true,
    );
    expect(logs.some((line) => line.includes("restart-success"))).toBe(true);
  });

  it("restarts after fetch failed polling errors", async () => {
    runSpy
      .mockImplementationOnce(() => ({
        task: () => Promise.reject(new TypeError("fetch failed")),
        stop: vi.fn(async () => undefined),
      }))
      .mockImplementationOnce(() => ({
        task: () => Promise.resolve(),
        stop: vi.fn(async () => undefined),
      }));

    await monitorTelegramProvider({ token: "tok" });

    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(computeBackoff).toHaveBeenCalledTimes(1);
    expect(sleepWithAbort).toHaveBeenCalledTimes(1);
  });

  it("restarts after an uncontrolled AbortError from runner.task", async () => {
    const abortError = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    });
    const abort = new AbortController();
    runSpy
      .mockImplementationOnce(() => ({
        task: () => Promise.reject(abortError),
        stop: vi.fn(async () => undefined),
      }))
      .mockImplementationOnce(() => ({
        task: () => Promise.resolve(),
        stop: vi.fn(async () => undefined),
      }));

    await monitorTelegramProvider({ token: "tok", abortSignal: abort.signal });

    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(computeBackoff).toHaveBeenCalledTimes(1);
  });

  it("awaits the previous runner stop before creating a replacement", async () => {
    const events: string[] = [];
    let releaseStop: (() => void) | null = null;
    const stopStarted = new Promise<void>((resolve) => {
      const firstStop = vi.fn(async () => {
        events.push("stop-start");
        resolve();
        await new Promise<void>((stopResolve) => {
          releaseStop = () => {
            events.push("stop-end");
            stopResolve();
          };
        });
      });
      runSpy
        .mockImplementationOnce(() => ({
          task: async () => {
            events.push("task-1");
            throw new TypeError("fetch failed");
          },
          stop: firstStop,
        }))
        .mockImplementationOnce(() => ({
          task: async () => {
            events.push("task-2");
          },
          stop: vi.fn(async () => undefined),
        }));
    });

    const promise = monitorTelegramProvider({ token: "tok" });
    await stopStarted;

    expect(runSpy).toHaveBeenCalledTimes(1);
    releaseStop?.();
    await promise;

    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["task-1", "stop-start", "stop-end", "task-2"]);
  });

  it("handles a slash-command-style update after poller recovery", async () => {
    runSpy
      .mockImplementationOnce(() => ({
        task: () => Promise.reject(new TypeError("fetch failed")),
        stop: vi.fn(async () => undefined),
      }))
      .mockImplementationOnce(() => ({
        task: () => Promise.resolve(),
        stop: vi.fn(async () => undefined),
      }));

    await monitorTelegramProvider({ token: "tok" });
    await handlers.message?.({
      message: {
        message_id: 3,
        chat: { id: 321, type: "private" },
        text: "/gateway_status",
      },
      me: { username: "mybot" },
      getFile: vi.fn(async () => ({})),
    });

    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(api.sendMessage).toHaveBeenCalledWith(321, "echo:/gateway_status", {
      parse_mode: "HTML",
    });
  });

  it("surfaces non-recoverable errors", async () => {
    runSpy.mockImplementationOnce(() => ({
      task: () => Promise.reject(new Error("bad token")),
      stop: vi.fn(),
    }));

    await expect(monitorTelegramProvider({ token: "tok" })).rejects.toThrow("bad token");
  });
});
