import { execSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCheckpoint,
  getHeadSha,
  isGitRepo,
  isWorkingTreeClean,
  resetToCheckpoint,
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

describe("git-checkpoint", () => {
  describe("isGitRepo", () => {
    it("returns true for a git repo", () => {
      expect(isGitRepo(tracked(initRepo()))).toBe(true);
    });

    it("returns false for a non-git directory", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "git-checkpoint-no-git-"));
      expect(isGitRepo(tracked(dir))).toBe(false);
    });

    it("returns false for a non-existent path", () => {
      expect(isGitRepo("/tmp/nonexistent-git-test-" + Date.now())).toBe(false);
    });
  });

  describe("isWorkingTreeClean", () => {
    it("returns true for a clean repo", () => {
      expect(isWorkingTreeClean(tracked(initRepo()))).toBe(true);
    });

    it("returns false when untracked files exist", () => {
      const dir = tracked(initRepo());
      fs.writeFileSync(path.join(dir, "untracked.txt"), "dirty\n");
      expect(isWorkingTreeClean(dir)).toBe(false);
    });

    it("returns false when tracked files are modified", () => {
      const dir = tracked(initRepo());
      fs.writeFileSync(path.join(dir, "README.md"), "modified\n");
      expect(isWorkingTreeClean(dir)).toBe(false);
    });
  });

  describe("getHeadSha", () => {
    it("returns a 40-char sha", () => {
      const dir = tracked(initRepo());
      const result = getHeadSha(dir);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.sha).toHaveLength(40);
        expect(result.sha).toMatch(/^[a-f0-9]{40}$/);
      }
    });

    it("fails for non-git directory", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "git-checkpoint-no-head-"));
      const result = getHeadSha(tracked(dir));
      expect(result.success).toBe(false);
    });
  });

  describe("createCheckpoint", () => {
    it("creates a branch and returns checkpoint info", () => {
      const dir = tracked(initRepo());
      const checkpoint = createCheckpoint(dir, "run1", "step1");
      expect(checkpoint).not.toBeNull();
      expect(checkpoint!.branch).toBe("claw/run1/step1");
      expect(checkpoint!.sha).toHaveLength(40);
      expect(checkpoint!.taskId).toBe("step1");

      // Verify branch was created
      const branch = execSync("git branch --show-current", {
        cwd: dir,
        encoding: "utf8",
      }).trim();
      expect(branch).toBe("claw/run1/step1");
    });

    it("returns null for non-git directory", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "git-checkpoint-no-repo-"));
      expect(createCheckpoint(tracked(dir), "run1", "step1")).toBeNull();
    });
  });

  describe("resetToCheckpoint", () => {
    it("resets files back to checkpoint state", () => {
      const dir = tracked(initRepo());
      const checkpoint = createCheckpoint(dir, "run1", "step1")!;

      // Make changes after checkpoint
      fs.writeFileSync(path.join(dir, "new-file.txt"), "new content\n");
      execSync("git add . && git commit -m 'add file'", { cwd: dir });
      expect(fs.existsSync(path.join(dir, "new-file.txt"))).toBe(true);

      // Reset
      const result = resetToCheckpoint(dir, checkpoint);
      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(dir, "new-file.txt"))).toBe(false);
    });

    it("cleans untracked files", () => {
      const dir = tracked(initRepo());
      const checkpoint = createCheckpoint(dir, "run1", "step1")!;

      // Add an untracked file (not committed)
      fs.writeFileSync(path.join(dir, "untracked.txt"), "junk\n");

      const result = resetToCheckpoint(dir, checkpoint);
      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(dir, "untracked.txt"))).toBe(false);
    });

    it("fails for non-git directory", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "git-checkpoint-no-reset-"));
      const result = resetToCheckpoint(tracked(dir), {
        sha: "abc123",
        branch: "",
        taskId: "step1",
        createdAt: new Date().toISOString(),
      });
      expect(result.success).toBe(false);
    });
  });
});
