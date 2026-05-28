import { describe, expect, it } from "vitest";

import { MoltbotSchema } from "./zod-schema.js";

describe("telegram chat settings schema", () => {
  it("accepts goalRouter, chatMode, and repoChatBackend on root telegram config", () => {
    const res = MoltbotSchema.safeParse({
      channels: {
        telegram: {
          goalRouter: false,
          chatMode: "chat",
          repoChatBackend: "claude_code",
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.data.channels?.telegram?.goalRouter).toBe(false);
    expect(res.data.channels?.telegram?.chatMode).toBe("chat");
    expect(res.data.channels?.telegram?.repoChatBackend).toBe("claude_code");
  });

  it("accepts repoChatBackend=null for disabled mode", () => {
    const res = MoltbotSchema.safeParse({
      channels: {
        telegram: {
          repoChatBackend: null,
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.channels?.telegram?.repoChatBackend).toBeNull();
  });

  it("accepts settings under telegram accounts", () => {
    const res = MoltbotSchema.safeParse({
      channels: {
        telegram: {
          accounts: {
            work: {
              goalRouter: true,
              chatMode: "help",
              repoChatBackend: "codex",
            },
          },
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) return;
    const work = res.data.channels?.telegram?.accounts?.work;
    expect(work?.goalRouter).toBe(true);
    expect(work?.chatMode).toBe("help");
    expect(work?.repoChatBackend).toBe("codex");
  });

  it("rejects invalid repoChatBackend values", () => {
    const res = MoltbotSchema.safeParse({
      channels: {
        telegram: {
          repoChatBackend: "not_a_backend",
        },
      },
    });

    expect(res.success).toBe(false);
  });
});
