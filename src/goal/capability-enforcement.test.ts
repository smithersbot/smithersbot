import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BashOperations } from "@mariozechner/pi-coding-agent";
import {
  createEnforcedBashOperations,
  createEnforcedCodingTools,
} from "./capability-enforcement.js";
import { HARD_DENIES, checkCommandDeny, checkPathDeny } from "./hard-deny.js";

const WORKING_DIR = "/home/user/project";
const mockSpawn = vi.fn();
let capturedBashOps: BashOperations | undefined;

afterEach(() => {
  capturedBashOps = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
  };
});

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createCodingTools: (
    _workingDir: string,
    options?: { bash?: { operations?: BashOperations } },
  ) => {
    capturedBashOps = options?.bash?.operations;
    return [
      { name: "Read", execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) },
      { name: "Write", execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) },
      { name: "Edit", execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) },
    ];
  },
}));

/** Mock BashOperations that records calls. */
function mockBashOps(): BashOperations & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async exec(command, _cwd, options) {
      calls.push(command);
      options.onData(Buffer.from("ok\n"));
      return { exitCode: 0 };
    },
  };
}

function createEnoentError(): NodeJS.ErrnoException {
  const error = new Error("ENOENT") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

function createMockSpawnChild(exitCode = 0) {
  const closeHandlers: Array<(code: number | null) => void> = [];
  const child = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "close") {
        closeHandlers.push(handler as (code: number | null) => void);
      }
      return child;
    }),
    kill: vi.fn(),
  };

  queueMicrotask(() => {
    for (const handler of closeHandlers) {
      handler(exitCode);
    }
  });

  return child;
}

function createMockSpawnErrorChild() {
  const errorHandlers: Array<() => void> = [];
  const child = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "error") {
        errorHandlers.push(handler as () => void);
      }
      return child;
    }),
    kill: vi.fn(),
  };

  queueMicrotask(() => {
    for (const handler of errorHandlers) {
      handler();
    }
  });

  return child;
}

describe("hard deny helpers", () => {
  it("checkPathDeny blocks .env files", () => {
    const deny = checkPathDeny("/home/user/project/.env.local");
    expect(deny).not.toBeNull();
  });

  it("checkPathDeny allows normal source files", () => {
    const deny = checkPathDeny("/home/user/project/src/index.ts");
    expect(deny).toBeNull();
  });

  it("checkCommandDeny blocks sudo", () => {
    const deny = checkCommandDeny("sudo rm -rf /");
    expect(deny).not.toBeNull();
  });

  it("checkCommandDeny allows pnpm test", () => {
    const deny = checkCommandDeny("pnpm test");
    expect(deny).toBeNull();
  });

  it("checkCommandDeny blocks gateway service restart commands", () => {
    const direct = checkCommandDeny("systemctl --user restart moltbot-gateway-dev.service");
    const absolute = checkCommandDeny(
      "/usr/bin/systemctl --user restart moltbot-gateway-dev.service",
    );
    const cli = checkCommandDeny("moltbot gateway restart");
    expect(direct).not.toBeNull();
    expect(absolute).not.toBeNull();
    expect(cli).not.toBeNull();
  });
});

describe("createEnforcedBashOperations", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it("denies hard-denied commands and returns a message", async () => {
    const denied: string[] = [];
    const mock = mockBashOps();
    const ops = createEnforcedBashOperations(HARD_DENIES, (d) => denied.push(d.reason), mock);
    const output: string[] = [];
    const result = await ops.exec("sudo apt-get install vim", WORKING_DIR, {
      onData: (data) => output.push(data.toString()),
    });

    expect(result.exitCode).toBe(126);
    expect(denied.length).toBe(1);
    expect(output.join("")).toContain("Denied:");
  });

  it("denies inline interpreter shell-exec commands before bash execution", async () => {
    const denied: string[] = [];
    const mock = mockBashOps();
    const ops = createEnforcedBashOperations(HARD_DENIES, (d) => denied.push(d.reason), mock);
    const output: string[] = [];

    const result = await ops.exec(`python3 -c "import os; os.system('npm publish')"`, WORKING_DIR, {
      onData: (data) => output.push(data.toString()),
    });

    expect(result.exitCode).toBe(126);
    expect(denied).toContain("Publishing not permitted");
    expect(mock.calls).toHaveLength(0);
    expect(output.join("")).toContain("Denied:");
  });

  it("strips gateway and channel secrets from Pi bash env while preserving shell vars", async () => {
    const envKeys = [
      "PATH",
      "HOME",
      "TERM",
      "DATABASE_URL",
      "OP_SESSION_test",
      "APP_SECRET",
      "ANTHROPIC_API_KEY",
      "CLAWDBOT_GATEWAY_TOKEN",
      "CLAWDBOT_GATEWAY_PASSWORD",
      "SMITHERSBOT_GATEWAY_TOKEN",
      "SMITHERSBOT_GATEWAY_PASSWORD",
      "MOLTBOT_GATEWAY_TOKEN",
      "DISCORD_BOT_TOKEN",
      "TELEGRAM_BOT_TOKEN",
      "SLACK_BOT_TOKEN",
      "SLACK_SIGNING_SECRET",
      "SLACK_APP_TOKEN",
    ] as const;
    const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<
      (typeof envKeys)[number],
      string | undefined
    >;

    mockSpawn.mockImplementation(() => createMockSpawnChild());
    process.env.PATH = "/usr/bin:/bin";
    process.env.HOME = "/tmp/pi-home";
    process.env.TERM = "xterm-256color";
    process.env.DATABASE_URL = "postgres://user:pass@db.local:5432/app";
    process.env.OP_SESSION_test = "one-password-session";
    process.env.APP_SECRET = "secret";
    process.env.ANTHROPIC_API_KEY = "anthropic-key";
    process.env.CLAWDBOT_GATEWAY_TOKEN = "gateway-token";
    process.env.CLAWDBOT_GATEWAY_PASSWORD = "gateway-password";
    process.env.SMITHERSBOT_GATEWAY_TOKEN = "smithersbot-gateway-token";
    process.env.SMITHERSBOT_GATEWAY_PASSWORD = "smithersbot-gateway-password";
    process.env.MOLTBOT_GATEWAY_TOKEN = "moltbot-gateway-token";
    process.env.DISCORD_BOT_TOKEN = "discord-token";
    process.env.TELEGRAM_BOT_TOKEN = "telegram-token";
    process.env.SLACK_BOT_TOKEN = "slack-token";
    process.env.SLACK_SIGNING_SECRET = "slack-signing-secret";
    process.env.SLACK_APP_TOKEN = "slack-app-token";

    try {
      createEnforcedCodingTools(WORKING_DIR, HARD_DENIES);
      expect(capturedBashOps).toBeTruthy();

      const result = await capturedBashOps!.exec("printf ok", WORKING_DIR, {
        onData: vi.fn(),
      });

      expect(result.exitCode).toBe(0);
      expect(mockSpawn).toHaveBeenCalledWith(
        "bash",
        ["-c", "printf ok"],
        expect.objectContaining({
          cwd: WORKING_DIR,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );

      const spawnEnv = mockSpawn.mock.calls[0]?.[2]?.env as Record<string, string | undefined>;
      expect(spawnEnv.PATH).toBe("/usr/bin:/bin");
      expect(spawnEnv.HOME).toBe("/tmp/pi-home");
      expect(spawnEnv.TERM).toBe("xterm-256color");
      expect(spawnEnv.DATABASE_URL).toBeUndefined();
      expect(spawnEnv.OP_SESSION_test).toBeUndefined();
      expect(spawnEnv.APP_SECRET).toBeUndefined();
      expect(spawnEnv.ANTHROPIC_API_KEY).toBeUndefined();
      expect(spawnEnv.CLAWDBOT_GATEWAY_TOKEN).toBeUndefined();
      expect(spawnEnv.CLAWDBOT_GATEWAY_PASSWORD).toBeUndefined();
      expect(spawnEnv.SMITHERSBOT_GATEWAY_TOKEN).toBeUndefined();
      expect(spawnEnv.SMITHERSBOT_GATEWAY_PASSWORD).toBeUndefined();
      expect(spawnEnv.MOLTBOT_GATEWAY_TOKEN).toBeUndefined();
      expect(spawnEnv.DISCORD_BOT_TOKEN).toBeUndefined();
      expect(spawnEnv.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(spawnEnv.SLACK_BOT_TOKEN).toBeUndefined();
      expect(spawnEnv.SLACK_SIGNING_SECRET).toBeUndefined();
      expect(spawnEnv.SLACK_APP_TOKEN).toBeUndefined();
    } finally {
      for (const key of envKeys) {
        const prior = priorEnv[key];
        if (prior === undefined) delete process.env[key];
        else process.env[key] = prior;
      }
    }
  });

  it("clears default bash exec timeout after the process exits", async () => {
    vi.useFakeTimers();
    mockSpawn.mockImplementation(() => createMockSpawnChild());

    createEnforcedCodingTools(WORKING_DIR, HARD_DENIES);
    expect(capturedBashOps).toBeTruthy();

    const result = await capturedBashOps!.exec("printf ok", WORKING_DIR, {
      onData: vi.fn(),
      timeout: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears default bash exec timeout after a spawn error", async () => {
    vi.useFakeTimers();
    mockSpawn.mockImplementation(() => createMockSpawnErrorChild());

    createEnforcedCodingTools(WORKING_DIR, HARD_DENIES);
    expect(capturedBashOps).toBeTruthy();

    const result = await capturedBashOps!.exec("printf ok", WORKING_DIR, {
      onData: vi.fn(),
      timeout: 10_000,
    });

    expect(result.exitCode).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("denies bash commands that read SmithersBot config files", async () => {
    const denied: string[] = [];
    const mock = mockBashOps();
    const ops = createEnforcedBashOperations(
      HARD_DENIES,
      (detail) => denied.push(detail.reason),
      mock,
    );
    const output: string[] = [];

    const result = await ops.exec("cat ~/.smithersbot/smithersbot.json", WORKING_DIR, {
      onData: (data) => output.push(data.toString()),
    });

    expect(result.exitCode).toBe(126);
    expect(mock.calls).toHaveLength(0);
    expect(denied[0]).toContain("local secret/config file");
    expect(output.join("")).toContain("Denied:");
  });
});

describe("createEnforcedCodingTools", () => {
  it("denies Read on hard-denied paths", async () => {
    const tools = createEnforcedCodingTools(WORKING_DIR, HARD_DENIES);
    const readTool = tools.find((t) => t.name === "Read");
    expect(readTool).toBeTruthy();

    const result = await readTool!.execute("1", { path: ".env" });
    const text = result.content?.[0]?.text ?? "";
    expect(text).toContain("Denied:");
  });

  it("denies Read on canonical SmithersBot secret paths", async () => {
    const tools = createEnforcedCodingTools(WORKING_DIR, HARD_DENIES);
    const readTool = tools.find((t) => t.name === "Read");
    expect(readTool).toBeTruthy();

    const envResult = await readTool!.execute("1", { path: "~/.smithersbot/.env" });
    const envText = envResult.content?.[0]?.text ?? "";
    expect(envText).toContain("local secret/config file");

    const configResult = await readTool!.execute("2", {
      path: "~/.smithersbot/smithersbot.json",
    });
    const configText = configResult.content?.[0]?.text ?? "";
    expect(configText).toContain("local secret/config file");
  });

  it("denies path access when realpath resolves to a denied target", async () => {
    vi.spyOn(fs, "realpathSync").mockReturnValue("/home/user/.ssh/id_rsa");

    const tools = createEnforcedCodingTools(WORKING_DIR, HARD_DENIES);
    const readTool = tools.find((t) => t.name === "Read");
    expect(readTool).toBeTruthy();

    const result = await readTool!.execute("1", { path: "data/file.txt" });
    const text = result.content?.[0]?.text ?? "";
    expect(text).toContain("Denied:");
    expect(fs.realpathSync).toHaveBeenCalledWith(path.resolve(WORKING_DIR, "data/file.txt"));
  });

  it("still denies direct denied paths when realpath matches the original path", async () => {
    vi.spyOn(fs, "realpathSync").mockReturnValue(path.resolve(WORKING_DIR, ".env"));

    const tools = createEnforcedCodingTools(WORKING_DIR, HARD_DENIES);
    const readTool = tools.find((t) => t.name === "Read");
    expect(readTool).toBeTruthy();

    const result = await readTool!.execute("1", { path: ".env" });
    const text = result.content?.[0]?.text ?? "";
    expect(text).toContain("Denied:");
  });

  it("falls back to resolved path checks when realpathSync returns ENOENT", async () => {
    vi.spyOn(fs, "realpathSync").mockImplementation(() => {
      throw createEnoentError();
    });

    const tools = createEnforcedCodingTools(WORKING_DIR, HARD_DENIES);
    const writeTool = tools.find((t) => t.name === "Write");
    expect(writeTool).toBeTruthy();

    const result = await writeTool!.execute("1", {
      path: "notes/new-file.txt",
      content: "hello",
    });
    const text = result.content?.[0]?.text ?? "";
    expect(text).toBe("ok");
    expect(fs.realpathSync).toHaveBeenCalledWith(path.resolve(WORKING_DIR, "notes/new-file.txt"));
  });
});
