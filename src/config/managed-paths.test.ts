import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isPathInsideAgentRoot,
  isPathInsideManagedRoot,
  isPathInsidePrivateRoot,
  resolveAgentRoot,
  resolveManagedRoot,
  resolvePrivateEnvFile,
  resolvePrivateRoot,
  resolveWorkspaceRepoDir,
  slugifyWorkspaceName,
} from "./managed-paths.js";

describe("managed paths", () => {
  let tmpDir: string;
  let env: { SMITHERSBOT_GOALS_ROOT: string };
  const homedir = () => "/home/test";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-paths-test-"));
    env = { SMITHERSBOT_GOALS_ROOT: path.join(tmpDir, "managed") };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("defaults fresh installs to ~/smithersbot-home", () => {
    expect(resolveManagedRoot({} as NodeJS.ProcessEnv, () => tmpDir)).toBe(
      path.join(tmpDir, "smithersbot-home"),
    );
  });

  it("respects an existing former default when the new default is absent", () => {
    const legacyRoot = path.join(tmpDir, "smithersbot-goals");
    fs.mkdirSync(legacyRoot);

    expect(resolveManagedRoot({} as NodeJS.ProcessEnv, () => tmpDir)).toBe(legacyRoot);
  });

  it("keeps workspace projects under agent and private env outside agent", () => {
    const managedRoot = resolveManagedRoot(env, homedir);
    const agentRoot = resolveAgentRoot(env, homedir);
    const privateRoot = resolvePrivateRoot(env, homedir);
    const repoDir = resolveWorkspaceRepoDir("smithersbot", env, homedir);
    const privateEnv = resolvePrivateEnvFile("smithersbot", env, homedir);

    expect(agentRoot).toBe(path.join(managedRoot, "agent"));
    expect(privateRoot).toBe(path.join(managedRoot, "private"));
    expect(repoDir).toBe(path.join(agentRoot, "workspaces", "smithersbot"));
    expect(privateEnv).toBe(path.join(privateRoot, "env", "smithersbot", ".env"));
    expect(isPathInsideAgentRoot(repoDir, env, homedir)).toBe(true);
    expect(isPathInsideAgentRoot(privateEnv, env, homedir)).toBe(false);
    expect(isPathInsidePrivateRoot(privateEnv, env, homedir)).toBe(true);
    expect(isPathInsideManagedRoot(privateEnv, env, homedir)).toBe(true);
  });

  it("rejects workspace names that could traverse managed roots", () => {
    expect(() => slugifyWorkspaceName("../private")).toThrow();
    expect(() => slugifyWorkspaceName("/tmp/workspace")).toThrow();
    expect(() => slugifyWorkspaceName("team one")).toThrow();
  });

  it("returns the workspace root for a new workspace", () => {
    expect(resolveWorkspaceRepoDir("new-project", env, homedir)).toBe(
      path.join(resolveAgentRoot(env, homedir), "workspaces", "new-project"),
    );
  });

  it("falls back to legacy repo when the workspace root only contains a non-empty repo dir", () => {
    const workspaceRoot = path.join(resolveAgentRoot(env, homedir), "workspaces", "legacy");
    const legacyRepo = path.join(workspaceRoot, "repo");
    fs.mkdirSync(legacyRepo, { recursive: true });
    fs.writeFileSync(path.join(legacyRepo, "README.md"), "# legacy\n", "utf8");

    expect(resolveWorkspaceRepoDir("legacy", env, homedir)).toBe(legacyRepo);
  });

  it("falls back to legacy repo when the repo dir is a git repo", () => {
    const workspaceRoot = path.join(resolveAgentRoot(env, homedir), "workspaces", "legacy-git");
    const legacyRepo = path.join(workspaceRoot, "repo");
    fs.mkdirSync(path.join(legacyRepo, ".git"), { recursive: true });

    expect(resolveWorkspaceRepoDir("legacy-git", env, homedir)).toBe(legacyRepo);
  });

  it("prefers the workspace root when it already contains project content", () => {
    const workspaceRoot = path.join(resolveAgentRoot(env, homedir), "workspaces", "new-layout");
    const legacyRepo = path.join(workspaceRoot, "repo");
    fs.mkdirSync(legacyRepo, { recursive: true });
    fs.writeFileSync(path.join(legacyRepo, "README.md"), "# legacy\n", "utf8");
    fs.writeFileSync(path.join(workspaceRoot, "package.json"), "{}\n", "utf8");

    expect(resolveWorkspaceRepoDir("new-layout", env, homedir)).toBe(workspaceRoot);
  });

  it("does not fall back to an empty legacy repo dir", () => {
    const workspaceRoot = path.join(resolveAgentRoot(env, homedir), "workspaces", "empty-legacy");
    fs.mkdirSync(path.join(workspaceRoot, "repo"), { recursive: true });

    expect(resolveWorkspaceRepoDir("empty-legacy", env, homedir)).toBe(workspaceRoot);
  });

  it("rejects managed workspace paths that resolve outside the agent root", () => {
    const workspacePath = path.join(resolveAgentRoot(env, homedir), "workspaces", "escape");
    const privateTarget = path.join(resolvePrivateRoot(env, homedir), "env", "escape");
    fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
    fs.mkdirSync(privateTarget, { recursive: true });
    fs.symlinkSync(privateTarget, workspacePath);

    expect(() => resolveWorkspaceRepoDir("escape", env, homedir)).toThrow(/managed agent root/);
  });
});
