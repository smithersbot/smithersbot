import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../commands/agent-via-gateway.js", () => ({
  agentCliCommand: vi.fn(),
}));
vi.mock("../../commands/goal.js", () => ({
  goalCommand: vi.fn(),
}));

import { resolveGatewayInstanceIdentity } from "../../config/gateway-instance.js";
import { agentCliCommand } from "../../commands/agent-via-gateway.js";
import { goalCommand } from "../../commands/goal.js";
import {
  registerHarnessCommand,
  runHarnessCallbackCli,
  runHarnessCommandCli,
  runHarnessReplyCli,
} from "./register.harness.js";

const home = () => "/Users/test";
const dev = resolveGatewayInstanceIdentity("dev", home);
const stable = resolveGatewayInstanceIdentity("stable", home);

function harnessResult(instance: "stable" | "dev", runId = "run-1") {
  const identity = instance === "dev" ? dev : stable;
  return {
    ok: true,
    messages: [{ text: "created goal" }],
    ownership: {
      instance,
      port: identity.defaultPort,
      stateRoot: identity.stateDir,
      serviceUnit: identity.serviceUnit,
      runId,
      runJsonPath: `${identity.stateDir}/goals/${runId}/run.json`,
    },
  };
}

function deps(result = harnessResult("dev")) {
  const logs: string[] = [];
  const callGateway = vi.fn(async () => result);
  return {
    logs,
    callGateway,
    deps: {
      callGateway,
      homedir: home,
      log: (message: string) => logs.push(message),
    },
  };
}

describe("harness CLI", () => {
  it("rejects a missing explicit instance before any gateway call", async () => {
    const d = deps();

    await expect(runHarnessCommandCli("/new_goal", ["ship", "it"], {}, d.deps)).rejects.toThrow(
      "Harness requires an explicit --instance stable|dev.",
    );

    expect(d.callGateway).not.toHaveBeenCalled();
  });

  it("rejects an unknown instance with a clear error before any gateway call", async () => {
    const d = deps();

    await expect(
      runHarnessCommandCli("/new_goal", ["ship", "it"], { instance: "prod" }, d.deps),
    ).rejects.toThrow('Unknown SmithersBot gateway instance "prod"');

    expect(d.callGateway).not.toHaveBeenCalled();
  });

  it("dispatches /new_goal through harness.command over callGateway, not agent or in-process goal", async () => {
    const d = deps(harnessResult("dev", "run-dev"));

    await runHarnessCommandCli("/new_goal", ["clean", "up"], { instance: "dev" }, d.deps);

    expect(d.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `ws://127.0.0.1:${dev.defaultPort}`,
        method: "harness.command",
        params: { command: "new_goal", text: "clean up" },
        config: { gateway: { mode: "local", bind: "loopback", port: dev.defaultPort } },
      }),
    );
    expect(agentCliCommand).not.toHaveBeenCalled();
    expect(goalCommand).not.toHaveBeenCalled();
    expect(d.logs.join("\n")).toContain("Ownership: dev-owned");
    expect(d.logs.join("\n")).toContain("runId=run-dev");
    expect(d.logs.join("\n")).toContain(`runJsonPath=${dev.stateDir}/goals/run-dev/run.json`);
  });

  it("prints stable-owned evidence for a stable target", async () => {
    const d = deps(harnessResult("stable", "run-stable"));

    await runHarnessCommandCli("goal_status", ["run-stable"], { instance: "stable" }, d.deps);

    expect(d.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `ws://127.0.0.1:${stable.defaultPort}`,
        method: "harness.command",
        params: { command: "goal_status", runId: "run-stable" },
      }),
    );
    const output = d.logs.join("\n");
    expect(output).toContain("Ownership: stable-owned");
    expect(output).toContain(`port=${stable.defaultPort}`);
    expect(output).toContain(`stateRoot=${stable.stateDir}`);
    expect(output).toContain(`runJsonPath=${stable.stateDir}/goals/run-stable/run.json`);
  });

  it("emits a single parseable JSON payload for --json output", async () => {
    const d = deps(harnessResult("dev", "run-json"));

    await runHarnessCommandCli(
      "goal_status",
      ["run-json"],
      { instance: "dev", json: true },
      d.deps,
    );

    expect(d.logs).toHaveLength(1);
    expect(d.logs[0]?.startsWith("│")).toBe(false);
    const parsed = JSON.parse(d.logs[0] ?? "");
    expect(parsed.ownership.runId).toBe("run-json");
    expect(parsed.ownership.instance).toBe("dev");
  });

  it("maps goal_answer, goal_resume, gateway_status, and gateway_restart to narrow harness RPCs", async () => {
    const d = deps(harnessResult("dev", "run-dev"));

    await runHarnessCommandCli(
      "goal_answer",
      ["run-dev", "answer", "text"],
      { instance: "dev" },
      d.deps,
    );
    await runHarnessCommandCli("goal_resume", ["run-dev"], { instance: "dev" }, d.deps);
    await runHarnessCommandCli("gateway_status", [], { instance: "dev" }, d.deps);
    await runHarnessCommandCli("gateway_restart", [], { instance: "dev" }, d.deps);

    expect(d.callGateway.mock.calls.map((call) => call[0].method)).toEqual([
      "harness.command",
      "harness.command",
      "harness.command",
      "harness.gateway_restart",
    ]);
    expect(d.callGateway.mock.calls[0]?.[0].params).toEqual({
      command: "goal_answer",
      runId: "run-dev",
      text: "answer text",
    });
    expect(d.callGateway.mock.calls[3]?.[0].params).toEqual({ command: "gateway_restart" });
    expect(JSON.stringify(d.callGateway.mock.calls)).not.toContain("smithersbot-gateway.service");
  });

  it("maps callback and reply flows to namespaced harness RPC methods", async () => {
    const d = deps(harnessResult("dev", "run-dev"));

    await runHarnessCallbackCli(
      "request_edit",
      "run-dev",
      ["updated", "prompt"],
      { instance: "dev", proposalId: "proposal-1" },
      d.deps,
    );
    await runHarnessCallbackCli(
      "add_details",
      "run-dev",
      ["more", "context"],
      { instance: "dev" },
      d.deps,
    );
    await runHarnessCallbackCli("resume", "run-dev", [], { instance: "dev" }, d.deps);
    await runHarnessReplyCli(
      "continuation_edit",
      "run-dev",
      ["final", "prompt"],
      { instance: "dev" },
      d.deps,
    );

    expect(d.callGateway.mock.calls.map((call) => call[0].method)).toEqual([
      "harness.callback",
      "harness.callback",
      "harness.callback",
      "harness.reply",
    ]);
    expect(d.callGateway.mock.calls[0]?.[0].params).toEqual({
      action: "request_edit",
      runId: "run-dev",
      text: "updated prompt",
      proposalId: "proposal-1",
    });
    expect(d.callGateway.mock.calls[1]?.[0].params).toEqual({
      action: "add_details",
      runId: "run-dev",
      text: "more context",
    });
    expect(d.callGateway.mock.calls[3]?.[0].params).toEqual({
      kind: "continuation_edit",
      runId: "run-dev",
      text: "final prompt",
    });
  });

  it("gives slow planning/resume commands a generous default timeout so /new_goal returns its runId", async () => {
    const d = deps(harnessResult("dev", "run-dev"));

    await runHarnessCommandCli("/new_goal", ["read", "only", "smoke"], { instance: "dev" }, d.deps);
    await runHarnessCommandCli("goal_resume", ["run-dev"], { instance: "dev" }, d.deps);
    await runHarnessCommandCli(
      "goal_answer",
      ["run-dev", "more", "context"],
      { instance: "dev" },
      d.deps,
    );

    for (const call of d.callGateway.mock.calls) {
      expect(call[0].timeoutMs).toBe(600_000);
    }
  });

  it("keeps the fast 10s default for status/callback/reply commands", async () => {
    const d = deps(harnessResult("dev", "run-dev"));

    await runHarnessCommandCli("gateway_status", [], { instance: "dev" }, d.deps);
    await runHarnessCommandCli("goal_status", ["run-dev"], { instance: "dev" }, d.deps);
    await runHarnessCallbackCli("approve_prompt", "run-dev", [], { instance: "dev" }, d.deps);
    await runHarnessReplyCli("add_details", "run-dev", ["note"], { instance: "dev" }, d.deps);

    for (const call of d.callGateway.mock.calls) {
      expect(call[0].timeoutMs).toBe(10_000);
    }
  });

  it("honors an explicit --timeout override even for slow commands", async () => {
    const d = deps(harnessResult("dev", "run-dev"));

    await runHarnessCommandCli(
      "/new_goal",
      ["read", "only"],
      { instance: "dev", timeout: "45000" },
      d.deps,
    );

    expect(d.callGateway.mock.calls[0]?.[0].timeoutMs).toBe(45_000);
  });

  it("does not read or print private config/auth/session values", async () => {
    const d = deps(harnessResult("dev", "run-dev"));
    process.env.SMITHERSBOT_SECRET_TEST_VALUE = "do-not-print-secret";
    try {
      await runHarnessCommandCli("/goal", ["safe", "placeholder"], { instance: "dev" }, d.deps);
    } finally {
      delete process.env.SMITHERSBOT_SECRET_TEST_VALUE;
    }

    const call = d.callGateway.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      url: `ws://127.0.0.1:${dev.defaultPort}`,
      config: { gateway: { mode: "local", bind: "loopback", port: dev.defaultPort } },
    });
    expect(call).not.toHaveProperty("token");
    expect(call).not.toHaveProperty("configPath");
    expect(JSON.stringify(call)).not.toContain("do-not-print-secret");
    expect(d.logs.join("\n")).not.toContain("do-not-print-secret");
  });

  it("registers a commander harness subcommand with required --instance", async () => {
    const program = new Command();
    program.exitOverride();
    registerHarnessCommand(program);

    await expect(
      program.parseAsync(["harness", "command", "/new_goal", "ship"], { from: "user" }),
    ).rejects.toThrow(/required option '--instance <stable\|dev>' not specified/);
  });
});
