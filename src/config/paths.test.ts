import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  resolveDefaultConfigCandidates,
  resolveConfigPath,
  resolveOAuthDir,
  resolveOAuthPath,
  resolveStateDir,
} from "./paths.js";
import {
  DEFAULT_MANAGED_ROOT_DIRNAME,
  isPathInsideAgentRoot,
  isPathInsideManagedRoot,
  isPathInsidePrivateRoot,
  resolveAgentGoalHistoryDir,
  resolveAgentHistoryIndexDir,
  resolveAgentRepoChatHistoryDir,
  resolveAgentRoot,
  resolveManagedRoot,
  resolvePrivateAuthDir,
  resolvePrivateConfigDir,
  resolvePrivateEnvDir,
  resolvePrivateEnvFile,
  resolvePrivateRoot,
  resolvePrivateSessionsDir,
  resolveScratchDir,
  resolveScratchRoot,
  resolveWorkspaceRepoDir,
  slugifyWorkspaceName,
} from "./managed-paths.js";

describe("oauth paths", () => {
  it("prefers CLAWDBOT_OAUTH_DIR over CLAWDBOT_STATE_DIR", () => {
    const env = {
      CLAWDBOT_OAUTH_DIR: "/custom/oauth",
      CLAWDBOT_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.resolve("/custom/oauth"));
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      path.join(path.resolve("/custom/oauth"), "oauth.json"),
    );
  });

  it("derives oauth path from CLAWDBOT_STATE_DIR when unset", () => {
    const env = {
      CLAWDBOT_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.join("/custom/state", "credentials"));
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      path.join("/custom/state", "credentials", "oauth.json"),
    );
  });
});

describe("state + config path candidates", () => {
  it("prefers SMITHERSBOT_STATE_DIR over legacy state dir envs", () => {
    const env = {
      SMITHERSBOT_STATE_DIR: "/smithersbot/state",
      MOLTBOT_STATE_DIR: "/moltbot/state",
      CLAWDBOT_STATE_DIR: "/clawdbot/state",
    } as NodeJS.ProcessEnv;

    expect(resolveStateDir(env, () => "/home/test")).toBe(path.resolve("/smithersbot/state"));
  });

  it("orders default config candidates as SmithersBot then Moltbot then Clawdbot", () => {
    const home = "/home/test";
    const candidates = resolveDefaultConfigCandidates({} as NodeJS.ProcessEnv, () => home);
    expect(candidates[0]).toBe(path.join(home, ".smithersbot", "smithersbot.json"));
    expect(candidates[1]).toBe(path.join(home, ".smithersbot", "moltbot.json"));
    expect(candidates[2]).toBe(path.join(home, ".smithersbot", "clawdbot.json"));
    expect(candidates[3]).toBe(path.join(home, ".moltbot", "smithersbot.json"));
    expect(candidates[4]).toBe(path.join(home, ".moltbot", "moltbot.json"));
    expect(candidates[5]).toBe(path.join(home, ".moltbot", "clawdbot.json"));
    expect(candidates[6]).toBe(path.join(home, ".clawdbot", "smithersbot.json"));
    expect(candidates[7]).toBe(path.join(home, ".clawdbot", "moltbot.json"));
    expect(candidates[8]).toBe(path.join(home, ".clawdbot", "clawdbot.json"));
  });

  it("defaults to ~/.smithersbot when no existing state dirs are present", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "smithersbot-state-"));
    try {
      const resolved = resolveStateDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(path.join(root, ".smithersbot"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to existing ~/.moltbot when canonical dir is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-state-"));
    try {
      const newDir = path.join(root, ".moltbot");
      await fs.mkdir(newDir, { recursive: true });
      const resolved = resolveStateDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(newDir);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("CONFIG_PATH prefers existing legacy filename when present", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-config-"));
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousHomeDrive = process.env.HOMEDRIVE;
    const previousHomePath = process.env.HOMEPATH;
    const previousSmithersbotConfig = process.env.SMITHERSBOT_CONFIG_PATH;
    const previousMoltbotConfig = process.env.MOLTBOT_CONFIG_PATH;
    const previousClawdbotConfig = process.env.CLAWDBOT_CONFIG_PATH;
    const previousSmithersbotState = process.env.SMITHERSBOT_STATE_DIR;
    const previousMoltbotState = process.env.MOLTBOT_STATE_DIR;
    const previousClawdbotState = process.env.CLAWDBOT_STATE_DIR;
    try {
      const legacyDir = path.join(root, ".clawdbot");
      await fs.mkdir(legacyDir, { recursive: true });
      const legacyPath = path.join(legacyDir, "clawdbot.json");
      await fs.writeFile(legacyPath, "{}", "utf-8");

      process.env.HOME = root;
      if (process.platform === "win32") {
        process.env.USERPROFILE = root;
        const parsed = path.win32.parse(root);
        process.env.HOMEDRIVE = parsed.root.replace(/\\$/, "");
        process.env.HOMEPATH = root.slice(parsed.root.length - 1);
      }
      delete process.env.SMITHERSBOT_CONFIG_PATH;
      delete process.env.MOLTBOT_CONFIG_PATH;
      delete process.env.CLAWDBOT_CONFIG_PATH;
      delete process.env.SMITHERSBOT_STATE_DIR;
      delete process.env.MOLTBOT_STATE_DIR;
      delete process.env.CLAWDBOT_STATE_DIR;

      vi.resetModules();
      const { CONFIG_PATH } = await import("./paths.js");
      expect(CONFIG_PATH).toBe(legacyPath);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      if (previousHomeDrive === undefined) delete process.env.HOMEDRIVE;
      else process.env.HOMEDRIVE = previousHomeDrive;
      if (previousHomePath === undefined) delete process.env.HOMEPATH;
      else process.env.HOMEPATH = previousHomePath;
      if (previousSmithersbotConfig === undefined) delete process.env.SMITHERSBOT_CONFIG_PATH;
      else process.env.SMITHERSBOT_CONFIG_PATH = previousSmithersbotConfig;
      if (previousMoltbotConfig === undefined) delete process.env.MOLTBOT_CONFIG_PATH;
      else process.env.MOLTBOT_CONFIG_PATH = previousMoltbotConfig;
      if (previousClawdbotConfig === undefined) delete process.env.CLAWDBOT_CONFIG_PATH;
      else process.env.CLAWDBOT_CONFIG_PATH = previousClawdbotConfig;
      if (previousSmithersbotState === undefined) delete process.env.SMITHERSBOT_STATE_DIR;
      else process.env.SMITHERSBOT_STATE_DIR = previousSmithersbotState;
      if (previousMoltbotState === undefined) delete process.env.MOLTBOT_STATE_DIR;
      else process.env.MOLTBOT_STATE_DIR = previousMoltbotState;
      if (previousClawdbotState === undefined) delete process.env.CLAWDBOT_STATE_DIR;
      else process.env.CLAWDBOT_STATE_DIR = previousClawdbotState;
      await fs.rm(root, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it("managed root defaults to ~/smithersbot-goals under home", () => {
    const env = {} as NodeJS.ProcessEnv;
    const home = "/home/test-user";
    expect(resolveManagedRoot(env, () => home)).toBe(path.join(home, DEFAULT_MANAGED_ROOT_DIRNAME));
  });

  it("managed root respects SMITHERSBOT_GOALS_ROOT override", () => {
    const env = {
      SMITHERSBOT_GOALS_ROOT: "/custom/managed/root",
    } as NodeJS.ProcessEnv;
    expect(resolveManagedRoot(env, () => "/home/test-user")).toBe(
      path.resolve("/custom/managed/root"),
    );
  });

  it("managed root expands ~ prefix in override using os.homedir", () => {
    const env = {
      SMITHERSBOT_GOALS_ROOT: "~/custom-goals",
    } as NodeJS.ProcessEnv;
    expect(resolveManagedRoot(env, () => "/ignored")).toBe(
      path.resolve(os.homedir(), "custom-goals"),
    );
  });

  it("agent root is <managed>/agent and workspace repo lives inside it", () => {
    const env = { SMITHERSBOT_GOALS_ROOT: "/m/root" } as NodeJS.ProcessEnv;
    const home = () => "/home/test";
    const agentRoot = resolveAgentRoot(env, home);
    expect(agentRoot).toBe(path.resolve("/m/root/agent"));

    const repo = resolveWorkspaceRepoDir("smithersbot", env, home);
    expect(repo).toBe(path.resolve("/m/root/agent/workspaces/smithersbot/repo"));
    expect(isPathInsideAgentRoot(repo, env, home)).toBe(true);
    expect(isPathInsidePrivateRoot(repo, env, home)).toBe(false);
  });

  it("agent history goal/repo-chat/index dirs are inside agent root", () => {
    const env = { SMITHERSBOT_GOALS_ROOT: "/m/root" } as NodeJS.ProcessEnv;
    const home = () => "/home/test";
    const goalDir = resolveAgentGoalHistoryDir("ws", "goal-abc", env, home);
    const chatDir = resolveAgentRepoChatHistoryDir("ws", env, home);
    const indexDir = resolveAgentHistoryIndexDir(env, home);
    expect(goalDir).toBe(path.resolve("/m/root/agent/history/goals/ws/goal-abc"));
    expect(chatDir).toBe(path.resolve("/m/root/agent/history/repo-chats/ws"));
    expect(indexDir).toBe(path.resolve("/m/root/agent/history/index"));
    expect(isPathInsideAgentRoot(goalDir, env, home)).toBe(true);
    expect(isPathInsideAgentRoot(chatDir, env, home)).toBe(true);
    expect(isPathInsideAgentRoot(indexDir, env, home)).toBe(true);
  });

  it("private env/config/auth/sessions live outside agent root", () => {
    const env = { SMITHERSBOT_GOALS_ROOT: "/m/root" } as NodeJS.ProcessEnv;
    const home = () => "/home/test";
    const envFile = resolvePrivateEnvFile("smithersbot", env, home);
    const envDir = resolvePrivateEnvDir("smithersbot", env, home);
    const cfgDir = resolvePrivateConfigDir(env, home);
    const authDir = resolvePrivateAuthDir(env, home);
    const sessDir = resolvePrivateSessionsDir(env, home);
    expect(envFile).toBe(path.resolve("/m/root/private/env/smithersbot/.env"));
    expect(envDir).toBe(path.resolve("/m/root/private/env/smithersbot"));
    expect(cfgDir).toBe(path.resolve("/m/root/private/config"));
    expect(authDir).toBe(path.resolve("/m/root/private/auth"));
    expect(sessDir).toBe(path.resolve("/m/root/private/sessions"));
    for (const p of [envFile, envDir, cfgDir, authDir, sessDir]) {
      expect(isPathInsidePrivateRoot(p, env, home)).toBe(true);
      expect(isPathInsideAgentRoot(p, env, home)).toBe(false);
      expect(isPathInsideManagedRoot(p, env, home)).toBe(true);
    }
    expect(resolvePrivateRoot(env, home)).toBe(path.resolve("/m/root/private"));
  });

  it("scratch dir lives under <root>/scratch and is not inside agent root", () => {
    const env = { SMITHERSBOT_GOALS_ROOT: "/m/root" } as NodeJS.ProcessEnv;
    const home = () => "/home/test";
    const scratchRoot = resolveScratchRoot(env, home);
    const scratchDir = resolveScratchDir("run-1", "task-2", env, home);
    expect(scratchRoot).toBe(path.resolve("/m/root/scratch"));
    expect(scratchDir).toBe(path.resolve("/m/root/scratch/run-1/task-2"));
    expect(isPathInsideAgentRoot(scratchDir, env, home)).toBe(false);
    expect(isPathInsidePrivateRoot(scratchDir, env, home)).toBe(false);
    expect(isPathInsideManagedRoot(scratchDir, env, home)).toBe(true);
  });

  it("slugifyWorkspaceName accepts safe identifiers", () => {
    expect(slugifyWorkspaceName("smithersbot")).toBe("smithersbot");
    expect(slugifyWorkspaceName("my-project_2")).toBe("my-project_2");
    expect(slugifyWorkspaceName("Repo.Name")).toBe("Repo.Name");
  });

  it("slugifyWorkspaceName replaces unsafe characters with hyphens", () => {
    expect(slugifyWorkspaceName("my@project!")).toBe("my-project-");
  });

  it("slugifyWorkspaceName rejects traversal, separators, control chars, and empty input", () => {
    expect(() => slugifyWorkspaceName("..")).toThrow();
    expect(() => slugifyWorkspaceName("../etc")).toThrow();
    expect(() => slugifyWorkspaceName("foo/bar")).toThrow();
    expect(() => slugifyWorkspaceName("foo\\bar")).toThrow();
    expect(() => slugifyWorkspaceName("/abs/path")).toThrow();
    expect(() => slugifyWorkspaceName("")).toThrow();
    expect(() => slugifyWorkspaceName("   ")).toThrow();
    expect(() => slugifyWorkspaceName("has space")).toThrow();
    expect(() => slugifyWorkspaceName("ctrlname")).toThrow();
    expect(() => slugifyWorkspaceName("null name")).toThrow();
    expect(() => slugifyWorkspaceName(undefined as unknown as string)).toThrow();
    expect(() => slugifyWorkspaceName(42 as unknown as string)).toThrow();
  });

  it("isPathInsideAgentRoot rejects paths outside the agent root", () => {
    const env = { SMITHERSBOT_GOALS_ROOT: "/m/root" } as NodeJS.ProcessEnv;
    const home = () => "/home/test";
    expect(isPathInsideAgentRoot("/m/root/agent", env, home)).toBe(true);
    expect(isPathInsideAgentRoot("/m/root/agent/workspaces/foo", env, home)).toBe(true);
    expect(isPathInsideAgentRoot("/m/root/private/env/foo/.env", env, home)).toBe(false);
    expect(isPathInsideAgentRoot("/etc/passwd", env, home)).toBe(false);
    expect(isPathInsideAgentRoot("/m/root", env, home)).toBe(false);
    expect(isPathInsideAgentRoot("", env, home)).toBe(false);
  });

  it("isPathInsidePrivateRoot rejects paths outside the private root", () => {
    const env = { SMITHERSBOT_GOALS_ROOT: "/m/root" } as NodeJS.ProcessEnv;
    const home = () => "/home/test";
    expect(isPathInsidePrivateRoot("/m/root/private", env, home)).toBe(true);
    expect(isPathInsidePrivateRoot("/m/root/private/env/x/.env", env, home)).toBe(true);
    expect(isPathInsidePrivateRoot("/m/root/agent/workspaces/x/repo", env, home)).toBe(false);
    expect(isPathInsidePrivateRoot("/m/root/scratch/r/t", env, home)).toBe(false);
    expect(isPathInsidePrivateRoot("/var/tmp/private", env, home)).toBe(false);
  });

  it("respects state dir overrides when config is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-config-override-"));
    try {
      const legacyDir = path.join(root, ".clawdbot");
      await fs.mkdir(legacyDir, { recursive: true });
      const legacyConfig = path.join(legacyDir, "moltbot.json");
      await fs.writeFile(legacyConfig, "{}", "utf-8");

      const overrideDir = path.join(root, "override");
      const env = { MOLTBOT_STATE_DIR: overrideDir } as NodeJS.ProcessEnv;
      const resolved = resolveConfigPath(env, overrideDir, () => root);
      expect(resolved).toBe(path.join(overrideDir, "smithersbot.json"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
