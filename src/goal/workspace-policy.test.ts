import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertGoalWorkerWorkspace, LEGACY_WORKING_DIR_WARNING } from "./workspace-policy.js";

describe("goal workspace policy", () => {
  const previousRoot = process.env.SMITHERSBOT_GOALS_ROOT;

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
    else process.env.SMITHERSBOT_GOALS_ROOT = previousRoot;
  });

  it("allows managed agent workspaces without warning", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-policy-"));
    process.env.SMITHERSBOT_GOALS_ROOT = root;
    const warnings: string[] = [];
    try {
      assertGoalWorkerWorkspace({
        workingDir: path.join(root, "agent", "workspaces", "sample", "repo"),
        onWarning: (message) => warnings.push(message),
      });
      expect(warnings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps legacy workingDir compatibility with a clear warning", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-policy-root-"));
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-policy-legacy-"));
    process.env.SMITHERSBOT_GOALS_ROOT = root;
    const warnings: string[] = [];
    try {
      assertGoalWorkerWorkspace({
        workingDir: legacyDir,
        onWarning: (message) => warnings.push(message),
      });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(LEGACY_WORKING_DIR_WARNING);
      expect(warnings[0]).toContain(legacyDir);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("fails closed for legacy workingDir only when configured", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-policy-root-"));
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-policy-legacy-"));
    process.env.SMITHERSBOT_GOALS_ROOT = root;
    try {
      expect(() =>
        assertGoalWorkerWorkspace({
          workingDir: legacyDir,
          config: { allowLegacyWorkingDir: false },
        }),
      ).toThrow(/managed agent root/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("rejects managed private paths and private symlink targets even while legacy dirs are compatible", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-policy-root-"));
    process.env.SMITHERSBOT_GOALS_ROOT = root;
    const privateEnvDir = path.join(root, "private", "env", "sample");
    const repoDir = path.join(root, "agent", "workspaces", "sample", "repo");
    fs.mkdirSync(privateEnvDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });
    const privateLink = path.join(repoDir, "private-env-link");
    fs.symlinkSync(privateEnvDir, privateLink, "dir");

    try {
      expect(() =>
        assertGoalWorkerWorkspace({
          workingDir: privateEnvDir,
        }),
      ).toThrow(/private paths/);
      expect(() =>
        assertGoalWorkerWorkspace({
          workingDir: privateLink,
        }),
      ).toThrow(/private paths/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
