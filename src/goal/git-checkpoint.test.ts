import { execSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  autosaveIfDirty,
  canRunGit,
  ensureWorkingDir,
  ensureRunBranch,
  finalizeTaskCheckpoint,
  isGitRepo,
  isWorkingTreeClean,
  startTaskCheckpoint,
} from "./git-checkpoint.js";

function initRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "git-checkpoint-"));
  execSync("git init", { cwd: dir });
  execSync("git config user.email test@test.com", { cwd: dir });
  execSync("git config user.name Test", { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# Test\n");
  execSync("git add . && git commit -m init", { cwd: dir });
  return dir;
}

function initSubmoduleRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "git-checkpoint-submodule-"));
  execSync("git init", { cwd: dir });
  execSync("git config user.email test@test.com", { cwd: dir });
  execSync("git config user.name Test", { cwd: dir });
  fs.writeFileSync(path.join(dir, "SUBMODULE.md"), "submodule\n");
  execSync("git add . && git commit -m init", { cwd: dir });
  return dir;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function tracked(dir: string): string {
  dirs.push(dir);
  return dir;
}

const shouldRunGit = process.env.MOLTBOT_TEST_GIT === "1" && canRunGit();
const describeGit = shouldRunGit ? describe : describe.skip;

describeGit("git-checkpoint", () => {
  it("ensureRunBranch creates run branch", () => {
    const dir = tracked(initRepo());
    const result = ensureRunBranch(dir, "run1");
    expect(result.success).toBe(true);
    const branch = execSync("git branch --show-current", {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    expect(branch).toBe("claw/run/run1");
  });

  it("autosaveIfDirty commits when dirty", () => {
    const dir = tracked(initRepo());
    fs.writeFileSync(path.join(dir, "untracked.txt"), "dirty\n");
    const result = autosaveIfDirty(dir, "claw: autosave before goal run1");
    expect(result.success).toBe(true);
    expect(result.success && result.sha).toHaveLength(40);
    expect(isWorkingTreeClean(dir)).toBe(true);
  });

  it("startTaskCheckpoint records baseSha and beforeCommit when dirty", () => {
    const dir = tracked(initRepo());
    fs.writeFileSync(path.join(dir, "file.txt"), "data\n");
    const result = startTaskCheckpoint(dir, "step1");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.checkpoint.baseSha).toHaveLength(40);
      expect(result.checkpoint.beforeCommit).toHaveLength(40);
    }
  });

  it("finalizeTaskCheckpoint commits changes", () => {
    const dir = tracked(initRepo());
    const checkpoint = startTaskCheckpoint(dir, "step1");
    expect(checkpoint.success).toBe(true);

    fs.writeFileSync(path.join(dir, "after.txt"), "after\n");
    const result = finalizeTaskCheckpoint(dir, "step1", "Done");
    expect(result.success).toBe(true);
    expect(result.success && result.sha).toHaveLength(40);
  });

  it("isGitRepo returns true for a git repo", () => {
    expect(isGitRepo(tracked(initRepo()))).toBe(true);
  });

  it("ensureWorkingDir initializes a new git workspace with a valid HEAD commit", () => {
    const parent = tracked(mkdtempSync(path.join(tmpdir(), "git-workingdir-parent-")));
    const workingDir = path.join(parent, "workspace");

    ensureWorkingDir(workingDir);

    expect(fs.existsSync(workingDir)).toBe(true);
    expect(isGitRepo(workingDir)).toBe(true);
    expect(fs.existsSync(path.join(workingDir, ".gitkeep"))).toBe(true);

    const head = execSync("git rev-parse HEAD", {
      cwd: workingDir,
      encoding: "utf8",
    }).trim();
    expect(head).toHaveLength(40);
  });

  it("autosaveIfDirty does not fail when only submodule content is dirty", () => {
    const dir = tracked(initRepo());
    const submoduleDir = tracked(initSubmoduleRepo());

    execSync(`git -c protocol.file.allow=always submodule add ${submoduleDir} marketingskills`, {
      cwd: dir,
    });
    execSync("git commit -m add-submodule", { cwd: dir });

    fs.writeFileSync(path.join(dir, "marketingskills", "SUBMODULE.md"), "dirty-submodule\n");

    expect(isWorkingTreeClean(dir)).toBe(false);
    const result = autosaveIfDirty(dir, "claw: autosave before goal run-submodule");
    expect(result.success).toBe(true);
  });
});
