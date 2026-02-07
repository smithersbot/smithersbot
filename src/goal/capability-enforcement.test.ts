import { describe, expect, it } from "vitest";
import type { BashOperations } from "@mariozechner/pi-coding-agent";
import { createEnforcedBashOperations } from "./capability-enforcement.js";
import { createDefaultPolicy, isPathDenied, isPathWithinGrants } from "./capability-policy.js";
import { computeEffectiveCapabilities } from "./capability-broker.js";
import type { DeniedAction, EffectiveCapabilities } from "./capability-types.js";
import type { PlanStep } from "./types.js";

const WORKING_DIR = "/home/user/project";

function makeStep(overrides?: Partial<PlanStep>): PlanStep {
  return {
    id: "test-step",
    description: "Test step",
    dependsOn: [],
    status: "pending",
    ...overrides,
  };
}

/** Mock BashOperations that records calls. */
function mockBashOps(): BashOperations & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async exec(command, _cwd, options) {
      calls.push(command);
      options.onData(Buffer.from("ok\n"));
      return { exitCode: 0 };
    },
  };
}

describe("createEnforcedBashOperations", () => {
  const policy = createDefaultPolicy(WORKING_DIR);
  const step = makeStep();
  const effective = computeEffectiveCapabilities(policy, step, WORKING_DIR);

  function createEnforced(effectiveOverride?: EffectiveCapabilities): {
    ops: BashOperations;
    denied: DeniedAction[];
    mockOps: BashOperations & { calls: string[] };
  } {
    const denied: DeniedAction[] = [];
    const mock = mockBashOps();
    const ops = createEnforcedBashOperations(
      effectiveOverride ?? effective,
      WORKING_DIR,
      policy,
      (d) => denied.push(d),
      mock,
    );
    return { ops, denied, mockOps: mock };
  }

  it("allows pnpm test", async () => {
    const { ops, denied, mockOps } = createEnforced();
    const result = await ops.exec("pnpm test", WORKING_DIR, {
      onData: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(denied).toEqual([]);
    expect(mockOps.calls).toEqual(["pnpm test"]);
  });

  it("denies sudo (hard deny)", async () => {
    const { ops, denied } = createEnforced();
    const output: string[] = [];
    const result = await ops.exec("sudo apt-get install vim", WORKING_DIR, {
      onData: (data) => output.push(data.toString()),
    });
    expect(result.exitCode).toBe(126);
    expect(denied.length).toBe(1);
    expect(denied[0]!.hardDeny).toBe(true);
    expect(output.join("")).toContain("DENIED");
  });

  it("denies git push --force (hard deny)", async () => {
    const { ops, denied } = createEnforced();
    const result = await ops.exec("git push --force origin main", WORKING_DIR, {
      onData: () => {},
    });
    expect(result.exitCode).toBe(126);
    expect(denied.length).toBe(1);
    expect(denied[0]!.hardDeny).toBe(true);
  });

  it("denies curl (network, missing cap — soft deny)", async () => {
    const { ops, denied } = createEnforced();
    const result = await ops.exec("curl https://example.com", WORKING_DIR, {
      onData: () => {},
    });
    expect(result.exitCode).toBe(126);
    expect(denied.length).toBe(1);
    expect(denied[0]!.hardDeny).toBe(false); // capability-gated, not hard deny
    expect(denied[0]!.type).toBe("network");
    expect(denied[0]!.missingCapabilityId).toBe("network.read_only");
  });

  it("allows curl when network.read_only is granted", async () => {
    const stepWithNetwork = makeStep({
      requestedCapabilities: [{ id: "network.read_only" }],
    });
    const effectiveWithNetwork = computeEffectiveCapabilities(policy, stepWithNetwork, WORKING_DIR);
    const { ops, denied, mockOps } = createEnforced(effectiveWithNetwork);
    const result = await ops.exec("curl https://example.com", WORKING_DIR, {
      onData: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(denied).toEqual([]);
    expect(mockOps.calls).toEqual(["curl https://example.com"]);
  });

  it("denies curl when only network.registry_only is granted", async () => {
    const stepWithRegistry = makeStep({
      requestedCapabilities: [{ id: "network.registry_only" }],
    });
    const effectiveWithRegistry = computeEffectiveCapabilities(
      policy,
      stepWithRegistry,
      WORKING_DIR,
    );
    const { ops, denied } = createEnforced(effectiveWithRegistry);
    const result = await ops.exec("curl https://example.com", WORKING_DIR, {
      onData: () => {},
    });
    expect(result.exitCode).toBe(126);
    expect(denied.length).toBe(1);
    expect(denied[0]!.hardDeny).toBe(false);
    expect(denied[0]!.type).toBe("network");
  });

  it("denies cat (bash bypass, not in exec.safe)", async () => {
    const { ops, denied } = createEnforced();
    const result = await ops.exec("cat .env", WORKING_DIR, {
      onData: () => {},
    });
    expect(result.exitCode).toBe(126);
    expect(denied.length).toBe(1);
    expect(denied[0]!.hardDeny).toBe(false);
  });

  it("denies head (bash bypass)", async () => {
    const { ops, denied } = createEnforced();
    const result = await ops.exec("head -n 10 /etc/passwd", WORKING_DIR, {
      onData: () => {},
    });
    expect(result.exitCode).toBe(126);
    expect(denied.length).toBe(1);
  });

  it("denies cp (bash bypass)", async () => {
    const { ops, denied } = createEnforced();
    const result = await ops.exec("cp .env .env.bak", WORKING_DIR, {
      onData: () => {},
    });
    expect(result.exitCode).toBe(126);
    expect(denied.length).toBe(1);
  });

  it("denies npm install (missing exec.install_deps)", async () => {
    const { ops, denied } = createEnforced();
    const result = await ops.exec("npm install express", WORKING_DIR, {
      onData: () => {},
    });
    expect(result.exitCode).toBe(126);
    expect(denied.length).toBe(1);
    expect(denied[0]!.missingCapabilityId).toBe("exec.install_deps");
  });

  it("allows npm install when exec.install_deps is granted", async () => {
    const stepWithInstall = makeStep({
      requestedCapabilities: [
        {
          id: "exec.install_deps",
          commandPatterns: [
            "npm install",
            "pnpm install",
            "bun install",
            "pip install",
            "yarn add",
          ],
        },
      ],
    });
    const effectiveWithInstall = computeEffectiveCapabilities(policy, stepWithInstall, WORKING_DIR);
    const { ops, denied, mockOps } = createEnforced(effectiveWithInstall);
    const result = await ops.exec("npm install express", WORKING_DIR, {
      onData: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(denied).toEqual([]);
    expect(mockOps.calls).toEqual(["npm install express"]);
  });

  it("denies git push when git.push_private not granted", async () => {
    const { ops, denied } = createEnforced();
    const result = await ops.exec("git push origin main", WORKING_DIR, {
      onData: () => {},
    });
    expect(result.exitCode).toBe(126);
    expect(denied.length).toBe(1);
    expect(denied[0]!.type).toBe("exec");
    // git push is not in exec.safe so it fails at the grant check first
    expect(denied[0]!.missingCapabilityId).toBe("git.push_private");
  });

  it("DeniedAction callback fires with correct fields", async () => {
    const { ops, denied } = createEnforced();
    await ops.exec("sudo rm -rf /", WORKING_DIR, { onData: () => {} });
    expect(denied.length).toBe(1);
    const action = denied[0]!;
    expect(action.type).toBe("exec");
    expect(action.command).toBe("sudo rm -rf /");
    expect(action.hardDeny).toBe(true);
    expect(typeof action.reason).toBe("string");
  });
});

describe("path enforcement helpers", () => {
  const policy = createDefaultPolicy(WORKING_DIR);

  it("Read: repo file allowed", () => {
    const deny = isPathDenied(`${WORKING_DIR}/src/index.ts`, policy.hardDenies);
    expect(deny).toBeNull();
    expect(isPathWithinGrants(`${WORKING_DIR}/src/index.ts`, policy.baseline, WORKING_DIR)).toBe(
      true,
    );
  });

  it("Read: /etc/passwd denied (outside scope)", () => {
    expect(isPathWithinGrants("/etc/passwd", policy.baseline, WORKING_DIR)).toBe(false);
  });

  it("Write: .env denied (hard deny)", () => {
    const deny = isPathDenied(`${WORKING_DIR}/.env`, policy.hardDenies);
    expect(deny).not.toBeNull();
  });

  it("Write: repo file allowed", () => {
    const deny = isPathDenied(`${WORKING_DIR}/src/app.ts`, policy.hardDenies);
    expect(deny).toBeNull();
    expect(isPathWithinGrants(`${WORKING_DIR}/src/app.ts`, policy.baseline, WORKING_DIR)).toBe(
      true,
    );
  });
});
