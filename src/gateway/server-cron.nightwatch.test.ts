import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MoltbotConfig } from "../config/config.js";

const mockLoadConfig = vi.fn();
vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  };
});

const mockRunCronIsolatedAgentTurn = vi.fn();
vi.mock("../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: (...args: unknown[]) => mockRunCronIsolatedAgentTurn(...args),
}));

const mockRunNightwatch = vi.fn();
const mockRegisterNightwatchJob = vi.fn(async () => undefined);
vi.mock("../cron/nightwatch.js", () => ({
  runNightwatch: (...args: unknown[]) => mockRunNightwatch(...args),
  registerNightwatchJob: (...args: unknown[]) => mockRegisterNightwatchJob(...args),
}));

const mockResolveCronStorePath = vi.fn(() => "/tmp/moltbot-nightwatch-cron-store.json");
vi.mock("../cron/store.js", () => ({
  resolveCronStorePath: (...args: unknown[]) => mockResolveCronStorePath(...args),
}));

const mockAppendCronRunLog = vi.fn(async () => undefined);
const mockResolveCronRunLogPath = vi.fn(() => "/tmp/moltbot-nightwatch-cron/runs/job-1.jsonl");
vi.mock("../cron/run-log.js", () => ({
  appendCronRunLog: (...args: unknown[]) => mockAppendCronRunLog(...args),
  resolveCronRunLogPath: (...args: unknown[]) => mockResolveCronRunLogPath(...args),
}));

const mockMirrorCronRuntimeToAgentHistory = vi.fn(() => ({}));
vi.mock("../goal/runtime-mirror.js", () => ({
  mirrorCronRuntimeToAgentHistory: (...args: unknown[]) =>
    mockMirrorCronRuntimeToAgentHistory(...args),
}));

const mockCronList = vi.fn(async () => []);
const mockCronAdd = vi.fn(async () => ({}));
const mockCronUpdate = vi.fn(async () => ({}));
const mockCronRemove = vi.fn(async () => ({}));
const mockCronStart = vi.fn(async () => undefined);
const mockCronStop = vi.fn(() => undefined);
let capturedCronDeps:
  | {
      runIsolatedAgentJob: (params: {
        job: Record<string, unknown>;
        message: string;
      }) => Promise<{ status: "ok" | "error" | "skipped"; summary?: string; error?: string }>;
      onEvent: (evt: Record<string, unknown>) => void;
    }
  | undefined;

vi.mock("../cron/service.js", () => ({
  CronService: class {
    constructor(deps: unknown) {
      capturedCronDeps = deps as typeof capturedCronDeps;
    }
    list = (...args: unknown[]) => mockCronList(...args);
    add = (...args: unknown[]) => mockCronAdd(...args);
    update = (...args: unknown[]) => mockCronUpdate(...args);
    remove = (...args: unknown[]) => mockCronRemove(...args);
    start = (...args: unknown[]) => mockCronStart(...args);
    stop = (...args: unknown[]) => mockCronStop(...args);
  },
}));

describe("buildGatewayCronService nightwatch routing", () => {
  const runtimeCfg: MoltbotConfig = {
    cron: {
      nightwatch: {
        enabled: true,
        telegramChatId: "12345",
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    capturedCronDeps = undefined;
    mockLoadConfig.mockReturnValue(runtimeCfg);
    mockRunNightwatch.mockResolvedValue({ status: "ok", summary: "Plan delivered to Telegram" });
    mockAppendCronRunLog.mockResolvedValue(undefined);
    mockMirrorCronRuntimeToAgentHistory.mockReturnValue({});
    mockRunCronIsolatedAgentTurn.mockResolvedValue({
      status: "ok",
      summary: "isolated run complete",
    });
  });

  it("registers nightwatch job during gateway cron service build", async () => {
    const { buildGatewayCronService } = await import("./server-cron.js");
    const cfg: MoltbotConfig = { cron: { nightwatch: { enabled: true } } };

    buildGatewayCronService({
      cfg,
      deps: {} as never,
      broadcast: vi.fn(),
    });

    await Promise.resolve();
    expect(mockRegisterNightwatchJob).toHaveBeenCalledTimes(1);
    expect(mockRegisterNightwatchJob).toHaveBeenCalledWith(
      expect.objectContaining({
        list: expect.any(Function),
        add: expect.any(Function),
        update: expect.any(Function),
        remove: expect.any(Function),
      }),
      cfg.cron?.nightwatch,
    );
  });

  it("routes nightwatch-daily jobs to runNightwatch with lastRunAtMs", async () => {
    const { buildGatewayCronService } = await import("./server-cron.js");
    buildGatewayCronService({
      cfg: runtimeCfg,
      deps: {} as never,
      broadcast: vi.fn(),
    });

    if (!capturedCronDeps) {
      throw new Error("expected cron deps to be captured");
    }

    const result = await capturedCronDeps.runIsolatedAgentJob({
      job: {
        id: "job-1",
        name: "nightwatch-daily",
        state: { lastRunAtMs: 1_707_872_400_000 },
      },
      message: "__nightwatch__",
    });

    expect(mockRunNightwatch).toHaveBeenCalledTimes(1);
    expect(mockRunNightwatch).toHaveBeenCalledWith({
      cfg: runtimeCfg,
      nightwatchCfg: runtimeCfg.cron?.nightwatch,
      lastRunAtMs: 1_707_872_400_000,
    });
    expect(mockRunCronIsolatedAgentTurn).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "ok", summary: "Plan delivered to Telegram" });
  });

  it("falls back to generic isolated agent turn for non-nightwatch jobs", async () => {
    const { buildGatewayCronService } = await import("./server-cron.js");
    buildGatewayCronService({
      cfg: runtimeCfg,
      deps: {} as never,
      broadcast: vi.fn(),
    });

    if (!capturedCronDeps) {
      throw new Error("expected cron deps to be captured");
    }

    const result = await capturedCronDeps.runIsolatedAgentJob({
      job: {
        id: "job-2",
        name: "weekly-review",
        agentId: "default",
      },
      message: "normal cron message",
    });

    expect(mockRunNightwatch).not.toHaveBeenCalled();
    expect(mockRunCronIsolatedAgentTurn).toHaveBeenCalledTimes(1);
    expect(mockRunCronIsolatedAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: runtimeCfg,
        job: expect.objectContaining({
          id: "job-2",
          name: "weekly-review",
        }),
        message: "normal cron message",
        sessionKey: "cron:job-2",
        lane: "cron",
      }),
    );
    expect(result).toEqual({ status: "ok", summary: "isolated run complete" });
  });

  it("mirrors cron runtime artifacts after finished run log append", async () => {
    const { buildGatewayCronService } = await import("./server-cron.js");
    buildGatewayCronService({
      cfg: runtimeCfg,
      deps: {} as never,
      broadcast: vi.fn(),
    });

    capturedCronDeps?.onEvent({
      action: "finished",
      jobId: "job-1",
      status: "ok",
      runAtMs: 123,
      durationMs: 45,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(mockAppendCronRunLog).toHaveBeenCalledTimes(1);
    expect(mockMirrorCronRuntimeToAgentHistory).toHaveBeenCalledWith({
      storePath: "/tmp/moltbot-nightwatch-cron-store.json",
    });
  });

  it("swallows cron runtime mirror failures after recording a warning event", async () => {
    const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "server-cron-managed-"));
    const previousManagedRoot = process.env.SMITHERSBOT_GOALS_ROOT;
    process.env.SMITHERSBOT_GOALS_ROOT = managedRoot;
    mockMirrorCronRuntimeToAgentHistory.mockImplementationOnce(() => {
      throw new Error("mirror unavailable");
    });

    try {
      const { buildGatewayCronService } = await import("./server-cron.js");
      buildGatewayCronService({
        cfg: runtimeCfg,
        deps: {} as never,
        broadcast: vi.fn(),
      });

      expect(() =>
        capturedCronDeps?.onEvent({
          action: "finished",
          jobId: "job-1",
          status: "ok",
          runAtMs: 123,
          durationMs: 45,
        }),
      ).not.toThrow();

      await Promise.resolve();
      await Promise.resolve();

      const eventsPath = path.join(managedRoot, "agent", "history", "cron", "events.jsonl");
      const events = fs
        .readFileSync(eventsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events.at(-1)).toMatchObject({
        event: "runtime_mirror_warning",
        phase: "cron",
        status: "warning",
        jobId: "job-1",
      });
    } finally {
      if (previousManagedRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
      else process.env.SMITHERSBOT_GOALS_ROOT = previousManagedRoot;
      fs.rmSync(managedRoot, { recursive: true, force: true });
    }
  });
});
