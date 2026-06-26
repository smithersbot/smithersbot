import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OBSERVED_INSTANCES_ENV,
  isInstanceObserved,
  resolveGatewayInstanceIdentity,
  resolveObservedInstanceSet,
} from "./gateway-instance.js";
import {
  isObservedAgentPathAllowed,
  resolveAgentRoot,
  resolveManagedRoot,
  resolveObservedAgentRoot,
  resolveObservedGoalHistoryRoot,
  resolveObservedHistoryIndexDir,
  resolveObservedInspectionTarget,
  resolveObservedManagedRoot,
  resolveObservedRepoChatHistoryRoot,
  resolveObservedWorkspacesRoot,
} from "./managed-paths.js";

const DEV_OBSERVED = { observedInstances: ["dev"] };

describe("observed-instance opt-in", () => {
  it("derives an empty set with no opt-in", () => {
    expect(resolveObservedInstanceSet({ env: {} as NodeJS.ProcessEnv }).size).toBe(0);
    expect(isInstanceObserved("dev", { env: {} as NodeJS.ProcessEnv })).toBe(false);
  });

  it("parses the env opt-in signal", () => {
    const env = { [OBSERVED_INSTANCES_ENV]: "dev" } as unknown as NodeJS.ProcessEnv;
    expect(resolveObservedInstanceSet({ env }).has("dev")).toBe(true);
    expect(isInstanceObserved("dev", { env })).toBe(true);
  });

  it("treats an explicit list as authoritative over env", () => {
    const env = { [OBSERVED_INSTANCES_ENV]: "dev" } as unknown as NodeJS.ProcessEnv;
    // Explicit empty list means no opt-in, even when env names dev.
    expect(resolveObservedInstanceSet({ observedInstances: [], env }).size).toBe(0);
  });

  it("normalizes aliases and rejects unknown observed instance names", () => {
    expect(resolveObservedInstanceSet({ observedInstances: ["default"] }).has("stable")).toBe(true);
    expect(() => resolveObservedInstanceSet({ observedInstances: ["prod"] })).toThrow(
      'Unknown SmithersBot gateway instance "prod". Allowed values: default, stable, dev.',
    );
  });
});

describe("observed-instance resolvers and guard", () => {
  let home: string;
  let homedir: () => string;
  let devManagedRoot: string;
  let devAgentRoot: string;
  let devPrivateRoot: string;
  let devStateDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "observed-instance-"));
    homedir = () => home;
    const devIdentity = resolveGatewayInstanceIdentity("dev", homedir);
    devManagedRoot = devIdentity.managedRoot;
    devAgentRoot = path.join(devIdentity.managedRoot, "agent");
    devPrivateRoot = path.join(devManagedRoot, "private");
    devStateDir = devIdentity.stateDir;

    for (const dir of [
      path.join(devAgentRoot, "workspaces", "smithersbot-dev"),
      path.join(devAgentRoot, "history", "goals"),
      path.join(devAgentRoot, "history", "repo-chats"),
      path.join(devAgentRoot, "history", "index"),
      path.join(devPrivateRoot, "env"),
      path.join(devPrivateRoot, "config"),
      path.join(devPrivateRoot, "auth"),
      path.join(devPrivateRoot, "sessions"),
      devStateDir,
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const opts = () => ({ ...DEV_OBSERVED, homedir });

  it("resolves the dev agent surface from the explicit identity mapping", () => {
    expect(resolveObservedManagedRoot("dev", opts())).toBe(devManagedRoot);
    expect(resolveObservedAgentRoot("dev", opts())).toBe(devAgentRoot);
    expect(resolveObservedWorkspacesRoot("dev", opts())).toBe(
      path.join(devAgentRoot, "workspaces"),
    );
    expect(resolveObservedGoalHistoryRoot("dev", opts())).toBe(
      path.join(devAgentRoot, "history", "goals"),
    );
    expect(resolveObservedRepoChatHistoryRoot("dev", opts())).toBe(
      path.join(devAgentRoot, "history", "repo-chats"),
    );
    expect(resolveObservedHistoryIndexDir("dev", opts())).toBe(
      path.join(devAgentRoot, "history", "index"),
    );
  });

  it("allows the agent workspaces and history subtrees", () => {
    const allowed = [
      path.join(devAgentRoot, "workspaces"),
      path.join(devAgentRoot, "workspaces", "smithersbot-dev"),
      path.join(devAgentRoot, "history", "goals"),
      path.join(devAgentRoot, "history", "goals", "ws", "goal-1"),
      path.join(devAgentRoot, "history", "repo-chats"),
      path.join(devAgentRoot, "history", "repo-chats", "ws"),
      path.join(devAgentRoot, "history", "index"),
    ];
    for (const candidate of allowed) {
      expect(isObservedAgentPathAllowed(candidate, "dev", opts())).toBe(true);
    }
  });

  it("classifies observed dev agent paths as readable context and seals private state", () => {
    const workspace = path.join(devAgentRoot, "workspaces", "smithersbot-dev");
    const history = path.join(devAgentRoot, "history", "repo-chats", "smithersbot-dev");

    expect(resolveObservedInspectionTarget(devAgentRoot, opts())).toEqual({
      kind: "agent",
      instance: "dev",
      agentRoot: devAgentRoot,
    });
    expect(resolveObservedInspectionTarget(workspace, opts())).toEqual({
      kind: "agent",
      instance: "dev",
      agentRoot: devAgentRoot,
    });
    expect(resolveObservedInspectionTarget(history, opts())).toEqual({
      kind: "agent",
      instance: "dev",
      agentRoot: devAgentRoot,
    });
    expect(resolveObservedInspectionTarget(path.join(devPrivateRoot, "env"), opts())).toEqual({
      kind: "sealed",
      instance: "dev",
    });
    expect(resolveObservedInspectionTarget(devStateDir, opts())).toEqual({
      kind: "sealed",
      instance: "dev",
    });
  });

  it("rejects the observed private root, its subtrees, and the state dir", () => {
    const rejected = [
      devPrivateRoot,
      path.join(devPrivateRoot, "env", "ws", ".env"),
      path.join(devPrivateRoot, "config"),
      path.join(devPrivateRoot, "auth"),
      path.join(devPrivateRoot, "sessions"),
      devStateDir,
      path.join(devStateDir, ".env"),
    ];
    for (const candidate of rejected) {
      expect(isObservedAgentPathAllowed(candidate, "dev", opts())).toBe(false);
    }
  });

  it("rejects a symlink under the agent root that escapes into private", () => {
    const secret = path.join(devPrivateRoot, "env", "ws", ".env");
    fs.mkdirSync(path.dirname(secret), { recursive: true });
    fs.writeFileSync(secret, "TELEGRAM_TOKEN=should-never-be-read");
    const link = path.join(devAgentRoot, "workspaces", "leak");
    fs.symlinkSync(secret, link);

    expect(isObservedAgentPathAllowed(link, "dev", opts())).toBe(false);
  });

  it("rejects a symlink under the agent root that escapes into the state dir", () => {
    const target = path.join(devStateDir, "smithersbot.json");
    fs.writeFileSync(target, "{}");
    const link = path.join(devAgentRoot, "history", "goals", "leak");
    fs.symlinkSync(target, link);

    expect(isObservedAgentPathAllowed(link, "dev", opts())).toBe(false);
  });

  it("denies everything and refuses to resolve roots with no opt-in", () => {
    const noOptIn = { observedInstances: [] as string[], homedir };
    expect(isObservedAgentPathAllowed(path.join(devAgentRoot, "workspaces"), "dev", noOptIn)).toBe(
      false,
    );
    expect(() => resolveObservedAgentRoot("dev", noOptIn)).toThrow(/not an opted-in observed/);
    expect(() => resolveObservedManagedRoot("dev", noOptIn)).toThrow(/not an opted-in observed/);
  });

  it("works via the env opt-in signal", () => {
    const env = { [OBSERVED_INSTANCES_ENV]: "dev" } as unknown as NodeJS.ProcessEnv;
    expect(
      isObservedAgentPathAllowed(path.join(devAgentRoot, "workspaces"), "dev", { env, homedir }),
    ).toBe(true);
    expect(resolveObservedAgentRoot("dev", { env, homedir })).toBe(devAgentRoot);
  });

  it("does not change the current process's own managed-root resolution", () => {
    // A no-instance process still resolves stable, regardless of observation opt-in.
    const env = {
      [OBSERVED_INSTANCES_ENV]: "dev",
    } as unknown as NodeJS.ProcessEnv;
    const stableIdentity = resolveGatewayInstanceIdentity("stable", homedir);
    expect(resolveManagedRoot(env, homedir)).toBe(stableIdentity.managedRoot);
    expect(resolveAgentRoot(env, homedir)).toBe(path.join(stableIdentity.managedRoot, "agent"));
  });
});
