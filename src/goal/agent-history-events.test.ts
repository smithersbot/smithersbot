import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendAgentHistoryEvent,
  appendAgentHistoryEventBestEffort,
  parseBackendUsage,
  resolveAgentHistoryEventsPath,
  writeAgentPromptArtifact,
  writeCriticalAgentLaunchEvent,
  type AgentHistoryScope,
} from "./agent-history-events.js";

describe("agent-history-events", () => {
  let tmpDir: string;
  let originalManagedRoot: string | undefined;
  let originalGatewayToken: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-history-events-test-"));
    originalManagedRoot = process.env.SMITHERSBOT_GOALS_ROOT;
    originalGatewayToken = process.env.SMITHERSBOT_GATEWAY_TOKEN;
    process.env.SMITHERSBOT_GOALS_ROOT = path.join(tmpDir, "managed");
    process.env.SMITHERSBOT_GATEWAY_TOKEN = "PLANTED_AGENT_HISTORY_SECRET_123";
  });

  afterEach(() => {
    if (originalManagedRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
    else process.env.SMITHERSBOT_GOALS_ROOT = originalManagedRoot;
    if (originalGatewayToken === undefined) delete process.env.SMITHERSBOT_GATEWAY_TOKEN;
    else process.env.SMITHERSBOT_GATEWAY_TOKEN = originalGatewayToken;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const goalScope: AgentHistoryScope = {
    kind: "goal",
    workspaceName: "smithersbot",
    goalId: "run-123",
  };

  function readJsonl(filePath: string): Array<Record<string, unknown>> {
    return fs
      .readFileSync(filePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("appends atomic JSONL events that remain discoverable after a simulated restart", () => {
    const firstPath = appendAgentHistoryEvent(goalScope, {
      event: "status",
      phase: "planner",
      backend: "codex",
      status: "started",
      argv: ["codex", "exec", "--json"],
      timestamp: "2026-05-23T10:00:00.000Z",
    });
    const secondPath = appendAgentHistoryEvent(goalScope, {
      event: "status",
      phase: "planner",
      backend: "codex",
      status: "completed",
      timestamp: "2026-05-23T10:00:01.000Z",
    });

    expect(secondPath).toBe(firstPath);
    const restartedEventsPath = resolveAgentHistoryEventsPath(goalScope);
    expect(restartedEventsPath).toBe(firstPath);
    expect(fs.existsSync(restartedEventsPath)).toBe(true);

    const events = readJsonl(restartedEventsPath);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      event: "status",
      phase: "planner",
      backend: "codex",
      status: "started",
    });
    expect(events[1]).toMatchObject({ status: "completed" });
    for (const line of fs.readFileSync(restartedEventsPath, "utf8").trim().split("\n")) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("writes redacted prompt artifacts and redacts planted secrets from events", () => {
    const promptPath = writeAgentPromptArtifact({
      scope: goalScope,
      phase: "worker",
      backend: "claude",
      prompt: "Run with PLANTED_AGENT_HISTORY_SECRET_123 hidden",
      timestamp: "2026-05-23T11:00:00.000Z",
    });
    appendAgentHistoryEvent(goalScope, {
      event: "launch",
      phase: "worker",
      backend: "claude",
      argv: ["claude", "--secret", "PLANTED_AGENT_HISTORY_SECRET_123"],
      promptArtifactPath: promptPath,
      outputSummary: "saw PLANTED_AGENT_HISTORY_SECRET_123",
    });

    const promptText = fs.readFileSync(promptPath, "utf8");
    const eventsText = fs.readFileSync(resolveAgentHistoryEventsPath(goalScope), "utf8");
    expect(promptText).not.toContain("PLANTED_AGENT_HISTORY_SECRET_123");
    expect(eventsText).not.toContain("PLANTED_AGENT_HISTORY_SECRET_123");
    expect(promptText).toContain("[REDACTED]");
    expect(eventsText).toContain("[REDACTED]");
  });

  it("throws from the critical pre-spawn writer when the history target is not writable", () => {
    const blockedScope: AgentHistoryScope = {
      kind: "goal",
      workspaceName: "smithersbot",
      goalId: "blocked-run",
    };
    const blockedDir = path.join(
      process.env.SMITHERSBOT_GOALS_ROOT!,
      "agent",
      "history",
      "goals",
      "smithersbot",
      "blocked-run",
    );
    fs.mkdirSync(path.dirname(blockedDir), { recursive: true });
    fs.writeFileSync(blockedDir, "not a directory", "utf8");

    expect(() =>
      writeCriticalAgentLaunchEvent({
        scope: blockedScope,
        phase: "worker",
        backend: "codex",
        prompt: "prompt",
        argv: ["codex", "exec"],
      }),
    ).toThrow();
  });

  it("returns a redacted warning from best-effort writes without throwing", () => {
    const blockedScope: AgentHistoryScope = {
      kind: "goal",
      workspaceName: "smithersbot",
      goalId: "blocked-run",
    };
    const blockedDir = path.join(
      process.env.SMITHERSBOT_GOALS_ROOT!,
      "agent",
      "history",
      "goals",
      "smithersbot",
      "blocked-run",
    );
    fs.mkdirSync(path.dirname(blockedDir), { recursive: true });
    fs.writeFileSync(blockedDir, "not a directory PLANTED_AGENT_HISTORY_SECRET_123", "utf8");

    const result = appendAgentHistoryEventBestEffort(blockedScope, {
      event: "failure",
      phase: "worker",
      errorClass: "process_lost",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.warning).toContain("agent history event write failed");
      expect(result.warning).not.toContain("PLANTED_AGENT_HISTORY_SECRET_123");
    }
  });

  it("writes a critical launch event with a prompt artifact before backend spawn", () => {
    const result = writeCriticalAgentLaunchEvent({
      scope: goalScope,
      phase: "worker",
      backend: "codex",
      prompt: "exact prompt body",
      argv: ["codex", "exec", "--json"],
      timestamp: "2026-05-23T12:00:00.000Z",
      event: {
        runId: "run-123",
        stepId: "step-a",
        attemptNumber: 1,
      },
    });

    expect(fs.readFileSync(result.promptArtifactPath, "utf8")).toBe("exact prompt body");
    const events = readJsonl(result.eventPath);
    expect(events[0]).toMatchObject({
      event: "launch",
      phase: "worker",
      backend: "codex",
      runId: "run-123",
      stepId: "step-a",
      attemptNumber: 1,
      argv: ["codex", "exec", "--json"],
      promptArtifactPath: result.promptArtifactPath,
    });
  });

  it("extracts Claude Code stream-json result usage", () => {
    const usage = parseBackendUsage(
      JSON.stringify({
        type: "result",
        usage: {
          input_tokens: 11,
          output_tokens: 22,
          cache_read_input_tokens: 33,
          cache_creation_input_tokens: 44,
        },
        total_cost_usd: 0.123,
      }),
    );

    expect(usage).toEqual({
      available: true,
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheCreationTokens: 44,
      totalCostUsd: 0.123,
      source: "claude-stream-json",
    });
  });

  it("extracts Codex token_count JSON event usage", () => {
    const usage = parseBackendUsage(
      [
        JSON.stringify({ type: "message", text: "working" }),
        JSON.stringify({
          type: "token_count",
          token_count: {
            input_tokens: 101,
            output_tokens: 202,
            cache_read_tokens: 303,
            total_tokens: 606,
          },
        }),
      ].join("\n"),
    );

    expect(usage).toMatchObject({
      available: true,
      inputTokens: 101,
      outputTokens: 202,
      cacheReadTokens: 303,
      totalTokens: 606,
      source: "codex-json",
    });
  });

  it("extracts Codex usage JSON event usage", () => {
    const usage = parseBackendUsage({
      type: "usage",
      usage: {
        inputTokens: "7",
        outputTokens: 8,
        cacheCreationTokens: 9,
        totalCostUsd: "0.01",
      },
    });

    expect(usage).toMatchObject({
      available: true,
      inputTokens: 7,
      outputTokens: 8,
      cacheCreationTokens: 9,
      totalCostUsd: 0.01,
      source: "codex-json",
    });
  });

  it("reports unavailable token usage when no per-run usage exists", () => {
    const usage = parseBackendUsage('plain assistant output\n{"type":"message","text":"done"}');

    expect(usage.available).toBe(false);
    if (!usage.available) {
      expect(usage.reason).toContain("per-run token usage metadata");
    }
  });
});
