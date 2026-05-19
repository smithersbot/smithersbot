import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts/setup-smithersbot.sh");
const testToken = "1234567890:TEST_TOKEN";

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
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function mkTempHome() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smithersbot-setup-test-"));
  tempDirs.push(dir);
  return dir;
}

async function startTelegramStub(handler: RouteHandler) {
  const server = createServer((req, res) => {
    const body = handler(req.url ?? "/");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("stub server did not bind to a TCP port");
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  servers.push({ close });
  return `http://127.0.0.1:${address.port}`;
}

async function runSetup(params: {
  home: string;
  apiBase: string;
  input: string;
  pollSeconds?: string;
  pollInterval?: string;
}) {
  const child = spawn(
    "bash",
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
        HOME: params.home,
        SMITHERSBOT_TELEGRAM_API_BASE: params.apiBase,
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
  child.stdin.end(params.input);

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
    },
    envRaw,
    configMode: configStat.mode & 0o777,
    envMode: envStat.mode & 0o777,
  };
}

describe("scripts/setup-smithersbot.sh", () => {
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
      "Open @smithersbot2_test_bot in Telegram, press Start, then come back here.",
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
    expect(generated.configMode).toBe(0o600);
    expect(generated.envMode).toBe(0o600);
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
