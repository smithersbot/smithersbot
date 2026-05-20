import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepoChatSession } from "./types.js";
import {
  findRepoChatSessionByMessageId,
  loadRepoChatSession,
  resetRepoChatStoreIndexForTests,
  saveRepoChatSession,
} from "./repo-chat-store.js";

function makeSession(overrides: Partial<RepoChatSession> = {}): RepoChatSession {
  return {
    id: "repo-chat-1",
    backend: "codex",
    workingDir: "/tmp/workspace",
    cliSessionId: "thread-1",
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    messageRefs: [
      { chatId: 101, messageId: 201 },
      { chatId: 101, messageId: 202 },
    ],
    ...overrides,
  };
}

describe("repo-chat-store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-chat-store-"));
    resetRepoChatStoreIndexForTests();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetRepoChatStoreIndexForTests();
  });

  it("saves and loads repo chat sessions", () => {
    const session = makeSession();
    saveRepoChatSession(session, tmpDir);

    const loaded = loadRepoChatSession("repo-chat-1", tmpDir);
    expect(loaded).toEqual(session);
  });

  it("finds a session by mapped message id", () => {
    saveRepoChatSession(makeSession(), tmpDir);

    const found = findRepoChatSessionByMessageId({
      chatId: 101,
      messageId: 202,
      repoChatsDir: tmpDir,
    });

    expect(found?.id).toBe("repo-chat-1");
    expect(found?.cliSessionId).toBe("thread-1");
  });

  it("returns undefined for unknown message ids", () => {
    saveRepoChatSession(makeSession(), tmpDir);

    const found = findRepoChatSessionByMessageId({
      chatId: 101,
      messageId: 999,
      repoChatsDir: tmpDir,
    });
    expect(found).toBeUndefined();
  });

  it("warms the lookup index from existing session files on disk", () => {
    saveRepoChatSession(makeSession(), tmpDir);
    resetRepoChatStoreIndexForTests();

    const found = findRepoChatSessionByMessageId({
      chatId: 101,
      messageId: 201,
      repoChatsDir: tmpDir,
    });
    expect(found?.id).toBe("repo-chat-1");
  });

  it("re-indexes message mappings when saving an updated session", () => {
    saveRepoChatSession(makeSession(), tmpDir);
    saveRepoChatSession(
      makeSession({
        updatedAt: "2026-02-13T01:00:00.000Z",
        messageRefs: [{ chatId: 101, messageId: 303 }],
      }),
      tmpDir,
    );

    const oldRef = findRepoChatSessionByMessageId({
      chatId: 101,
      messageId: 201,
      repoChatsDir: tmpDir,
    });
    const newRef = findRepoChatSessionByMessageId({
      chatId: 101,
      messageId: 303,
      repoChatsDir: tmpDir,
    });

    expect(oldRef).toBeUndefined();
    expect(newRef?.id).toBe("repo-chat-1");
  });

  it("redacts secret values from persisted session artifacts", () => {
    const originalToken = process.env.SMITHERSBOT_GATEWAY_TOKEN;
    process.env.SMITHERSBOT_GATEWAY_TOKEN = "FAKE_GATEWAY_SECRET_456";
    try {
      saveRepoChatSession(
        makeSession({
          cliSessionId: "thread-FAKE_GATEWAY_SECRET_456",
          workingDir: "/tmp/FAKE_GATEWAY_SECRET_456/repo",
        }),
        tmpDir,
      );
    } finally {
      if (originalToken === undefined) delete process.env.SMITHERSBOT_GATEWAY_TOKEN;
      else process.env.SMITHERSBOT_GATEWAY_TOKEN = originalToken;
    }

    const sessionJson = fs.readFileSync(path.join(tmpDir, "repo-chat-1", "session.json"), "utf8");
    expect(sessionJson).toContain("[REDACTED]");
    expect(sessionJson).not.toContain("FAKE_GATEWAY_SECRET_456");
  });
});
