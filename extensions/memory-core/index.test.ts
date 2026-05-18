import { describe, expect, it, vi } from "vitest";

import type { MoltbotPluginApi } from "smithersbot/plugin-sdk";

import plugin from "./index.js";

describe("memory-core extension", () => {
  it("registers memory tools and CLI", () => {
    const registerTool = vi.fn();
    const registerCli = vi.fn();
    const api = {
      runtime: { tools: {} },
      registerTool,
      registerCli,
    } as unknown as MoltbotPluginApi;

    plugin.register(api);

    expect(plugin.id).toBe("memory-core");
    expect(registerTool).toHaveBeenCalledWith(expect.any(Function), {
      names: ["memory_search", "memory_get"],
    });
    expect(registerCli).toHaveBeenCalledWith(expect.any(Function), { commands: ["memory"] });
  });
});
