import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    mkdtempSync: vi.fn(),
    readFileSync: vi.fn(),
    rmSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DEFAULT_MERMAID_RENDER_TIMEOUT_MS, renderMermaidToPng } from "./mermaid-png.js";

const execFileSyncMock = execFileSync as unknown as vi.Mock;
const mkdtempSyncMock = mkdtempSync as unknown as vi.Mock;
const readFileSyncMock = readFileSync as unknown as vi.Mock;
const rmSyncMock = rmSync as unknown as vi.Mock;
const writeFileSyncMock = writeFileSync as unknown as vi.Mock;

describe("renderMermaidToPng", () => {
  const originalRenderTimeoutEnv = process.env.MOLTBOT_MERMAID_RENDER_TIMEOUT_MS;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MOLTBOT_MERMAID_RENDER_TIMEOUT_MS = "";
    mkdtempSyncMock.mockReturnValue("/tmp/mermaid-png-test");
    readFileSyncMock.mockReturnValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    execFileSyncMock.mockReturnValue(Buffer.alloc(0));
  });

  afterEach(() => {
    process.env.MOLTBOT_MERMAID_RENDER_TIMEOUT_MS = originalRenderTimeoutEnv;
  });

  it("uses a 10 minute default mmdc timeout", () => {
    expect(DEFAULT_MERMAID_RENDER_TIMEOUT_MS).toBe(600_000);
  });

  it("returns a buffer result on render success", () => {
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    readFileSyncMock.mockReturnValueOnce(pngBuffer);

    const result = renderMermaidToPng("graph TD\n  A --> B");

    expect(result).toEqual({ buffer: pngBuffer });
    expect(execFileSyncMock).toHaveBeenCalledOnce();
    expect(writeFileSyncMock).toHaveBeenCalledTimes(2);
    expect(rmSyncMock).toHaveBeenCalledOnce();
  });

  it("returns an error payload for non-timeout mmdc failures", () => {
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error("Parse error on line 1");
    });

    const result = renderMermaidToPng("graph TD\n  invalid mermaid");

    expect(result).toEqual({ error: expect.stringContaining("Parse error on line 1") });
    expect(rmSyncMock).toHaveBeenCalledOnce();
  });

  it("returns null for timeout-like failures", () => {
    execFileSyncMock.mockImplementationOnce(() => {
      const timeoutError = new Error("Command timed out");
      // @ts-expect-error test shape for child_process timeout errors
      timeoutError.signal = "SIGTERM";
      throw timeoutError;
    });

    const result = renderMermaidToPng("graph TD\n  A --> B");

    expect(result).toBeNull();
    expect(rmSyncMock).toHaveBeenCalledOnce();
  });
});
