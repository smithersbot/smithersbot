import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { startTelegramWebhook } from "./webhook.js";

const httpMocks = vi.hoisted(() => {
  let requestHandler: ((req: unknown, res: unknown) => void) | undefined;
  const server = {
    listen: vi.fn(),
    address: vi.fn(),
    close: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
  };
  const createServer = vi.fn((handler: (req: unknown, res: unknown) => void) => {
    requestHandler = handler;
    return server;
  });
  const reset = () => {
    requestHandler = undefined;
    createServer.mockClear();
    server.listen.mockReset();
    server.address.mockReset();
    server.close.mockReset();
    server.once.mockReset();
    server.off.mockReset();
    server.listen.mockImplementation((_port: number, _host: string, cb: () => void) => {
      cb();
      return server;
    });
    server.address.mockReturnValue({
      address: "127.0.0.1",
      family: "IPv4",
      port: 54321,
    });
  };
  reset();
  return {
    createServer,
    getRequestHandler: () => requestHandler,
    reset,
    server,
  };
});

vi.mock("node:http", () => ({
  createServer: httpMocks.createServer,
}));

const handlerSpy = vi.fn(
  (_req: unknown, res: { writeHead: (status: number) => void; end: (body?: string) => void }) => {
    res.writeHead(200);
    res.end("ok");
  },
);
const setWebhookSpy = vi.fn();
const stopSpy = vi.fn();

const createTelegramBotSpy = vi.fn(() => ({
  api: { setWebhook: setWebhookSpy },
  stop: stopSpy,
}));

vi.mock("grammy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("grammy")>();
  return { ...actual, webhookCallback: () => handlerSpy };
});

vi.mock("./bot.js", () => ({
  createTelegramBot: (...args: unknown[]) => createTelegramBotSpy(...args),
}));

function dispatchRequest(url: string, method = "GET"): { body: string; status: number } {
  const handler = httpMocks.getRequestHandler();
  if (!handler) throw new Error("server was not created");
  let status = 0;
  let body = "";
  let res: {
    headersSent: boolean;
    writeHead: (nextStatus: number) => void;
    end: (nextBody?: string) => void;
  };
  res = {
    headersSent: false,
    writeHead(nextStatus: number) {
      status = nextStatus;
      res.headersSent = true;
    },
    end(nextBody?: string) {
      body += nextBody ?? "";
    },
  };
  handler({ method, url } as IncomingMessage, res as ServerResponse);
  return { body, status };
}

describe("startTelegramWebhook", () => {
  beforeEach(() => {
    httpMocks.reset();
    handlerSpy.mockClear();
    setWebhookSpy.mockClear();
    stopSpy.mockClear();
    createTelegramBotSpy.mockClear();
  });

  it("starts server, registers webhook, and serves health", async () => {
    const abort = new AbortController();
    const cfg = { bindings: [] };
    const { server } = await startTelegramWebhook({
      token: "tok",
      accountId: "opie",
      config: cfg,
      port: 0, // random free port
      host: "127.0.0.1",
      abortSignal: abort.signal,
    });
    expect(createTelegramBotSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "opie",
        config: expect.objectContaining({ bindings: [] }),
      }),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");

    const health = dispatchRequest("/healthz");
    expect(health.status).toBe(200);
    expect(health.body).toBe("ok");
    expect(setWebhookSpy).toHaveBeenCalledWith(
      `http://127.0.0.1:${address.port}/telegram-webhook`,
      expect.any(Object),
    );

    abort.abort();
  });

  it("invokes webhook handler on matching path", async () => {
    const abort = new AbortController();
    const cfg = { bindings: [] };
    await startTelegramWebhook({
      token: "tok",
      accountId: "opie",
      config: cfg,
      port: 0,
      host: "127.0.0.1",
      abortSignal: abort.signal,
      path: "/hook",
    });
    expect(createTelegramBotSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "opie",
        config: expect.objectContaining({ bindings: [] }),
      }),
    );
    dispatchRequest("/hook", "POST");
    expect(handlerSpy).toHaveBeenCalled();
    abort.abort();
  });
});
