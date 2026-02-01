import type { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";

import { deliverReplies } from "./bot/delivery.js";
import { beginProofOfLife } from "./proof-of-life.js";

describe("telegram proof-of-life", () => {
  it("edits the placeholder into the final reply for chat", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 10 });
    const editMessageText = vi.fn().mockResolvedValue(true);
    const bot = { api: { sendMessage, editMessageText } } as unknown as Bot;

    const proof = beginProofOfLife({ bot, chatId: 1 });
    await deliverReplies({
      replies: [{ text: "hello" }],
      chatId: "1",
      token: "token",
      runtime: {},
      bot,
      replyToMode: "off",
      textLimit: 4096,
      editTarget: proof,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(editMessageText).toHaveBeenCalledTimes(1);
  });

  it("falls back to sendMessage when edit fails", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 10 });
    const editMessageText = vi.fn().mockRejectedValue(new Error("edit failed"));
    const bot = { api: { sendMessage, editMessageText } } as unknown as Bot;

    const proof = beginProofOfLife({ bot, chatId: 1 });
    await deliverReplies({
      replies: [{ text: "hello" }],
      chatId: "1",
      token: "token",
      runtime: {},
      bot,
      replyToMode: "off",
      textLimit: 4096,
      editTarget: proof,
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(editMessageText).toHaveBeenCalledTimes(1);
  });
});
