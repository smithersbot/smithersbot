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

describe("git-checkpoint push/pr", () => {
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

    const { pushRunBranch } = await import("./git-checkpoint.js");
    const result = pushRunBranch(dir, runId);

    expect(result).toEqual({ success: true, sha });
    const pushCall = mockExecFileSync.mock.calls.find(
      (call) => call[0] === "git" && argvFrom(call[1])[2] === "push",
    );
    expect(pushCall).toBeTruthy();
    expect(pushCall?.[1]).toEqual(["-C", dir, "push", "-u", "origin", `claw/run/${runId}`]);
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

  it("createRunPullRequest returns the created PR URL", async () => {
    const dir = makeRepoDir();
    dirs.push(dir);

    mockExecFileSync.mockImplementation((command: unknown, args: unknown) => {
      const argv = argvFrom(args);
      if (command !== "gh") throw new Error(`Unexpected command: ${String(command)}`);
      if (argv[0] === "pr" && argv[1] === "create") {
        return "https://github.com/owner/repo/pull/42\n";
      }
      throw new Error(`Unexpected args for ${String(command)}: ${argv.join(" ")}`);
    });

    const { createRunPullRequest } = await import("./git-checkpoint.js");
    const result = createRunPullRequest(dir, "run-42", "Ship it", "main");

    expect(result).toEqual({ ok: true, prUrl: "https://github.com/owner/repo/pull/42" });

    const createCall = mockExecFileSync.mock.calls.find(
      (call) =>
        call[0] === "gh" && argvFrom(call[1])[0] === "pr" && argvFrom(call[1])[1] === "create",
    );
    expect(createCall).toBeTruthy();
    expect(createCall?.[1]).toContain("Ship it");
    expect(createCall?.[1]).toContain("claw/run/run-42");
  });

  it("createRunPullRequest returns an error when gh pr create fails", async () => {
    const dir = makeRepoDir();
    dirs.push(dir);

    mockExecFileSync.mockImplementation((command: unknown, args: unknown) => {
      const argv = argvFrom(args);
      if (command !== "gh") throw new Error(`Unexpected command: ${String(command)}`);
      if (argv[0] === "pr" && argv[1] === "create") {
        const error = new Error("Command failed") as Error & { stderr?: string };
        error.stderr = "no commits between main and branch";
        throw error;
      }
      throw new Error(`Unexpected args for ${String(command)}: ${argv.join(" ")}`);
    });

    const { createRunPullRequest } = await import("./git-checkpoint.js");
    const result = createRunPullRequest(dir, "run-empty", "No changes", "main");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("no commits between main and branch");
    }
  });
});
