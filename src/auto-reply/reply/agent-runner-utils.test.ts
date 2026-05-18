import { describe, expect, it } from "vitest";

import type { MoltbotConfig } from "../../config/config.js";
import type { TemplateContext } from "../templating.js";
import { buildThreadingToolContext } from "./agent-runner-utils.js";

describe("buildThreadingToolContext", () => {
  const cfg = {} as MoltbotConfig;

  it("falls back to To for WhatsApp when From is missing", () => {
    const sessionCtx = {
      Provider: "whatsapp",
      To: "+15550001",
    } as TemplateContext;

    const result = buildThreadingToolContext({
      sessionCtx,
      config: cfg,
      hasRepliedRef: undefined,
    });

    expect(result.currentChannelId).toBe("+15550001");
  });

  it("uses the recipient id for other channels", () => {
    const sessionCtx = {
      Provider: "telegram",
      From: "user:42",
      To: "chat:99",
    } as TemplateContext;

    const result = buildThreadingToolContext({
      sessionCtx,
      config: cfg,
      hasRepliedRef: undefined,
    });

    expect(result.currentChannelId).toBe("chat:99");
  });

  it("uses chat_id for iMessage groups", () => {
    const sessionCtx = {
      Provider: "imessage",
      ChatType: "group",
      From: "imessage:group:7",
      To: "chat_id:7",
    } as TemplateContext;

    const result = buildThreadingToolContext({
      sessionCtx,
      config: cfg,
      hasRepliedRef: undefined,
    });

    expect(result.currentChannelId).toBe("chat_id:7");
  });
});
