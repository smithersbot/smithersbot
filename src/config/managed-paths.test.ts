import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isObservedAgentPathAllowed,
  isPathInsideAgentRoot,
  isPathInsideManagedRoot,
  isPathInsidePrivateRoot,
  isPathInsideWorkspacesRoot,
  resolveAgentRoot,
  resolveManagedRoot,
  resolveObservedAgentRoot,
  resolveObservedWorkspacesRoot,
  resolvePrivateEnvFile,
  resolvePrivateRoot,
  resolveWorkspaceRepoDir,
  resolveWorkspacesRoot,
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

  it("resolves the dev managed root from an explicit dev instance", () => {
    const legacyRoot = path.join(tmpDir, "smithersbot-goals");
    fs.mkdirSync(legacyRoot);

    expect(
      resolveManagedRoot({ SMITHERSBOT_INSTANCE: "dev" } as NodeJS.ProcessEnv, () => tmpDir),
    ).toBe(path.join(tmpDir, "smithersbot-dev-home"));
  });

  it("does not use the legacy fallback when an instance is selected explicitly", () => {
    const legacyRoot = path.join(tmpDir, "smithersbot-goals");
    fs.mkdirSync(legacyRoot);

    expect(
      resolveManagedRoot({ SMITHERSBOT_INSTANCE: "stable" } as NodeJS.ProcessEnv, () => tmpDir),
    ).toBe(path.join(tmpDir, "smithersbot-home"));
  });

  it("resolves the smithersbot-dev workspace name under the selected instance root", () => {
    const home = "/home/matt";

    expect(
      resolveWorkspaceRepoDir(
        "smithersbot-dev",
        { SMITHERSBOT_INSTANCE: "stable" } as NodeJS.ProcessEnv,
        () => home,
      ),
    ).toBe("/home/matt/smithersbot-home/agent/workspaces/smithersbot-dev");
    expect(
      resolveWorkspaceRepoDir(
        "smithersbot-dev",
        { SMITHERSBOT_INSTANCE: "dev" } as NodeJS.ProcessEnv,
        () => home,
      ),
    ).toBe("/home/matt/smithersbot-dev-home/agent/workspaces/smithersbot-dev");
  });

  it("keeps an explicit managed-root override over the selected instance root", () => {
    const override = path.join(tmpDir, "custom-root");

    expect(
      resolveWorkspaceRepoDir(
        "smithersbot-dev",
        { SMITHERSBOT_INSTANCE: "dev", SMITHERSBOT_GOALS_ROOT: override } as NodeJS.ProcessEnv,
        () => "/home/matt",
      ),
    ).toBe(path.join(override, "agent", "workspaces", "smithersbot-dev"));
  });

  it("does not infer dev managed root from a smithersbot-dev working directory", () => {
    const prevCwd = process.cwd();
    const devCheckout = path.join(
      tmpDir,
      "smithersbot-home",
      "agent",
      "workspaces",
      "smithersbot-dev",
    );
    fs.mkdirSync(devCheckout, { recursive: true });
    try {
      process.chdir(devCheckout);
      expect(resolveManagedRoot({} as NodeJS.ProcessEnv, () => tmpDir)).toBe(
        path.join(tmpDir, "smithersbot-home"),
      );
    } finally {
      process.chdir(prevCwd);
    }
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

  it("resolves the workspaces root under the agent root", () => {
    expect(resolveWorkspacesRoot(env, homedir)).toBe(
      path.join(resolveAgentRoot(env, homedir), "workspaces"),
    );
  });

  it("recognizes paths inside the managed workspaces root and rejects those outside", () => {
    const inside = path.join(resolveWorkspacesRoot(env, homedir), "launch-inputs");
    const nested = path.join(inside, "src", "index.ts");
    const agentSibling = path.join(resolveAgentRoot(env, homedir), "history", "goals");
    const outside = path.join(resolveManagedRoot(env, homedir), "..", "elsewhere");

    expect(isPathInsideWorkspacesRoot(inside, env, homedir)).toBe(true);
    expect(isPathInsideWorkspacesRoot(nested, env, homedir)).toBe(true);
    // The workspaces root itself counts as inside.
    expect(isPathInsideWorkspacesRoot(resolveWorkspacesRoot(env, homedir), env, homedir)).toBe(
      true,
    );
    // Other agent subtrees are not workspaces.
    expect(isPathInsideWorkspacesRoot(agentSibling, env, homedir)).toBe(false);
    expect(isPathInsideWorkspacesRoot(outside, env, homedir)).toBe(false);
    expect(isPathInsideWorkspacesRoot("", env, homedir)).toBe(false);
  });

  it("is traversal-safe: a '..' escape from the workspaces root is rejected", () => {
    const escape = path.join(resolveWorkspacesRoot(env, homedir), "..", "..", "private", "env");
    expect(isPathInsideWorkspacesRoot(escape, env, homedir)).toBe(false);
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

  describe("observed-instance surface", () => {
    let devAgentRoot: string;
    let devPrivateRoot: string;
    let devStateDir: string;
    // Root the observed instance under the real temp dir so fixtures are writable.
    let devHome: () => string;
    const observed = () => ({ observedInstances: ["dev"], homedir: devHome });

    beforeEach(() => {
      devHome = () => tmpDir;
      const devManagedRoot = path.join(tmpDir, "smithersbot-dev-home");
      devAgentRoot = path.join(devManagedRoot, "agent");
      devPrivateRoot = path.join(devManagedRoot, "private");
      devStateDir = path.join(tmpDir, ".smithersbot-dev");
      for (const dir of [
        path.join(devAgentRoot, "workspaces"),
        path.join(devAgentRoot, "history", "goals"),
        path.join(devAgentRoot, "history", "repo-chats"),
        path.join(devAgentRoot, "history", "index"),
        path.join(devPrivateRoot, "env"),
        devStateDir,
      ]) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });

    it("resolves the dev agent surface from the explicit identity mapping", () => {
      expect(resolveObservedAgentRoot("dev", observed())).toBe(devAgentRoot);
      expect(resolveObservedWorkspacesRoot("dev", observed())).toBe(
        path.join(devAgentRoot, "workspaces"),
      );
    });

    it("allows agent workspaces/history and rejects private/state", () => {
      expect(
        isObservedAgentPathAllowed(path.join(devAgentRoot, "workspaces", "ws"), "dev", observed()),
      ).toBe(true);
      expect(
        isObservedAgentPathAllowed(path.join(devAgentRoot, "history", "index"), "dev", observed()),
      ).toBe(true);
      expect(isObservedAgentPathAllowed(devPrivateRoot, "dev", observed())).toBe(false);
      expect(isObservedAgentPathAllowed(devStateDir, "dev", observed())).toBe(false);
    });

    it("rejects symlinks under the agent root that escape into private", () => {
      const secret = path.join(devPrivateRoot, "env", ".env");
      fs.writeFileSync(secret, "TOKEN=secret");
      const link = path.join(devAgentRoot, "workspaces", "leak");
      fs.symlinkSync(secret, link);
      expect(isObservedAgentPathAllowed(link, "dev", observed())).toBe(false);
    });

    it("denies everything with no opt-in and leaves own resolution unchanged", () => {
      const noOptIn = { observedInstances: [] as string[], homedir };
      expect(
        isObservedAgentPathAllowed(path.join(devAgentRoot, "workspaces"), "dev", noOptIn),
      ).toBe(false);
      // Own managed-root resolution is unaffected by observation opt-in.
      expect(resolveManagedRoot(env, homedir)).toBe(path.join(tmpDir, "managed"));
    });
  });
});
