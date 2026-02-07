import { describe, expect, it } from "vitest";
import { computeEffectiveCapabilities } from "./capability-broker.js";
import { createDefaultPolicy } from "./capability-policy.js";
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

describe("computeEffectiveCapabilities", () => {
  const policy = createDefaultPolicy(WORKING_DIR);

  it("baseline-only: effective caps = baseline when step has no requests", () => {
    const step = makeStep();
    const effective = computeEffectiveCapabilities(policy, step, WORKING_DIR);
    expect(effective.grants).toEqual(policy.baseline);
    expect(effective.denies).toEqual(policy.hardDenies);
    expect(effective.nodeGrants).toEqual([]);
  });

  it("node request adds to effective caps", () => {
    const step = makeStep({
      requestedCapabilities: [
        {
          id: "exec.install_deps",
          commandPatterns: ["npm install", "pnpm install"],
        },
      ],
    });
    const effective = computeEffectiveCapabilities(policy, step, WORKING_DIR);
    expect(effective.grants.length).toBe(policy.baseline.length + 1);
    expect(effective.nodeGrants.length).toBe(1);
    expect(effective.nodeGrants[0]!.id).toBe("exec.install_deps");
  });

  it("unknown capability ID silently dropped", () => {
    const step = makeStep({
      requestedCapabilities: [{ id: "unknown.thing" as never }],
    });
    const effective = computeEffectiveCapabilities(policy, step, WORKING_DIR);
    expect(effective.grants).toEqual(policy.baseline);
    expect(effective.nodeGrants).toEqual([]);
  });

  it("path globs outside workingDir rejected", () => {
    const step = makeStep({
      requestedCapabilities: [
        {
          id: "fs.write_config",
          pathGlobs: ["/etc/config/**"],
        },
      ],
    });
    const effective = computeEffectiveCapabilities(policy, step, WORKING_DIR);
    expect(effective.nodeGrants).toEqual([]);
  });

  it("overly broad patterns (**/*) for fs.write_config rejected", () => {
    const step = makeStep({
      requestedCapabilities: [
        {
          id: "fs.write_config",
          pathGlobs: ["**/*"],
        },
      ],
    });
    const effective = computeEffectiveCapabilities(policy, step, WORKING_DIR);
    expect(effective.nodeGrants).toEqual([]);
  });

  it("command patterns matching hard denies rejected", () => {
    const step = makeStep({
      requestedCapabilities: [
        {
          id: "exec.install_deps",
          commandPatterns: ["sudo npm install"],
        },
      ],
    });
    const effective = computeEffectiveCapabilities(policy, step, WORKING_DIR);
    expect(effective.nodeGrants).toEqual([]);
  });

  it("TTL: attempt-scoped grant excluded on attempt > 1", () => {
    const step = makeStep({
      requestedCapabilities: [
        {
          id: "exec.install_deps",
          ttl: "attempt",
          commandPatterns: ["npm install"],
        },
      ],
    });
    // First attempt includes it
    const first = computeEffectiveCapabilities(policy, step, WORKING_DIR, 1);
    expect(first.nodeGrants.length).toBe(1);

    // Retry excludes it
    const retry = computeEffectiveCapabilities(policy, step, WORKING_DIR, 2);
    expect(retry.nodeGrants.length).toBe(0);
  });

  it("determinism: same inputs produce same output", () => {
    const step = makeStep({
      requestedCapabilities: [
        {
          id: "network.read_only",
          domainAllowlist: ["example.com"],
        },
      ],
    });
    const first = computeEffectiveCapabilities(policy, step, WORKING_DIR);
    const second = computeEffectiveCapabilities(policy, step, WORKING_DIR);
    expect(first).toEqual(second);
  });

  it("caps array lengths", () => {
    const manyGlobs: string[] = Array.from({ length: 30 }, (_, i) => `${WORKING_DIR}/dir${i}/**`);
    const step = makeStep({
      requestedCapabilities: [
        {
          id: "fs.write_config",
          pathGlobs: manyGlobs,
        },
      ],
    });
    const effective = computeEffectiveCapabilities(policy, step, WORKING_DIR);
    const nodeGrant = effective.nodeGrants[0];
    expect(nodeGrant?.pathGlobs?.length).toBeLessThanOrEqual(20);
  });

  it("valid path globs within workingDir are accepted", () => {
    const step = makeStep({
      requestedCapabilities: [
        {
          id: "fs.write_config",
          pathGlobs: [`${WORKING_DIR}/.config/**`],
        },
      ],
    });
    const effective = computeEffectiveCapabilities(policy, step, WORKING_DIR);
    expect(effective.nodeGrants.length).toBe(1);
  });
});
