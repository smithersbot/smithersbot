import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCliProcess } from "./cli-process.js";

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
      expect(result.exitCode).toBe(0);

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
