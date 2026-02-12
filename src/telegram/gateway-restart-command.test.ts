import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  requestTelegramGatewayRestart,
  resolveTelegramGatewayRestartPaths,
} from "./gateway-restart-command.js";

async function readLogEntries(logPath: string) {
  const raw = await fs.readFile(logPath, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("requestTelegramGatewayRestart", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-tg-restart-"));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("rejects unauthorized users", async () => {
    const result = await requestTelegramGatewayRestart({
      chatType: "private",
      senderId: 1234,
      allowFrom: ["9999"],
      stateDir,
      nowMs: 1_000,
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("unauthorized");
    expect(result.ackText).toContain("Rejected");

    const paths = resolveTelegramGatewayRestartPaths({ stateDir });
    const entries = await readLogEntries(paths.logPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      requestingUserId: "1234",
      result: "rejected",
      reason: "unauthorized",
    });
  });

  it("rejects non-private chats", async () => {
    const result = await requestTelegramGatewayRestart({
      chatType: "group",
      senderId: 9999,
      allowFrom: ["9999"],
      stateDir,
      nowMs: 2_000,
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("non_private_chat");
    expect(result.ackText).toContain("private chats");

    const paths = resolveTelegramGatewayRestartPaths({ stateDir });
    const entries = await readLogEntries(paths.logPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      requestingUserId: "9999",
      result: "rejected",
      reason: "non_private_chat",
    });
  });

  it("enforces cooldown", async () => {
    const first = await requestTelegramGatewayRestart({
      chatType: "private",
      senderId: 9999,
      allowFrom: ["telegram:9999"],
      stateDir,
      nowMs: 10_000,
      nonce: () => "first",
    });
    const second = await requestTelegramGatewayRestart({
      chatType: "private",
      senderId: 9999,
      allowFrom: ["telegram:9999"],
      stateDir,
      nowMs: 20_000,
      nonce: () => "second",
    });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(second.reason).toBe("cooldown");
    expect(second.cooldownRemainingSeconds).toBe(50);

    const paths = resolveTelegramGatewayRestartPaths({ stateDir });
    const requestFiles = await fs.readdir(paths.requestsDir);
    expect(requestFiles).toEqual(["restart-10000-first.req"]);
  });

  it("writes a request file when accepted", async () => {
    const result = await requestTelegramGatewayRestart({
      chatType: "private",
      senderId: "9999",
      allowFrom: ["tg:9999"],
      stateDir,
      nowMs: 300_000,
      nonce: () => "n1",
    });

    expect(result.accepted).toBe(true);
    expect(result.reason).toBe("accepted");
    expect(result.ackText).toContain("Accepted");
    expect(result.requestFilePath).toBeDefined();

    const paths = resolveTelegramGatewayRestartPaths({ stateDir });
    const requestFiles = await fs.readdir(paths.requestsDir);
    expect(requestFiles).toEqual(["restart-300000-n1.req"]);

    const filePath = path.join(paths.requestsDir, requestFiles[0] as string);
    const body = await fs.readFile(filePath, "utf8");
    expect(body).toContain('"requestingUserId":"9999"');

    const entries = await readLogEntries(paths.logPath);
    expect(entries.at(-1)).toMatchObject({
      requestingUserId: "9999",
      result: "accepted",
      reason: "accepted",
      requestFile: "restart-300000-n1.req",
    });
  });
});
