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
    const root = track(fs.mkdtempSync(path.join(os.tmpdir(), "git-root-miss-")));
    const nested = path.join(root, "x", "y");
    fs.mkdirSync(nested, { recursive: true });

    expect(findGitRoot(nested)).toBeNull();
  });

  it("isGitRepo detects .git directories without calling git", () => {
    const root = track(fs.mkdtempSync(path.join(os.tmpdir(), "git-repo-")));
    fs.mkdirSync(path.join(root, ".git"));
    const nested = path.join(root, "deep");
    fs.mkdirSync(nested, { recursive: true });

    expect(isGitRepo(nested)).toBe(true);
  });
});
