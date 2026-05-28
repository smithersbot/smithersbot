import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEnv } from "../runtime.js";

const checkGatewayHealth = vi.fn();
const resolveTelegramAccount = vi.fn();
const probeTelegram = vi.fn();
const readClaudeCliCredentials = vi.fn();
const spawnSyncMock = vi.fn();
const readConfigFileSnapshot = vi.fn();
const maybeOfferUpdateBeforeDoctor = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: spawnSyncMock,
  };
});

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshot,
  };
});

vi.mock("./doctor-gateway-health.js", () => ({
  checkGatewayHealth,
}));

vi.mock("../telegram/accounts.js", () => ({
  resolveTelegramAccount,
}));

vi.mock("../telegram/probe.js", () => ({
  probeTelegram,
}));

vi.mock("../agents/cli-credentials.js", () => ({
  readClaudeCliCredentials,
}));

vi.mock("./doctor-update.js", () => ({
  maybeOfferUpdateBeforeDoctor,
}));

vi.mock("../terminal/theme.js", () => ({
  theme: {
    success: (message: string) => message,
    error: (message: string) => message,
    warn: (message: string) => message,
    muted: (message: string) => message,
    heading: (message: string) => message,
  },
}));

let originalHome: string | undefined;
let originalStateDir: string | undefined;
let originalProfile: string | undefined;
let originalExitCode: number | undefined;
let tempDir: string | undefined;

function makeSnapshot(config: Record<string, unknown> = {}) {
  return {
    path: "/tmp/moltbot.json",
    exists: true,
    raw: "{}",
    parsed: {},
    valid: true,
    config,
    issues: [],
    legacyIssues: [],
  };
}

function setupPassingMocks() {
  readConfigFileSnapshot.mockResolvedValue(
    makeSnapshot({
      gateway: { mode: "local" },
    }),
  );
  checkGatewayHealth.mockResolvedValue({ healthOk: true });
  resolveTelegramAccount.mockReturnValue({
    accountId: "default",
    enabled: true,
    name: "Customer Bot",
    token: "telegram-token",
    tokenSource: "config",
    config: {},
  });
  probeTelegram.mockResolvedValue({
    ok: true,
    status: null,
    error: null,
    elapsedMs: 10,
    bot: { username: "test_bot" },
  });
  spawnSyncMock.mockReturnValue({
    status: 0,
    stdout: "claude 1.0.0\n",
    stderr: "",
  });
  readClaudeCliCredentials.mockReturnValue({
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
  });
  maybeOfferUpdateBeforeDoctor.mockResolvedValue({ handled: false });
}

function makeRuntime() {
  const log = vi.fn();
  const error = vi.fn();
  const runtime: RuntimeEnv = {
    log,
    error,
    exit: (_code: number): never => {
      throw new Error("runtime.exit should not be called");
    },
  };
  return { runtime, log };
}

function readLogs(log: ReturnType<typeof vi.fn>): string {
  return log.mock.calls.map((call) => call.map((arg) => String(arg)).join(" ")).join("\n");
}

async function runCustomerCheck(): Promise<string> {
  const { doctorCommand } = await import("./doctor.js");
  const { runtime, log } = makeRuntime();
  await doctorCommand(runtime, { customerCheck: true });
  return readLogs(log);
}

beforeEach(() => {
  vi.resetModules();

  checkGatewayHealth.mockReset();
  resolveTelegramAccount.mockReset();
  probeTelegram.mockReset();
  readClaudeCliCredentials.mockReset();
  spawnSyncMock.mockReset();
  readConfigFileSnapshot.mockReset();
  maybeOfferUpdateBeforeDoctor.mockReset();
  setupPassingMocks();

  originalHome = process.env.HOME;
  originalStateDir = process.env.CLAWDBOT_STATE_DIR;
  originalProfile = process.env.CLAWDBOT_PROFILE;
  originalExitCode = process.exitCode;

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moltbot-doctor-customer-check-"));
  process.env.HOME = tempDir;
  process.env.CLAWDBOT_STATE_DIR = path.join(tempDir, "state");
  fs.mkdirSync(process.env.CLAWDBOT_STATE_DIR, { recursive: true });
  delete process.env.CLAWDBOT_PROFILE;
  process.exitCode = undefined;
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalStateDir === undefined) {
    delete process.env.CLAWDBOT_STATE_DIR;
  } else {
    process.env.CLAWDBOT_STATE_DIR = originalStateDir;
  }

  if (originalProfile === undefined) {
    delete process.env.CLAWDBOT_PROFILE;
  } else {
    process.env.CLAWDBOT_PROFILE = originalProfile;
  }

  process.exitCode = originalExitCode;

  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("doctor --customer-check", () => {
  it("passes all four checks when everything is configured", async () => {
    const output = await runCustomerCheck();
    expect(output).toContain("4/4 checks passed");
    expect(output).toContain("[PASS] Gateway health");
    expect(output).toContain("[PASS] Telegram channel");
    expect(output).toContain("[PASS] Claude Code CLI");
    expect(output).toContain("[PASS] Claude authentication");
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
  });

  it("fails gateway health with restart guidance", async () => {
    checkGatewayHealth.mockResolvedValue({ healthOk: false });
    const output = await runCustomerCheck();
    expect(output).toContain("[FAIL] Gateway health");
    expect(output).toContain("systemctl --user restart moltbot-gateway.service");
    expect(process.exitCode).toBe(1);
  });

  it("uses profile-aware service name in gateway restart guidance", async () => {
    process.env.CLAWDBOT_PROFILE = "sales";
    checkGatewayHealth.mockResolvedValue({ healthOk: false });
    const output = await runCustomerCheck();
    expect(output).toContain("systemctl --user restart moltbot-gateway-sales.service");
    expect(process.exitCode).toBe(1);
  });

  it("fails when Telegram token is missing", async () => {
    resolveTelegramAccount.mockReturnValue({
      accountId: "default",
      enabled: true,
      token: "",
      tokenSource: "none",
      config: {},
    });
    const output = await runCustomerCheck();
    expect(output).toContain("moltbot channels add --channel telegram --token <token>");
    expect(process.exitCode).toBe(1);
  });

  it("fails when Telegram is configured but disabled", async () => {
    resolveTelegramAccount.mockReturnValue({
      accountId: "default",
      enabled: false,
      token: "telegram-token",
      tokenSource: "config",
      config: {},
    });
    const output = await runCustomerCheck();
    expect(output).toContain("moltbot config set channels.telegram.enabled true");
    expect(output).not.toContain("moltbot channels enable telegram");
    expect(process.exitCode).toBe(1);
  });

  it("fails when Telegram token probe fails", async () => {
    probeTelegram.mockResolvedValue({
      ok: false,
      status: 401,
      error: "Unauthorized",
      elapsedMs: 12,
    });
    const output = await runCustomerCheck();
    expect(output).toContain("Telegram token probe failed (status 401): Unauthorized");
    expect(process.exitCode).toBe(1);
  });

  it("passes Telegram check and prints bot username when probe succeeds", async () => {
    probeTelegram.mockResolvedValue({
      ok: true,
      status: null,
      error: null,
      elapsedMs: 9,
      bot: { username: "smithers_bot" },
    });
    const output = await runCustomerCheck();
    expect(output).toContain("[PASS] Telegram channel");
    expect(output).toContain("(@smithers_bot)");
  });

  it("fails when Claude CLI is not installed", async () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "",
      error: new Error("spawn ENOENT"),
    });
    const output = await runCustomerCheck();
    expect(output).toContain("[FAIL] Claude Code CLI");
    expect(output).toContain("Install Claude Code: npm i -g @anthropic-ai/claude-code");
    expect(process.exitCode).toBe(1);
  });

  it("passes Claude CLI check when version command succeeds", async () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "claude 9.9.9\n",
      stderr: "",
    });
    const output = await runCustomerCheck();
    expect(output).toContain("[PASS] Claude Code CLI");
    expect(output).toContain("Installed (claude 9.9.9).");
  });

  it("fails when Claude authentication is missing", async () => {
    readClaudeCliCredentials.mockReturnValue(null);
    const output = await runCustomerCheck();
    expect(output).toContain("[FAIL] Claude authentication");
    expect(output).toContain("Claude Code is not authenticated. Run: claude login");
    expect(process.exitCode).toBe(1);
  });

  it("fails when Claude authentication is expired", async () => {
    readClaudeCliCredentials.mockReturnValue({
      type: "oauth",
      access: "token",
      refresh: "refresh",
      expires: Date.now() - 5_000,
    });
    const output = await runCustomerCheck();
    expect(output).toContain("[FAIL] Claude authentication");
    expect(output).toContain("Claude auth expired. Run: claude login");
    expect(process.exitCode).toBe(1);
  });

  it("passes when Claude OAuth credential is valid", async () => {
    readClaudeCliCredentials.mockReturnValue({
      type: "oauth",
      access: "token",
      refresh: "refresh",
      expires: Date.now() + 120_000,
    });
    const output = await runCustomerCheck();
    expect(output).toContain("[PASS] Claude authentication");
    expect(output).toContain("Authenticated (oauth");
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
  });

  it("short-circuits before running regular doctor flow", async () => {
    await runCustomerCheck();
    expect(maybeOfferUpdateBeforeDoctor).not.toHaveBeenCalled();
  });
});
