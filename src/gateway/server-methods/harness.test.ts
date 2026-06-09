import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SerializedRun } from "../../goal/types.js";
import type { HarnessDeps, HarnessResult } from "./harness.js";
import type { GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  handleGoal: vi.fn(),
  handleGoalStatus: vi.fn(),
  handleGoalAnswer: vi.fn(),
  handleGoalApprove: vi.fn(),
  agentViaGateway: vi.fn(),
  inProcessGoalCommand: vi.fn(),
}));

let testGoalsDir: string;

vi.mock("../../goal/run-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../goal/run-store.js")>();
  return {
    ...actual,
    resolveGoalsDir: () => testGoalsDir,
    listRuns: (dir?: string) => actual.listRuns(dir ?? testGoalsDir),
    loadRun: (id: string, dir?: string) => actual.loadRun(id, dir ?? testGoalsDir),
    saveRun: (run: SerializedRun, dir?: string) => actual.saveRun(run, dir ?? testGoalsDir),
    resolveRunId: (partial: string, dir?: string) =>
      actual.resolveRunId(partial, dir ?? testGoalsDir),
  };
});

vi.mock("../../telegram/goal-commands.js", () => ({
  handleGoal: mocks.handleGoal,
  handleGoalStatus: mocks.handleGoalStatus,
  handleGoalAnswer: mocks.handleGoalAnswer,
  handleGoalApprove: mocks.handleGoalApprove,
}));

vi.mock("../../commands/agent-via-gateway.js", () => ({
  agentViaGatewayCommand: mocks.agentViaGateway,
}));

vi.mock("../../commands/goal.js", () => ({
  goalCommand: mocks.inProcessGoalCommand,
}));

// Request Edit revisions require a real continuation backend (see 2a59e40
// "fix-request-edit-recompute"). Provide a deterministic fake client so the
// harness path can drive a successful revision without Telegram or a live LLM.
const REVISED_BRIEF_SUMMARY = "Revised: draft the next continuation plan.";
const REVISED_PROPOSED_PROMPT = "Draft the next plan incorporating the requested revision.";
vi.mock("../../telegram/continuation-client.js", () => ({
  resolveContinuationClient: () => ({
    complete: async () => ({
      text: JSON.stringify({
        briefSummary: REVISED_BRIEF_SUMMARY,
        runAt: "now",
        proposedPrompt: REVISED_PROPOSED_PROMPT,
        decisions: [],
      }),
    }),
  }),
}));

const RUN_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const PROPOSAL_ID = "bbbbbbbb-2222-3333-4444-555555555555";

function run(overrides: Partial<SerializedRun> = {}): SerializedRun {
  return {
    runId: RUN_ID,
    goal: "Harness test",
    state: "blocked",
    plan: {
      goal: "Harness test",
      workingDir: "/tmp/ws",
      summary: "Plan",
      shortSummary: "Plan",
      steps: [
        {
          id: "blocked-step",
          description: "Blocked step",
          shortSummary: "Blocked step",
          dependsOn: [],
          status: "blocked",
          blockedReason: "user_input",
          blockedQuestion: "Need details",
        },
      ],
    },
    stepResults: {},
    blocked: {
      blockedAt: "execution",
      prompt: "Need details",
      requiredInputKey: "task:blocked-step:input",
    },
    answers: {},
    workingDir: "/tmp/ws",
    model: undefined,
    dryRun: false,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    planRevision: 1,
    activePlanRevision: 1,
    planNumber: 1,
    ...overrides,
  };
}

function continuationRun(): SerializedRun {
  return run({
    state: "done",
    blocked: null,
    pendingContinuation: {
      proposalId: PROPOSAL_ID,
      fromPlanNumber: 1,
      fromRevision: 1,
      goalAchieved: false,
      briefSummary: "Continue.",
      proposedPrompt: "Draft the next plan.",
      runAt: "now",
      status: "pending",
      createdAt: "2026-06-01T00:00:00.000Z",
    },
  });
}

async function callHarness(
  method: "harness.command" | "harness.callback" | "harness.reply" | "harness.gateway_restart",
  params: Record<string, unknown>,
  deps?: HarnessDeps,
) {
  const { createHarnessHandlers } = await import("./harness.js");
  const handlers = createHarnessHandlers(deps);
  const respond = vi.fn();
  await handlers[method]?.({
    params,
    respond,
    context: {} as GatewayRequestContext,
    req: { type: "req", id: "1", method },
    client: null,
    isWebchatConnect: () => false,
  });
  return respond.mock.calls[0] as [boolean, HarnessResult | undefined, unknown?];
}

describe("gateway harness server methods", () => {
  beforeEach(() => {
    testGoalsDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-harness-goals-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(testGoalsDir, { recursive: true, force: true });
  });

  it("routes /new_goal through the goal command path and returns dev ownership evidence", async () => {
    const { saveRun } = await import("../../goal/run-store.js");
    mocks.handleGoal.mockImplementation(async (text: string) => {
      saveRun(run({ goal: text, state: "awaiting_approval", blocked: null }));
      return { text: "planned", runId: RUN_ID };
    });

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-harness-home-"));
    const [ok, payload] = await callHarness(
      "harness.command",
      { command: "new_goal", text: "Build harness" },
      { env: { SMITHERSBOT_INSTANCE: "dev" }, homedir: () => home },
    );

    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      ok: true,
      ownership: {
        instance: "dev",
        port: 18790,
        stateRoot: path.join(home, ".smithersbot-dev"),
        runId: RUN_ID,
        runJsonPath: path.join(home, ".smithersbot-dev", "goals", RUN_ID, "run.json"),
      },
    });
    expect(mocks.handleGoal).toHaveBeenCalledWith("Build harness");
    expect(mocks.agentViaGateway).not.toHaveBeenCalled();
    expect(mocks.inProcessGoalCommand).not.toHaveBeenCalled();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("returns stable-owned evidence when the target gateway resolves stable", async () => {
    mocks.handleGoal.mockResolvedValue({ text: "planned", runId: RUN_ID });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-harness-home-"));

    const [, payload] = await callHarness(
      "harness.command",
      { command: "goal", text: "Stable smoke" },
      { env: { SMITHERSBOT_INSTANCE: "stable" }, homedir: () => home },
    );

    expect(payload?.ownership).toMatchObject({
      instance: "stable",
      port: 18789,
      stateRoot: path.join(home, ".smithersbot"),
      runJsonPath: path.join(home, ".smithersbot", "goals", RUN_ID, "run.json"),
    });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("routes goal_status, goal_answer, and goal_resume through Telegram command cores", async () => {
    mocks.handleGoalStatus.mockResolvedValue("status text");
    mocks.handleGoalAnswer.mockResolvedValue("answer text");
    mocks.handleGoalApprove.mockResolvedValue("resume text");

    await callHarness("harness.command", { command: "goal_status", runId: RUN_ID });
    await callHarness("harness.command", {
      command: "goal_answer",
      runId: RUN_ID,
      text: "postgres",
    });
    await callHarness("harness.command", { command: "goal_resume", runId: RUN_ID });

    expect(mocks.handleGoalStatus).toHaveBeenCalledWith(RUN_ID);
    expect(mocks.handleGoalAnswer).toHaveBeenCalledWith(RUN_ID, "postgres");
    expect(mocks.handleGoalApprove).toHaveBeenCalledWith(RUN_ID);
  });

  it("drives continuation callbacks and reply text without Telegram", async () => {
    const { loadRun, saveRun } = await import("../../goal/run-store.js");
    saveRun(continuationRun());

    const [, payload] = await callHarness("harness.callback", {
      action: "request_edit",
      runId: "aaaaaaaa",
      proposalIdPrefix: "bbbbbbbb",
      text: "Use a revised prompt.",
    });

    const joined = payload?.messages.map((entry) => entry.text).join("\n") ?? "";
    expect(joined).toContain("Continue this goal with a new plan?");
    expect(joined).toContain(REVISED_BRIEF_SUMMARY);
    expect(joined).not.toContain("no continuation backend was available");
    expect(loadRun(RUN_ID)?.pendingContinuation).toMatchObject({
      proposedPrompt: REVISED_PROPOSED_PROMPT,
      status: "edited",
      lastContinuationEditMessage: "Use a revised prompt.",
    });
  });

  it("drives Add Details callback and reply equivalents without Telegram", async () => {
    const { loadRun, saveRun } = await import("../../goal/run-store.js");
    saveRun(run());

    const [, callbackPayload] = await callHarness("harness.callback", {
      action: "add_details",
      runId: "aaaaaaaa",
      text: "Use postgres.",
    });
    expect(callbackPayload?.messages.map((entry) => entry.text).join("\n")).toContain(
      "Right away, sir. Resuming the goal now.",
    );
    expect(loadRun(RUN_ID)?.resumeNotes?.[0]).toMatchObject({
      source: "add_details",
      userText: "Use postgres.",
    });

    saveRun(run({ runId: "cccccccc-1111-2222-3333-444444444444" }));
    await callHarness("harness.reply", {
      kind: "add_details",
      runId: "cccccccc",
      text: "Use sqlite.",
    });
    expect(loadRun("cccccccc-1111-2222-3333-444444444444")?.resumeNotes?.[0]).toMatchObject({
      source: "add_details",
      userText: "Use sqlite.",
    });
  });

  it("derives gateway_restart unit from the resolved instance and rejects arbitrary units", async () => {
    const restart = vi.fn(() => ({ ok: true, method: "systemd" as const, tried: [] }));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-harness-home-"));

    const [ok, payload] = await callHarness(
      "harness.gateway_restart",
      {},
      { env: { SMITHERSBOT_INSTANCE: "dev" }, homedir: () => home, restart },
    );

    expect(ok).toBe(true);
    expect(restart).toHaveBeenCalledWith("smithersbot-dev-gateway.service");
    expect(payload?.restart?.unit).toBe("smithersbot-dev-gateway.service");

    const [unsafeOk, unsafePayload, unsafeError] = await callHarness(
      "harness.gateway_restart",
      { unit: "smithersbot-gateway.service" },
      { env: { SMITHERSBOT_INSTANCE: "dev" }, homedir: () => home, restart },
    );

    expect(unsafeOk).toBe(false);
    expect(unsafePayload).toBeUndefined();
    expect(String((unsafeError as { message?: string })?.message)).toContain("arbitrary systemd");
    expect(restart).toHaveBeenCalledTimes(1);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("does not expose private env/auth/session/config values in harness responses", async () => {
    mocks.handleGoal.mockResolvedValue({ text: "planned", runId: RUN_ID });
    const secret = "super-secret-token-value";
    const [, payload] = await callHarness(
      "harness.command",
      { command: "new_goal", text: "No leaks" },
      { env: { SMITHERSBOT_INSTANCE: "dev", SMITHERSBOT_GATEWAY_TOKEN: secret } },
    );

    expect(JSON.stringify(payload)).not.toContain(secret);
    expect(JSON.stringify(payload)).not.toContain("SMITHERSBOT_GATEWAY_TOKEN");
  });
});
