import { execFile as execFileCallback, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts/setup-smithersbot.sh");
const testToken = "1234567890:TEST_TOKEN";
const execFile = promisify(execFileCallback);

const getMeSuccess = {
  ok: true,
  result: {
    id: 1234567890,
    is_bot: true,
    first_name: "SmithersBot2",
    username: "smithersbot2_test_bot",
  },
};

const getUpdatesEmpty = {
  ok: true,
  result: [],
};

const getUpdatesPrivate = {
  ok: true,
  result: [
    {
      update_id: 100000001,
      message: {
        message_id: 1,
        from: {
          id: 555111222,
          is_bot: false,
          first_name: "Test",
          username: "test_operator",
        },
        chat: {
          id: 555111222,
          first_name: "Test",
          username: "test_operator",
          type: "private",
        },
        date: 1770000000,
        text: "/start",
      },
    },
  ],
};

const getUpdatesConflict = {
  ok: false,
  error_code: 409,
  description: "Conflict: can't use getUpdates method while webhook is active",
};

type RouteHandler = (path: string) => unknown;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function mkTempHome() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smithersbot-setup-test-"));
  tempDirs.push(dir);
  return dir;
}

async function mkGitFixture(root: string, name = "fixture-repo") {
  const repo = path.join(root, name);
  await fs.mkdir(repo, { recursive: true });
  await fs.writeFile(path.join(repo, "README.md"), `# ${name}\n`, "utf8");
  await execFile("git", ["init"], { cwd: repo });
  await execFile("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  await execFile("git", ["config", "user.name", "Test User"], { cwd: repo });
  await execFile("git", ["add", "README.md"], { cwd: repo });
  await execFile("git", ["commit", "-m", "initial"], { cwd: repo });
  return repo;
}

async function runSetupPreflight(params: { home: string; env?: NodeJS.ProcessEnv }) {
  const child = spawn(
    "/bin/bash",
    [
      scriptPath,
      "--no-build",
      "--backend",
      "codex",
      "--config-dir",
      path.join(params.home, ".smithersbot"),
      "--state-dir",
      path.join(params.home, ".smithersbot"),
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...params.env,
        HOME: params.home,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end("");
  const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { exitCode, stdout, stderr, output: `${stdout}\n${stderr}` };
}

async function writeExecutable(filePath: string, content: string) {
  await fs.writeFile(filePath, content, { mode: 0o755 });
  await fs.chmod(filePath, 0o755);
}

async function startTelegramStub(handler: RouteHandler) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smithersbot-telegram-stub-"));
  tempDirs.push(dir);
  await fs.writeFile(path.join(dir, "getMe.json"), JSON.stringify(handler("/getMe")), "utf8");
  await fs.writeFile(
    path.join(dir, "getUpdates.1.json"),
    JSON.stringify(handler("/getUpdates")),
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "getUpdates.2.json"),
    JSON.stringify(handler("/getUpdates")),
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "getUpdates.json"),
    JSON.stringify(handler("/getUpdates")),
    "utf8",
  );
  return dir;
}

async function runSetup(params: {
  home: string;
  apiBase: string;
  input: string;
  pollSeconds?: string;
  pollInterval?: string;
  managedRootInput?: string;
  repoPromptInput?: string;
  workspaceNameInput?: string;
  honorificInput?: string;
  systemdInput?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const sourceRepo = path.join(params.home, "source-repo");
  const repoPromptInput = params.repoPromptInput ?? `2\n${sourceRepo}\n`;
  if (params.repoPromptInput === undefined) {
    await mkGitFixture(params.home, "source-repo");
  }
  const wizardInput = [
    params.managedRootInput ?? "\n",
    repoPromptInput,
    params.workspaceNameInput ?? "\n",
    params.honorificInput ?? "\n",
    params.input,
    params.systemdInput ?? "\n",
  ].join("");
  const child = spawn(
    "/bin/bash",
    [
      scriptPath,
      "--no-build",
      "--backend",
      "codex",
      "--config-dir",
      path.join(params.home, ".smithersbot"),
      "--state-dir",
      path.join(params.home, ".smithersbot"),
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...params.env,
        HOME: params.home,
        SMITHERSBOT_TELEGRAM_API_STUB_DIR: params.apiBase,
        SMITHERSBOT_SETUP_POLL_SECONDS: params.pollSeconds ?? "1",
        SMITHERSBOT_SETUP_POLL_INTERVAL: params.pollInterval ?? "0.05",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(wizardInput);

  const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { exitCode, stdout, stderr, output: `${stdout}\n${stderr}` };
}

async function readGeneratedConfig(home: string) {
  const configPath = path.join(home, ".smithersbot", "smithersbot.json");
  const envPath = path.join(home, ".smithersbot", ".env");
  const [configRaw, envRaw, configStat, envStat] = await Promise.all([
    fs.readFile(configPath, "utf8"),
    fs.readFile(envPath, "utf8"),
    fs.stat(configPath),
    fs.stat(envPath),
  ]);
  return {
    config: JSON.parse(configRaw) as {
      channels: { telegram: { allowFrom: string[]; botToken: string; repoChatBackend: string } };
      gateway: { mode: string; auth: { token: string } };
      agents: { defaults: { workspace: string; identity: { operatorHonorific: string } } };
      goal: { defaultWorkspaceName: string };
    },
    envRaw,
    configMode: configStat.mode & 0o777,
    envMode: envStat.mode & 0o777,
  };
}

describe("scripts/setup-smithersbot.sh", () => {
  it("requires Node.js >= 22.12.0", async () => {
    const home = await mkTempHome();
    const bin = path.join(home, "bin");
    await fs.mkdir(bin);
    await writeExecutable(path.join(bin, "node"), "#!/bin/bash\nprintf 'v22.11.0\\n'\n");
    const result = await runSetupPreflight({
      home,
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Node.js >= 22.12.0 is required; found v22.11.0");
  });

  it("requires pnpm even with --no-build", async () => {
    const home = await mkTempHome();
    const bin = path.join(home, "bin");
    await fs.mkdir(bin);
    await writeExecutable(path.join(bin, "node"), "#!/bin/bash\nprintf 'v22.12.0\\n'\n");
    for (const cmd of ["grep", "git"]) {
      const resolved = (await execFile("command", ["-v", cmd], { shell: true })).stdout.trim();
      await fs.symlink(resolved, path.join(bin, cmd));
    }

    const result = await runSetupPreflight({ home, env: { PATH: bin } });

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("pnpm is required but was not found");
  });

  it("accepts a valid getMe token, discovers a private chat ID, and writes usable private files without echoing the token", async () => {
    const home = await mkTempHome();
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({ home, apiBase, input: `${testToken}\n\n` });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Telegram bot verified: @smithersbot2_test_bot");
    expect(result.output).toContain(
      "Open @smithersbot2_test_bot (your new bot, NOT @BotFather) in Telegram and press Start, or send any message.",
    );
    expect(result.output).toContain("Use this Telegram private chat ID for allowFrom? [Y/n]");
    expect(result.output).not.toContain(testToken);

    const generated = await readGeneratedConfig(home);
    expect(generated.envRaw).toContain(`TELEGRAM_BOT_TOKEN=${testToken}`);
    expect(generated.config.channels.telegram.allowFrom).toEqual(["555111222"]);
    expect(generated.config.channels.telegram.botToken).toBe("${TELEGRAM_BOT_TOKEN}");
    expect(generated.config.channels.telegram.repoChatBackend).toBe("codex");
    expect(generated.config.gateway.mode).toBe("local");
    expect(generated.config.gateway.auth.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(generated.config.agents.defaults.identity.operatorHonorific).toBe("sir");
    expect(generated.config.goal.defaultWorkspaceName).toBe("source-repo");
    expect(generated.configMode).toBe(0o600);
    expect(generated.envMode).toBe(0o600);

    // Stage 2S: managed root directory tree is created under HOME.
    const managedRoot = path.join(home, "smithersbot-goals");
    const managedSubdirs = [
      "agent/workspaces",
      "agent/history/goals",
      "agent/history/repo-chats",
      "agent/history/index",
      "private/env",
      "private/config",
      "private/auth",
      "private/sessions",
      "scratch",
    ];
    for (const subdir of managedSubdirs) {
      const stat = await fs.stat(path.join(managedRoot, subdir));
      expect(stat.isDirectory()).toBe(true);
    }
    const privateRootStat = await fs.stat(path.join(managedRoot, "private"));
    expect(privateRootStat.mode & 0o777).toBe(0o700);
    for (const privSub of ["private/env", "private/config", "private/auth", "private/sessions"]) {
      const stat = await fs.stat(path.join(managedRoot, privSub));
      expect(stat.mode & 0o777).toBe(0o700);
    }
    expect(result.output).toContain(`Managed root: ${managedRoot}`);
    const workspaceRepo = path.join(managedRoot, "agent", "workspaces", "source-repo");
    expect(generated.config.agents.defaults.workspace).toBe(workspaceRepo);
    expect((await fs.stat(path.join(workspaceRepo, ".git"))).isDirectory()).toBe(true);
    await expect(fs.readFile(path.join(workspaceRepo, "README.md"), "utf8")).resolves.toContain(
      "# source-repo",
    );
    await expect(fs.stat(path.join(workspaceRepo, "repo"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const privateEnvPath = path.join(managedRoot, "private", "env", "source-repo", ".env");
    const privateEnvStat = await fs.stat(privateEnvPath);
    expect(privateEnvStat.mode & 0o777).toBe(0o600);
    expect(path.relative(workspaceRepo, privateEnvPath).startsWith("..")).toBe(true);
    await expect(fs.readFile(privateEnvPath, "utf8")).resolves.toContain("EXAMPLE_API_KEY");
    expect(result.output).toContain("/gateway_status");
    expect(result.output).toContain("/usage_status");
  });

  it("honors the managed-root prompt", async () => {
    const home = await mkTempHome();
    const customRoot = path.join(home, "custom-managed-root");
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      managedRootInput: `${customRoot}\n`,
      input: `${testToken}\n\n`,
    });

    expect(result.exitCode).toBe(0);
    for (const subdir of ["agent/workspaces", "agent/history/goals", "private/env", "scratch"]) {
      const stat = await fs.stat(path.join(customRoot, subdir));
      expect(stat.isDirectory()).toBe(true);
    }
    expect(result.output).toContain(`Managed root: ${customRoot}`);
  });

  it("clones a local repo URL fixture into the managed workspace repo", async () => {
    const home = await mkTempHome();
    const source = await mkGitFixture(home, "url-repo");
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      repoPromptInput: `3\nfile://${source}\n`,
      input: `${testToken}\n\n`,
    });

    expect(result.exitCode).toBe(0);
    const workspaceRepo = path.join(home, "smithersbot-goals", "agent", "workspaces", "url-repo");
    await expect(fs.readFile(path.join(workspaceRepo, "README.md"), "utf8")).resolves.toContain(
      "# url-repo",
    );
    await expect(fs.stat(path.join(workspaceRepo, "repo"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(result.output).toContain("Cloned repo URL into isolated agent workspace");
  });

  it("copies a local non-git directory as a fallback", async () => {
    const home = await mkTempHome();
    const source = path.join(home, "plain-source");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "notes.txt"), "plain copy\n", "utf8");
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      repoPromptInput: `2\n${source}\n`,
      input: `${testToken}\n\n`,
    });

    expect(result.exitCode).toBe(0);
    const workspaceRepo = path.join(
      home,
      "smithersbot-goals",
      "agent",
      "workspaces",
      "plain-source",
    );
    await expect(fs.readFile(path.join(workspaceRepo, "notes.txt"), "utf8")).resolves.toBe(
      "plain copy\n",
    );
    await expect(fs.stat(path.join(workspaceRepo, "repo"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(result.output).toContain("Local source is not a git repo; copied it");
  });

  it("rejects unsafe workspace names and accepts the next safe value", async () => {
    const home = await mkTempHome();
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      workspaceNameInput: "../bad\nsafe-name\n",
      input: `${testToken}\n\n`,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Workspace name must be a single safe path segment");
    await expect(
      fs.stat(path.join(home, "smithersbot-goals", "agent", "workspaces", "safe-name")),
    ).resolves.toBeTruthy();
  });

  it("stops cleanly for an invalid token", async () => {
    const home = await mkTempHome();
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) {
        return { ok: false, error_code: 401, description: "Unauthorized" };
      }
      return getUpdatesPrivate;
    });

    const result = await runSetup({ home, apiBase, input: `${testToken}\n` });

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("invalid Telegram bot token: Unauthorized");
    expect(result.output).not.toContain(testToken);
  });

  it("shows retry/manual instructions when getUpdates stays empty", async () => {
    const home = await mkTempHome();
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesEmpty;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      pollSeconds: "0",
      input: `${testToken}\nm\n555111222\n`,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(
      "No private Telegram message was detected before the setup timeout.",
    );
    expect(result.output).toContain("Retry detection or enter ID manually? [r/m]");
    expect(result.output).not.toContain(testToken);
    const generated = await readGeneratedConfig(home);
    expect(generated.config.channels.telegram.allowFrom).toEqual(["555111222"]);
  });

  it("ignores non-private updates", async () => {
    const home = await mkTempHome();
    let getUpdatesCalls = 0;
    const groupThenPrivate = {
      ok: true,
      result: [
        {
          update_id: 100000002,
          message: {
            message_id: 2,
            from: { id: 111, is_bot: false },
            chat: { id: -100123, type: "supergroup", title: "Test Group" },
            date: 1770000001,
            text: "/start",
          },
        },
      ],
    };
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) {
        getUpdatesCalls += 1;
        return getUpdatesCalls === 1 ? groupThenPrivate : getUpdatesPrivate;
      }
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({ home, apiBase, input: `${testToken}\n\n` });

    expect(result.exitCode).toBe(0);
    expect(getUpdatesCalls).toBeGreaterThanOrEqual(2);
    const generated = await readGeneratedConfig(home);
    expect(generated.config.channels.telegram.allowFrom).toEqual(["555111222"]);
  });

  it("uses the newest private update by highest update_id", async () => {
    const home = await mkTempHome();
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) {
        return {
          ok: true,
          result: [
            {
              update_id: 100000003,
              message: {
                message_id: 3,
                from: { id: 111111111, is_bot: false },
                chat: { id: 111111111, type: "private" },
                date: 1770000002,
                text: "old",
              },
            },
            {
              update_id: 100000009,
              message: {
                message_id: 4,
                from: { id: 999888777, is_bot: false },
                chat: { id: 999888777, type: "private" },
                date: 1770000003,
                text: "hello",
              },
            },
          ],
        };
      }
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({ home, apiBase, input: `${testToken}\n\n` });

    expect(result.exitCode).toBe(0);
    const generated = await readGeneratedConfig(home);
    expect(generated.config.channels.telegram.allowFrom).toEqual(["999888777"]);
  });

  it("prints an actionable webhook conflict message without exposing the token", async () => {
    const home = await mkTempHome();
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesConflict;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({ home, apiBase, input: `${testToken}\n` });

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(
      "Telegram getUpdates is blocked because a webhook is active for this bot.",
    );
    expect(result.output).toContain("deleteWebhook");
    expect(result.output).toContain(
      "Conflict: can't use getUpdates method while webhook is active",
    );
    expect(result.output).toContain("<YOUR_BOT_TOKEN>");
    expect(result.output).not.toContain(testToken);
  });
});
