import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

function makeRepoDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-checkpoint-push-"));
  fs.mkdirSync(path.join(dir, ".git"));
  return dir;
}

function argvFrom(args: unknown): string[] {
  return Array.isArray(args) ? (args as string[]) : [];
}

describe("git-checkpoint push/review URLs", () => {
  const dirs: string[] = [];

  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  afterEach(() => {
    for (const dir of dirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it("pushRunBranch pushes run branch when repo is private", async () => {
    const dir = makeRepoDir();
    dirs.push(dir);
    const runId = "run-123";
    const runCreatedAt = "2026-02-25T15:04:05.999Z";
    const sha = "1234567890123456789012345678901234567890";

    mockExecFileSync.mockImplementation((command: unknown, args: unknown) => {
      const argv = argvFrom(args);
      if (command !== "git" && command !== "gh") {
        throw new Error(`Unexpected command: ${String(command)}`);
      }
      if (command === "git" && argv[0] === "--version") return "git version 2.45.0";
      if (command === "git" && argv[2] === "remote" && argv[3] === "get-url") {
        return "git@github.com:owner/repo.git\n";
      }
      if (command === "gh" && argv[0] === "api") return "true\n";
      if (command === "git" && argv[2] === "push") return "";
      if (command === "git" && argv[2] === "rev-parse") return `${sha}\n`;
      throw new Error(`Unexpected args for ${String(command)}: ${argv.join(" ")}`);
    });

    const { buildRunBranchName, pushRunBranch } = await import("./git-checkpoint.js");
    const runBranchName = buildRunBranchName(runId, runCreatedAt);
    const result = pushRunBranch(dir, runId, "origin", runBranchName);

    expect(result).toEqual({ success: true, sha });
    const pushCall = mockExecFileSync.mock.calls.find(
      (call) => call[0] === "git" && argvFrom(call[1])[2] === "push",
    );
    expect(pushCall).toBeTruthy();
    expect(pushCall?.[1]).toEqual(["-C", dir, "push", "-u", "origin", runBranchName]);
  });

  it("pushRunBranch fails closed when repo is not private", async () => {
    const dir = makeRepoDir();
    dirs.push(dir);

    mockExecFileSync.mockImplementation((command: unknown, args: unknown) => {
      const argv = argvFrom(args);
      if (command !== "git" && command !== "gh") {
        throw new Error(`Unexpected command: ${String(command)}`);
      }
      if (command === "git" && argv[0] === "--version") return "git version 2.45.0";
      if (command === "git" && argv[2] === "remote" && argv[3] === "get-url") {
        return "git@github.com:owner/repo.git\n";
      }
      if (command === "gh" && argv[0] === "api") return "false\n";
      throw new Error(`Unexpected args for ${String(command)}: ${argv.join(" ")}`);
    });

    const { pushRunBranch } = await import("./git-checkpoint.js");
    const result = pushRunBranch(dir, "run-public");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not private");
    }

    const pushCall = mockExecFileSync.mock.calls.find(
      (call) => call[0] === "git" && argvFrom(call[1])[2] === "push",
    );
    expect(pushCall).toBeUndefined();
  });

  it.each([
    ["https://github.com/owner/repo.git"],
    ["https://github.com/owner/repo"],
    ["git@github.com:owner/repo.git"],
  ])("buildGitHubBranchUrl converts %s to a tree URL", async (remoteUrl) => {
    const { buildGitHubBranchUrl, buildRunBranchName } = await import("./git-checkpoint.js");
    const branch = buildRunBranchName("run-42", "2026-02-25T15:04:05.999Z");

    expect(buildGitHubBranchUrl(remoteUrl, branch)).toBe(
      "https://github.com/owner/repo/tree/smithersbot/20260225-150405Z-run-42",
    );
  });

  it("buildGitHubBranchUrl returns null for non-GitHub remotes", async () => {
    const { buildGitHubBranchUrl } = await import("./git-checkpoint.js");

    expect(buildGitHubBranchUrl("git@example.com:owner/repo.git", "smithersbot/run-42")).toBeNull();
  });
});
