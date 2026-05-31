import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { assertGoalWorkerWorkspace } from "./workspace-policy.js";

const HOME = "/home/matt";
const homedir = () => HOME;
const stableEnv = { SMITHERSBOT_INSTANCE: "stable" } as NodeJS.ProcessEnv;
const devEnv = { SMITHERSBOT_INSTANCE: "dev" } as NodeJS.ProcessEnv;

function stablePolicy(overrides: Partial<Parameters<typeof assertGoalWorkerWorkspace>[0]> = {}) {
  return {
    env: stableEnv,
    homedir,
    ...overrides,
  };
}

function devPolicy(overrides: Partial<Parameters<typeof assertGoalWorkerWorkspace>[0]> = {}) {
  return {
    env: devEnv,
    homedir,
    ...overrides,
  };
}

describe("goal workspace policy", () => {
  let tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
    tempRoots = [];
  });

  it("allows stable/default goals under the stable instance agent workspaces root", () => {
    const warnings: string[] = [];

    assertGoalWorkerWorkspace(
      stablePolicy({
        workingDir: "/home/matt/smithersbot-home/agent/workspaces/smithersbot-dev",
        onWarning: (message) => warnings.push(message),
      }),
    );

    expect(warnings).toEqual([]);
  });

  it("rejects the observed dev runtime workspace for stable goals even with the legacy flag enabled", () => {
    const workingDir = "/home/matt/smithersbot-dev-home/agent/workspaces/smithersbot-dev";

    expect(() =>
      assertGoalWorkerWorkspace(
        stablePolicy({
          workingDir,
          config: { allowLegacyWorkingDir: true },
          observedInstances: ["dev"],
        }),
      ),
    ).toThrow(
      /\/home\/matt\/smithersbot-dev-home\/agent\/workspaces\/smithersbot-dev.*outside the current stable instance's own agent\/workspaces tree \(\/home\/matt\/smithersbot-home\/agent\/workspaces\).*observed\/foreign dev agent surface.*read-only for context/s,
    );
  });

  it("rejects arbitrary out-of-root paths for stable goals", () => {
    for (const workingDir of ["/tmp/whatever", "/home/matt/.config/smithersbot"]) {
      expect(() => assertGoalWorkerWorkspace(stablePolicy({ workingDir }))).toThrow(
        new RegExp(
          `${workingDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*outside the current stable instance's own agent/workspaces tree \\(/home/matt/smithersbot-home/agent/workspaces\\)`,
          "s",
        ),
      );
    }
  });

  it("allows dev instance goals under the dev instance agent workspaces root", () => {
    assertGoalWorkerWorkspace(
      devPolicy({
        workingDir: "/home/matt/smithersbot-dev-home/agent/workspaces/smithersbot-dev",
      }),
    );
  });

  it("rejects the stable instance workspace for dev goals", () => {
    const workingDir = "/home/matt/smithersbot-home/agent/workspaces/smithersbot-dev";

    expect(() => assertGoalWorkerWorkspace(devPolicy({ workingDir }))).toThrow(
      /\/home\/matt\/smithersbot-home\/agent\/workspaces\/smithersbot-dev.*outside the current dev instance's own agent\/workspaces tree \(\/home\/matt\/smithersbot-dev-home\/agent\/workspaces\).*foreign stable gateway instance/s,
    );
  });

  it("hard-denies private roots and private symlink targets", () => {
    expect(() =>
      assertGoalWorkerWorkspace(
        stablePolicy({
          workingDir: "/home/matt/smithersbot-home/private/env/smithersbot-dev",
          config: { allowLegacyWorkingDir: true },
        }),
      ),
    ).toThrow(/private paths/);

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-policy-"));
    tempRoots.push(home);
    const tempHomedir = () => home;
    const privateEnvDir = path.join(home, "smithersbot-home", "private", "env", "sample");
    const repoDir = path.join(home, "smithersbot-home", "agent", "workspaces", "sample");
    fs.mkdirSync(privateEnvDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });
    const privateLink = path.join(repoDir, "private-env-link");
    fs.symlinkSync(privateEnvDir, privateLink, "dir");

    expect(() =>
      assertGoalWorkerWorkspace({
        workingDir: privateLink,
        env: stableEnv,
        homedir: tempHomedir,
      }),
    ).toThrow(/private paths/);
  });
});
