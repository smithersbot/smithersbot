import { describe, expect, it, vi } from "vitest";

import { authorizeGatewayConnect } from "./auth.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

async function requestMethod(method: string, scopes: string[]) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: "auth-test", method },
    client: {
      connect: {
        role: "operator",
        scopes,
      },
    },
    isWebchatConnect: () => false,
    respond,
    context: {} as GatewayRequestContext,
    extraHandlers: {
      [method]: ({ respond: send }) => send(true, { reached: true }),
    },
  });
  return respond.mock.calls[0] as [boolean, unknown, { message?: string } | undefined];
}

describe("gateway auth", () => {
  it("does not throw when req is missing socket", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "secret" },
      // Regression: avoid crashing on req.socket.remoteAddress when callers pass a non-IncomingMessage.
      req: {} as never,
    });
    expect(res.ok).toBe(true);
  });

  it("reports missing and mismatched token reasons", async () => {
    const missing = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("token_missing");

    const mismatch = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "wrong" },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("token_mismatch");
  });

  it("reports missing token config reason", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", allowTailscale: false },
      connectAuth: { token: "anything" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_missing_config");
  });

  it("reports missing and mismatched password reasons", async () => {
    const missing = await authorizeGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("password_missing");

    const mismatch = await authorizeGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: { password: "wrong" },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("password_mismatch");
  });

  it("reports missing password config reason", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "password", allowTailscale: false },
      connectAuth: { password: "secret" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("password_missing_config");
  });

  it("treats local tailscale serve hostnames as direct", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: { token: "secret" },
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "gateway.tailnet-1234.ts.net:443" },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("token");
  });

  it("allows tailscale identity to satisfy token mode auth", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      tailscaleWhois: async () => ({ login: "peter", name: "Peter" }),
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: {
          host: "gateway.local",
          "x-forwarded-for": "100.64.0.1",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "ai-hub.bone-egret.ts.net",
          "tailscale-user-login": "peter",
          "tailscale-user-name": "Peter",
        },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("tailscale");
    expect(res.user).toBe("peter");
  });

  it("maps harness command/callback/reply to operator.write by exact namespaced method", async () => {
    for (const method of ["harness.command", "harness.callback", "harness.reply"]) {
      const denied = await requestMethod(method, ["operator.read"]);
      expect(denied[0]).toBe(false);
      expect(denied[2]?.message).toBe("missing scope: operator.write");

      const allowed = await requestMethod(method, ["operator.write"]);
      expect(allowed[0]).toBe(true);
      expect(allowed[1]).toEqual({ reached: true });
    }
  });

  it("maps harness.gateway_restart to operator.admin by exact namespaced method", async () => {
    const denied = await requestMethod("harness.gateway_restart", ["operator.write"]);
    expect(denied[0]).toBe(false);
    expect(denied[2]?.message).toBe("missing scope: operator.admin");

    const allowed = await requestMethod("harness.gateway_restart", ["operator.admin"]);
    expect(allowed[0]).toBe(true);
    expect(allowed[1]).toEqual({ reached: true });
  });

  it("does not grant write scope to bare harness-like method names", async () => {
    for (const method of ["command", "callback", "reply", "gateway_restart"]) {
      const denied = await requestMethod(method, ["operator.write"]);
      expect(denied[0]).toBe(false);
      expect(denied[2]?.message).toBe("missing scope: operator.admin");
    }
  });
});
