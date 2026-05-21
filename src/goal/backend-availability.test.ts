import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectBackendAvailability } from "./backend-availability.js";

type SpawnResult = {
  status?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  error?: Partial<NodeJS.ErrnoException>;
};

type ProbeResponse = {
  binary: string;
  args: string[];
  results: SpawnResult[];
};

const mockSpawnSync = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
  };
});

function probeKey(binary: string, args: string[]): string {
  return JSON.stringify([binary, args]);
}

function makeProbeResult(overrides: SpawnResult = {}): SpawnResult {
  return {
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

function codexFlagProbeArgs(): string[] {
  const gitPath = `${process.cwd()}/.git`;
  return [
    "--ask-for-approval",
    "never",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "--cd",
    process.cwd(),
    "-c",
    "net.allowed=true",
    "-c",
    `sandbox_workspace_write.writable_roots=["${gitPath}"]`,
    "--help",
  ];
}

function installProbeResponses(responses: ProbeResponse[]) {
  const callCounts = new Map<string, number>();
  const responseQueues = new Map<string, SpawnResult[]>(
    responses.map((response) => [probeKey(response.binary, response.args), [...response.results]]),
  );

  mockSpawnSync.mockImplementation((binary: string, args: string[]) => {
    const key = probeKey(binary, args);
    callCounts.set(key, (callCounts.get(key) ?? 0) + 1);

    const queue = responseQueues.get(key);
    if (!queue || queue.length === 0) {
      throw new Error(`Unexpected spawnSync call: ${binary} ${args.join(" ")}`);
    }

    const next = queue.shift();
    if (!next) {
      throw new Error(`Missing queued spawnSync result for: ${binary} ${args.join(" ")}`);
    }
    return makeProbeResult(next);
  });

  return {
    getCallCount(binary: string, args: string[]) {
      return callCounts.get(probeKey(binary, args)) ?? 0;
    },
  };
}

function baseProbeResponses(): ProbeResponse[] {
  return [
    {
      binary: "codex",
      args: ["--ask-for-approval", "never", "exec", "--help"],
      results: [makeProbeResult()],
    },
    {
      binary: "codex",
      args: ["exec", "--help"],
      results: [makeProbeResult()],
    },
    {
      binary: "codex",
      args: codexFlagProbeArgs(),
      results: [makeProbeResult()],
    },
    {
      binary: "claude",
      args: ["--help"],
      results: [makeProbeResult()],
    },
  ];
}

function getAvailability(
  availability: ReturnType<typeof detectBackendAvailability>,
  backendId: "codex" | "claude_code" | "pi",
) {
  const entry = availability.find((item) => item.id === backendId);
  expect(entry).toBeDefined();
  return entry!;
}

describe("detectBackendAvailability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries a signal-terminated probe and succeeds on the second attempt", () => {
    const claudeHelpArgs = ["--help"];
    const tracker = installProbeResponses([
      ...baseProbeResponses().filter((response) => response.binary !== "claude"),
      {
        binary: "claude",
        args: claudeHelpArgs,
        results: [makeProbeResult({ status: null, signal: "SIGTERM" }), makeProbeResult()],
      },
    ]);

    const availability = detectBackendAvailability();

    expect(getAvailability(availability, "claude_code")).toEqual({
      id: "claude_code",
      available: true,
    });
    expect(tracker.getCallCount("claude", claudeHelpArgs)).toBe(2);
  });

  it("does not retry an ENOENT probe for the same command tuple", () => {
    const claudeHelpArgs = ["--help"];
    const tracker = installProbeResponses([
      ...baseProbeResponses().filter((response) => response.binary !== "claude"),
      {
        binary: "claude",
        args: claudeHelpArgs,
        results: [
          makeProbeResult({
            status: null,
            signal: "SIGTERM",
            error: { code: "ENOENT" },
          }),
        ],
      },
    ]);

    const availability = detectBackendAvailability();

    expect(getAvailability(availability, "claude_code")).toEqual({
      id: "claude_code",
      available: false,
      reason: "claude not found on PATH",
    });
    expect(tracker.getCallCount("claude", claudeHelpArgs)).toBe(1);
  });

  it("re-probes availability on each call instead of returning stale cached results", () => {
    const claudeHelpArgs = ["--help"];
    const tracker = installProbeResponses([
      {
        binary: "codex",
        args: ["--ask-for-approval", "never", "exec", "--help"],
        results: [makeProbeResult(), makeProbeResult()],
      },
      {
        binary: "codex",
        args: ["exec", "--help"],
        results: [makeProbeResult(), makeProbeResult()],
      },
      {
        binary: "codex",
        args: codexFlagProbeArgs(),
        results: [makeProbeResult(), makeProbeResult()],
      },
      {
        binary: "claude",
        args: claudeHelpArgs,
        results: [makeProbeResult(), makeProbeResult({ status: 1, stderr: "still starting" })],
      },
    ]);

    const firstAvailability = detectBackendAvailability();
    const secondAvailability = detectBackendAvailability();

    expect(getAvailability(firstAvailability, "claude_code")).toEqual({
      id: "claude_code",
      available: true,
    });
    expect(getAvailability(secondAvailability, "claude_code")).toEqual({
      id: "claude_code",
      available: false,
      reason: "claude --help exited with code 1: still starting",
    });
    expect(tracker.getCallCount("claude", claudeHelpArgs)).toBe(2);
  });

  it("probes codex with sandboxed workspace-write flags and no dangerous bypass", () => {
    installProbeResponses(baseProbeResponses());

    detectBackendAvailability();

    const codexProbe = mockSpawnSync.mock.calls.find(
      ([binary, args]) =>
        binary === "codex" && Array.isArray(args) && args.includes("--skip-git-repo-check"),
    );
    expect(codexProbe).toBeDefined();
    const args = codexProbe?.[1] as string[];
    expect(args).toContain("--sandbox");
    expect(args).toContain("workspace-write");
    expect(args).toContain("--cd");
    expect(args).toContain(process.cwd());
    expect(args).toContain("net.allowed=true");
    expect(args.join(" ")).not.toContain("danger-full-access");
    expect(args.join(" ")).not.toContain("dangerously-bypass");
  });
});
