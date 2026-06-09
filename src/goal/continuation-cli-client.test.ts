import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ClaudeCodeLaunchSandboxConfig, CodexNativeSandboxConfig } from "./backend-sandbox.js";
import { createContinuationCliClient } from "./continuation-cli-client.js";
import { generateContinuationAssessment } from "./continuation.js";
import type { GoalLlmClient, SerializedRun } from "./types.js";
import { resolveContinuationClient } from "../telegram/continuation-client.js";

function makeRun(): SerializedRun {
  return {
    runId: "11111111-2222-4333-8444-555555555555",
    goal: "Prepare a continuation backend smoke test",
    state: "done",
    plan: {
      goal: "Prepare a continuation backend smoke test",
      workingDir: "/tmp/workspace",
      summary: "Check continuation backend selection.",
      shortSummary: "Check backend selection",
      steps: [
        {
          id: "check-backend",
          description: "Check continuation backend selection.",
          shortSummary: "Check backend",
          dependsOn: [],
          status: "done",
        },
      ],
    },
    stepResults: {},
    blocked: null,
    answers: {},
    workingDir: "/tmp/workspace",
    dryRun: false,
    createdAt: "2026-01-30T00:00:00.000Z",
    updatedAt: "2026-01-30T00:00:00.000Z",
    completionSummary: "Backend selection check is ready.",
  };
}

function fakeClaudeSandbox(): ClaudeCodeLaunchSandboxConfig {
  return { settingsPath: "/tmp/claude-settings.json", args: [] };
}

function fakeCodexSandbox(workingDir: string): CodexNativeSandboxConfig {
  const root = "/tmp/continuation-codex-sandbox";
  return {
    profileName: "smithersbot",
    executionRoot: workingDir,
    codexHome: path.join(root, "home"),
    configPath: path.join(root, "home", "config.toml"),
    helperDir: path.join(root, "bin"),
    helperPath: path.join(root, "bin", "codex-linux-sandbox"),
    codexPath: "/usr/bin/codex",
    authReferencePath: path.join(root, "home", "auth.json"),
    authSourcePath: path.join(root, "real-auth.json"),
    env: { CODEX_HOME: path.join(root, "home"), PATH: process.env.PATH ?? "" },
    args: [],
    configToml: "",
    deniedReadPaths: [],
    allowedReadPaths: [],
    writablePaths: [],
  };
}

describe("continuation CLI client backend selection", () => {
  it("prefers claude_code, then codex, through backend fallback", async () => {
    const runCliProcess = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "claude unavailable",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          type: "result",
          result: JSON.stringify({
            outcome: "continuation-recommended-now",
            goalAchieved: false,
            briefSummary: "Codex produced the continuation proposal.",
            proposedPrompt: "Create the next plan from the continuation prompt.",
          }),
        }),
        stderr: "",
      });

    const client = createContinuationCliClient({
      backends: ["claude_code", "codex"],
      workingDir: "/tmp/workspace",
      deps: {
        runCliProcess,
        detectBackendAvailability: () => [
          { id: "pi", available: false, reason: "not used" },
          { id: "claude_code", available: true },
          { id: "codex", available: true },
        ],
        resolveClaudeBinary: () => "/usr/bin/claude",
        buildClaudeSandbox: () => fakeClaudeSandbox(),
        writeCodexSandbox: ({ workingDir }) => fakeCodexSandbox(workingDir),
        getCodexAskForApprovalPlacement: () => "after_exec",
      },
    });

    if (!client) throw new Error("expected continuation CLI client");
    const assessment = await generateContinuationAssessment({ run: makeRun(), client });

    expect(runCliProcess).toHaveBeenCalledTimes(2);
    expect(runCliProcess.mock.calls.map((call) => call[0].command)).toEqual([
      "/usr/bin/claude",
      "codex",
    ]);
    expect(assessment).toMatchObject({
      outcome: "continuation-recommended-now",
      briefSummary: "Codex produced the continuation proposal.",
    });
  });

  it("resolves continuation clients to CLI before raw Anthropic, even when an env API key exists", () => {
    const cliClient: GoalLlmClient = { complete: vi.fn() };
    const createCliClient = vi.fn(() => cliClient);
    const createRawClient = vi.fn(() => ({ complete: vi.fn() }));

    const client = resolveContinuationClient(
      {
        goal: {
          enabledWorkers: ["codex", "claude_code"],
          defaultWorkingDir: "/tmp/workspace",
        },
      },
      {
        env: { ANTHROPIC_API_KEY: "sk-env-key" },
        createCliClient,
        createRawClient,
      },
    );

    expect(client).toBe(cliClient);
    expect(createRawClient).not.toHaveBeenCalled();
    expect(createCliClient).toHaveBeenCalledWith(
      expect.objectContaining({
        backends: ["claude_code", "codex"],
        workingDir: "/tmp/workspace",
      }),
    );
  });

  it("uses a configured raw Anthropic client only when no CLI continuation client is available", () => {
    const rawClient: GoalLlmClient = { complete: vi.fn() };
    const createCliClient = vi.fn(() => undefined);
    const createRawClient = vi.fn(() => rawClient);

    const client = resolveContinuationClient(
      {
        models: { providers: { anthropic: { apiKey: "sk-configured-key" } } },
        goal: { enabledWorkers: ["claude_code"], defaultWorkingDir: "/tmp/workspace" },
      },
      {
        createCliClient,
        createRawClient,
      },
    );

    expect(client).toBe(rawClient);
    expect(createCliClient).toHaveBeenCalled();
    expect(createRawClient).toHaveBeenCalledWith({ apiKey: "sk-configured-key" });
  });
});
