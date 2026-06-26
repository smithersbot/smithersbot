import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockLoadConfig } = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(() => ({}) as Record<string, unknown>),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mockLoadConfig,
}));

import {
  TUI_PILOT_OPS_DEFAULTS,
  TuiPilotSessionGate,
  ensureTuiPilotPreflight,
  resetTuiPilotPreflightCache,
  resolveTuiPilotOps,
  type ResolvedTuiPilotOps,
} from "./tui-pilot-driver.js";

function ops(partial: Partial<ResolvedTuiPilotOps> = {}): ResolvedTuiPilotOps {
  return {
    version: null,
    preflight: "enforce",
    maxConcurrent: 1,
    maxQueued: 16,
    queueTimeoutMs: 1000,
    ...partial,
  };
}

describe("resolveTuiPilotOps", () => {
  beforeEach(() => mockLoadConfig.mockReturnValue({}));

  it("applies productionized defaults when goal.tuiPilot is absent", () => {
    const resolved = resolveTuiPilotOps();
    expect(resolved).toEqual({
      version: null,
      preflight: TUI_PILOT_OPS_DEFAULTS.preflight,
      maxConcurrent: TUI_PILOT_OPS_DEFAULTS.maxConcurrent,
      maxQueued: TUI_PILOT_OPS_DEFAULTS.maxQueued,
      queueTimeoutMs: TUI_PILOT_OPS_DEFAULTS.queueTimeoutMs,
    });
  });

  it("honors configured overrides and trims the version pin", () => {
    const resolved = resolveTuiPilotOps({
      version: " 0.8.60 ",
      preflight: "warn",
      maxConcurrent: 5,
      maxQueued: 0,
      queueTimeoutMs: 1234,
    });
    expect(resolved).toEqual({
      version: "0.8.60",
      preflight: "warn",
      maxConcurrent: 5,
      maxQueued: 0,
      queueTimeoutMs: 1234,
    });
  });

  it("clamps invalid numeric overrides back to defaults", () => {
    const resolved = resolveTuiPilotOps({ maxConcurrent: 0, maxQueued: -3, queueTimeoutMs: -1 });
    expect(resolved.maxConcurrent).toBe(TUI_PILOT_OPS_DEFAULTS.maxConcurrent);
    expect(resolved.maxQueued).toBe(TUI_PILOT_OPS_DEFAULTS.maxQueued);
    expect(resolved.queueTimeoutMs).toBe(TUI_PILOT_OPS_DEFAULTS.queueTimeoutMs);
  });
});

describe("TuiPilotSessionGate", () => {
  it("admits up to maxConcurrent runs immediately and queues the rest", async () => {
    const gate = new TuiPilotSessionGate(() => ops({ maxConcurrent: 2, maxQueued: 4 }));
    const a = await gate.acquire();
    const b = await gate.acquire();
    expect(a.kind).toBe("acquired");
    expect(b.kind).toBe("acquired");
    expect(gate.stats()).toEqual({ active: 2, queued: 0 });

    let cResolved = false;
    const cPromise = gate.acquire().then((r) => {
      cResolved = true;
      return r;
    });
    await Promise.resolve();
    expect(cResolved).toBe(false);
    expect(gate.stats()).toEqual({ active: 2, queued: 1 });

    if (a.kind === "acquired") a.release();
    const c = await cPromise;
    expect(c.kind).toBe("acquired");
    expect(gate.stats()).toEqual({ active: 2, queued: 0 });
  });

  it("rejects with queue_full once the queue is saturated", async () => {
    const gate = new TuiPilotSessionGate(() => ops({ maxConcurrent: 1, maxQueued: 1 }));
    const held = await gate.acquire();
    expect(held.kind).toBe("acquired");
    void gate.acquire(); // fills the single queue slot
    const overflow = await gate.acquire();
    expect(overflow.kind).toBe("queue_full");
    if (overflow.kind === "queue_full") {
      expect(overflow.maxQueued).toBe(1);
      expect(overflow.queued).toBe(1);
    }
  });

  it("grants queued waiters in FIFO order as slots free", async () => {
    const gate = new TuiPilotSessionGate(() => ops({ maxConcurrent: 1, maxQueued: 8 }));
    const order: string[] = [];
    const held = await gate.acquire();
    const first = gate.acquire().then((r) => {
      order.push("first");
      return r;
    });
    const second = gate.acquire().then((r) => {
      order.push("second");
      return r;
    });
    await Promise.resolve();

    if (held.kind === "acquired") held.release();
    const firstRes = await first;
    expect(firstRes.kind).toBe("acquired");
    if (firstRes.kind === "acquired") firstRes.release();
    await second;
    expect(order).toEqual(["first", "second"]);
  });

  it("times out a queued waiter after queueTimeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const gate = new TuiPilotSessionGate(() => ops({ maxConcurrent: 1, queueTimeoutMs: 1000 }));
      const held = await gate.acquire();
      expect(held.kind).toBe("acquired");
      const waiter = gate.acquire();
      await Promise.resolve();
      expect(gate.stats().queued).toBe(1);
      vi.advanceTimersByTime(1000);
      const res = await waiter;
      expect(res.kind).toBe("timeout");
      expect(gate.stats().queued).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a queued waiter when its signal fires", async () => {
    const gate = new TuiPilotSessionGate(() => ops({ maxConcurrent: 1 }));
    const controller = new AbortController();
    const held = await gate.acquire();
    expect(held.kind).toBe("acquired");
    const waiter = gate.acquire(controller.signal);
    await Promise.resolve();
    expect(gate.stats().queued).toBe(1);
    controller.abort();
    const res = await waiter;
    expect(res.kind).toBe("aborted");
    expect(gate.stats().queued).toBe(0);
  });

  it("returns aborted immediately for an already-aborted signal", async () => {
    const gate = new TuiPilotSessionGate(() => ops({ maxConcurrent: 1 }));
    const controller = new AbortController();
    controller.abort();
    const res = await gate.acquire(controller.signal);
    expect(res.kind).toBe("aborted");
    expect(gate.stats()).toEqual({ active: 0, queued: 0 });
  });
});

describe("ensureTuiPilotPreflight", () => {
  beforeEach(() => {
    mockLoadConfig.mockReturnValue({});
    resetTuiPilotPreflightCache();
  });
  afterEach(() => resetTuiPilotPreflightCache());

  it("fails closed when required tools are unavailable", () => {
    const result = ensureTuiPilotPreflight({
      force: true,
      ops: ops({ version: "0.8.60" }),
      // PATH with nothing on it + a non-existent tui-pilot binary -> all hard checks fail.
      env: { PATH: "/nonexistent-bin-dir", TUI_PILOT_BIN: "/nonexistent/tui-pilot" },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("tui-pilot preflight failed");
    const names = result.checks.map((c) => c.name);
    expect(names).toContain("tui-pilot");
    expect(names).toContain("tmux");
    expect(names).toContain("uv");
    expect(names).toContain("claude");
    expect(names).toContain("subscription-credentials");
    expect(result.checks.find((c) => c.name === "tui-pilot")?.ok).toBe(false);
  });

  it("caches within the TTL and re-probes on force", () => {
    const env = { PATH: "/nonexistent-bin-dir", TUI_PILOT_BIN: "/nonexistent/tui-pilot" };
    const first = ensureTuiPilotPreflight({ force: true, env, now: 1_000 });
    const cached = ensureTuiPilotPreflight({ env, now: 1_500 });
    expect(cached).toBe(first); // same object reference => served from cache
    const reprobed = ensureTuiPilotPreflight({ force: true, env, now: 2_000 });
    expect(reprobed).not.toBe(first);
  });
});
