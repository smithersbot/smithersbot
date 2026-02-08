import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type GitCheckpoint = { sha: string; branch: string; taskId: string; createdAt: string };
export type GitResult = { success: true; sha: string } | { success: false; error: string };

export function canRunGit(): boolean {
  try {
    execFileSync("git", ["--version"], { encoding: "utf8", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function findGitRoot(cwd: string): string | null {
  let current: string;
  try {
    current = path.resolve(cwd);
  } catch {
    return null;
  }

  while (true) {
    const gitPath = path.join(current, ".git");
    if (fs.existsSync(gitPath)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function isGitRepo(cwd: string): boolean {
  return Boolean(findGitRoot(cwd));
}

export function isWorkingTreeClean(cwd: string): boolean {
  if (!canRunGit()) return true;
  try {
    const status = execFileSync("git", ["-C", cwd, "status", "--porcelain"], {
      encoding: "utf8",
      timeout: 5000,
    });
    return status.trim() === "";
  } catch {
    return false;
  }
}

export function getHeadSha(cwd: string): GitResult {
  if (!canRunGit()) return { success: false, error: "git not available" };
  try {
    const sha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    return { success: true, sha };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Create a task branch and capture a checkpoint. Returns null on non-git or error. */
export function createCheckpoint(cwd: string, runId: string, taskId: string): GitCheckpoint | null {
  if (!canRunGit()) return null;
  if (!isGitRepo(cwd)) return null;
  const headResult = getHeadSha(cwd);
  if (!headResult.success) return null;

  const branchName = `claw/${runId}/${taskId}`;
  try {
    execFileSync("git", ["-C", cwd, "checkout", "-B", branchName], {
      encoding: "utf8",
      timeout: 10000,
    });
  } catch {
    // Branch creation failed; proceed without branch isolation
    return { sha: headResult.sha, branch: "", taskId, createdAt: new Date().toISOString() };
  }

  return { sha: headResult.sha, branch: branchName, taskId, createdAt: new Date().toISOString() };
}

/** Auto-commit orphaned changes left by a crashed worker so the tree is clean for the next step. */
export function commitOrphanedChanges(cwd: string, runId: string): GitResult {
  if (!canRunGit()) return { success: false, error: "git not available" };
  if (!isGitRepo(cwd)) return { success: false, error: "Not a git repo" };
  if (isWorkingTreeClean(cwd)) return { success: false, error: "Tree already clean" };
  try {
    execFileSync("git", ["-C", cwd, "add", "-A"], { encoding: "utf8", timeout: 10000 });
    execFileSync(
      "git",
      [
        "-C",
        cwd,
        "commit",
        "-m",
        `checkpoint: orphaned changes from crashed run ${runId.slice(0, 8)}`,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    const sha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    return { success: true, sha };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function resetToCheckpoint(cwd: string, checkpoint: GitCheckpoint): GitResult {
  if (!canRunGit()) return { success: false, error: "git not available" };
  if (!isGitRepo(cwd)) return { success: false, error: "Not a git repo" };
  try {
    execFileSync("git", ["-C", cwd, "reset", "--hard", checkpoint.sha], {
      encoding: "utf8",
      timeout: 30000,
    });
    execFileSync("git", ["-C", cwd, "clean", "-fd"], {
      encoding: "utf8",
      timeout: 30000,
    });
    return { success: true, sha: checkpoint.sha };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}
