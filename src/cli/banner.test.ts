import { beforeEach, describe, expect, it, vi } from "vitest";

describe("emitCliBanner", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function callBannerWithArgv(argv: string[]): Promise<boolean> {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const origIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      const { emitCliBanner } = await import("./banner.js");
      emitCliBanner("1.0.0", { argv });
      return writeSpy.mock.calls.length > 0;
    } finally {
      writeSpy.mockRestore();
      Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, configurable: true });
    }
  }

  it("suppresses banner when --json is present", async () => {
    const emitted = await callBannerWithArgv(["node", "moltbot", "--json"]);
    expect(emitted).toBe(false);
  });

  it("suppresses banner when --output json is present", async () => {
    const emitted = await callBannerWithArgv([
      "node",
      "moltbot",
      "goal",
      "list",
      "--output",
      "json",
    ]);
    expect(emitted).toBe(false);
  });

  it("suppresses banner when --output=json is present", async () => {
    const emitted = await callBannerWithArgv([
      "node",
      "moltbot",
      "goal",
      "status",
      "--output=json",
    ]);
    expect(emitted).toBe(false);
  });
});
