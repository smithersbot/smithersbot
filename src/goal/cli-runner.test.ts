import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTaskWithCliWorker } from "./cli-worker.js";
import { HARD_DENIES } from "./hard-deny.js";
import { getLessonsForContext } from "./lessons.js";
import { CliTaskRunner } from "./cli-runner.js";
import type { Plan, PlanStep } from "./types.js";

vi.mock("./cli-worker.js", () => ({
  executeTaskWithCliWorker: vi.fn(),
}));

vi.mock("./lessons.js", () => ({
  getLessonsForContext: vi.fn(() => []),
}));

const executeTaskWithCliWorkerMock = vi.mocked(executeTaskWithCliWorker);
const getLessonsForContextMock = vi.mocked(getLessonsForContext);

function makeStep(): PlanStep {
  return {
    id: "step-1",
    description: "Do work",
    shortSummary: "Do work",
    dependsOn: [],
    status: "pending",
    backend: "codex",
  };
}

function makePlan(step: PlanStep): Plan {
  return {
    goal: "Test goal",
    shortSummary: "Test goal",
    workingDir: "/tmp/project",
    summary: "Plan summary",
    steps: [step],
  };
}

function makeContext(workingDir: string) {
  const step = makeStep();
  return {
    task: step,
    plan: makePlan(step),
    goal: "Run worker",
    workingDir,
    runId: "run-1",
    denyPolicy: HARD_DENIES.slice(0, 1),
    completedSummaries: [],
    abortSignal: new AbortController().signal,
    timeoutMs: 30_000,
  };
}

describe("CliTaskRunner project conventions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLessonsForContextMock.mockReturnValue([]);
    executeTaskWithCliWorkerMock.mockResolvedValue({
      output: { status: "complete", summary: "done" },
      turnsUsed: 1,
      rawStdout: "",
      rawStderr: "",
    });
  });

  it("passes CLAUDE.md content to codex workers", async () => {
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-runner-codex-"));
    fs.writeFileSync(path.join(workingDir, "CLAUDE.md"), "Use npm test\nNo force push\n", "utf8");

    const runner = new CliTaskRunner({ backend: "codex" });
    await runner.execute(makeContext(workingDir));

    expect(executeTaskWithCliWorkerMock).toHaveBeenCalledTimes(1);
    expect(executeTaskWithCliWorkerMock.mock.calls[0]?.[0]?.projectConventions).toBe(
      "Use npm test\nNo force push",
    );
  });

  it("omits project conventions for codex workers when CLAUDE.md is missing", async () => {
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-runner-codex-missing-"));

    const runner = new CliTaskRunner({ backend: "codex" });
    await runner.execute(makeContext(workingDir));

    expect(executeTaskWithCliWorkerMock).toHaveBeenCalledTimes(1);
    expect(executeTaskWithCliWorkerMock.mock.calls[0]?.[0]?.projectConventions).toBeUndefined();
  });

  it("does not inject project conventions for claude_code workers", async () => {
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-runner-claude-"));
    fs.writeFileSync(path.join(workingDir, "CLAUDE.md"), "Use npm test", "utf8");

    const runner = new CliTaskRunner({ backend: "claude_code" });
    await runner.execute(makeContext(workingDir));

    expect(executeTaskWithCliWorkerMock).toHaveBeenCalledTimes(1);
    expect(executeTaskWithCliWorkerMock.mock.calls[0]?.[0]?.projectConventions).toBeUndefined();
  });

  it("propagates the CLI worker session id for post-execution resume", async () => {
    executeTaskWithCliWorkerMock.mockResolvedValueOnce({
      output: { status: "complete", summary: "done" },
      turnsUsed: 1,
      sessionId: "thread_123",
      rawStdout: "",
      rawStderr: "",
    });

    const runner = new CliTaskRunner({ backend: "codex" });
    const result = await runner.execute(
      makeContext(fs.mkdtempSync(path.join(os.tmpdir(), "cli-runner-session-"))),
    );

    expect(result.status).toBe("complete");
    expect(result.executionSessionId).toBe("thread_123");
  });
});
