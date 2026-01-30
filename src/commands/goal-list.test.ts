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
    saveRun: (run: SerializedRun, dir?: string) => actual.saveRun(run, dir ?? testGoalsDir),
  };
});

function mockRuntime(): RuntimeEnv & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    log: (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    },
    error: (...args: unknown[]) => {
      logs.push(`ERROR: ${args.map(String).join(" ")}`);
    },
    exit: (() => {
      throw new Error("exit called");
    }) as never,
  };
}

const sampleRun: SerializedRun = {
  runId: "aaaa-bbbb-cccc-dddd",
  goal: "Build a widget",
  state: "done",
  plan: {
    goal: "Build a widget",
    summary: "Widget plan",
    steps: [
      {
        id: "1",
        description: "Step",
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

describe("goal-list command", () => {
  beforeEach(() => {
    testGoalsDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-list-test-"));
  });

  afterEach(() => {
    fs.rmSync(testGoalsDir, { recursive: true, force: true });
  });

  it("shows 'no runs' when directory is empty", async () => {
    const { goalListCommand } = await import("./goal-list.js");
    const rt = mockRuntime();
    await goalListCommand({}, rt);
    expect(rt.logs.join("\n")).toContain("No goal runs found.");
  });

  it("lists runs in text mode", async () => {
    saveRun(sampleRun);
    const { goalListCommand } = await import("./goal-list.js");
    const rt = mockRuntime();
    await goalListCommand({}, rt);
    const output = rt.logs.join("\n");
    expect(output).toContain("aaaa-bbb");
    expect(output).toContain("done");
    expect(output).toContain("Build a widget");
    expect(output).toContain("1/1 steps");
  });

  it("outputs valid JSON array when --json is set", async () => {
    saveRun(sampleRun);
    const { goalListCommand } = await import("./goal-list.js");
    const rt = mockRuntime();
    await goalListCommand({ json: true }, rt);
    const parsed = JSON.parse(rt.logs.join("")) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });

  it("outputs empty JSON array when no runs and --json", async () => {
    const { goalListCommand } = await import("./goal-list.js");
    const rt = mockRuntime();
    await goalListCommand({ json: true }, rt);
    const parsed = JSON.parse(rt.logs.join("")) as unknown[];
    expect(parsed).toEqual([]);
  });

  it("--output json produces strict JSON array", async () => {
    saveRun(sampleRun);
    const { goalListCommand } = await import("./goal-list.js");
    const rt = mockRuntime();
    await goalListCommand({ output: "json" }, rt);
    const raw = rt.logs.join("");
    expect(raw.trimStart()[0]).toBe("[");
    const parsed = JSON.parse(raw) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });

  it("--output json wins over --json false", async () => {
    saveRun(sampleRun);
    const { goalListCommand } = await import("./goal-list.js");
    const rt = mockRuntime();
    await goalListCommand({ json: false, output: "json" }, rt);
    const raw = rt.logs.join("");
    const parsed = JSON.parse(raw) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
  });

  it("--output md with --json true uses md (output wins)", async () => {
    saveRun(sampleRun);
    const { goalListCommand } = await import("./goal-list.js");
    const rt = mockRuntime();
    await goalListCommand({ json: true, output: "md" }, rt);
    const output = rt.logs.join("\n");
    expect(output).toContain("Goal runs:");
  });

  it("respects limit option", async () => {
    saveRun(sampleRun);
    saveRun({ ...sampleRun, runId: "eeee-ffff", updatedAt: "2026-01-30T02:00:00.000Z" });
    const { goalListCommand } = await import("./goal-list.js");
    const rt = mockRuntime();
    await goalListCommand({ json: true, limit: 1 }, rt);
    const parsed = JSON.parse(rt.logs.join("")) as unknown[];
    expect(parsed).toHaveLength(1);
  });
});
