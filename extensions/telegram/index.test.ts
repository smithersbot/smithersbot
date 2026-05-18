import { describe, expect, it, vi } from "vitest";

import type { MoltbotPluginApi } from "clawdbot/plugin-sdk";

import plugin from "./index.js";

describe("telegram extension", () => {
  it("registers the Telegram channel plugin", () => {
    const registerChannel = vi.fn();
    const api = {
      runtime: {},
      registerChannel,
    } as unknown as MoltbotPluginApi;

    plugin.register(api);

    expect(plugin.id).toBe("telegram");
    expect(registerChannel).toHaveBeenCalledWith({
      plugin: expect.objectContaining({ id: "telegram" }),
    });
  });
});
