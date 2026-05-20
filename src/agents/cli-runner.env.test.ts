import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MoltbotConfig } from "../config/config.js";
import { runCliAgent } from "./cli-runner.js";

const runCommandWithTimeoutMock = vi.fn();
const runExecMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
  runExec: (...args: unknown[]) => runExecMock(...args),
}));

const FORBIDDEN_ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "SMITHERSBOT_GATEWAY_TOKEN",
  "CLAWDBOT_GATEWAY_TOKEN",
  "MOLTBOT_GATEWAY_TOKEN",
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
];

describe("runCliAgent env", () => {
  const previousEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    runCommandWithTimeoutMock.mockReset();
    runExecMock.mockReset();
    runExecMock.mockResolvedValue({ stdout: "", stderr: "" });
    for (const key of FORBIDDEN_ENV_KEYS) {
      previousEnv.set(key, process.env[key]);
      process.env[key] = `secret-${key}`;
    }
  });

  afterEach(() => {
    for (const key of FORBIDDEN_ENV_KEYS) {
      const previous = previousEnv.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    previousEnv.clear();
  });

  it("strips credential env from spawned CLI backends and preserves explicit backend env", async () => {
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ message: "ok", session_id: "sid-1" }),
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    });

    const config = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              env: {
                CUSTOM_KEY: "value",
              },
            },
          },
        },
      },
    } satisfies Partial<MoltbotConfig> as MoltbotConfig;

    await runCliAgent({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config,
      prompt: "hi",
      provider: "claude-cli",
      model: "opus",
      timeoutMs: 1_000,
      runId: "run-1",
    });

    expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
    const options = runCommandWithTimeoutMock.mock.calls[0]?.[1] as {
      env?: Record<string, string | undefined>;
    };
    expect(options.env?.CUSTOM_KEY).toBe("value");
    for (const key of FORBIDDEN_ENV_KEYS) {
      expect(options.env).not.toHaveProperty(key);
    }
  });
});
