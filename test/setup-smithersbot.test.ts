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

const ansiPattern = new RegExp(String.raw`\x1B\[[0-9;]*m`);

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

async function mkPnpmGitFixture(root: string, name = "fixture-repo") {
  const repo = await mkGitFixture(root, name);
  await fs.writeFile(
    path.join(repo, "package.json"),
    JSON.stringify({ name, packageManager: "pnpm@10.0.0" }, null, 2),
    "utf8",
  );
  await fs.writeFile(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  await execFile("git", ["add", "package.json", "pnpm-lock.yaml"], { cwd: repo });
  await execFile("git", ["commit", "-m", "add pnpm project"], { cwd: repo });
  return repo;
}

async function runSetupPreflight(params: {
  home: string;
  env?: NodeJS.ProcessEnv;
  extraArgs?: string[];
}) {
  const args = [
    scriptPath,
    ...(params.extraArgs ?? []),
    "--no-build",
    "--backend",
    "codex",
    "--config-dir",
    path.join(params.home, ".smithersbot"),
    "--state-dir",
    path.join(params.home, ".smithersbot"),
  ];
  const child = spawn("/bin/bash", args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...params.env,
      HOME: params.home,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
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

async function linkHostCommand(bin: string, commandName: string) {
  const resolved = (await execFile("command", ["-v", commandName], { shell: true })).stdout.trim();
  await fs.symlink(resolved, path.join(bin, commandName));
}

async function writeIsolatedSetupPath(home: string) {
  const bin = path.join(home, "bin");
  await fs.mkdir(bin);
  for (const commandName of [
    "basename",
    "cat",
    "chmod",
    "cp",
    "date",
    "dirname",
    "find",
    "git",
    "grep",
    "head",
    "mkdir",
    "mktemp",
    "mv",
    "node",
    "pnpm",
    "rm",
    "sed",
    "sleep",
    "tail",
  ]) {
    await linkHostCommand(bin, commandName);
  }
  return bin;
}

async function writePnpmRecorder(bin: string, params: { logPath: string; failInstall?: boolean }) {
  await writeExecutable(
    path.join(bin, "pnpm"),
    `#!/bin/bash
printf '%s|%s\\n' "$PWD" "$*" >> ${JSON.stringify(params.logPath)}
if [[ "$1" == "install" && "$2" == "--frozen-lockfile" && "${params.failInstall ? "1" : "0"}" == "1" ]]; then
  echo "workspace install stdout"
  echo "workspace install stderr" >&2
  exit 41
fi
if [[ "$1" == "install" && "$2" == "--frozen-lockfile" ]]; then
  echo "NOISY_WORKSPACE_INSTALL"
fi
exit 0
`,
  );
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
  instance?: string;
  noBuild?: boolean;
  pollSeconds?: string;
  pollInterval?: string;
  managedRootInput?: string;
  repoPromptInput?: string;
  workspaceNameInput?: string;
  honorificInput?: string;
  systemdInput?: string;
  backendArg?: "codex" | "claude_code" | null;
  configDir?: string | null;
  stateDir?: string | null;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const sourceRepo = path.join(params.home, "source-repo");
  const repoPromptInput = params.repoPromptInput ?? `2\n${sourceRepo}\n`;
  if (params.repoPromptInput === undefined) {
    await mkGitFixture(params.home, "source-repo");
  }
  const wizardInput = [
    params.managedRootInput ?? "\n",
    params.honorificInput ?? "\n",
    repoPromptInput,
    repoPromptInput.startsWith("4") ? "" : (params.workspaceNameInput ?? "\n"),
    params.input,
    params.systemdInput ?? "n\n",
  ].join("");
  const args = [scriptPath];
  if (params.noBuild !== false) {
    args.push("--no-build");
  }
  if (params.backendArg !== null) {
    args.push("--backend", params.backendArg ?? "codex");
  }
  if (params.instance) {
    args.push("--instance", params.instance);
  }
  const configDir =
    params.configDir === undefined ? path.join(params.home, ".smithersbot") : params.configDir;
  const stateDir =
    params.stateDir === undefined ? path.join(params.home, ".smithersbot") : params.stateDir;
  if (configDir !== null) {
    args.push("--config-dir", configDir);
  }
  if (stateDir !== null) {
    args.push("--state-dir", stateDir);
  }
  const child = spawn("/bin/bash", args, {
    cwd: params.cwd ?? repoRoot,
    env: {
      ...process.env,
      ...params.env,
      HOME: params.home,
      SMITHERSBOT_TELEGRAM_API_STUB_DIR: params.apiBase,
      SMITHERSBOT_SETUP_POLL_SECONDS: params.pollSeconds ?? "1",
      SMITHERSBOT_SETUP_POLL_INTERVAL: params.pollInterval ?? "0.05",
      SMITHERSBOT_SETUP_SERVICE_WAIT_SECONDS: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

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

async function readGeneratedConfig(home: string, instance: "stable" | "dev" = "stable") {
  const stateDirName = instance === "dev" ? ".smithersbot-dev" : ".smithersbot";
  const configPath = path.join(home, stateDirName, "smithersbot.json");
  const envPath = path.join(home, stateDirName, ".env");
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
      agents: { defaults: { workspace?: string; identity: { operatorHonorific: string } } };
      goal: { defaultWorkspaceName?: string };
    },
    envRaw,
    configMode: configStat.mode & 0o777,
    envMode: envStat.mode & 0o777,
  };
}

describe("scripts/setup-smithersbot.sh", () => {
  it("documents the fresh-install default SmithersBot home", async () => {
    const [setupDoc, readme] = await Promise.all([
      fs.readFile(path.join(repoRoot, "SETUP.md"), "utf8"),
      fs.readFile(path.join(repoRoot, "README.md"), "utf8"),
    ]);

    expect(setupDoc).toContain("defaulting to `~/smithersbot-home`");
    expect(setupDoc).toContain("defaults to `~/smithersbot-home`");
    expect(setupDoc).toContain(
      "sudo apt install -y git curl ca-certificates gnupg build-essential bubblewrap socat",
    );
    expect(setupDoc).not.toContain("defaults to `~/smithersbot-goals`");
    expect(readme).toContain("`~/smithersbot-home/agent/workspaces`");
    expect(readme).toContain("`~/smithersbot-home/private/env/<workspace-name>/.env`");
    expect(readme).toContain("`~/smithersbot-home/agent/history`");
  });

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

  it("rejects unknown gateway instance names before setup starts", async () => {
    const home = await mkTempHome();
    const result = await runSetupPreflight({
      home,
      extraArgs: ["--instance", "prod"],
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(
      'Unknown SmithersBot gateway instance "prod". Allowed values: default, stable, dev.',
    );
  });

  it("suppresses successful install/build logs behind concise status lines", async () => {
    const home = await mkTempHome();
    const bin = path.join(home, "bin");
    await fs.mkdir(bin);
    await writeExecutable(path.join(bin, "corepack"), "#!/bin/bash\nexit 0\n");
    await writeExecutable(
      path.join(bin, "pnpm"),
      `#!/bin/bash
if [[ "$1" == "install" ]]; then
  echo "NOISY_INSTALL_OUTPUT"
  exit 0
fi
if [[ "$1" == "build" ]]; then
  echo "NOISY_BUILD_OUTPUT"
  exit 0
fi
exit 0
`,
    );
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      noBuild: false,
      repoPromptInput: "4\n",
      input: `${testToken}\n\n`,
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Checking system requirements...");
    expect(result.output).toMatch(/✓ Node \d+\.\d+\.\d+ or newer/);
    expect(result.output).toContain("✓ pnpm");
    expect(result.output).toContain("✓ git");
    expect(result.output).toContain("Installing dependencies...");
    expect(result.output).toContain("✓ Dependencies installed");
    expect(result.output).toContain("Building SmithersBot...");
    expect(result.output).toContain("✓ Build completed");
    expect(result.output).not.toContain("NOISY_INSTALL_OUTPUT");
    expect(result.output).not.toContain("NOISY_BUILD_OUTPUT");
  });

  it("prints captured install/build failure logs before exiting non-zero", async () => {
    const home = await mkTempHome();
    const bin = path.join(home, "bin");
    await fs.mkdir(bin);
    await writeExecutable(path.join(bin, "corepack"), "#!/bin/bash\nexit 0\n");
    await writeExecutable(
      path.join(bin, "pnpm"),
      `#!/bin/bash
if [[ "$1" == "install" ]]; then
  echo "useful install stdout"
  echo "useful install stderr" >&2
  exit 27
fi
exit 0
`,
    );
    const apiBase = await startTelegramStub(() => getMeSuccess);

    const result = await runSetup({
      home,
      apiBase,
      noBuild: false,
      repoPromptInput: "4\n",
      input: `${testToken}\n\n`,
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Installing dependencies...");
    expect(result.output).toContain("Installing dependencies failed. Last log lines:");
    expect(result.output).toContain("useful install stdout");
    expect(result.output).toContain("useful install stderr");
    expect(result.output).not.toContain("Step 1 of 6: SmithersBot home");
  });

  it("accepts a valid getMe token, discovers a private chat ID, and writes usable private files without echoing the token", async () => {
    const home = await mkTempHome();
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      input: `${testToken}\n\n`,
      pollSeconds: "2",
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toMatch(ansiPattern);
    expect(result.output).toContain(`Welcome to SmithersBot installation.

This installer will prepare the workspace, configure Telegram, and start the gateway so you can leave agents running without giving up control.

Very good. Let us begin.`);
    const introOutput = result.output.slice(
      0,
      result.output.indexOf("Step 1 of 6: SmithersBot home"),
    );
    expect(introOutput).not.toContain("first Telegram message");
    for (const header of [
      "Step 1 of 6: SmithersBot home",
      "Step 2 of 6: How SmithersBot addresses you",
      "Step 3 of 6: First workspace",
      "Step 4 of 6: Telegram bot",
      "Step 5 of 6: Repo chat backend",
      "Step 6 of 6: Run SmithersBot",
    ]) {
      expect(result.output).toContain(header);
    }
    expect(result.output).toContain(
      "https://github.com/smithersbot/smithersbot/blob/main/SETUP.md#7-create-a-telegram-bot",
    );
    expect(result.output).toContain("✓ Telegram bot verified:\n  @smithersbot2_test_bot");
    expect(result.output).toContain("Open this bot in Telegram:\n  @smithersbot2_test_bot");
    expect(result.output).toContain("Press Start, or send any message.");
    expect(result.output).toContain(
      "Do not use @BotFather here. BotFather has completed his part.",
    );
    expect(result.output).toContain("Waiting for your Telegram message...");
    expect(result.output).toContain("This can take up to 2 minutes.");
    expect(result.output).toContain(
      "✓ Detected Telegram private chat ID:\n  555111222\n\nUse this Telegram private chat ID for allowFrom? [Y/n]:",
    );
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
    const managedRoot = path.join(home, "smithersbot-home");
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
    expect(result.output).toContain(`✓ Very good. SmithersBot home is set:\n  ${managedRoot}`);
    expect(result.output).toContain("Nice to meet you, sir.");
    expect(result.output).toContain("I'll address you as sir from now on.");
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
    expect(result.output).toContain("Preparing the workspace...");
    expect(result.output).toContain(`✓ Workspace ready:\n  ${workspaceRepo}`);
    expect(result.output).not.toContain("Cloning into");
    expect(result.output).not.toContain(path.join(home, "smithersbot-goals"));
    expect(result.output).toContain(
      "Make sure to put all files you want SmithersBot to read and edit in that workspace.",
    );
    expect(result.output).toContain(
      `Private .env for this repo that SmithersBot cannot read:\n  ${privateEnvPath}`,
    );
    expect(result.output).not.toContain("SmithersBot setup complete.");
    expect(result.output).toContain("Setup complete");
    expect(result.output).toContain("Setup complete. The house is in order.");
    expect(result.output).toContain(`✓ SmithersBot home:\n  ${managedRoot}`);
    expect(result.output).toContain("✓ Telegram bot:\n  @smithersbot2_test_bot");
    expect(result.output).toContain("✓ Authorized Telegram chat ID:\n  555111222");
    expect(result.output).toContain(
      "Start SmithersBot from this checkout:\n\n  node scripts/run-node.mjs gateway",
    );
    expect(result.output).toContain("/help");
    expect(result.output).toContain("/commands");
    expect(result.output).toContain("/gateway_status");
    expect(result.output).toContain("/usage_status");
    expect(result.output).toContain("/goal_list");
    expect(result.output).toContain("/repo_chat say only: repo chat works");
    expect(result.output).toContain(
      "/new_goal Inspect the repository state and report whether the working tree is clean. Do not edit files.",
    );
  });

  it("keeps no-instance setup on the stable dirs even from the smithersbot-dev checkout", async () => {
    const home = await mkTempHome();
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      configDir: null,
      stateDir: null,
      repoPromptInput: "4\n",
      input: `${testToken}\n\n`,
    });

    expect(result.exitCode).toBe(0);
    await expect(fs.stat(path.join(home, ".smithersbot", ".env"))).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(home, ".smithersbot", "smithersbot.json")),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(home, "smithersbot-home", "agent", "workspaces")),
    ).resolves.toBeTruthy();
    await expect(fs.stat(path.join(home, ".smithersbot-dev"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(path.join(home, "smithersbot-dev-home"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(result.output).toContain(
      `✓ Very good. SmithersBot home is set:\n  ${path.join(home, "smithersbot-home")}`,
    );
    expect(result.output).toContain("  node scripts/run-node.mjs gateway");
    expect(result.output).not.toContain(
      "SMITHERSBOT_INSTANCE=dev node scripts/run-node.mjs gateway",
    );
  });

  it("--instance dev writes isolated dev config, state, managed home, and manual command", async () => {
    const home = await mkTempHome();
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      instance: "dev",
      configDir: null,
      stateDir: null,
      repoPromptInput: "4\n",
      input: `${testToken}\n\n`,
    });

    expect(result.exitCode).toBe(0);
    const generated = await readGeneratedConfig(home, "dev");
    expect(generated.envRaw).toContain(`TELEGRAM_BOT_TOKEN=${testToken}`);
    expect(generated.config.channels.telegram.allowFrom).toEqual(["555111222"]);
    const managedRoot = path.join(home, "smithersbot-dev-home");
    await expect(fs.stat(path.join(managedRoot, "agent", "workspaces"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(home, ".smithersbot"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(path.join(home, "smithersbot-home"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(result.output).toContain(`✓ Very good. SmithersBot home is set:\n  ${managedRoot}`);
    expect(result.output).toContain("  SMITHERSBOT_INSTANCE=dev node scripts/run-node.mjs gateway");
  });

  it("blocks configuring dev with the same Telegram token as stable without exposing it", async () => {
    const home = await mkTempHome();
    const stableDir = path.join(home, ".smithersbot");
    await fs.mkdir(stableDir, { recursive: true });
    await fs.writeFile(path.join(stableDir, ".env"), `TELEGRAM_BOT_TOKEN=${testToken}\n`, {
      mode: 0o600,
    });
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      instance: "dev",
      configDir: null,
      stateDir: null,
      repoPromptInput: "4\n",
      input: `${testToken}\n`,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(
      "dev gateway Telegram bot token must differ from the stable gateway token",
    );
    expect(result.output).not.toContain(testToken);
    await expect(fs.stat(path.join(home, ".smithersbot-dev", ".env"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("respects an existing former default SmithersBot home when the new default is absent", async () => {
    const home = await mkTempHome();
    const legacyRoot = path.join(home, "smithersbot-goals");
    await fs.mkdir(legacyRoot, { recursive: true });
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      repoPromptInput: "4\n",
      input: `${testToken}\n\n`,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(`✓ Very good. SmithersBot home is set:\n  ${legacyRoot}`);
    await expect(fs.stat(path.join(legacyRoot, "agent", "workspaces"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(home, "smithersbot-home"))).rejects.toMatchObject({
      code: "ENOENT",
    });
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
    expect(result.output).toContain(`✓ Very good. SmithersBot home is set:\n  ${customRoot}`);
  });

  it("supports choosing no first workspace while still writing usable config", async () => {
    const home = await mkTempHome();
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      repoPromptInput: "4\n",
      input: `${testToken}\n\n`,
    });

    expect(result.exitCode).toBe(0);
    const managedRoot = path.join(home, "smithersbot-home");
    expect(result.output).toContain(`Is there a repo you would like SmithersBot to work on first?

1) This SmithersBot checkout
   Copy this checkout into a new agent-editable workspace.

2) Another local repo path
   Copy or clone an existing local repo into a new agent-editable workspace.
   Example: ~/smithersbot

3) Clone a repo URL
   Clone a GitHub or Git repo URL into a new agent-editable workspace.

4) No thanks
   I will add workspaces myself later.

Choose [1/2/3/4]:`);
    expect(result.output).toContain(`✓ No first workspace created.

To add a workspace later:

1. Copy or clone your project into:
   ${managedRoot}/agent/workspaces/<workspace-name>

2. Put real project secrets in:
   ${managedRoot}/private/env/<workspace-name>/.env

3. Keep a redacted .env.example in the workspace.
   Agents can see which variables the project expects without seeing real secrets.

Anything under agent/workspaces can be read and edited by SmithersBot agents.

Private env/config/auth should stay under:
  ${managedRoot}/private

Very good. The workspace can be arranged later.`);
    const generated = await readGeneratedConfig(home);
    expect(generated.config.agents.defaults.workspace).toBeUndefined();
    expect(generated.config.goal.defaultWorkspaceName).toBeUndefined();
    expect(generated.config.agents.defaults.identity.operatorHonorific).toBe("sir");
    await expect(fs.readdir(path.join(managedRoot, "agent", "workspaces"))).resolves.toEqual([]);
    await expect(fs.readdir(path.join(managedRoot, "private", "env"))).resolves.toEqual([]);
  });

  it("keeps setup output plain when NO_COLOR is set or stdout is not a TTY", async () => {
    const home = await mkTempHome();
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      repoPromptInput: "4\n",
      input: `${testToken}\n\n`,
      env: { NO_COLOR: "" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toMatch(ansiPattern);
    expect(result.output).toContain("Step 1 of 6: SmithersBot home");
    expect(result.output).toContain("✓ No first workspace created.");
  });

  it("retries invalid local repo paths and accepts the next valid path", async () => {
    const home = await mkTempHome();
    const source = await mkGitFixture(home, "source-repo");
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      repoPromptInput: `2\nsmithersbot\n${source}\n`,
      input: `${testToken}\n\n`,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(`Local repo path:
Example: ~/smithersbot

Local repo path:`);
    expect(result.output).toContain(`✕ That path does not exist:
  smithersbot

Enter a local repo path, or press Ctrl-C to cancel.
Example: ~/smithersbot`);
    const workspaceRepo = path.join(home, "smithersbot-home", "agent", "workspaces", "source-repo");
    await expect(fs.readFile(path.join(workspaceRepo, "README.md"), "utf8")).resolves.toContain(
      "# source-repo",
    );
  });

  it("expands home-relative local repo paths before validation", async () => {
    const home = await mkTempHome();
    await mkGitFixture(home, "smithersbot");
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      repoPromptInput: "2\n~/smithersbot\n",
      input: `${testToken}\n\n`,
    });

    expect(result.exitCode).toBe(0);
    const workspaceRepo = path.join(home, "smithersbot-home", "agent", "workspaces", "smithersbot");
    await expect(fs.readFile(path.join(workspaceRepo, "README.md"), "utf8")).resolves.toContain(
      "# smithersbot",
    );
    expect(result.output).not.toContain("That path does not exist");
  });

  it("installs dependencies in a new pnpm first workspace with concise output", async () => {
    const home = await mkTempHome();
    const source = await mkPnpmGitFixture(home, "source-repo");
    const bin = path.join(home, "bin");
    const pnpmLog = path.join(home, "pnpm.log");
    await fs.mkdir(bin);
    await writePnpmRecorder(bin, { logPath: pnpmLog });
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
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    const workspaceRepo = path.join(home, "smithersbot-home", "agent", "workspaces", "source-repo");
    expect(result.exitCode).toBe(0);
    await expect(fs.readFile(pnpmLog, "utf8")).resolves.toContain(
      `${workspaceRepo}|install --frozen-lockfile`,
    );
    expect(result.output).toContain("Installing workspace dependencies...");
    expect(result.output).toContain("✓ Workspace dependencies installed");
    expect(result.output).not.toContain("NOISY_WORKSPACE_INSTALL");
  });

  it("prints manual workspace dependency guidance when install fails without aborting", async () => {
    const home = await mkTempHome();
    const source = await mkPnpmGitFixture(home, "source-repo");
    const bin = path.join(home, "bin");
    const pnpmLog = path.join(home, "pnpm.log");
    await fs.mkdir(bin);
    await writePnpmRecorder(bin, { logPath: pnpmLog, failInstall: true });
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
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    const workspaceRepo = path.join(home, "smithersbot-home", "agent", "workspaces", "source-repo");
    expect(result.exitCode).toBe(0);
    await expect(fs.readFile(pnpmLog, "utf8")).resolves.toContain(
      `${workspaceRepo}|install --frozen-lockfile`,
    );
    expect(result.output).toContain("Installing workspace dependencies failed. Last log lines:");
    expect(result.output).toContain("workspace install stdout");
    expect(result.output).toContain("workspace install stderr");
    expect(result.output).toContain("Workspace was created, but dependency installation failed.");
    expect(result.output).toContain(`cd ${workspaceRepo} && pnpm install --frozen-lockfile`);
    expect(result.output).toContain("Setup complete");
  });

  it("does not auto-install dependencies in an existing workspace", async () => {
    const home = await mkTempHome();
    const source = await mkPnpmGitFixture(home, "source-repo");
    const managedRoot = path.join(home, "smithersbot-home");
    const workspace = path.join(managedRoot, "agent", "workspaces", "source-repo");
    const bin = path.join(home, "bin");
    const pnpmLog = path.join(home, "pnpm.log");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await fs.mkdir(bin);
    await writePnpmRecorder(bin, { logPath: pnpmLog });
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      repoPromptInput: `2\n${source}\n`,
      workspaceNameInput: "\n1\n",
      input: `${testToken}\n\n`,
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    expect(result.exitCode).toBe(0);
    await expect(fs.readFile(pnpmLog, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.output).toContain(`✓ Using existing agent workspace:\n  ${workspace}`);
    expect(result.output).toContain(`cd ${workspace} && pnpm install --frozen-lockfile`);
    expect(result.output).not.toContain("Installing workspace dependencies...");
  });

  it("skips workspace dependency install when no first workspace is created", async () => {
    const home = await mkTempHome();
    const bin = path.join(home, "bin");
    const pnpmLog = path.join(home, "pnpm.log");
    await fs.mkdir(bin);
    await writePnpmRecorder(bin, { logPath: pnpmLog });
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      repoPromptInput: "4\n",
      input: `${testToken}\n\n`,
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    expect(result.exitCode).toBe(0);
    await expect(fs.readFile(pnpmLog, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.output).toContain("✓ No first workspace created.");
    expect(result.output).not.toContain("Installing workspace dependencies...");
    expect(result.output).not.toContain("Workspace dependencies installed");
  });

  it("uses an existing new-layout workspace without overwriting it", async () => {
    const home = await mkTempHome();
    const managedRoot = path.join(home, "smithersbot-home");
    const workspace = path.join(managedRoot, "agent", "workspaces", "source-repo");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "sentinel.txt"), "keep me\n", "utf8");
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      workspaceNameInput: "\n1\n",
      input: `${testToken}\n\n`,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(
      `A workspace named source-repo already exists:\n  ${workspace}`,
    );
    expect(result.output).toContain(`✓ Using existing agent workspace:\n  ${workspace}`);
    await expect(fs.readFile(path.join(workspace, "sentinel.txt"), "utf8")).resolves.toBe(
      "keep me\n",
    );
    await expect(fs.stat(path.join(workspace, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    const generated = await readGeneratedConfig(home);
    expect(generated.config.agents.defaults.workspace).toBe(workspace);
  });

  it("uses an existing legacy workspace repo child when selected", async () => {
    const home = await mkTempHome();
    const legacyRepo = path.join(
      home,
      "smithersbot-home",
      "agent",
      "workspaces",
      "source-repo",
      "repo",
    );
    await fs.mkdir(legacyRepo, { recursive: true });
    await fs.writeFile(path.join(legacyRepo, "sentinel.txt"), "legacy\n", "utf8");
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      workspaceNameInput: "\n1\n",
      input: `${testToken}\n\n`,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(`A legacy workspace already exists:\n  ${legacyRepo}`);
    expect(result.output).toContain(`✓ Using existing legacy workspace:\n  ${legacyRepo}`);
    const generated = await readGeneratedConfig(home);
    expect(generated.config.agents.defaults.workspace).toBe(legacyRepo);
    await expect(fs.readFile(path.join(legacyRepo, "sentinel.txt"), "utf8")).resolves.toBe(
      "legacy\n",
    );
  });

  it("reprompts when an existing workspace user chooses another name", async () => {
    const home = await mkTempHome();
    const existing = path.join(home, "smithersbot-home", "agent", "workspaces", "source-repo");
    await fs.mkdir(existing, { recursive: true });
    await fs.writeFile(path.join(existing, "sentinel.txt"), "keep\n", "utf8");
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      workspaceNameInput: "\n2\nnew-name\n",
      input: `${testToken}\n\n`,
    });

    expect(result.exitCode).toBe(0);
    const generated = await readGeneratedConfig(home);
    expect(generated.config.goal.defaultWorkspaceName).toBe("new-name");
    expect(generated.config.agents.defaults.workspace).toBe(
      path.join(home, "smithersbot-home", "agent", "workspaces", "new-name"),
    );
    await expect(fs.readFile(path.join(existing, "sentinel.txt"), "utf8")).resolves.toBe("keep\n");
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
    const workspaceRepo = path.join(home, "smithersbot-home", "agent", "workspaces", "url-repo");
    await expect(fs.readFile(path.join(workspaceRepo, "README.md"), "utf8")).resolves.toContain(
      "# url-repo",
    );
    await expect(fs.stat(path.join(workspaceRepo, "repo"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(result.output).toContain("Preparing the workspace...");
    expect(result.output).toContain(`✓ Workspace ready:\n  ${workspaceRepo}`);
    expect(result.output).not.toContain("Cloning into");
  });

  it("prints captured workspace preparation logs when clone fails", async () => {
    const home = await mkTempHome();
    const bin = path.join(home, "bin");
    await fs.mkdir(bin);
    await writeExecutable(
      path.join(bin, "git"),
      `#!/bin/bash
if [[ "$1" == "clone" ]]; then
  echo "useful clone stdout"
  echo "useful clone stderr" >&2
  exit 42
fi
exit 0
`,
    );
    const apiBase = await startTelegramStub(() => getMeSuccess);

    const result = await runSetup({
      home,
      apiBase,
      repoPromptInput: "3\nhttps://example.invalid/acme/fail-repo.git\n",
      workspaceNameInput: "\n",
      input: "",
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Preparing the workspace...");
    expect(result.output).toContain("Preparing the workspace failed. Last log lines:");
    expect(result.output).toContain("useful clone stdout");
    expect(result.output).toContain("useful clone stderr");
    expect(result.output).not.toContain("✓ Workspace ready:");
    expect(result.output).not.toContain("Setup complete");
  });

  it("defaults this checkout workspace name to the package name", async () => {
    const home = await mkTempHome();
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      repoPromptInput: "1\n",
      input: `${testToken}\n\n`,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Workspace name [ENTER for default: smithersbot]:");
    const generated = await readGeneratedConfig(home);
    expect(generated.config.goal.defaultWorkspaceName).toBe("smithersbot");
    expect(generated.config.agents.defaults.workspace).toBe(
      path.join(home, "smithersbot-home", "agent", "workspaces", "smithersbot"),
    );
  });

  it("defaults clone URL workspace names from the URL basename", async () => {
    const home = await mkTempHome();
    const existing = path.join(home, "smithersbot-home", "agent", "workspaces", "my-app");
    await fs.mkdir(existing, { recursive: true });
    await fs.writeFile(path.join(existing, "sentinel.txt"), "keep\n", "utf8");
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      repoPromptInput: "3\nhttps://example.invalid/acme/my-app.git\n",
      workspaceNameInput: "\n3\n",
      input: `${testToken}\n\n`,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Workspace name [ENTER for default: my-app]:");
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
      "smithersbot-home",
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
    expect(result.output).toContain("Preparing the workspace...");
    expect(result.output).toContain(`✓ Workspace ready:\n  ${workspaceRepo}`);
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
      fs.stat(path.join(home, "smithersbot-home", "agent", "workspaces", "safe-name")),
    ).resolves.toBeTruthy();
  });

  it("maps repo-chat backend menu choices and keeps --backend working", async () => {
    const cases: Array<{
      input: string;
      expected: string;
      backendArg?: "codex" | "claude_code" | null;
      env?: NodeJS.ProcessEnv;
      expectRetry?: boolean;
    }> = [
      { input: `${testToken}\n\n\n`, expected: "codex", backendArg: null },
      { input: `${testToken}\n\n1\n`, expected: "codex", backendArg: null },
      { input: `${testToken}\n\ncodex\n`, expected: "codex", backendArg: null },
      { input: `${testToken}\n\nCodex\n`, expected: "codex", backendArg: null },
      { input: `${testToken}\n\nCODEX\n`, expected: "codex", backendArg: null },
      { input: `${testToken}\n\n22\n1\n`, expected: "codex", backendArg: null, expectRetry: true },
      { input: `${testToken}\n\n2\n`, expected: "claude_code", backendArg: null },
      { input: `${testToken}\n\nclaude_code\n`, expected: "claude_code", backendArg: null },
      { input: `${testToken}\n\nClaude Code\n`, expected: "claude_code", backendArg: null },
      { input: `${testToken}\n\nclaude code\n`, expected: "claude_code", backendArg: null },
      { input: `${testToken}\n\nCLAUDE CODE\n`, expected: "claude_code", backendArg: null },
      { input: `${testToken}\n\nCLAUDE_CODE\n`, expected: "claude_code", backendArg: null },
      { input: `${testToken}\n\n`, expected: "claude_code", backendArg: "claude_code" },
    ];

    for (const testCase of cases) {
      const home = await mkTempHome();
      const apiBase = await startTelegramStub((requestPath) => {
        if (requestPath.endsWith("/getMe")) return getMeSuccess;
        if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
        return { ok: false, description: `unexpected path ${requestPath}` };
      });
      let env = testCase.env;
      if (testCase.expected === "claude_code") {
        const bin = path.join(home, "backend-bin");
        await fs.mkdir(bin);
        await writeExecutable(
          path.join(bin, "claude"),
          "#!/bin/bash\nprintf 'claude fixture\\n'\n",
        );
        await writeExecutable(path.join(bin, "bwrap"), "#!/bin/bash\nexit 0\n");
        await writeExecutable(path.join(bin, "socat"), "#!/bin/bash\nexit 0\n");
        env = { ...env, PATH: `${bin}:${process.env.PATH ?? ""}` };
      }

      const result = await runSetup({
        home,
        apiBase,
        input: testCase.input,
        backendArg: testCase.backendArg,
        env,
      });

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Step 5 of 6: Repo chat backend");
      expect(result.output).toContain("✓ Repo chat backend:");
      if (testCase.expectRetry) {
        expect(result.output).toContain("Please choose 1/2, Codex, Claude Code, or claude_code.");
      }
      expect(result.output).not.toContain("Codex login works");
      const generated = await readGeneratedConfig(home);
      expect(generated.config.channels.telegram.repoChatBackend).toBe(testCase.expected);
    }
  });

  it("prints the repo-chat backend menu copy when prompting interactively", async () => {
    const home = await mkTempHome();
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      input: `${testToken}\n\n\n`,
      backendArg: null,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(`Which backend should repo chat use by default?

1) Codex
2) Claude Code

Choose [ENTER for default: Codex]:`);
    expect(result.output).toContain("Checking Codex backend...");
    expect(result.output).toContain("✓ Repo chat backend:\n  Codex");
    expect(result.output).not.toContain("Codex login works");
  });

  it("fails Codex setup with recovery guidance when the native sandbox helper is missing", async () => {
    const home = await mkTempHome();
    const bin = path.join(home, "bin");
    await fs.mkdir(bin);
    await writeExecutable(path.join(bin, "codex"), "#!/bin/bash\nprintf 'codex fixture\\n'\n");
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      repoPromptInput: "4\n",
      input: `${testToken}\n\n`,
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Checking Codex backend...");
    expect(result.output).toContain("✓ Codex CLI found");
    expect(result.output).toContain(
      "✕ Codex is installed, but SmithersBot could not locate the Codex native sandbox helper.",
    );
    expect(result.output).toContain("  sudo npm install -g @openai/codex@latest");
    expect(result.output).toContain("  codex login");
    expect(result.output).toContain('  codex "say only: codex works"');
    expect(result.output).toContain("Then run setup again.");
    expect(result.output).not.toContain("Setup complete");
  });

  it("fails Claude Code setup with sandbox dependency guidance when bwrap or socat is missing", async () => {
    const home = await mkTempHome();
    const bin = await writeIsolatedSetupPath(home);
    await writeExecutable(path.join(bin, "claude"), "#!/bin/bash\nprintf 'claude fixture\\n'\n");
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      repoPromptInput: "4\n",
      input: `${testToken}\n\n`,
      backendArg: "claude_code",
      env: { PATH: bin },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Checking Claude Code backend...");
    expect(result.output).toContain("✓ Claude Code CLI found");
    expect(result.output).toContain(
      "✕ Claude Code is installed, but its native sandbox dependencies are missing.",
    );
    expect(result.output).toContain("  sudo apt install -y bubblewrap socat");
    expect(result.output).toContain('  claude -p "say only: claude works"');
    expect(result.output).not.toMatch(/disable/i);
    expect(result.output).not.toContain("Setup complete");
  });

  it("warns but continues when Claude Code is installed with missing sandbox tools and Codex is active", async () => {
    const home = await mkTempHome();
    const bin = await writeIsolatedSetupPath(home);
    await writeExecutable(path.join(bin, "claude"), "#!/bin/bash\nprintf 'claude fixture\\n'\n");
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      repoPromptInput: "4\n",
      input: `${testToken}\n\n`,
      env: { PATH: bin },
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Checking Codex backend...");
    expect(result.output).toContain("Warning: Codex CLI was not found on PATH.");
    expect(result.output).toContain(
      "Warning: Claude Code is installed, but its native sandbox dependencies are missing.",
    );
    expect(result.output).toContain("  sudo apt install -y bubblewrap socat");
    expect(result.output).toContain("✓ Repo chat backend:\n  Codex");
    expect(result.output).toContain("Setup complete");
  });

  it("starts the correct systemd user service by default when accepted", async () => {
    const home = await mkTempHome();
    const bin = path.join(home, "bin");
    const argvLog = path.join(home, "systemctl-argv.log");
    const devUnit = path.join(
      home,
      ".config",
      "systemd",
      "user",
      "smithersbot-dev-gateway.service",
    );
    await fs.mkdir(bin);
    await fs.mkdir(path.dirname(devUnit), { recursive: true });
    await fs.writeFile(devUnit, "keep dev unit\n", "utf8");
    await writeExecutable(
      path.join(bin, "systemctl"),
      `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}\nif [[ "$*" == "--user --version" ]]; then exit 0; fi\nexit 0\n`,
    );
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      input: `${testToken}\n\n`,
      systemdInput: "\n",
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    expect(result.exitCode).toBe(0);
    const argv = await fs.readFile(argvLog, "utf8");
    expect(argv).toContain("--user daemon-reload");
    expect(argv).toContain("--user enable --now smithersbot-gateway.service");
    expect(argv).toContain("--user is-active smithersbot-gateway.service");
    expect(argv).not.toMatch(/(^|\s)smithersbot\.service(\s|$)/);
    expect(result.output).toContain("✓ SmithersBot is now standing by in the background.");
    expect(result.output).toContain(
      "SmithersBot may take 1-2 minutes to answer the first Telegram message.",
    );
    expect(result.output).toContain("✓ SmithersBot is running:\n  smithersbot-gateway.service");
    expect(result.output).toContain("journalctl --user -u smithersbot-gateway.service -f");
    expect((result.output.match(/Next commands:/g) ?? []).length).toBe(0);
    await expect(fs.readFile(devUnit, "utf8")).resolves.toBe("keep dev unit\n");
  });

  it("starts the dev systemd user service when --instance dev is accepted", async () => {
    const home = await mkTempHome();
    const bin = path.join(home, "bin");
    const argvLog = path.join(home, "systemctl-argv.log");
    const stableUnit = path.join(home, ".config", "systemd", "user", "smithersbot-gateway.service");
    await fs.mkdir(bin);
    await fs.mkdir(path.dirname(stableUnit), { recursive: true });
    await fs.writeFile(stableUnit, "keep stable unit\n", "utf8");
    await writeExecutable(
      path.join(bin, "systemctl"),
      `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}\nif [[ "$*" == "--user --version" ]]; then exit 0; fi\nexit 0\n`,
    );
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      instance: "dev",
      configDir: null,
      stateDir: null,
      repoPromptInput: "4\n",
      input: `${testToken}\n\n`,
      systemdInput: "\n",
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    expect(result.exitCode).toBe(0);
    const argv = await fs.readFile(argvLog, "utf8");
    expect(argv).toContain("--user daemon-reload");
    expect(argv).toContain("--user enable --now smithersbot-dev-gateway.service");
    expect(argv).toContain("--user is-active smithersbot-dev-gateway.service");
    expect(argv).not.toContain("--user enable --now smithersbot-gateway.service");
    const unit = await fs.readFile(
      path.join(home, ".config", "systemd", "user", "smithersbot-dev-gateway.service"),
      "utf8",
    );
    expect(unit).toContain("EnvironmentFile=%h/.smithersbot-dev/.env\n");
    expect(unit).toContain("Environment=SMITHERSBOT_INSTANCE=dev\n");
    expect(unit).toContain("Environment=SMITHERSBOT_GATEWAY_PORT=18790\n");
    expect(unit).toContain(`WorkingDirectory=${repoRoot}\n`);
    await expect(fs.readFile(stableUnit, "utf8")).resolves.toBe("keep stable unit\n");
    expect(result.output).toContain("✓ SmithersBot is running:\n  smithersbot-dev-gateway.service");
    expect(result.output).toContain("journalctl --user -u smithersbot-dev-gateway.service -f");
  });

  it("prints a service-start failure block without setup complete when systemd never becomes active", async () => {
    const home = await mkTempHome();
    const bin = path.join(home, "bin");
    const argvLog = path.join(home, "systemctl-argv.log");
    await fs.mkdir(bin);
    await writeExecutable(
      path.join(bin, "systemctl"),
      `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}
if [[ "$*" == "--user --version" ]]; then exit 0; fi
if [[ "$*" == "--user is-active smithersbot-gateway.service" ]]; then exit 3; fi
exit 0
`,
    );
    const apiBase = await startTelegramStub((requestPath) => {
      if (requestPath.endsWith("/getMe")) return getMeSuccess;
      if (requestPath.endsWith("/getUpdates")) return getUpdatesPrivate;
      return { ok: false, description: `unexpected path ${requestPath}` };
    });

    const result = await runSetup({
      home,
      apiBase,
      input: `${testToken}\n\n`,
      systemdInput: "\n",
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    expect(result.exitCode).not.toBe(0);
    const argv = await fs.readFile(argvLog, "utf8");
    expect(argv).toContain("--user daemon-reload");
    expect(argv).toContain("--user enable --now smithersbot-gateway.service");
    expect(argv).toContain("--user is-active smithersbot-gateway.service");
    expect(result.output).toContain("SmithersBot did not start");
    expect(result.output).toContain(
      "systemctl --user status smithersbot-gateway.service --no-pager",
    );
    expect(result.output).toContain(
      "journalctl --user -u smithersbot-gateway.service -n 120 --no-pager",
    );
    expect(result.output).not.toContain("Setup complete");
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

    const result = await runSetup({
      home,
      apiBase,
      input: `${testToken}\n\n`,
      pollSeconds: "2",
    });

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
