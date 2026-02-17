import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEnv } from "../runtime.js";

const runInteractiveOnboardingMock = vi.fn();
const runNonInteractiveOnboardingMock = vi.fn();
const readConfigFileSnapshotMock = vi.fn();

vi.mock("./onboard-interactive.js", () => ({
  runInteractiveOnboarding: runInteractiveOnboardingMock,
}));

vi.mock("./onboard-non-interactive.js", () => ({
  runNonInteractiveOnboarding: runNonInteractiveOnboardingMock,
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshot: (...args: unknown[]) => readConfigFileSnapshotMock(...args),
  };
});

function makeRuntime() {
  const log = vi.fn();
  const error = vi.fn();
  const runtime: RuntimeEnv = {
    log,
    error,
    exit: (code: number): never => {
      throw new Error(`exit:${code}`);
    },
  };
  return { runtime, log, error };
}

describe("onboard: --telegram-token guards", () => {
  beforeEach(() => {
    vi.resetModules();
    runInteractiveOnboardingMock.mockReset();
    runNonInteractiveOnboardingMock.mockReset();
    readConfigFileSnapshotMock.mockReset();
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: false,
      valid: true,
      config: {},
    });
  });

  it("fails when --telegram-token is empty after trim", async () => {
    const { onboardCommand } = await import("./onboard.js");
    const { runtime, error } = makeRuntime();

    await expect(
      onboardCommand(
        {
          telegramToken: "   ",
        },
        runtime,
      ),
    ).rejects.toThrow("exit:1");

    expect(error).toHaveBeenCalledWith("Invalid --telegram-token: value cannot be empty.");
    expect(runInteractiveOnboardingMock).not.toHaveBeenCalled();
    expect(runNonInteractiveOnboardingMock).not.toHaveBeenCalled();
  }, 60_000);

  it("logs warning and clears token when --non-interactive is not provided", async () => {
    const { onboardCommand } = await import("./onboard.js");
    const { runtime, log, error } = makeRuntime();

    await onboardCommand(
      {
        telegramToken: "12345:interactive-warning-token",
      },
      runtime,
    );

    expect(log).toHaveBeenCalledWith(
      "Warning: --telegram-token only works with --non-interactive; ignoring it.",
    );
    expect(error).not.toHaveBeenCalled();
    expect(runNonInteractiveOnboardingMock).not.toHaveBeenCalled();
    expect(runInteractiveOnboardingMock).toHaveBeenCalledTimes(1);
    const interactiveOpts = runInteractiveOnboardingMock.mock.calls[0]?.[0] as {
      telegramToken?: string;
    };
    expect(interactiveOpts.telegramToken).toBeUndefined();
  }, 60_000);
});
