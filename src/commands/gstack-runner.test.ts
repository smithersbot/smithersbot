import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HARD_DENIES } from "../goal/hard-deny.js";

const mockSpawn = vi.fn();
const mockResolveClaudeBinary = vi.fn();
const mockBuildClaudeCodeEnv = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
  };
});

vi.mock("../goal/scout.js", () => ({
  resolveClaudeBinary: (...args: unknown[]) => mockResolveClaudeBinary(...args),
}));

vi.mock("../goal/claude-code-env.js", () => ({
  buildClaudeCodeEnv: (...args: unknown[]) => mockBuildClaudeCodeEnv(...args),
}));

import {
  buildDenyContent,
  buildGstackAllowedTools,
  buildGstackArgs,
  runGstack,
} from "./gstack-runner.js";

function createMockChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.pid = 1234;
  child.killed = false;
  child.kill = vi.fn(() => true) as ChildProcess["kill"];
  return child;
}

describe("gstack-runner", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockResolveClaudeBinary.mockReset();
    mockBuildClaudeCodeEnv.mockReset();
    mockResolveClaudeBinary.mockReturnValue("/usr/bin/claude");
    mockBuildClaudeCodeEnv.mockReturnValue({ CLAUDE_AUTH: "subscription" });
  });

  it("builds the validated interactive allowlist", () => {
    expect(buildGstackAllowedTools()).toEqual([
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "Bash(*)",
      "Agent",
      "AskUserQuestion",
      "WebSearch",
      "Skill",
      "ToolSearch",
    ]);
  });

  it("formats hard denies like the goal worker capability bounds file", () => {
    const content = buildDenyContent();
    const lines = content.split("\n");

    expect(lines[0]).toBe("HARD DENIES (enforced):");
    expect(lines).toHaveLength(HARD_DENIES.length + 1);
    expect(lines[1]).toBe(`- DENIED: ${HARD_DENIES[0]!.pattern} — ${HARD_DENIES[0]!.reason}`);
    expect(lines.at(-1)).toBe(
      `- DENIED: ${HARD_DENIES.at(-1)!.pattern} — ${HARD_DENIES.at(-1)!.reason}`,
    );
  });

  it("builds interactive claude args without print mode", () => {
    const args = buildGstackArgs({
      denyContent: "custom deny content",
      extraArgs: ["--model", "sonnet", "--resume"],
    });

    expect(args).toEqual([
      "--allowedTools",
      buildGstackAllowedTools().join(","),
      "--append-system-prompt",
      "custom deny content",
      "--model",
      "sonnet",
      "--resume",
    ]);
    expect(args).not.toContain("-p");
  });

  it("resolves the binary, filters env, and spawns an interactive claude session", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValueOnce(child);

    const pending = runGstack({
      claudeCodeAuth: "subscription",
      args: ["--resume"],
      cwd: "/tmp/gstack-project",
    });
    queueMicrotask(() => {
      child.emit("close", 0, null);
    });

    await expect(pending).resolves.toEqual({ exitCode: 0, signal: null });
    expect(mockResolveClaudeBinary).toHaveBeenCalledTimes(1);
    expect(mockBuildClaudeCodeEnv).toHaveBeenCalledWith("subscription");
    expect(mockSpawn).toHaveBeenCalledWith(
      "/usr/bin/claude",
      buildGstackArgs({ extraArgs: ["--resume"] }),
      {
        cwd: "/tmp/gstack-project",
        env: { CLAUDE_AUTH: "subscription" },
        stdio: "inherit",
      },
    );
  });

  it("throws when the claude binary cannot be resolved", async () => {
    mockResolveClaudeBinary.mockReturnValueOnce(null);

    await expect(runGstack({ claudeCodeAuth: "api_key" })).rejects.toThrow(
      "claude binary not found on PATH",
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("rejects when spawning the session fails", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValueOnce(child);

    const pending = runGstack({ claudeCodeAuth: "subscription" });
    const error = new Error("spawn failed");
    queueMicrotask(() => {
      child.emit("error", error);
    });

    await expect(pending).rejects.toThrow("spawn failed");
  });
});
