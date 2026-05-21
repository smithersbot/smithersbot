import path from "node:path";
import { describe, expect, it } from "vitest";
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
  const env = { SMITHERSBOT_GOALS_ROOT: "/tmp/smithersbot-managed" };
  const homedir = () => "/home/test";

  it("keeps workspace repos under agent and private env outside agent", () => {
    const managedRoot = resolveManagedRoot(env, homedir);
    const agentRoot = resolveAgentRoot(env, homedir);
    const privateRoot = resolvePrivateRoot(env, homedir);
    const repoDir = resolveWorkspaceRepoDir("smithersbot", env, homedir);
    const privateEnv = resolvePrivateEnvFile("smithersbot", env, homedir);

    expect(agentRoot).toBe(path.join(managedRoot, "agent"));
    expect(privateRoot).toBe(path.join(managedRoot, "private"));
    expect(repoDir).toBe(path.join(agentRoot, "workspaces", "smithersbot", "repo"));
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
});
