import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildParityLeg,
  compareLegOutcomes,
  createMockParityExecutor,
  formatParityReport,
  normalizeLegOutcome,
  parityLegInputs,
  parityLegSessionId,
  runShadowParity,
  type ParityCase,
  type ParityLegFixture,
} from "./tui-pilot-parity.js";

// Fixtures modeled on docs/tui-pilot-parity/samples/ (real claude v2.1.170
// stream-json captures). The direct leg emits native stream-json; the tui-pilot
// leg emits transcript-derived stream-json carrying the same system/assistant
// events plus a synthesized result envelope, per implementation-detail.md
// "tui-pilot Output Contract".

function initLine(sessionId: string, model: string): string {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model,
    apiKeySource: "none",
  });
}

function assistantLine(sessionId: string, text: string, error?: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    session_id: sessionId,
    ...(error ? { error } : {}),
  });
}

function resultLine(sessionId: string, text: string, isError: boolean): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: isError,
    result: text,
    session_id: sessionId,
    total_cost_usd: 0.0123,
    duration_ms: 4567,
  });
}

/** A clean successful goal-worker run. tui-pilot omits cost/duration fields. */
function successFixtures(text: string): Record<"direct" | "tui-pilot", ParityLegFixture> {
  const workerResult = { status: "complete", summary: "did the thing" };
  return {
    direct: {
      stdout: [
        initLine("sess-direct", "claude-haiku-4-5-20251001"),
        assistantLine("sess-direct", text),
        resultLine("sess-direct", text, false),
      ].join("\n"),
      exitCode: 0,
      workerResult,
    },
    "tui-pilot": {
      stdout: [
        initLine("sess-tui", "claude-haiku-4-5-20251001"),
        assistantLine("sess-tui", text),
        // synthesized result envelope, no cost/duration fields consumed
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: text,
          session_id: "sess-tui",
        }),
      ].join("\n"),
      exitCode: 0,
      workerResult,
    },
  };
}

const SUCCESS_CASE: ParityCase = {
  name: "goal-worker success",
  prompt: "Do the thing and write worker_result.json",
  allowedTools: ["Bash", "Read", "Write"],
  model: "claude-haiku-4-5-20251001",
  settings: { permissions: { deny: ["Read(./.env)"] }, sandbox: { enabled: true } },
  expectsWorkerResult: true,
};

const AUTH_FAIL_CASE: ParityCase = {
  name: "preflight auth failure",
  prompt: "Anything",
  allowedTools: ["Bash"],
  model: "claude-haiku-4-5-20251001",
  settings: { sandbox: { enabled: true } },
  expectsWorkerResult: true,
};

const SINGLE_TURN_CASE: ParityCase = {
  name: "single-turn lessons",
  prompt: "Summarize lessons",
  allowedTools: [],
  maxTurns: "1",
  model: "claude-haiku-4-5-20251001",
  settings: { sandbox: { enabled: true } },
  expectsWorkerResult: false,
};

describe("tui-pilot shadow-parity harness", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-test-"));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("derives fresh, valid-UUID per-leg session ids (Claude requires a UUID, rejects reuse)", () => {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const a = parityLegSessionId();
    const b = parityLegSessionId();
    expect(a).toMatch(uuidRe);
    expect(b).toMatch(uuidRe);
    expect(a).not.toBe(b);
  });

  it("builds matched leg inputs: direct keeps claude+--model, tui-pilot folds model into settings", () => {
    const legDir = path.join(rootDir, "build");
    const direct = buildParityLeg({
      parityCase: SUCCESS_CASE,
      mode: "direct",
      legDir: `${legDir}-d`,
    });
    const tui = buildParityLeg({
      parityCase: SUCCESS_CASE,
      mode: "tui-pilot",
      legDir: `${legDir}-t`,
    });

    // direct mode preserves the claude command + -p prompt run verbatim
    expect(direct.command).toBe("claude");
    expect(direct.args).toContain("-p");
    expect(direct.args).toContain("--model");

    // tui-pilot mode routes to the tui-pilot binary with a `print` subcommand
    expect(direct.command).not.toBe(tui.command);
    expect(tui.args[0]).toBe("print");
    // model is folded into settings.json and dropped from the CLI
    expect(tui.args).not.toContain("--model");

    const di = parityLegInputs(direct);
    const ti = parityLegInputs(tui);
    // equivalent effective model, allowed tools, settings present on both legs
    expect(di.effectiveModel).toBe("claude-haiku-4-5-20251001");
    expect(ti.effectiveModel).toBe("claude-haiku-4-5-20251001");
    expect(di.allowedTools).toEqual(["Bash", "Read", "Write"]);
    expect(ti.allowedTools).toEqual(["Bash", "Read", "Write"]);
    expect(di.hasSettings).toBe(true);
    expect(ti.hasSettings).toBe(true);
    // session ids are per-leg distinct
    expect(di.sessionId).not.toBe(ti.sessionId);
  });

  it("passes parity when both legs emit equivalent success output", async () => {
    const executor = createMockParityExecutor({
      [SUCCESS_CASE.name]: successFixtures("All done."),
    });
    const report = await runShadowParity({ cases: [SUCCESS_CASE], rootDir, executor });
    expect(report.passed).toBe(true);
    const [c] = report.cases;
    expect(c!.mismatches).toEqual([]);
    expect(c!.inputDiscrepancies).toEqual([]);
    expect(c!.direct.finalText).toBe("All done.");
    expect(c!.tuiPilot.finalText).toBe("All done.");
    expect(c!.direct.attemptOutcome).toBe("complete");
    expect(c!.tuiPilot.attemptOutcome).toBe("complete");
    // cost/duration present in direct stdout must NOT leak into compared fields
    expect(JSON.stringify(c!.direct)).not.toContain("total_cost_usd");
  });

  it("classifies a mid-run provider error identically across legs (out_of_credits)", async () => {
    const creditsText = "Credit balance is too low. Please add credits to continue.";
    const executor = createMockParityExecutor({
      [SUCCESS_CASE.name]: {
        direct: {
          stdout: [
            initLine("sess-direct", "claude-haiku-4-5-20251001"),
            assistantLine("sess-direct", creditsText, "billing_error"),
            resultLine("sess-direct", creditsText, true),
          ].join("\n"),
          exitCode: 1,
          // no worker_result.json written on provider failure
        },
        "tui-pilot": {
          stdout: [
            initLine("sess-tui", "claude-haiku-4-5-20251001"),
            assistantLine("sess-tui", creditsText, "billing_error"),
            JSON.stringify({
              type: "result",
              subtype: "success",
              is_error: true,
              result: creditsText,
              session_id: "sess-tui",
            }),
          ].join("\n"),
          exitCode: 1,
        },
      },
    });
    const report = await runShadowParity({ cases: [SUCCESS_CASE], rootDir, executor });
    expect(report.passed).toBe(true);
    const [c] = report.cases;
    expect(c!.direct.providerErrorClass).toBe("out_of_credits");
    expect(c!.tuiPilot.providerErrorClass).toBe("out_of_credits");
    expect(c!.direct.attemptOutcome).toBe(c!.tuiPilot.attemptOutcome);
  });

  it("keeps credits, rate-limit, and auth provider classes distinct", async () => {
    const cases: Array<{ text: string; assistantErr: string; expected: string }> = [
      {
        text: "Rate limit exceeded, too many requests",
        assistantErr: "rate_limit",
        expected: "rate_limit",
      },
      {
        text: "Insufficient credit balance for this request",
        assistantErr: "billing_error",
        expected: "out_of_credits",
      },
      {
        text: "Not logged in · Please run /login",
        assistantErr: "authentication_failed",
        expected: "auth",
      },
    ];
    for (const { text, assistantErr, expected } of cases) {
      const stdout = [
        initLine("s", "m"),
        assistantLine("s", text, assistantErr),
        resultLine("s", text, true),
      ].join("\n");
      const out = normalizeLegOutcome({
        mode: "tui-pilot",
        parityCase: SUCCESS_CASE,
        result: { stdout, stderr: "", exitCode: 1, signal: null, timedOut: false, durationMs: 0 },
      });
      expect(out.providerErrorClass).toBe(expected);
    }
  });

  it("classifies a pre-flight failure (no transcript) from exit + screen text", async () => {
    // tui-pilot surfaces ERRORED screen text on a non-zero exit with no transcript
    const executor = createMockParityExecutor({
      [AUTH_FAIL_CASE.name]: {
        direct: {
          stdout: "",
          stderr: "Invalid API key · authentication failed (401)",
          exitCode: 1,
        },
        "tui-pilot": {
          stdout: "ERRORED: Invalid API key · authentication failed (401)",
          stderr: "",
          exitCode: 1,
        },
      },
    });
    const report = await runShadowParity({ cases: [AUTH_FAIL_CASE], rootDir, executor });
    const [c] = report.cases;
    expect(c!.direct.providerErrorClass).toBe("auth");
    expect(c!.tuiPilot.providerErrorClass).toBe("auth");
    expect(c!.direct.attemptOutcome).toBe(c!.tuiPilot.attemptOutcome);
    expect(report.passed).toBe(true);
  });

  it("compares final text only for single-turn (non-worker) callers", async () => {
    const text = "Lesson: always verify.";
    const executor = createMockParityExecutor({
      [SINGLE_TURN_CASE.name]: {
        direct: {
          stdout: [initLine("s", "m"), assistantLine("s", text), resultLine("s", text, false)].join(
            "\n",
          ),
        },
        "tui-pilot": {
          stdout: [initLine("s2", "m"), assistantLine("s2", text)].join("\n"),
        },
      },
    });
    const report = await runShadowParity({ cases: [SINGLE_TURN_CASE], rootDir, executor });
    const [c] = report.cases;
    expect(c!.passed).toBe(true);
    expect(c!.direct.finalText).toBe(text);
    expect(c!.tuiPilot.finalText).toBe(text);
    // non-worker cases do not derive an attempt outcome / worker result
    expect(c!.direct.attemptOutcome).toBeNull();
    expect(c!.direct.workerResult).toBeNull();
  });

  it("detects a final-text mismatch between legs", () => {
    const direct = normalizeLegOutcome({
      mode: "direct",
      parityCase: SINGLE_TURN_CASE,
      result: {
        stdout: assistantLine("s", "answer A"),
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 0,
      },
    });
    const tui = normalizeLegOutcome({
      mode: "tui-pilot",
      parityCase: SINGLE_TURN_CASE,
      result: {
        stdout: assistantLine("s2", "answer B"),
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 0,
      },
    });
    const mismatches = compareLegOutcomes(direct, tui);
    expect(mismatches.map((m) => m.field)).toContain("finalText");
  });

  it("detects a worker_result.json mismatch between legs", async () => {
    const fixtures = successFixtures("done");
    // make tui-pilot report a different status
    fixtures["tui-pilot"].workerResult = { status: "complete", summary: "DIFFERENT summary" };
    const executor = createMockParityExecutor({ [SUCCESS_CASE.name]: fixtures });
    const report = await runShadowParity({ cases: [SUCCESS_CASE], rootDir, executor });
    expect(report.passed).toBe(false);
    expect(report.cases[0]!.mismatches.map((m) => m.field)).toContain("workerResult");
  });

  it("detects a provider-error-class mismatch between legs", () => {
    const direct = normalizeLegOutcome({
      mode: "direct",
      parityCase: SUCCESS_CASE,
      result: {
        stdout: [assistantLine("s", "x", "rate_limit"), resultLine("s", "rate limited", true)].join(
          "\n",
        ),
        stderr: "",
        exitCode: 1,
        signal: null,
        timedOut: false,
        durationMs: 0,
      },
    });
    const tui = normalizeLegOutcome({
      mode: "tui-pilot",
      parityCase: SUCCESS_CASE,
      result: {
        stdout: [
          assistantLine("s2", "x", "billing_error"),
          resultLine("s2", "no credits", true),
        ].join("\n"),
        stderr: "",
        exitCode: 1,
        signal: null,
        timedOut: false,
        durationMs: 0,
      },
    });
    const mismatches = compareLegOutcomes(direct, tui);
    const byField = new Map(mismatches.map((m) => [m.field, m]));
    expect(byField.has("providerErrorClass")).toBe(true);
    expect(byField.get("providerErrorClass")!.direct).toBe("rate_limit");
    expect(byField.get("providerErrorClass")!.tuiPilot).toBe("out_of_credits");
  });

  it("produces operator-facing report text for a multi-case run", async () => {
    const executor = createMockParityExecutor({
      [SUCCESS_CASE.name]: successFixtures("ok"),
      [SINGLE_TURN_CASE.name]: {
        direct: { stdout: assistantLine("s", "hi") },
        "tui-pilot": { stdout: assistantLine("s2", "hi") },
      },
    });
    const report = await runShadowParity({
      cases: [SUCCESS_CASE, SINGLE_TURN_CASE],
      rootDir,
      executor,
    });
    const text = formatParityReport(report);
    expect(text).toContain("Shadow parity: PASS (2 cases)");
    expect(text).toContain(SUCCESS_CASE.name);
    expect(text).toContain(SINGLE_TURN_CASE.name);
  });
});
