import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDefaultSastCommand,
  classifyBuildGateFailure,
  resolveChangedFilesSinceCheckpoint,
} from "./build-gate.js";

const mockSpawnSync = vi.fn();
const mockExecFileSync = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  };
});

describe("buildDefaultSastCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null while default semgrep SAST is disabled", () => {
    const command = buildDefaultSastCommand({ workingDir: "/tmp/moltbot" });
    expect(command).toBeNull();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("returns null even when semgrep is available", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "/usr/local/bin/semgrep\n",
      stderr: "",
    });

    const command = buildDefaultSastCommand({ workingDir: "/tmp/moltbot" });
    expect(command).toBeNull();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("returns null when target paths are provided", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "/usr/local/bin/semgrep\n",
      stderr: "",
    });

    const command = buildDefaultSastCommand({
      workingDir: "/tmp/moltbot",
      targetPaths: ["src/a.ts", "ui/path with space.ts"],
    });
    expect(command).toBeNull();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("returns null when targetPaths is explicitly empty", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "/usr/local/bin/semgrep\n",
      stderr: "",
    });

    const command = buildDefaultSastCommand({
      workingDir: "/tmp/moltbot",
      targetPaths: [],
    });
    expect(command).toBeNull();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });
});

describe("resolveChangedFilesSinceCheckpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no base SHA is provided", () => {
    const changed = resolveChangedFilesSinceCheckpoint({
      workingDir: "/tmp/moltbot",
    });
    expect(changed).toBeNull();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("returns sorted unique tracked and untracked changed files", () => {
    mockExecFileSync
      .mockReturnValueOnce("src/z.ts\nsrc/a.ts\n")
      .mockReturnValueOnce("src/a.ts\nui/new.ts\n");

    const changed = resolveChangedFilesSinceCheckpoint({
      workingDir: "/tmp/moltbot",
      baseSha: "base-sha-1",
    });

    expect(changed).toEqual(["src/a.ts", "src/z.ts", "ui/new.ts"]);
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      1,
      "git",
      ["-C", "/tmp/moltbot", "diff", "--name-only", "--diff-filter=ACMRTUXB", "base-sha-1"],
      expect.objectContaining({ encoding: "utf8" }),
    );
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      2,
      "git",
      ["-C", "/tmp/moltbot", "ls-files", "--others", "--exclude-standard"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it("returns null when git commands fail", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("git failed");
    });

    const changed = resolveChangedFilesSinceCheckpoint({
      workingDir: "/tmp/moltbot",
      baseSha: "base-sha-1",
    });
    expect(changed).toBeNull();
  });
});

describe("classifyBuildGateFailure", () => {
  it("classifies semgrep infrastructure failures separately", () => {
    const kind = classifyBuildGateFailure(
      "semgrep scan --config auto --error .",
      "Build gate command failed to execute: spawnSync bash ETIMEDOUT",
    );
    expect(kind).toBe("infra_failed");
  });

  it("keeps semgrep code findings as command failures", () => {
    const kind = classifyBuildGateFailure(
      "semgrep scan --config auto --error .",
      "src/foo.ts\n❯❱ javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp",
    );
    expect(kind).toBe("command_failed");
  });

  it("keeps non-semgrep failures as command failures", () => {
    const kind = classifyBuildGateFailure("pnpm build", "TS2307: Cannot find module");
    expect(kind).toBe("command_failed");
  });
});
