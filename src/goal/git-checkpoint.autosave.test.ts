import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

function makeRepoDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-checkpoint-autosave-"));
  fs.mkdirSync(path.join(dir, ".git"));
  return dir;
}

describe("git-checkpoint autosave", () => {
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

  it("treats no-stageable-change commit errors as success (stdout-only)", async () => {
    const dir = makeRepoDir();
    dirs.push(dir);

    mockExecFileSync.mockImplementation((command: unknown, args: unknown) => {
      if (command !== "git") throw new Error(`Unexpected command: ${String(command)}`);
      const argv = Array.isArray(args) ? (args as string[]) : [];
      if (argv[0] === "--version") return "git version 2.34.1";
      if (argv[2] === "status") return " M marketingskills\n";
      if (argv[2] === "add") return "";
      if (argv[2] === "commit") {
        const err = new Error("Command failed") as Error & { stdout?: string };
        err.stdout = "no changes added to commit";
        throw err;
      }
      throw new Error(`Unexpected git args: ${argv.join(" ")}`);
    });

    const { autosaveIfDirty } = await import("./git-checkpoint.js");
    const result = autosaveIfDirty(dir, "claw: autosave");

    expect(result).toEqual({ success: true });
  });

  it("preserves real commit failures", async () => {
    const dir = makeRepoDir();
    dirs.push(dir);

    mockExecFileSync.mockImplementation((command: unknown, args: unknown) => {
      if (command !== "git") throw new Error(`Unexpected command: ${String(command)}`);
      const argv = Array.isArray(args) ? (args as string[]) : [];
      if (argv[0] === "--version") return "git version 2.34.1";
      if (argv[2] === "status") return " M README.md\n";
      if (argv[2] === "add") return "";
      if (argv[2] === "commit") {
        const err = new Error("Command failed") as Error & { stderr?: string };
        err.stderr = "fatal: unable to auto-detect email address";
        throw err;
      }
      throw new Error(`Unexpected git args: ${argv.join(" ")}`);
    });

    const { autosaveIfDirty } = await import("./git-checkpoint.js");
    const result = autosaveIfDirty(dir, "claw: autosave");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("unable to auto-detect email address");
    }
  });

  it("falls back to git add -u when git add -A times out", async () => {
    const dir = makeRepoDir();
    dirs.push(dir);
    const seenGitArgs: string[][] = [];

    mockExecFileSync.mockImplementation((command: unknown, args: unknown) => {
      if (command !== "git") throw new Error(`Unexpected command: ${String(command)}`);
      const argv = Array.isArray(args) ? (args as string[]) : [];
      seenGitArgs.push(argv);
      if (argv[0] === "--version") return "git version 2.34.1";
      if (argv[2] === "status") return " M README.md\n";
      if (argv[2] === "add" && argv[3] === "-A") {
        const err = new Error("spawnSync git ETIMEDOUT") as Error & { code?: string };
        err.code = "ETIMEDOUT";
        throw err;
      }
      if (argv[2] === "add" && argv[3] === "-u") return "";
      if (argv[2] === "commit") return "";
      if (argv[2] === "rev-parse") return "1234567890123456789012345678901234567890\n";
      throw new Error(`Unexpected git args: ${argv.join(" ")}`);
    });

    const { autosaveIfDirty } = await import("./git-checkpoint.js");
    const result = autosaveIfDirty(dir, "claw: autosave");

    expect(result).toEqual({
      success: true,
      sha: "1234567890123456789012345678901234567890",
    });

    const addModes = seenGitArgs.filter((argv) => argv[2] === "add").map((argv) => argv[3]);
    expect(addModes).toEqual(["-A", "-u"]);
  });
});
