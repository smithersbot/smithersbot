import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockLoadConfig } = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(() => ({})),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mockLoadConfig,
}));

import {
  buildClaudeDriverSpawnCommand,
  resolveClaudeDriver,
  runCliProcess,
} from "./cli-process.js";

// Smoke tests for the runCliProcess default-env contract: callers that omit
// `env` get a credential-stripped copy of process.env, so any new LLM caller
// that forgets to pass env still fails closed for secret exposure.
describe("runCliProcess default env", () => {
  let workDir: string;
  let outPath: string;
  let errPath: string;
  const originalTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalGatewayToken = process.env.SMITHERSBOT_GATEWAY_TOKEN;
  const originalLegacyToken = process.env.MOLTBOT_GATEWAY_TOKEN;

  beforeEach(() => {
    mockLoadConfig.mockReturnValue({});
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-process-test-"));
    outPath = path.join(workDir, "stdout.txt");
    errPath = path.join(workDir, "stderr.txt");
    process.env.TELEGRAM_BOT_TOKEN = "FAKE_TELEGRAM_TOKEN_FOR_TEST";
    process.env.SMITHERSBOT_GATEWAY_TOKEN = "FAKE_GATEWAY_TOKEN_FOR_TEST";
    process.env.MOLTBOT_GATEWAY_TOKEN = "FAKE_LEGACY_GATEWAY_TOKEN_FOR_TEST";
  });

  afterEach(() => {
    if (originalTelegramToken == null) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalTelegramToken;
    if (originalGatewayToken == null) delete process.env.SMITHERSBOT_GATEWAY_TOKEN;
    else process.env.SMITHERSBOT_GATEWAY_TOKEN = originalGatewayToken;
    if (originalLegacyToken == null) delete process.env.MOLTBOT_GATEWAY_TOKEN;
    else process.env.MOLTBOT_GATEWAY_TOKEN = originalLegacyToken;
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("strips known credential keys when env is omitted", async () => {
    // Use printenv-via-node to capture the child env: a Node subprocess that
    // prints its own process.env, so we can assert what runCliProcess passed
    // to the spawned process.
    const result = await runCliProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify(process.env));"],
      cwd: workDir,
      timeoutMs: 30_000,
      stdoutPath: outPath,
      stderrPath: errPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    const childEnv = JSON.parse(result.stdout) as Record<string, string>;
    expect(childEnv).not.toHaveProperty("TELEGRAM_BOT_TOKEN");
    expect(childEnv).not.toHaveProperty("SMITHERSBOT_GATEWAY_TOKEN");
    expect(childEnv).not.toHaveProperty("MOLTBOT_GATEWAY_TOKEN");
    // Sanity: non-credential keys still propagate so the subprocess can run.
    expect(childEnv).toHaveProperty("PATH");
  });

  it("passes explicit env through unchanged", async () => {
    const result = await runCliProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify(process.env));"],
      cwd: workDir,
      timeoutMs: 30_000,
      stdoutPath: outPath,
      stderrPath: errPath,
      env: {
        PATH: process.env.PATH,
        TELEGRAM_BOT_TOKEN: "EXPLICIT_OPT_IN_TOKEN",
      },
    });

    expect(result.exitCode).toBe(0);
    const childEnv = JSON.parse(result.stdout) as Record<string, string>;
    // Explicit env is honored verbatim — callers that opt in keep their keys.
    expect(childEnv.TELEGRAM_BOT_TOKEN).toBe("EXPLICIT_OPT_IN_TOKEN");
  });

  it("clears the SIGTERM grace timer when an aborted process exits promptly", async () => {
    const abortController = new AbortController();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    try {
      const runPromise = runCliProcess({
        command: process.execPath,
        args: [
          "-e",
          [
            "process.on('SIGTERM', () => process.exit(0));",
            "process.stdout.write('ready');",
            "setInterval(() => {}, 1000);",
          ].join(""),
        ],
        cwd: workDir,
        timeoutMs: 30_000,
        abortSignal: abortController.signal,
        stdoutPath: outPath,
        stderrPath: errPath,
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      abortController.abort();

      const result = await runPromise;
      expect(result.timedOut).toBe(true);
      expect(result.exitCode === 0 || result.signal === "SIGTERM").toBe(true);

      const graceTimerHandle = setTimeoutSpy.mock.calls
        .map((call, index) => ({
          delay: call[1],
          handle: setTimeoutSpy.mock.results[index]?.value,
        }))
        .find((call) => call.delay === 5_000)?.handle;

      expect(graceTimerHandle).toBeDefined();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(graceTimerHandle);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });
});

describe("runCliProcess Claude driver seam", () => {
  let workDir: string;
  let binDir: string;
  let originalPath: string | undefined;

  function writeExecutableMarker(name: string): string {
    const filePath = path.join(binDir, name);
    fs.writeFileSync(filePath, "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 });
    return filePath;
  }

  beforeEach(() => {
    mockLoadConfig.mockReturnValue({});
    workDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-cli-process-driver-test-"));
    binDir = path.join(workDir, "bin");
    fs.mkdirSync(binDir);
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  });

  afterEach(() => {
    mockLoadConfig.mockReturnValue({});
    if (originalPath == null) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("defaults to direct mode and preserves Claude prompt-run args byte-for-byte", async () => {
    const claude = "/usr/local/bin/claude";
    const args = [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--settings",
      path.join(workDir, "settings.json"),
      "--setting-sources",
      "",
      "--permission-mode",
      "default",
      "--allowedTools",
      "Read,Bash",
      "--append-system-prompt",
      "caps",
      "--model",
      "claude-test",
      "hello",
    ];

    const result = buildClaudeDriverSpawnCommand({
      command: claude,
      args,
      cwd: workDir,
      env: { PATH: process.env.PATH },
    });

    expect(result.command).toBe(claude);
    expect(result.args).toEqual(args);
  });

  it("maps Claude prompt-run args to tui-pilot print when goal.claudeDriver is tui-pilot", async () => {
    const claude = "/usr/local/bin/claude";
    const tuiPilot = writeExecutableMarker("tui-pilot");
    const settingsPath = path.join(workDir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      `${JSON.stringify({ sandbox: { enabled: true }, permissions: { deny: ["WebFetch"] } })}\n`,
    );
    mockLoadConfig.mockReturnValue({ goal: { claudeDriver: "tui-pilot" } });

    const result = buildClaudeDriverSpawnCommand({
      command: claude,
      args: [
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
        "--settings",
        settingsPath,
        "--setting-sources",
        "",
        "--permission-mode",
        "default",
        "--allowedTools",
        "Read,Bash",
        "--append-system-prompt",
        "caps",
        "--max-turns",
        "1",
        "--session-id",
        "11111111-1111-4111-8111-111111111111",
        "--model",
        "claude-test",
        "hello",
      ],
      cwd: workDir,
      env: { PATH: process.env.PATH, TUI_PILOT_BIN: tuiPilot },
    });

    expect(result.command).toBe(tuiPilot);
    expect(result.args).toEqual([
      "print",
      "--output-format",
      "stream-json",
      "--policy",
      "deny",
      "--cwd",
      workDir,
      "--settings",
      settingsPath,
      "--setting-sources",
      "",
      "--session-id",
      "11111111-1111-4111-8111-111111111111",
      "--append-system-prompt",
      "caps",
      "--allowedTools",
      "Read,Bash",
      "--max-turns",
      "1",
      "hello",
    ]);
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toMatchObject({
      sandbox: { enabled: true },
      permissions: { deny: ["WebFetch"] },
      model: "claude-test",
    });
  });

  it("uses configured tui-pilot binary before PATH lookup", async () => {
    const claude = "/usr/local/bin/claude";
    const configuredTuiPilot = path.join(workDir, "configured-tui-pilot");
    mockLoadConfig.mockReturnValue({
      goal: { claudeDriver: "tui-pilot", tuiPilotBinary: configuredTuiPilot },
    });

    const result = buildClaudeDriverSpawnCommand({
      command: claude,
      args: ["-p", "--output-format", "stream-json", "hello"],
      cwd: workDir,
      env: { PATH: process.env.PATH },
    });

    expect(result.command).toBe(configuredTuiPilot);
    expect(result.args).toEqual([
      "print",
      "--output-format",
      "stream-json",
      "--policy",
      "deny",
      "--cwd",
      workDir,
      "hello",
    ]);
  });

  it("passes non-Claude commands through unchanged even when tui-pilot is enabled", async () => {
    const helper = "/usr/local/bin/helper";
    mockLoadConfig.mockReturnValue({ goal: { claudeDriver: "tui-pilot" } });

    const result = buildClaudeDriverSpawnCommand({
      command: helper,
      args: ["-p", "--output-format", "stream-json", "hello"],
      cwd: workDir,
      env: { PATH: process.env.PATH },
    });

    expect(result.command).toBe(helper);
    expect(result.args).toEqual(["-p", "--output-format", "stream-json", "hello"]);
  });

  it("passes non-prompt Claude commands through unchanged when tui-pilot is enabled", async () => {
    const claude = "/usr/local/bin/claude";
    mockLoadConfig.mockReturnValue({ goal: { claudeDriver: "tui-pilot" } });

    const result = buildClaudeDriverSpawnCommand({
      command: claude,
      args: ["--version"],
      cwd: workDir,
      env: { PATH: process.env.PATH },
    });

    expect(result.command).toBe(claude);
    expect(result.args).toEqual(["--version"]);
  });
});

describe("resolveClaudeDriver per-site selection", () => {
  beforeEach(() => mockLoadConfig.mockReturnValue({}));
  afterEach(() => mockLoadConfig.mockReturnValue({}));

  it("defaults to direct when nothing is configured", () => {
    mockLoadConfig.mockReturnValue({});
    expect(resolveClaudeDriver()).toBe("direct");
    expect(resolveClaudeDriver("cli-worker")).toBe("direct");
  });

  it("honors the global goal.claudeDriver for every site", () => {
    mockLoadConfig.mockReturnValue({ goal: { claudeDriver: "tui-pilot" } });
    expect(resolveClaudeDriver()).toBe("tui-pilot");
    expect(resolveClaudeDriver("lessons")).toBe("tui-pilot");
  });

  it("lets a per-site override win over the global default (the S3 canary)", () => {
    mockLoadConfig.mockReturnValue({
      goal: {
        claudeDriver: "direct",
        tuiPilot: {
          sites: {
            "cli-worker": "tui-pilot",
            "cli-planner": "tui-pilot",
            "post-execution-report": "tui-pilot",
            "repo-chat-worker": "tui-pilot",
          },
        },
      },
    });
    // Canary sites flip to tui-pilot while the global default stays direct.
    expect(resolveClaudeDriver("cli-worker")).toBe("tui-pilot");
    expect(resolveClaudeDriver("repo-chat-worker")).toBe("tui-pilot");
    // A non-canary site (and the global default) stay direct.
    expect(resolveClaudeDriver("lessons")).toBe("direct");
    expect(resolveClaudeDriver()).toBe("direct");
  });

  it("lets a per-site override pin a site back to direct when the global default is tui-pilot", () => {
    mockLoadConfig.mockReturnValue({
      goal: { claudeDriver: "tui-pilot", tuiPilot: { sites: { nightwatch: "direct" } } },
    });
    expect(resolveClaudeDriver("nightwatch")).toBe("direct");
    expect(resolveClaudeDriver("cli-worker")).toBe("tui-pilot");
  });
});
