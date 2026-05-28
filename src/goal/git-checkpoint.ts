import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { TaskCheckpoint } from "./types.js";
import { isRepoPrivate, parseGitHubRemote } from "./git-privacy.js";

export type GitResult = { success: true; sha: string } | { success: false; error: string };
export type GitCommitResult = { success: true; sha?: string } | { success: false; error: string };

const RUN_BRANCH_PREFIX = "smithersbot";
const LEGACY_RUN_BRANCH_PREFIX = "claw/run";

const INITIAL_WORKING_DIR_GITIGNORE = `venv/
.venv/
node_modules/
__pycache__/
.pytest_cache/
.tox/
.mypy_cache/
.env
.env.*
`;

function describeGitError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr = (error as { stderr?: Buffer | string }).stderr;
  const stdout = (error as { stdout?: Buffer | string }).stdout;
  const stdoutText =
    typeof stdout === "string" ? stdout : stdout instanceof Buffer ? stdout.toString("utf8") : "";
  const stderrText =
    typeof stderr === "string" ? stderr : stderr instanceof Buffer ? stderr.toString("utf8") : "";
  if (stderrText || stdoutText) {
    return [error.message, stdoutText, stderrText]
      .filter((part) => part != null && part.trim() !== "")
      .join("\n");
  }
  return error.message;
}

/**
 * Dirty git state can come solely from modified submodule working trees.
 * In that case `git add -A` stages nothing in the parent repo and commit exits 1
 * with "no changes added to commit"/"nothing to commit". Treat this as non-fatal.
 */
function isNoStagedChangesCommitError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("no changes added to commit") || normalized.includes("nothing to commit")
  );
}

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

function hasHeadCommit(cwd: string): boolean {
  try {
    execFileSync("git", ["-C", cwd, "rev-parse", "--verify", "HEAD"], {
      encoding: "utf8",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

function formatUtcBranchTimestamp(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}Z`;
}

function resolveBranchTimestamp(createdAt?: string): Date {
  if (!createdAt) return new Date();
  const parsed = new Date(createdAt);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function formatRunBranchName(prefix: string, timestamp: string, runId: string): string {
  return `${prefix}/${timestamp}-${runId}`;
}

function buildRunBranchNameWithPrefix(prefix: string, runId: string, createdAt?: string): string {
  const timestamp = formatUtcBranchTimestamp(resolveBranchTimestamp(createdAt));
  return formatRunBranchName(prefix, timestamp, runId);
}

export function buildRunBranchName(runId: string, createdAt?: string): string {
  return buildRunBranchNameWithPrefix(RUN_BRANCH_PREFIX, runId, createdAt);
}

export function buildLegacyRunBranchName(runId: string, createdAt?: string): string {
  return buildRunBranchNameWithPrefix(LEGACY_RUN_BRANCH_PREFIX, runId, createdAt);
}

export function buildGitHubBranchUrl(remoteUrl: string, branchName: string): string | null {
  const parsed = parseGitHubRemote(remoteUrl.trim());
  const branch = branchName.trim();
  if (!parsed || !branch) return null;

  const branchPath = branch.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${parsed.owner}/${parsed.repo}/tree/${branchPath}`;
}

export function resolveRunBranchNameForResume(
  cwd: string,
  runId: string,
  createdAt?: string,
): string {
  const timestamp = formatUtcBranchTimestamp(resolveBranchTimestamp(createdAt));
  const legacyBranchName = formatRunBranchName(LEGACY_RUN_BRANCH_PREFIX, timestamp, runId);
  try {
    execFileSync(
      "git",
      ["-C", cwd, "show-ref", "--verify", "--quiet", `refs/heads/${legacyBranchName}`],
      {
        stdio: "ignore",
        timeout: 5000,
      },
    );
    return legacyBranchName;
  } catch {
    return formatRunBranchName(RUN_BRANCH_PREFIX, timestamp, runId);
  }
}

export function ensureWorkingDir(cwd: string): void {
  fs.mkdirSync(cwd, { recursive: true });
  if (!canRunGit()) return;

  if (!isGitRepo(cwd)) {
    execFileSync("git", ["-C", cwd, "init"], {
      encoding: "utf8",
      timeout: 10000,
    });
  }

  // `git checkout -B` and `git rev-parse HEAD` require HEAD to exist.
  if (hasHeadCommit(cwd)) return;

  const gitkeepPath = path.join(cwd, ".gitkeep");
  if (!fs.existsSync(gitkeepPath)) {
    fs.writeFileSync(gitkeepPath, "");
  }
  const gitignorePath = path.join(cwd, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, INITIAL_WORKING_DIR_GITIGNORE);
  }
  execFileSync("git", ["-C", cwd, "add", ".gitkeep", ".gitignore"], {
    encoding: "utf8",
    timeout: 10000,
  });
  try {
    execFileSync(
      "git",
      [
        "-C",
        cwd,
        "-c",
        "user.name=Moltbot",
        "-c",
        "user.email=moltbot@localhost",
        "commit",
        "-m",
        "chore: initialize workspace",
      ],
      {
        encoding: "utf8",
        timeout: 10000,
      },
    );
  } catch (error) {
    if (hasHeadCommit(cwd)) return;
    const errorText = describeGitError(error);
    throw new Error(`Failed to create initial commit for working directory ${cwd}: ${errorText}`);
  }
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

export function ensureRunBranch(
  cwd: string,
  runId: string,
  runBranchName = buildRunBranchName(runId),
): GitResult {
  if (!canRunGit()) return { success: false, error: "git not available" };
  if (!isGitRepo(cwd)) return { success: false, error: "Not a git repo" };
  try {
    execFileSync("git", ["-C", cwd, "checkout", "-B", runBranchName], {
      encoding: "utf8",
      timeout: 10000,
    });
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
  return getHeadSha(cwd);
}

export function pushRunBranch(
  cwd: string,
  runId: string,
  remote = "origin",
  runBranchName = buildRunBranchName(runId),
): GitResult {
  if (!canRunGit()) return { success: false, error: "git not available" };
  if (!isGitRepo(cwd)) return { success: false, error: "Not a git repo" };

  try {
    if (!isRepoPrivate(cwd)) {
      return { success: false, error: "Repository is not private; refusing to push run branch" };
    }
  } catch (e) {
    return { success: false, error: `Failed to verify repo privacy: ${describeGitError(e)}` };
  }

  try {
    execFileSync("git", ["-C", cwd, "push", "-u", remote, runBranchName], {
      encoding: "utf8",
      timeout: 60_000,
    });
  } catch (e) {
    return { success: false, error: describeGitError(e) };
  }

  return getHeadSha(cwd);
}

export function autosaveIfDirty(cwd: string, message: string): GitCommitResult {
  if (!canRunGit()) return { success: false, error: "git not available" };
  if (!isGitRepo(cwd)) return { success: false, error: "Not a git repo" };
  if (isWorkingTreeClean(cwd)) return { success: true };
  return commitAll(cwd, message);
}

export function startTaskCheckpoint(
  cwd: string,
  taskId: string,
): { success: true; checkpoint: TaskCheckpoint } | { success: false; error: string } {
  const before = autosaveIfDirty(cwd, `claw: autosave before ${taskId}`);
  if (!before.success) return before;

  const head = getHeadSha(cwd);
  if (!head.success) return head;

  const checkpoint: TaskCheckpoint = { baseSha: head.sha };
  if (before.sha) checkpoint.beforeCommit = before.sha;
  return { success: true, checkpoint };
}

export function finalizeTaskCheckpoint(
  cwd: string,
  taskId: string,
  summary?: string,
): GitCommitResult {
  if (!canRunGit()) return { success: false, error: "git not available" };
  if (!isGitRepo(cwd)) return { success: false, error: "Not a git repo" };
  if (isWorkingTreeClean(cwd)) return { success: true };

  const message = buildTaskCommitMessage(taskId, summary);
  return commitAll(cwd, message);
}

function buildTaskCommitMessage(taskId: string, summary?: string): string {
  const trimmed = summary?.split("\n")[0]?.trim();
  const suffix = trimmed ? ` - ${trimmed.slice(0, 72)}` : "";
  return `claw: ${taskId}${suffix}`;
}

function isTimeoutError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined;
  if (code === "ETIMEDOUT") return true;
  return describeGitError(error).includes("ETIMEDOUT");
}

function commitAll(cwd: string, message: string): GitCommitResult {
  try {
    try {
      execFileSync("git", ["-C", cwd, "add", "-A"], { encoding: "utf8", timeout: 60000 });
    } catch (addError) {
      if (!isTimeoutError(addError)) throw addError;
      execFileSync("git", ["-C", cwd, "add", "-u"], { encoding: "utf8", timeout: 60000 });
    }
    execFileSync("git", ["-C", cwd, "commit", "-m", message], {
      encoding: "utf8",
      timeout: 60000,
    });
    const sha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    return { success: true, sha };
  } catch (e) {
    const errorText = describeGitError(e);
    if (isNoStagedChangesCommitError(errorText)) {
      return { success: true };
    }
    return { success: false, error: errorText };
  }
}
