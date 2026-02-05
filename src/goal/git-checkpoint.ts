import { execFileSync } from "node:child_process";

export type GitCheckpoint = { sha: string; branch: string; taskId: string; createdAt: string };
export type GitResult = { success: true; sha: string } | { success: false; error: string };

export function isGitRepo(cwd: string): boolean {
  try {
    execFileSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

export function isWorkingTreeClean(cwd: string): boolean {
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

export function resetToCheckpoint(cwd: string, checkpoint: GitCheckpoint): GitResult {
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
