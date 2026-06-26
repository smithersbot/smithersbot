import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILD_GATE_OUTPUT_MAX_CHARS,
  buildDefaultSastCommand,
  classifyBuildGateFailure,
  makeBuildGateFailurePrompt,
  resolveChangedFilesSinceCheckpoint,
  runBuildGateCommands,
  truncateForPrompt,
} from "./build-gate.js";

const mockSpawnSync = vi.fn();
const mockExecFileSync = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  };
});

// The shared goal-execution guard is exercised end-to-end in workspace-policy.test.ts.
// Here it is routed through a controllable mock so existing build-gate tests use
// their fixture working dirs, while a dedicated test drives the real rejection
// behavior to prove the guard runs BEFORE any command spawn / git invocation.
const mockAssertGoalWorkerWorkspace = vi.fn();
vi.mock("./workspace-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspace-policy.js")>();
  return {
    ...actual,
    assertGoalWorkerWorkspace: (...args: unknown[]) => mockAssertGoalWorkerWorkspace(...args),
  };
});

describe("buildDefaultSastCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a semgrep command when semgrep is available", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "/usr/local/bin/semgrep\n",
      stderr: "",
    });

    const command = buildDefaultSastCommand({ workingDir: "/tmp/moltbot" });
    expect(command).toBe(
      "semgrep scan --config auto --error --quiet --severity ERROR --timeout 600 --exclude 'node_modules' --exclude 'dist' --exclude '.git' --exclude '.next' --exclude 'build' --exclude '*.test.ts' --exclude '.moltbot-goal-worker-results' '/tmp/moltbot'",
    );
    expect(mockSpawnSync).toHaveBeenCalledWith("which", ["semgrep"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("returns a semgrep command scoped to target paths", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "/usr/local/bin/semgrep\n",
      stderr: "",
    });

    const command = buildDefaultSastCommand({
      workingDir: "/tmp/moltbot",
      targetPaths: ["src/a.ts", "ui/path with space.ts", "-leading-dash.ts"],
    });
    expect(command).toBe(
      "semgrep scan --config auto --error --quiet --severity ERROR --timeout 600 --exclude 'node_modules' --exclude 'dist' --exclude '.git' --exclude '.next' --exclude 'build' --exclude '*.test.ts' --exclude '.moltbot-goal-worker-results' 'src/a.ts' 'ui/path with space.ts' './-leading-dash.ts'",
    );
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });

  it("returns null when semgrep is not available on PATH", () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "not found",
    });

    const command = buildDefaultSastCommand({ workingDir: "/tmp/moltbot" });
    expect(command).toBeNull();
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });

  it("returns null when targetPaths is explicitly empty", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "/usr/local/bin/semgrep\n",
      stderr: "",
    });

    const command = buildDefaultSastCommand({
      workingDir: "/tmp/moltbot",
      targetPaths: [],
    });
    expect(command).toBeNull();
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });
});

describe("resolveChangedFilesSinceCheckpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no base SHA is provided", () => {
    const changed = resolveChangedFilesSinceCheckpoint({
      workingDir: "/tmp/moltbot",
    });
    expect(changed).toBeNull();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("returns sorted unique tracked and untracked changed files", () => {
    mockExecFileSync
      .mockReturnValueOnce("src/z.ts\nsrc/a.ts\n")
      .mockReturnValueOnce("src/a.ts\nui/new.ts\n");

    const changed = resolveChangedFilesSinceCheckpoint({
      workingDir: "/tmp/moltbot",
      baseSha: "base-sha-1",
    });

    expect(changed).toEqual(["src/a.ts", "src/z.ts", "ui/new.ts"]);
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      1,
      "git",
      ["-C", "/tmp/moltbot", "diff", "--name-only", "--diff-filter=ACMRTUXB", "base-sha-1"],
      expect.objectContaining({ encoding: "utf8" }),
    );
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      2,
      "git",
      ["-C", "/tmp/moltbot", "ls-files", "--others", "--exclude-standard"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it("returns null when git commands fail", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("git failed");
    });

    const changed = resolveChangedFilesSinceCheckpoint({
      workingDir: "/tmp/moltbot",
      baseSha: "base-sha-1",
    });
    expect(changed).toBeNull();
  });
});

describe("runBuildGateCommands current-instance guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws and never spawns a command when the working dir is rejected", () => {
    mockAssertGoalWorkerWorkspace.mockImplementationOnce(() => {
      throw new Error(
        'Goal worker workspace "/tmp/evil" is outside the current stable instance\'s own ' +
          "agent/workspaces tree (/root/agent/workspaces).",
      );
    });

    expect(() => runBuildGateCommands(["echo hi"], "/tmp/evil")).toThrow(
      /outside the current stable instance's own agent\/workspaces tree/,
    );
    // Guard ran before any command spawn.
    expect(mockAssertGoalWorkerWorkspace).toHaveBeenCalledWith({ workingDir: "/tmp/evil" });
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("runs commands for a valid stable working dir (guard passes)", () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "", error: undefined });
    const result = runBuildGateCommands(["echo hi"], "/root/agent/workspaces/smithersbot-dev");
    expect(result).toEqual({ passed: true });
    expect(mockAssertGoalWorkerWorkspace).toHaveBeenCalledWith({
      workingDir: "/root/agent/workspaces/smithersbot-dev",
    });
    expect(mockSpawnSync).toHaveBeenCalled();
  });
});

describe("classifyBuildGateFailure", () => {
  it("classifies semgrep infrastructure failures separately", () => {
    const kind = classifyBuildGateFailure(
      "semgrep scan --config auto --error .",
      "Build gate command failed to execute: spawnSync bash ETIMEDOUT",
    );
    expect(kind).toBe("infra_failed");
  });

  it("keeps semgrep code findings as command failures", () => {
    const kind = classifyBuildGateFailure(
      "semgrep scan --config auto --error .",
      "src/foo.ts\n❯❱ javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp",
    );
    expect(kind).toBe("command_failed");
  });

  it("keeps non-semgrep failures as command failures", () => {
    const kind = classifyBuildGateFailure("pnpm build", "TS2307: Cannot find module");
    expect(kind).toBe("command_failed");
  });
});

describe("truncateForPrompt", () => {
  it("preserves early TAP failures and summary lines in long output", () => {
    const earlyOutput = [
      "TAP version 13",
      "ok 1 - setup passed",
      "ok 2 - nearby passing test",
      "not ok 3 - lower-numbered failure hidden by tail truncation",
      "  failure details near the top",
    ].join("\n");
    const longMiddle = Array.from(
      { length: 1_200 },
      (_, index) =>
        `# verbose passing output ${index.toString().padStart(4, "0")} ${"x".repeat(32)}`,
    ).join("\n");
    const summary = ["# tests 1200", "# pass 1199", "# fail 1"].join("\n");
    const output = [earlyOutput, longMiddle, summary].join("\n");

    expect(output.length).toBeGreaterThan(50_000);

    const truncated = truncateForPrompt(output);
    const prompt = makeBuildGateFailurePrompt("pnpm test", truncated);

    expect(truncated.length).toBeLessThanOrEqual(BUILD_GATE_OUTPUT_MAX_CHARS);
    expect(truncated).toContain("Failing tests:");
    expect(truncated).toContain("not ok 3 - lower-numbered failure hidden by tail truncation");
    expect(truncated).toContain("# tests 1200");
    expect(truncated).toContain("# pass 1199");
    expect(truncated).toContain("# fail 1");
    expect(prompt).toContain("not ok 3 - lower-numbered failure hidden by tail truncation");
  });

  it("keeps the existing tail truncation behavior for long non-TAP output", () => {
    const output = `start-${"a".repeat(BUILD_GATE_OUTPUT_MAX_CHARS)}-end`;

    expect(truncateForPrompt(output)).toBe(output.slice(-BUILD_GATE_OUTPUT_MAX_CHARS));
  });
});

describe("makeBuildGateFailurePrompt", () => {
  it("keeps the base prompt structure for non-semgrep failures", () => {
    const prompt = makeBuildGateFailurePrompt("pnpm build", "TS2307: Cannot find module");

    expect(prompt).toBe(
      [
        "The build gate (pnpm build) failed after you reported complete.",
        "Fix the errors.",
        "Here is the output:",
        "TS2307: Cannot find module",
      ].join("\n"),
    );
    expect(prompt).not.toContain("Suppress Semgrep findings at exact offending lines");
    expect(prompt).not.toContain(
      "When suppression changes span multiple files, ensure the full gate command passes across all affected files.",
    );
  });

  it("adds semgrep suppression guidance for semgrep failures", () => {
    const command = "pnpm lint && semgrep scan --config auto --error .";
    const prompt = makeBuildGateFailurePrompt(command, "semgrep findings here");

    expect(prompt).toContain(
      "Suppress Semgrep findings at exact offending lines with explicit rule IDs (e.g. # nosemgrep: rule-id) instead of broad file-level ignores so rules stay active elsewhere in the file.",
    );
    expect(prompt).toContain(
      "When suppression changes span multiple files, ensure the full gate command passes across all affected files.",
    );
    expect(prompt.split("\n").slice(0, 4)).toEqual([
      `The build gate (${command}) failed after you reported complete.`,
      "Fix the errors.",
      "Here is the output:",
      "semgrep findings here",
    ]);
  });
});
