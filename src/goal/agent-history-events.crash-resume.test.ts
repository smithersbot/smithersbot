import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveAgentGoalHistoryDir,
  resolveAgentRepoChatHistoryDir,
  slugifyWorkspaceName,
} from "../config/managed-paths.js";
import {
  appendAgentHistoryEvent,
  appendAgentHistoryEventBestEffort,
  resolveAgentHistoryEventsPath,
  writeCriticalAgentLaunchEvent,
  type AgentHistoryScope,
} from "./agent-history-events.js";

/**
 * Stage 2U-C crash / restart / resume durability proofs.
 *
 * These tests use mocks/simulation only — they never spawn a real backend and
 * never touch the live gateway. A "process death" is simulated by writing the
 * pre-spawn launch event (and any incremental events) and then NOT writing a
 * terminal result; a "restart" is simulated by re-resolving the agent-visible
 * history path from a freshly constructed scope object (a new process resolves
 * paths purely from env + scope, so the on-disk JSONL/prompts are all that
 * survive). The primitives are stateless, so this faithfully models what a
 * future scout/planner/repo-chat worker would see after a gateway crash.
 */
describe("agent-history-events crash/restart/resume durability", () => {
  let tmpDir: string;
  let originalManagedRoot: string | undefined;
  let originalGatewayToken: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-history-crash-resume-"));
    originalManagedRoot = process.env.SMITHERSBOT_GOALS_ROOT;
    originalGatewayToken = process.env.SMITHERSBOT_GATEWAY_TOKEN;
    process.env.SMITHERSBOT_GOALS_ROOT = path.join(tmpDir, "managed");
    // A planted secret in a TOKEN-suffixed env var must never reach disk.
    process.env.SMITHERSBOT_GATEWAY_TOKEN = "PLANTED_CRASH_RESUME_SECRET_4242";
  });

  afterEach(() => {
    if (originalManagedRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
    else process.env.SMITHERSBOT_GOALS_ROOT = originalManagedRoot;
    if (originalGatewayToken === undefined) delete process.env.SMITHERSBOT_GATEWAY_TOKEN;
    else process.env.SMITHERSBOT_GATEWAY_TOKEN = originalGatewayToken;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readJsonl(filePath: string): Array<Record<string, unknown>> {
    return fs
      .readFileSync(filePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("keeps the planner/scout launch + prompt event on disk after a simulated process death", () => {
    const scope: AgentHistoryScope = {
      kind: "goal",
      workspaceName: "smithersbot",
      goalId: "planner-crash-run",
    };

    // BEFORE spawning the planner backend the worker writes the critical
    // fail-closed launch event + prompt artifact.
    const { promptArtifactPath } = writeCriticalAgentLaunchEvent({
      scope,
      phase: "scout-planner",
      backend: "claude_code",
      prompt: "Plan the goal. (token PLANTED_CRASH_RESUME_SECRET_4242 must be redacted)",
      argv: ["claude", "-p", "--allowedTools", "Read,Glob,Grep,Bash"],
      event: { runId: "planner-crash-run", status: "spawning" },
    });

    // <-- gateway dies here, before the backend ever returns a result.

    // A future process re-resolves the path purely from env + scope.
    const afterRestart: AgentHistoryScope = {
      kind: "goal",
      workspaceName: "smithersbot",
      goalId: "planner-crash-run",
    };
    const eventsPath = resolveAgentHistoryEventsPath(afterRestart);
    expect(fs.existsSync(eventsPath)).toBe(true);

    const events = readJsonl(eventsPath);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "launch",
      phase: "scout-planner",
      backend: "claude_code",
      status: "spawning",
    });
    // The exact prompt artifact survives and is redacted.
    expect(fs.existsSync(promptArtifactPath)).toBe(true);
    const promptText = fs.readFileSync(promptArtifactPath, "utf8");
    expect(promptText).toContain("Plan the goal.");
    expect(promptText).not.toContain("PLANTED_CRASH_RESUME_SECRET_4242");
    expect(promptText).toContain("[REDACTED]");
    // No terminal result was ever written — the launch event is the only record.
    expect(events.some((e) => e.event === "result")).toBe(false);
  });

  it("records process_lost/missing_result before any user-facing message when worker_result.json is absent", () => {
    const scope: AgentHistoryScope = {
      kind: "goal",
      workspaceName: "smithersbot",
      goalId: "worker-missing-result-run",
    };

    // Simulated worker flow: launch event before spawn, backend "exits" without
    // writing worker_result.json, failure event written BEFORE the user message.
    const sequence: string[] = [];

    function simulateWorkerAttempt(): { userMessage: string } {
      writeCriticalAgentLaunchEvent({
        scope,
        phase: "worker",
        backend: "codex",
        prompt: "Implement step A.",
        argv: ["codex", "exec", "--json"],
        event: { runId: "worker-missing-result-run", stepId: "step-a", attemptNumber: 1 },
      });
      sequence.push("launch");

      // Backend process closed; the worker probes for its result file.
      const resultFile = path.join(tmpDir, "no-such-worker_result.json");
      const resultExists = fs.existsSync(resultFile);
      // Mirror cli-worker classification: no exit info -> process_lost.
      const errorClass = resultExists ? "ok" : "process_lost";

      // Failure event is written BEFORE control returns / before any user message.
      appendAgentHistoryEvent(scope, {
        event: "failure",
        phase: "worker",
        backend: "codex",
        runId: "worker-missing-result-run",
        stepId: "step-a",
        attemptNumber: 1,
        status: "failed",
        errorClass,
        outputSummary: "backend exited without worker_result.json",
      });
      sequence.push("failure-event");

      const userMessage = "Step A failed: the worker did not produce a result.";
      sequence.push("user-message");
      return { userMessage };
    }

    const { userMessage } = simulateWorkerAttempt();
    expect(userMessage.length).toBeGreaterThan(0);

    // Ordering proof: the failure event hit disk before the user-facing message.
    expect(sequence).toEqual(["launch", "failure-event", "user-message"]);
    expect(sequence.indexOf("failure-event")).toBeLessThan(sequence.indexOf("user-message"));

    const events = readJsonl(resolveAgentHistoryEventsPath(scope));
    const failure = events.find((e) => e.event === "failure");
    expect(failure).toMatchObject({
      event: "failure",
      phase: "worker",
      errorClass: "process_lost",
      status: "failed",
    });
  });

  it("records BOTH the failed backend and the fallback backend on usage-limit fallback, incrementally", () => {
    const scope: AgentHistoryScope = {
      kind: "goal",
      workspaceName: "smithersbot",
      goalId: "usage-limit-fallback-run",
    };

    // Attempt 1: Claude hits a usage limit -> incremental usage_limit event.
    writeCriticalAgentLaunchEvent({
      scope,
      phase: "worker",
      backend: "claude_code",
      prompt: "Implement step B.",
      argv: ["claude", "-p"],
      event: { runId: "usage-limit-fallback-run", stepId: "step-b", attemptNumber: 1 },
    });
    appendAgentHistoryEvent(scope, {
      event: "usage_limit",
      phase: "worker",
      backend: "claude_code",
      stepId: "step-b",
      attemptNumber: 1,
      status: "usage_limited",
      errorClass: "anthropic_usage_limit",
    });

    // Fallback to Codex: incremental usage_limit_fallback event recorded BEFORE
    // the retry actually runs.
    appendAgentHistoryEvent(scope, {
      event: "usage_limit_fallback",
      phase: "worker",
      backend: "codex",
      stepId: "step-b",
      attemptNumber: 2,
      status: "fallback_selected",
      transition: { from: "claude_code", to: "codex" },
    });
    writeCriticalAgentLaunchEvent({
      scope,
      phase: "worker",
      backend: "codex",
      prompt: "Implement step B (fallback).",
      argv: ["codex", "exec", "--json"],
      event: { runId: "usage-limit-fallback-run", stepId: "step-b", attemptNumber: 2 },
    });

    const events = readJsonl(resolveAgentHistoryEventsPath(scope));
    // Both the failed backend and the fallback backend are recorded.
    const failedBackend = events.find((e) => e.event === "usage_limit");
    const fallbackBackend = events.find((e) => e.event === "usage_limit_fallback");
    expect(failedBackend).toMatchObject({
      backend: "claude_code",
      errorClass: "anthropic_usage_limit",
    });
    expect(fallbackBackend).toMatchObject({
      backend: "codex",
      transition: { from: "claude_code", to: "codex" },
    });

    // The fallback was written incrementally (its line precedes the fallback
    // backend's launch line), not batched at the end.
    const order = events.map((e) => `${String(e.event)}:${String(e.backend)}`);
    expect(order).toEqual([
      "launch:claude_code",
      "usage_limit:claude_code",
      "usage_limit_fallback:codex",
      "launch:codex",
    ]);
  });

  it("lets resume discover prior partial agent-visible history after a simulated restart", () => {
    const scope: AgentHistoryScope = {
      kind: "goal",
      workspaceName: "smithersbot",
      goalId: "resume-partial-run",
    };

    // Phase 1 ran and produced a launch + an in-flight status event, then the
    // gateway was restarted (no terminal result/summary.json written).
    const { promptArtifactPath } = writeCriticalAgentLaunchEvent({
      scope,
      phase: "worker",
      backend: "codex",
      prompt: "Step C work in progress.",
      argv: ["codex", "exec", "--json"],
      event: { runId: "resume-partial-run", stepId: "step-c", attemptNumber: 1 },
    });
    appendAgentHistoryEvent(scope, {
      event: "status",
      phase: "worker",
      backend: "codex",
      stepId: "step-c",
      status: "running",
    });

    // <-- restart. Resume reconstructs scope from persisted run id only.
    const resumeScope: AgentHistoryScope = {
      kind: "goal",
      workspaceName: "smithersbot",
      goalId: "resume-partial-run",
    };
    const historyDir = resolveAgentGoalHistoryDir(
      resumeScope.workspaceName,
      (resumeScope as { goalId: string }).goalId,
    );
    expect(fs.existsSync(historyDir)).toBe(true);

    const events = readJsonl(resolveAgentHistoryEventsPath(resumeScope));
    expect(events.map((e) => e.event)).toEqual(["launch", "status"]);
    expect(events[1]).toMatchObject({ status: "running", stepId: "step-c" });
    // The prompt artifact written before the crash is still inspectable.
    expect(fs.existsSync(promptArtifactPath)).toBe(true);
    expect(fs.readFileSync(promptArtifactPath, "utf8")).toContain("Step C work in progress.");

    // Resume can append further events to the SAME stream (continuity).
    appendAgentHistoryEvent(resumeScope, {
      event: "result",
      phase: "worker",
      backend: "codex",
      stepId: "step-c",
      status: "succeeded",
    });
    const afterResume = readJsonl(resolveAgentHistoryEventsPath(resumeScope));
    expect(afterResume.map((e) => e.event)).toEqual(["launch", "status", "result"]);
  });

  it("makes goal history visible to a later scout/planner context and repo-chat history to a follow-up turn", () => {
    // --- Goal history visible to scout/planner ---
    const goalScope: AgentHistoryScope = {
      kind: "goal",
      workspaceName: "smithersbot",
      goalId: "cross-context-goal",
    };
    appendAgentHistoryEvent(goalScope, {
      event: "result",
      phase: "worker",
      backend: "codex",
      stepId: "step-1",
      status: "succeeded",
      outputSummary: "implemented feature X",
    });

    // A later scout/planner worker (new process) reads the goal history dir.
    const plannerView = resolveAgentHistoryEventsPath({
      kind: "goal",
      workspaceName: "smithersbot",
      goalId: "cross-context-goal",
    });
    expect(fs.existsSync(plannerView)).toBe(true);
    const goalEvents = readJsonl(plannerView);
    expect(goalEvents.some((e) => e.outputSummary === "implemented feature X")).toBe(true);

    // --- Repo-chat history visible to a follow-up / resume turn ---
    const sessionId = "chat-session-77";
    const turn1Scope: AgentHistoryScope = {
      kind: "repo-chat",
      workspaceName: "smithersbot",
      sessionId,
    };
    writeCriticalAgentLaunchEvent({
      scope: turn1Scope,
      phase: "repo-chat",
      backend: "claude_code",
      prompt: "Explain the auth flow.",
      argv: ["claude", "-p"],
      event: { sessionId, status: "turn-1" },
    });
    appendAgentHistoryEvent(turn1Scope, {
      event: "success",
      phase: "repo-chat",
      backend: "claude_code",
      sessionId,
      outputSummary: "answered auth-flow question",
    });

    // The follow-up turn rebuilds the SAME session-keyed scope and sees turn 1.
    const followUpScope: AgentHistoryScope = {
      kind: "repo-chat",
      workspaceName: "smithersbot",
      sessionId,
    };
    const repoChatEventsPath = resolveAgentHistoryEventsPath(followUpScope);
    // The session-keyed dir lives under the repo-chat history root.
    const sessionDir = path.join(
      resolveAgentRepoChatHistoryDir("smithersbot"),
      slugifyWorkspaceName(sessionId),
    );
    expect(path.dirname(repoChatEventsPath)).toBe(sessionDir);
    expect(fs.existsSync(repoChatEventsPath)).toBe(true);

    const repoChatEvents = readJsonl(repoChatEventsPath);
    expect(repoChatEvents.map((e) => e.event)).toEqual(["launch", "success"]);
    expect(repoChatEvents.some((e) => e.outputSummary === "answered auth-flow question")).toBe(
      true,
    );

    // The follow-up turn appends to the same session stream.
    const followUp = appendAgentHistoryEventBestEffort(followUpScope, {
      event: "launch",
      phase: "repo-chat",
      backend: "claude_code",
      sessionId,
      status: "turn-2",
    });
    expect(followUp.ok).toBe(true);
    expect(readJsonl(repoChatEventsPath)).toHaveLength(3);
  });
});
