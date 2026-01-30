import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveRun } from "../goal/run-store.js";
import type { SerializedRun } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";

let testGoalsDir: string;

vi.mock("../goal/run-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../goal/run-store.js")>();
  return {
    ...actual,
    resolveGoalsDir: () => testGoalsDir,
    listRuns: (dir?: string) => actual.listRuns(dir ?? testGoalsDir),
    loadRun: (id: string, dir?: string) => actual.loadRun(id, dir ?? testGoalsDir),
    saveRun: (run: SerializedRun, dir?: string) => actual.saveRun(run, dir ?? testGoalsDir),
    resolveRunId: (partial: string, dir?: string) =>
      actual.resolveRunId(partial, dir ?? testGoalsDir),
  };
});

function mockRuntime(): RuntimeEnv & { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log: (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    },
    error: (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    },
    exit: (() => {
      throw new Error("exit called");
    }) as never,
  };
}

const sampleRun: SerializedRun = {
  runId: "status-test-aaaa",
  goal: "Build a widget",
  state: "done",
  plan: {
    goal: "Build a widget",
    summary: "Widget plan",
    steps: [
      {
        id: "1",
        description: "Create dir",
        dependsOn: [],
        tool: { name: "mkdir", args: { path: "x" } },
        status: "done",
      },
    ],
  },
  stepResults: { "1": { stepId: "1", success: true, output: "", durationMs: 1 } },
  blockReason: null,
  workingDir: "/tmp",
  model: undefined,
  dryRun: false,
  createdAt: "2026-01-30T00:00:00.000Z",
  updatedAt: "2026-01-30T00:01:00.000Z",
};

describe("goal-status command", () => {
  beforeEach(() => {
    testGoalsDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-status-test-"));
  });

  afterEach(() => {
    fs.rmSync(testGoalsDir, { recursive: true, force: true });
  });

  it("shows run details in text mode", async () => {
    saveRun(sampleRun);
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("status-test-aaaa", {}, rt);
    const output = rt.logs.join("\n");
    expect(output).toContain("status-test-aaaa");
    expect(output).toContain("Build a widget");
    expect(output).toContain("done");
  });

  it("--json outputs strict JSON object", async () => {
    saveRun(sampleRun);
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("status-test-aaaa", { json: true }, rt);
    const raw = rt.logs.join("");
    expect(raw.trimStart()[0]).toBe("{");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.runId).toBe("status-test-aaaa");
    expect(parsed.goal).toBe("Build a widget");
  });

  it("--output json outputs strict JSON object", async () => {
    saveRun(sampleRun);
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("status-test-aaaa", { output: "json" }, rt);
    const raw = rt.logs.join("");
    expect(raw.trimStart()[0]).toBe("{");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.runId).toBe("status-test-aaaa");
  });

  it("--output md with --json true uses md (output wins)", async () => {
    saveRun(sampleRun);
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("status-test-aaaa", { json: true, output: "md" }, rt);
    const output = rt.logs.join("\n");
    expect(output).toContain("Run:");
    expect(output).toContain("Goal:");
  });

  it("errors for unknown run ID", async () => {
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("nonexistent", {}, rt);
    expect(rt.errors).toContain("Run not found: nonexistent");
  });

  it("--json error for unknown run outputs strict JSON", async () => {
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("nonexistent", { json: true }, rt);
    const raw = rt.logs.join("");
    expect(raw.trimStart()[0]).toBe("{");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.error).toBe("Run not found: nonexistent");
  });

  it("resolves partial run IDs", async () => {
    saveRun(sampleRun);
    const { goalStatusCommand } = await import("./goal-status.js");
    const rt = mockRuntime();
    await goalStatusCommand("status-t", {}, rt);
    const output = rt.logs.join("\n");
    expect(output).toContain("status-test-aaaa");
  });
});
