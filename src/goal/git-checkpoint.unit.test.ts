import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findGitRoot, isGitRepo } from "./git-checkpoint.js";

const dirs: string[] = [];

function track(dir: string): string {
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

describe("git-checkpoint (unit)", () => {
  it("findGitRoot returns the nearest parent containing .git", () => {
    const root = track(fs.mkdtempSync(path.join(os.tmpdir(), "git-root-")));
    fs.mkdirSync(path.join(root, ".git"));
    const nested = path.join(root, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });

    expect(findGitRoot(nested)).toBe(root);
  });

  it("findGitRoot returns null when no .git is found", () => {
    // Walk a synthetic absolute path whose ancestors (down to the filesystem root)
    // contain no .git. A real temp dir is unsafe here: under vitest os.tmpdir() is
    // redirected inside this git repo (see vitest.config.ts), so a walk up from it
    // would find the repo's .git and never reach the null case.
    const noGitPath = path.join(path.parse(os.tmpdir()).root, `sb-no-git-${Date.now()}`, "x", "y");

    expect(findGitRoot(noGitPath)).toBeNull();
  });

  it("isGitRepo detects .git directories without calling git", () => {
    const root = track(fs.mkdtempSync(path.join(os.tmpdir(), "git-repo-")));
    fs.mkdirSync(path.join(root, ".git"));
    const nested = path.join(root, "deep");
    fs.mkdirSync(nested, { recursive: true });

    expect(isGitRepo(nested)).toBe(true);
  });
});
