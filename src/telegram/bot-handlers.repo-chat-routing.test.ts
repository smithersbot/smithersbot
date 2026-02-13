import { describe, expect, it } from "vitest";

import { shouldRouteTelegramTextToRepoChat } from "./bot-handlers.js";

describe("shouldRouteTelegramTextToRepoChat", () => {
  it("routes non-reply text to repo chat when backend is codex", () => {
    expect(
      shouldRouteTelegramTextToRepoChat({
        repoChatBackend: "codex",
        replyToMessageId: undefined,
      }),
    ).toBe(true);
  });

  it("routes non-reply text to repo chat when backend is claude_code", () => {
    expect(
      shouldRouteTelegramTextToRepoChat({
        repoChatBackend: "claude_code",
        replyToMessageId: undefined,
      }),
    ).toBe(true);
  });

  it("does not route replies to repo chat", () => {
    expect(
      shouldRouteTelegramTextToRepoChat({
        repoChatBackend: "codex",
        replyToMessageId: 123,
      }),
    ).toBe(false);
  });

  it("does not route to repo chat when backend is disabled", () => {
    expect(
      shouldRouteTelegramTextToRepoChat({
        repoChatBackend: null,
        replyToMessageId: undefined,
      }),
    ).toBe(false);
  });
});
