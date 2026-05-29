import { execSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  autosaveIfDirty,
  buildRunBranchName,
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

/**
 * ensureWorkingDir only auto-initializes a *fresh* (non-git) directory. Under
 * vitest, os.tmpdir() is redirected inside this repository (.tmp/vitest), so any
 * dir created there is detected as part of this repo and would never be inited.
 * Find a writable temp base where git discovery does not see a parent repo.
 * GIT_CEILING_DIRECTORIES lets Vitest's repo-local temp dir behave like an
 * isolated non-repo for git's own rev-parse checks.
 */
function gitDiscoversRepo(cwd: string): boolean {
  try {
    execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function tempBaseOutsideRepo(): string {
  const candidates = [
    process.env.RUNNER_TEMP,
    process.env.CLAUDE_CODE_TMPDIR,
    process.env.MOLTBOT_TEST_TMPDIR,
    tmpdir(),
  ].filter((base): base is string => typeof base === "string" && base.length > 0);
  for (const base of candidates) {
    try {
      const probe = mkdtempSync(path.join(base, "git-checkpoint-probe-"));
      const insideRepo = gitDiscoversRepo(probe);
      fs.rmSync(probe, { recursive: true, force: true });
      if (!insideRepo) return base;
    } catch {
      // Not writable or unusable; try the next candidate.
    }
  }
  throw new Error("could not find a writable temp base outside a git repo");
}

const dirs: string[] = [];
const repoRoot = fs.realpathSync(process.cwd());

// Safe defaults the generated .gitignore must include (extras are allowed).
const SAFE_GITIGNORE_DEFAULTS = [
  ".env",
  ".env.*",
  "!.env.example",
  "node_modules/",
  "dist/",
  "build/",
  ".tmp/",
  ".moltbot-goal-worker-results/",
];

let managedRoot: string;
let savedGoalsRoot: string | undefined;
let savedGitCeiling: string | undefined;

beforeEach(() => {
  savedGitCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = savedGitCeiling
    ? `${repoRoot}${path.delimiter}${savedGitCeiling}`
    : repoRoot;
  managedRoot = fs.realpathSync(
    mkdtempSync(path.join(tempBaseOutsideRepo(), "git-checkpoint-managed-")),
  );
  dirs.push(managedRoot);
  savedGoalsRoot = process.env.SMITHERSBOT_GOALS_ROOT;
  process.env.SMITHERSBOT_GOALS_ROOT = managedRoot;
});

afterEach(() => {
  if (savedGoalsRoot === undefined) {
    delete process.env.SMITHERSBOT_GOALS_ROOT;
  } else {
    process.env.SMITHERSBOT_GOALS_ROOT = savedGoalsRoot;
  }
  if (savedGitCeiling === undefined) {
    delete process.env.GIT_CEILING_DIRECTORIES;
  } else {
    process.env.GIT_CEILING_DIRECTORIES = savedGitCeiling;
  }
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function tracked(dir: string): string {
  dirs.push(dir);
  return dir;
}

/** Path to a workspace under the managed workspaces root (not created on disk). */
function managedWorkspace(name: string): string {
  return path.join(managedRoot, "agent", "workspaces", name);
}

const shouldRunGit = process.env.MOLTBOT_TEST_GIT === "1" && canRunGit();
const describeGit = shouldRunGit ? describe : describe.skip;

describe("git-checkpoint branch naming", () => {
  it("buildRunBranchName prefixes UTC timestamp before run id", () => {
    expect(buildRunBranchName("run1", "2026-02-25T15:04:05.999Z")).toBe(
      "smithersbot/20260225-150405Z-run1",
    );
  });
});

describeGit("git-checkpoint", () => {
  it("ensureRunBranch creates run branch", () => {
    const dir = tracked(initRepo());
    const runId = "run1";
    const runBranchName = buildRunBranchName(runId, "2026-02-25T15:04:05.999Z");
    const result = ensureRunBranch(dir, runId, runBranchName);
    expect(result.success).toBe(true);
    const branch = execSync("git branch --show-current", {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    expect(branch).toBe(runBranchName);
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
    const workingDir = managedWorkspace("init-empty");

    ensureWorkingDir(workingDir);

    expect(fs.existsSync(workingDir)).toBe(true);
    expect(isGitRepo(workingDir)).toBe(true);
    expect(fs.existsSync(path.join(workingDir, ".gitkeep"))).toBe(true);
    const gitignorePath = path.join(workingDir, ".gitignore");
    expect(fs.existsSync(gitignorePath)).toBe(true);
    // The generated .gitignore must include the conservative safe defaults, but
    // is not constrained to only those entries.
    const gitignore = fs.readFileSync(gitignorePath, "utf8");
    for (const entry of SAFE_GITIGNORE_DEFAULTS) {
      expect(gitignore.split("\n")).toContain(entry);
    }

    const head = execSync("git rev-parse HEAD", {
      cwd: workingDir,
      encoding: "utf8",
    }).trim();
    expect(head).toHaveLength(40);

    const filesInHead = execSync("git ls-tree --name-only -r HEAD", {
      cwd: workingDir,
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    expect(filesInHead).toContain(".gitkeep");
    expect(filesInHead).toContain(".gitignore");

    // Local-only: no remote configured, nothing pushed.
    const remotes = execSync("git remote -v", { cwd: workingDir, encoding: "utf8" }).trim();
    expect(remotes).toBe("");
  });

  it("auto-initializes a plain folder inside managed workspaces with a baseline commit", () => {
    const workingDir = managedWorkspace("plain-folder");
    fs.mkdirSync(workingDir, { recursive: true });
    fs.writeFileSync(path.join(workingDir, "README.md"), "# Dragged-in project\n");
    fs.mkdirSync(path.join(workingDir, "src"));
    fs.writeFileSync(path.join(workingDir, "src", "index.ts"), "export const x = 1;\n");

    ensureWorkingDir(workingDir);

    expect(isGitRepo(workingDir)).toBe(true);
    const head = execSync("git rev-parse HEAD", { cwd: workingDir, encoding: "utf8" }).trim();
    expect(head).toHaveLength(40);

    const filesInHead = execSync("git ls-tree --name-only -r HEAD", {
      cwd: workingDir,
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    // Existing content is captured in the baseline commit; .gitkeep is not added
    // because the folder already had committable content.
    expect(filesInHead).toContain("README.md");
    expect(filesInHead).toContain("src/index.ts");
    expect(filesInHead).toContain(".gitignore");
    expect(filesInHead).not.toContain(".gitkeep");
    expect(isWorkingTreeClean(workingDir)).toBe(true);

    const remotes = execSync("git remote -v", { cwd: workingDir, encoding: "utf8" }).trim();
    expect(remotes).toBe("");
  });

  it("does not overwrite an existing .gitignore when auto-initializing", () => {
    const workingDir = managedWorkspace("keep-gitignore");
    fs.mkdirSync(workingDir, { recursive: true });
    const existing = "# custom\nmy-secret-dir/\n";
    fs.writeFileSync(path.join(workingDir, ".gitignore"), existing);

    ensureWorkingDir(workingDir);

    expect(fs.readFileSync(path.join(workingDir, ".gitignore"), "utf8")).toBe(existing);
    expect(isGitRepo(workingDir)).toBe(true);
  });

  it("does not change behavior for an existing git repo", () => {
    const dir = tracked(initRepo());
    const headBefore = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    const branchBefore = execSync("git branch --show-current", {
      cwd: dir,
      encoding: "utf8",
    }).trim();

    ensureWorkingDir(dir);

    // No new commit, no .gitkeep/.gitignore injected, no remote added.
    expect(execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim()).toBe(headBefore);
    expect(execSync("git branch --show-current", { cwd: dir, encoding: "utf8" }).trim()).toBe(
      branchBefore,
    );
    expect(fs.existsSync(path.join(dir, ".gitkeep"))).toBe(false);
    expect(isWorkingTreeClean(dir)).toBe(true);
  });

  it("rejects a plain folder outside managed workspaces with an actionable message", () => {
    const outside = tracked(mkdtempSync(path.join(tempBaseOutsideRepo(), "outside-managed-")));

    expect(() => ensureWorkingDir(outside)).toThrow(/managed workspaces root/);
    expect(() => ensureWorkingDir(outside)).toThrow(/git init/);
    // Never auto-initialized outside the managed root.
    expect(fs.existsSync(path.join(outside, ".git"))).toBe(false);
    // Never surfaces the raw git error.
    try {
      ensureWorkingDir(outside);
    } catch (error) {
      expect((error as Error).message).not.toMatch(/fatal: not a git repository/);
    }
  });

  it("initializes an outside folder only when explicitly allowed (no remote)", () => {
    const outside = tracked(mkdtempSync(path.join(tempBaseOutsideRepo(), "outside-explicit-")));

    ensureWorkingDir(outside, { allowOutsideManagedRoot: true });

    expect(isGitRepo(outside)).toBe(true);
    const head = execSync("git rev-parse HEAD", { cwd: outside, encoding: "utf8" }).trim();
    expect(head).toHaveLength(40);
    const remotes = execSync("git remote -v", { cwd: outside, encoding: "utf8" }).trim();
    expect(remotes).toBe("");
  });

  // A `git` shim placed first on PATH records the exact order of git
  // invocations (and can simulate init/rev-parse failures) so these tests fail
  // if any `git add` is ever issued before `git init` + verification succeed.
  describe("git-init-before-staging ordering", () => {
    let shimDir: string;
    let logPath: string;
    let savedPath: string | undefined;
    let realGit: string;

    function gitInvocations(): string[][] {
      if (!fs.existsSync(logPath)) return [];
      return fs
        .readFileSync(logPath, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => line.split(/\s+/));
    }

    /** Index of the first invocation whose git subcommand is `name`. */
    function firstIndexOf(invocations: string[][], name: string): number {
      return invocations.findIndex((args) => args[2] === name);
    }

    beforeEach(() => {
      realGit = (() => {
        try {
          return execSync("command -v git", { encoding: "utf8" }).trim() || "git";
        } catch {
          return "git";
        }
      })();
      shimDir = tracked(mkdtempSync(path.join(tempBaseOutsideRepo(), "git-shim-")));
      logPath = path.join(shimDir, "git-invocations.log");
      const shimPath = path.join(shimDir, "git");
      fs.writeFileSync(
        shimPath,
        [
          "#!/usr/bin/env bash",
          'printf "%s\\n" "$*" >> "$MOLTBOT_GIT_LOG"',
          'if [ "$3" = "init" ] && [ -n "$MOLTBOT_GIT_FAIL_INIT" ]; then',
          '  echo "fatal: simulated init failure" >&2',
          "  exit 128",
          "fi",
          'if [ "$3" = "rev-parse" ] && [ "$4" = "--show-toplevel" ] && [ -n "$MOLTBOT_GIT_FAIL_REVPARSE" ]; then',
          '  echo "fatal: simulated rev-parse failure" >&2',
          "  exit 128",
          "fi",
          `exec "${realGit}" "$@"`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      savedPath = process.env.PATH;
      process.env.PATH = `${shimDir}${path.delimiter}${savedPath ?? ""}`;
      process.env.MOLTBOT_GIT_LOG = logPath;
    });

    afterEach(() => {
      if (savedPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = savedPath;
      }
      delete process.env.MOLTBOT_GIT_LOG;
      delete process.env.MOLTBOT_GIT_FAIL_INIT;
      delete process.env.MOLTBOT_GIT_FAIL_REVPARSE;
    });

    it("creates .git (init + rev-parse) before any git add for a plain managed folder", () => {
      const workingDir = managedWorkspace("plain-shim");
      fs.mkdirSync(workingDir, { recursive: true });
      fs.writeFileSync(path.join(workingDir, "README.md"), "# Dragged-in\n");

      ensureWorkingDir(workingDir);

      const invocations = gitInvocations();
      const idxInit = firstIndexOf(invocations, "init");
      const idxAdd = firstIndexOf(invocations, "add");
      const idxVerify = invocations.findIndex(
        (args, i) => i > idxInit && args[2] === "rev-parse" && args.includes("--show-toplevel"),
      );

      expect(idxInit).toBeGreaterThanOrEqual(0);
      expect(idxAdd).toBeGreaterThanOrEqual(0);
      // init runs first; verification rev-parse runs after init and before add.
      expect(idxAdd).toBeGreaterThan(idxInit);
      expect(idxVerify).toBeGreaterThan(idxInit);
      expect(idxAdd).toBeGreaterThan(idxVerify);

      // The real repo exists with a baseline commit and no remote.
      expect(isGitRepo(workingDir)).toBe(true);
      const head = execSync("git rev-parse HEAD", { cwd: workingDir, encoding: "utf8" }).trim();
      expect(head).toHaveLength(40);
      expect(execSync("git remote -v", { cwd: workingDir, encoding: "utf8" }).trim()).toBe("");
    });

    it("aborts with a clear non-raw error and never stages when git init fails", () => {
      const workingDir = managedWorkspace("plain-init-fail");
      fs.mkdirSync(workingDir, { recursive: true });
      process.env.MOLTBOT_GIT_FAIL_INIT = "1";

      expect(() => ensureWorkingDir(workingDir)).toThrow(
        /SmithersBot could not initialize a local git repository/,
      );

      const invocations = gitInvocations();
      expect(firstIndexOf(invocations, "add")).toBe(-1);
    });

    it("aborts with a clear non-raw error and never stages when rev-parse verification fails", () => {
      const workingDir = managedWorkspace("plain-revparse-fail");
      fs.mkdirSync(workingDir, { recursive: true });
      process.env.MOLTBOT_GIT_FAIL_REVPARSE = "1";

      let thrown: Error | undefined;
      try {
        ensureWorkingDir(workingDir);
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown).toBeDefined();
      expect(thrown?.message).toMatch(/could not verify it with/);
      expect(thrown?.message).not.toMatch(/fatal: not a git repository/);

      const invocations = gitInvocations();
      // init was attempted, but verification failed, so no staging happened.
      expect(firstIndexOf(invocations, "init")).toBeGreaterThanOrEqual(0);
      expect(firstIndexOf(invocations, "add")).toBe(-1);
    });
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
