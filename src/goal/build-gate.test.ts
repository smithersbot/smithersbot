import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDefaultSastCommand } from "./build-gate.js";

const mockSpawnSync = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
  };
});

describe("buildDefaultSastCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when semgrep is unavailable", () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "",
    });

    const command = buildDefaultSastCommand("/tmp/moltbot");
    expect(command).toBeNull();
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "which",
      ["semgrep"],
      expect.objectContaining({
        encoding: "utf8",
      }),
    );
  });

  it("returns the semgrep command when semgrep is available", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "/usr/local/bin/semgrep\n",
      stderr: "",
    });

    const command = buildDefaultSastCommand("/tmp/moltbot");
    expect(command).toBe("semgrep scan --config auto --error --quiet --timeout 30 /tmp/moltbot");
  });
});
