import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeAttemptBundle, resolveWorkerDir } from "./attempt-bundle.js";
import { resolveAgentHistoryEventsPath } from "./agent-history-events.js";
import { workspaceNameFromWorkingDir } from "./agent-history.js";
import { buildClaudeCodeSandboxSettingsConfig } from "./backend-sandbox.js";
import {
  buildClaudeExtractionPrompt,
  buildLessonExtractionPrompt,
} from "../prompts/lessons/extraction-prompt.js";
import { saveRun } from "./run-store.js";
import {
  addLesson,
  clearLessons,
  extractRunLessons,
  getLessonsForContext,
  loadLessons,
  removeLessons,
  saveLessons,
} from "./lessons.js";
import type { RunCliProcessResult } from "./cli-process.js";
import type { Lesson } from "./lessons.js";
import type { SerializedRun } from "./types.js";

const mockRunCliProcess = vi.fn();
const mockBuildClaudeCodeSandboxLaunchConfig = vi.fn(
  (params: { runId: string; workingDir: string; purpose: string }) => ({
    settingsPath: `/tmp/${params.runId}-settings.json`,
    args: [
      "--settings",
      `/tmp/${params.runId}-settings.json`,
      "--setting-sources",
      "",
      "--permission-mode",
      "default",
    ],
  }),
);
const mockWriteCodexNativeSandboxConfig = vi.fn(
  (params: { runId: string; workingDir: string; purpose: string }) => ({
    profileName: "smithersbot",
    executionRoot: params.workingDir,
    codexHome: `/tmp/${params.runId}-codex-home`,
    configPath: `/tmp/${params.runId}-codex-home/config.toml`,
    helperDir: `/tmp/${params.runId}-codex-home/bin`,
    helperPath: `/tmp/${params.runId}-codex-home/bin/codex-linux-sandbox`,
    codexPath: "codex",
    authReferencePath: `/tmp/${params.runId}-codex-home/auth.json`,
    authSourcePath: "/home/test/.codex/auth.json",
    env: {
      CODEX_HOME: `/tmp/${params.runId}-codex-home`,
      PATH: `/tmp/${params.runId}-codex-home/bin:${process.env.PATH ?? ""}`,
    },
    args: ["sandbox", "linux", "--permissions-profile", "smithersbot", "--cd", params.workingDir],
    configToml: [
      'default_permissions = "smithersbot"',
      "[permissions.smithersbot.filesystem]",
      '"/" = "read"',
      `"${params.workingDir}" = "read"`,
      `"${params.workingDir}/.env" = "deny"`,
      '"/managed/private/env/smithersbot/.env" = "deny"',
      '"/home/test/.codex/auth.json" = "deny"',
    ].join("\n"),
    deniedReadPaths: [
      `${params.workingDir}/.env`,
      `${params.workingDir}/.env.local`,
      `${params.workingDir}/.env.production`,
      "/managed/private/env/smithersbot/.env",
      "/home/test/.codex/auth.json",
      "/home/test/.claude/settings.json",
    ],
    allowedReadPaths: [params.workingDir],
    writablePaths: [],
  }),
);
const LESSONS_MODULE_URL = new URL("./lessons.ts", import.meta.url).href;
const CONCURRENT_ADD_LESSON_HELPER = `
import fs from "node:fs";
import path from "node:path";

const [stateDir, barrierDir, writerId, pattern, lesson, runId, moduleUrl] = process.argv.slice(2);
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => {
  if (ms > 0) Atomics.wait(waitBuffer, 0, 0, ms);
};

process.env.MOLTBOT_STATE_DIR = stateDir;
delete process.env.CLAWDBOT_STATE_DIR;

const targetPath = path.join(stateDir, "goal-lessons.json");
const originalRenameSync = fs.renameSync.bind(fs);
fs.renameSync = (from, to) => {
  if (String(to) === targetPath) {
    sleepSync(250);
  }
  return originalRenameSync(from, to);
};

fs.writeFileSync(path.join(barrierDir, \`\${writerId}.ready\`), "");
const startPath = path.join(barrierDir, "start");
while (!fs.existsSync(startPath)) sleepSync(10);

const { addLesson } = await import(moduleUrl);
addLesson({
  workingDir: "/repo/a",
  pattern,
  lesson,
  source: "worker",
  runId,
});
`;

vi.mock("./cli-process.js", () => ({
  runCliProcess: (...args: unknown[]) => mockRunCliProcess(...args),
}));

vi.mock("./backend-sandbox.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backend-sandbox.js")>();
  return {
    ...actual,
    buildClaudeCodeSandboxLaunchConfig: (...args: unknown[]) =>
      mockBuildClaudeCodeSandboxLaunchConfig(...args),
    writeCodexNativeSandboxConfig: (...args: unknown[]) =>
      mockWriteCodexNativeSandboxConfig(...args),
  };
});

const mockResolveClaudeBinary = vi.fn();
vi.mock("./scout.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scout.js")>();
  return {
    ...actual,
    resolveClaudeBinary: (...args: unknown[]) => mockResolveClaudeBinary(...args),
  };
});

const FORBIDDEN_AGENT_ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "SMITHERSBOT_GATEWAY_TOKEN",
  "CLAWDBOT_GATEWAY_TOKEN",
  "MOLTBOT_GATEWAY_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY_OLD",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
] as const;

function withForbiddenAgentEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of FORBIDDEN_AGENT_ENV_KEYS) {
    previous.set(key, process.env[key]);
    process.env[key] = `secret-${key}`;
  }
  return fn().finally(() => {
    for (const key of FORBIDDEN_AGENT_ENV_KEYS) {
      const prior = previous.get(key);
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  });
}

function expectForbiddenAgentEnvAbsent(env: Record<string, string | undefined>): void {
  for (const key of FORBIDDEN_AGENT_ENV_KEYS) {
    expect(env[key]).toBeUndefined();
  }
}

describe("lessons store", () => {
  let tmpDir: string;
  let prevMoltbotStateDir: string | undefined;
  let prevClawdbotStateDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-lessons-test-"));
    prevMoltbotStateDir = process.env.MOLTBOT_STATE_DIR;
    prevClawdbotStateDir = process.env.CLAWDBOT_STATE_DIR;
    process.env.MOLTBOT_STATE_DIR = tmpDir;
    delete process.env.CLAWDBOT_STATE_DIR;
  });

  afterEach(() => {
    if (prevMoltbotStateDir === undefined) delete process.env.MOLTBOT_STATE_DIR;
    else process.env.MOLTBOT_STATE_DIR = prevMoltbotStateDir;
    if (prevClawdbotStateDir === undefined) delete process.env.CLAWDBOT_STATE_DIR;
    else process.env.CLAWDBOT_STATE_DIR = prevClawdbotStateDir;

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function waitForReadyFiles(dir: string, count: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (true) {
      const readyFiles = fs.readdirSync(dir).filter((entry) => entry.endsWith(".ready"));
      if (readyFiles.length >= count) return;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${count} lesson writers to be ready.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function spawnConcurrentLessonWriter(
    helperPath: string,
    barrierDir: string,
    writerId: string,
    pattern: string,
    lesson: string,
    runId: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          helperPath,
          tmpDir,
          barrierDir,
          writerId,
          pattern,
          lesson,
          runId,
          LESSONS_MODULE_URL,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            `lesson writer ${writerId} failed (code=${String(code)} signal=${String(signal)}): ${stderr.trim()}`,
          ),
        );
      });
    });
  }

  it("adds and loads lessons through disk round-trip", () => {
    const added = addLesson({
      workingDir: "/repo/a",
      pattern: "vitest-config",
      lesson: "Use forks in this workspace for consistency.",
      source: "worker",
      runId: "run-1",
      stepId: "step-1",
    });

    expect(added.id).toBeTypeOf("string");
    expect(added.id.length).toBeGreaterThan(0);
    expect(added.scope).toBe("project");
    expect(Number.isNaN(Date.parse(added.createdAt))).toBe(false);

    const loaded = loadLessons();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(added);
  });

  it("persists explicit lesson scope from addLesson", () => {
    const added = addLesson({
      workingDir: "/repo/a",
      pattern: "cross-project-policy",
      lesson: "This lesson applies to every workspace.",
      source: "worker",
      runId: "run-global-1",
      scope: "global",
    });

    expect(added.scope).toBe("global");
    expect(loadLessons()[0]?.scope).toBe("global");
  });

  it("serializes concurrent addLesson writes so both lessons persist", async () => {
    saveLessons([]);

    const helperPath = path.join(tmpDir, "concurrent-add-lesson-writer.mjs");
    const barrierDir = fs.mkdtempSync(path.join(tmpDir, "lessons-barrier-"));
    fs.writeFileSync(helperPath, CONCURRENT_ADD_LESSON_HELPER, "utf8");

    const writerA = spawnConcurrentLessonWriter(
      helperPath,
      barrierDir,
      "writer-a",
      "pattern-a",
      "lesson a",
      "run-a",
    );
    const writerB = spawnConcurrentLessonWriter(
      helperPath,
      barrierDir,
      "writer-b",
      "pattern-b",
      "lesson b",
      "run-b",
    );

    await waitForReadyFiles(barrierDir, 2);
    fs.writeFileSync(path.join(barrierDir, "start"), "go", "utf8");
    await Promise.all([writerA, writerB]);

    const loaded = loadLessons();
    expect(loaded).toHaveLength(2);
    expect(loaded.map((lesson) => lesson.pattern).sort()).toEqual(["pattern-a", "pattern-b"]);
    expect(loaded.map((lesson) => lesson.runId).sort()).toEqual(["run-a", "run-b"]);
  });

  it("releases the lessons lock when addLesson throws", () => {
    saveLessons([]);

    const lockPath = path.join(tmpDir, "goal-lessons.json.lock");
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("rename failed");
    });

    try {
      expect(() =>
        addLesson({
          workingDir: "/repo/a",
          pattern: "rename-failure",
          lesson: "Lock cleanup should still run.",
          source: "worker",
          runId: "run-rename-failure",
        }),
      ).toThrow("rename failed");
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it("returns global lessons and matching project lessons for a workingDir", () => {
    const lessons: Lesson[] = [
      {
        id: "exact",
        workingDir: "/repo/project",
        pattern: "exact",
        lesson: "Exact match lesson",
        source: "worker",
        runId: "run-1",
        scope: "project",
        createdAt: "2026-02-24T00:00:00.000Z",
      },
      {
        id: "legacy-exact",
        workingDir: "/repo/project",
        pattern: "legacy-exact",
        lesson: "Legacy project lesson with no scope still matches this project.",
        source: "feedback",
        runId: "run-legacy",
        createdAt: "2026-02-24T00:00:00.500Z",
      },
      {
        id: "global",
        workingDir: "/repo/other",
        pattern: "global",
        lesson: "Global lesson should match any workingDir",
        source: "worker",
        runId: "run-global",
        scope: "global",
        createdAt: "2026-02-24T00:00:01.000Z",
      },
      {
        id: "other-project",
        workingDir: "/repo/other",
        pattern: "other-project",
        lesson: "Other project lesson should not match",
        source: "feedback",
        runId: "run-other",
        scope: "project",
        createdAt: "2026-02-24T00:00:02.000Z",
      },
      {
        id: "legacy-other",
        workingDir: "/repo/other",
        pattern: "legacy-other",
        lesson: "Legacy project lesson for other directory should not match.",
        source: "autocheck",
        runId: "run-other-legacy",
        createdAt: "2026-02-24T00:00:03.000Z",
      },
    ];
    saveLessons(lessons);

    const matched = getLessonsForContext("/repo/project");
    expect(matched.map((lesson) => lesson.id)).toEqual(["exact", "legacy-exact", "global"]);
  });

  it("treats missing lesson scope as project during context lookup", () => {
    saveLessons([
      {
        id: "legacy-a",
        workingDir: "/repo/a",
        pattern: "legacy-a",
        lesson: "Legacy lesson without scope for repo a.",
        source: "worker",
        runId: "run-a",
        createdAt: "2026-02-24T00:00:00.000Z",
      },
      {
        id: "legacy-b",
        workingDir: "/repo/b",
        pattern: "legacy-b",
        lesson: "Legacy lesson without scope for repo b.",
        source: "worker",
        runId: "run-b",
        createdAt: "2026-02-24T00:00:01.000Z",
      },
    ]);

    expect(getLessonsForContext("/repo/a").map((lesson) => lesson.id)).toEqual(["legacy-a"]);
    expect(getLessonsForContext("/repo/b").map((lesson) => lesson.id)).toEqual(["legacy-b"]);
  });

  it("clears lessons by workingDir and globally", () => {
    saveLessons([
      {
        id: "a1",
        workingDir: "/repo/a",
        pattern: "a",
        lesson: "a lesson",
        source: "user_edit",
        runId: "run-a1",
        createdAt: "2026-02-24T00:00:00.000Z",
      },
      {
        id: "a2",
        workingDir: "/repo/a",
        pattern: "a2",
        lesson: "a second lesson",
        source: "worker",
        runId: "run-a2",
        createdAt: "2026-02-24T00:00:01.000Z",
      },
      {
        id: "b1",
        workingDir: "/repo/b",
        pattern: "b",
        lesson: "b lesson",
        source: "feedback",
        runId: "run-b1",
        createdAt: "2026-02-24T00:00:02.000Z",
      },
    ]);

    expect(clearLessons("/repo/a")).toBe(2);
    expect(loadLessons().map((lesson) => lesson.id)).toEqual(["b1"]);

    expect(clearLessons()).toBe(1);
    expect(loadLessons()).toEqual([]);
  });

  it("removes lessons by id and preserves source values", () => {
    saveLessons([
      {
        id: "l1",
        workingDir: "/repo/a",
        pattern: "p1",
        lesson: "lesson 1",
        source: "worker",
        runId: "run-1",
        createdAt: "2026-02-24T00:00:00.000Z",
      },
      {
        id: "l2",
        workingDir: "/repo/a",
        pattern: "p2",
        lesson: "lesson 2",
        source: "feedback",
        runId: "run-2",
        createdAt: "2026-02-24T00:00:01.000Z",
      },
      {
        id: "l3",
        workingDir: "/repo/a",
        pattern: "p3",
        lesson: "lesson 3",
        source: "autocheck",
        runId: "run-3",
        createdAt: "2026-02-24T00:00:02.000Z",
      },
    ]);

    expect(removeLessons(["l2", "missing"])).toBe(1);
    const remaining = loadLessons();
    expect(remaining.map((lesson) => lesson.id)).toEqual(["l1", "l3"]);
    expect(remaining.map((lesson) => lesson.source)).toEqual(["worker", "autocheck"]);
  });
});

type ExtractionRunOptions = {
  runId: string;
  workingDir: string;
  stepResults?: SerializedRun["stepResults"];
  planHistory?: SerializedRun["planHistory"];
};

function createPlan(workingDir: string, summary: string) {
  return {
    goal: "Extract lessons",
    workingDir,
    summary,
    shortSummary: summary,
    steps: [
      {
        id: "step-alpha",
        description: "Fix parser reliability",
        shortSummary: "Fix parser",
        dependsOn: [],
        status: "done" as const,
      },
    ],
  };
}

function saveExtractionRun(options: ExtractionRunOptions): void {
  const run: SerializedRun = {
    runId: options.runId,
    goal: "Improve extraction reliability",
    state: "done",
    plan: createPlan(options.workingDir, "Current plan"),
    stepResults: options.stepResults ?? {},
    blocked: null,
    answers: {},
    workingDir: options.workingDir,
    model: "claude-sonnet-4-20250514",
    dryRun: false,
    createdAt: "2026-02-24T00:00:00.000Z",
    updatedAt: "2026-02-24T00:01:00.000Z",
    planHistory: options.planHistory,
  };
  saveRun(run);
}

function makeCliResult(overrides: Partial<RunCliProcessResult>): RunCliProcessResult {
  return {
    stdout: "",
    stderr: "",
    timedOut: false,
    exitCode: 0,
    signal: null,
    durationMs: 15,
    ...overrides,
  };
}

describe("extractRunLessons", () => {
  let tmpDir: string;
  let prevMoltbotStateDir: string | undefined;
  let prevClawdbotStateDir: string | undefined;
  let managedRoot: string;
  let prevManagedRoot: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-extract-lessons-test-"));
    prevMoltbotStateDir = process.env.MOLTBOT_STATE_DIR;
    prevClawdbotStateDir = process.env.CLAWDBOT_STATE_DIR;
    prevManagedRoot = process.env.SMITHERSBOT_GOALS_ROOT;
    process.env.MOLTBOT_STATE_DIR = tmpDir;
    managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goal-extract-lessons-managed-"));
    process.env.SMITHERSBOT_GOALS_ROOT = managedRoot;
    delete process.env.CLAWDBOT_STATE_DIR;
    mockRunCliProcess.mockReset();
    mockResolveClaudeBinary.mockReset();
    mockBuildClaudeCodeSandboxLaunchConfig.mockClear();
    mockWriteCodexNativeSandboxConfig.mockClear();
    mockResolveClaudeBinary.mockReturnValue("/usr/bin/claude");
  });

  afterEach(() => {
    if (prevMoltbotStateDir === undefined) delete process.env.MOLTBOT_STATE_DIR;
    else process.env.MOLTBOT_STATE_DIR = prevMoltbotStateDir;
    if (prevClawdbotStateDir === undefined) delete process.env.CLAWDBOT_STATE_DIR;
    else process.env.CLAWDBOT_STATE_DIR = prevClawdbotStateDir;
    if (prevManagedRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
    else process.env.SMITHERSBOT_GOALS_ROOT = prevManagedRoot;

    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(managedRoot, { recursive: true, force: true });
  });

  function readLessonHistoryEvents(
    runId: string,
    workingDir: string,
  ): Array<Record<string, unknown>> {
    const eventsPath = resolveAgentHistoryEventsPath({
      kind: "goal",
      workspaceName: workspaceNameFromWorkingDir(workingDir),
      goalId: runId,
    });
    return fs
      .readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("loads artifacts from temp run directories, includes existing lessons, and records extracted lessons", async () => {
    const runId = "extract-run-success";
    const workingDir = "/repo/project-a";
    saveExtractionRun({
      runId,
      workingDir,
      planHistory: [
        {
          revision: 1,
          source: "user",
          plan: createPlan(workingDir, "Initial plan"),
        },
        {
          revision: 2,
          source: "autocheck",
          editInstructions: "Adjust for monorepo tsconfig lookup",
          plan: createPlan(workingDir, "Adjusted plan"),
        },
      ],
      stepResults: {
        "step-alpha": {
          stepId: "step-alpha",
          success: false,
          output: "pnpm build failed",
          error: "Cannot resolve workspace tsconfig path",
          durationMs: 1532,
        },
      },
    });

    writeAttemptBundle(resolveWorkerDir(runId, "step-alpha"), {
      attemptNumber: 1,
      backend: "codex",
      outcome: "ralph",
      durationMs: 88,
      ralphDetail: {
        approachTried: "Hardcoded default tsconfig path.",
        specificErrors: "Broke monorepo sub-package builds.",
        keyInsight: "Resolve tsconfig from package root before invoking toolchain.",
        suggestedApproach: "Inspect nearest package.json and walk to tsconfig path.",
      },
    });

    mockRunCliProcess.mockResolvedValueOnce(
      makeCliResult({
        stdout: JSON.stringify({
          usage: { input_tokens: 44, output_tokens: 11 },
          lessons: [
            {
              pattern: "workspace-tsconfig",
              lesson:
                "Resolve tsconfig from the current package root instead of assuming repo root defaults.",
              stepId: "step-alpha",
            },
          ],
        }),
      }),
    );

    const previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "https://proxy.invalid";
    let recorded: Awaited<ReturnType<typeof extractRunLessons>>;
    try {
      recorded = await withForbiddenAgentEnv(() =>
        extractRunLessons(runId, workingDir, [
          { pattern: "known-dedup", lesson: "Do not duplicate this existing lesson." },
        ]),
      );
    } finally {
      if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
    }

    expect(mockRunCliProcess).toHaveBeenCalledTimes(1);
    const call = mockRunCliProcess.mock.calls[0]?.[0] as {
      command: string;
      cwd: string;
      stdin: string;
      env: Record<string, string | undefined>;
      args: string[];
    };
    expect(call.command).toBe("/usr/bin/claude");
    expect(call.cwd).toBe(workingDir);
    expectForbiddenAgentEnvAbsent(call.env);
    expect(call.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(mockBuildClaudeCodeSandboxLaunchConfig).toHaveBeenCalledWith({
      workingDir,
      runId: `${runId}-lessons-1`,
      purpose: "repo-chat",
    });
    expect(call.args).toContain("--settings");
    expect(call.args).toContain(`/tmp/${runId}-lessons-1-settings.json`);
    expect(call.args).not.toContain("--dangerously-skip-permissions");
    expect(call.args).not.toContain("--allow-dangerously-skip-permissions");
    expect(call.stdin).toContain("Adjust for monorepo tsconfig lookup");
    expect(call.stdin).toContain("Resolve tsconfig from package root before invoking toolchain.");
    expect(call.stdin).toContain("Cannot resolve workspace tsconfig path");
    expect(call.stdin).toContain("- [known-dedup] Do not duplicate this existing lesson.");

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      workingDir,
      pattern: "workspace-tsconfig",
      lesson:
        "Resolve tsconfig from the current package root instead of assuming repo root defaults.",
      source: "autocheck",
      runId,
      stepId: "step-alpha",
      scope: "project",
    });
    expect(recorded[0]?.id.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(recorded[0]!.createdAt))).toBe(false);

    const stored = loadLessons();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(recorded[0]);
    const events = readLessonHistoryEvents(runId, workingDir);
    expect(events[0]).toMatchObject({
      event: "launch",
      phase: "lessons",
      backend: "claude_code",
      status: "started",
    });
    expect(events[0]?.promptArtifactPath).toEqual(expect.any(String));
    expect(fs.readFileSync(String(events[0]?.promptArtifactPath), "utf8")).toContain(
      "Improve extraction reliability",
    );
    expect(events[1]).toMatchObject({
      event: "result",
      status: "success",
      tokenUsage: { available: true, inputTokens: 44, outputTokens: 11 },
    });
  });

  it("redacts known secret values from extracted lessons before storing them", async () => {
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "FAKE_TELEGRAM_SECRET_123";
    try {
      const runId = "extract-run-redact";
      const workingDir = "/repo/project-redact";
      saveExtractionRun({
        runId,
        workingDir,
        stepResults: {
          "step-alpha": {
            stepId: "step-alpha",
            success: false,
            output: "worker output",
            error: "worker error",
            durationMs: 50,
          },
        },
      });

      mockRunCliProcess.mockResolvedValueOnce(
        makeCliResult({
          stdout: JSON.stringify({
            lessons: [
              {
                pattern: "secret-redaction",
                lesson: "Never persist FAKE_TELEGRAM_SECRET_123 in lessons.",
                stepId: "step-alpha",
              },
            ],
          }),
        }),
      );

      const recorded = await extractRunLessons(runId, workingDir, []);

      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.lesson).toContain("[REDACTED]");
      expect(recorded[0]?.lesson).not.toContain("FAKE_TELEGRAM_SECRET_123");
      const persisted = fs.readFileSync(path.join(tmpDir, "goal-lessons.json"), "utf8");
      expect(persisted).toContain("[REDACTED]");
      expect(persisted).not.toContain("FAKE_TELEGRAM_SECRET_123");
      const historyText = fs.readFileSync(
        resolveAgentHistoryEventsPath({
          kind: "goal",
          workspaceName: workspaceNameFromWorkingDir(workingDir),
          goalId: runId,
        }),
        "utf8",
      );
      expect(historyText).not.toContain("FAKE_TELEGRAM_SECRET_123");
    } finally {
      if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    }
  });

  it("falls back to Codex when Claude Code hits a usage limit", async () => {
    const runId = "extract-run-usage-fallback";
    const workingDir = "/repo/project-usage-fallback";
    saveExtractionRun({
      runId,
      workingDir,
      stepResults: {
        "step-alpha": {
          stepId: "step-alpha",
          success: false,
          output: "pnpm build failed",
          error: "Parser emitted malformed JSON",
          durationMs: 22,
        },
      },
    });

    mockRunCliProcess
      .mockResolvedValueOnce(
        makeCliResult({
          stdout: "",
          stderr: "API 429: You've hit your org's monthly usage limit. Resets at 3pm.",
          exitCode: 1,
        }),
      )
      .mockResolvedValueOnce(
        makeCliResult({
          stdout: JSON.stringify({
            lessons: [
              {
                pattern: "fallback-works",
                lesson: "Codex recovered the extraction.",
                stepId: "step-alpha",
              },
            ],
          }),
        }),
      );

    const recorded = await extractRunLessons(runId, workingDir, []);

    expect(mockRunCliProcess).toHaveBeenCalledTimes(2);
    expect(mockRunCliProcess.mock.calls[0]?.[0]).toMatchObject({ command: "/usr/bin/claude" });
    expect(mockRunCliProcess.mock.calls[1]?.[0]).toMatchObject({ command: "codex" });
    const codexCall = mockRunCliProcess.mock.calls[1]?.[0] as {
      args: string[];
      env: Record<string, string | undefined>;
    };
    expect(codexCall.args).not.toContain("--sandbox");
    expect(codexCall.args).not.toContain("--skip-git-repo-check");
    expect(codexCall.args).not.toContain("--dangerously-skip-permissions");
    expect(codexCall.args).not.toContain("--allow-dangerously-skip-permissions");
    expect(codexCall.env.CODEX_HOME).toContain(`${runId}-lessons-2-codex-home`);
    const sandboxConfig = mockWriteCodexNativeSandboxConfig.mock.results[0]?.value as {
      writablePaths: string[];
      deniedReadPaths: string[];
      allowedReadPaths: string[];
    };
    expect(sandboxConfig.writablePaths).toEqual([]);
    expect(sandboxConfig.allowedReadPaths).toContain(workingDir);
    expect(sandboxConfig.deniedReadPaths).toEqual(
      expect.arrayContaining([
        `${workingDir}/.env`,
        "/managed/private/env/smithersbot/.env",
        "/home/test/.codex/auth.json",
        "/home/test/.claude/settings.json",
      ]),
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.pattern).toBe("fallback-works");
    const events = readLessonHistoryEvents(runId, workingDir);
    expect(events.map((event) => event.event)).toContain("fallback");
    expect(
      events.filter((event) => event.event === "launch").map((event) => event.backend),
    ).toEqual(["claude_code", "codex"]);
  });

  it("returns [] (fail-open) when both backends are usage-limited, trying each once", async () => {
    const runId = "extract-run-usage-exhausted";
    const workingDir = "/repo/project-usage-exhausted";
    saveExtractionRun({
      runId,
      workingDir,
      stepResults: {
        "step-alpha": {
          stepId: "step-alpha",
          success: false,
          output: "pnpm build failed",
          error: "Parser emitted malformed JSON",
          durationMs: 22,
        },
      },
    });

    mockRunCliProcess
      .mockResolvedValueOnce(
        makeCliResult({ stdout: "", stderr: "monthly usage limit reached", exitCode: 1 }),
      )
      .mockResolvedValueOnce(
        makeCliResult({ stdout: "", stderr: "Codex weekly usage limit hit", exitCode: 1 }),
      );

    const recorded = await extractRunLessons(runId, workingDir, []);

    expect(recorded).toEqual([]);
    expect(mockRunCliProcess).toHaveBeenCalledTimes(2);
  });

  it("includes hardened worker-only extraction instructions and scope schema in prompts", async () => {
    const runId = "extract-run-prompt-contract";
    const workingDir = "/repo/project-prompts";
    saveExtractionRun({
      runId,
      workingDir,
      planHistory: [
        {
          revision: 1,
          source: "autocheck",
          editInstructions: "Fix reliability issue from failed parser run",
          plan: createPlan(workingDir, "Revised plan"),
        },
      ],
      stepResults: {
        "step-alpha": {
          stepId: "step-alpha",
          success: false,
          output: "pnpm build failed",
          error: "Parser emitted malformed JSON",
          durationMs: 22,
        },
      },
    });

    mockRunCliProcess.mockResolvedValueOnce(makeCliResult({ stdout: '{"lessons":[]}' }));

    const recorded = await extractRunLessons(runId, workingDir, []);
    expect(recorded).toEqual([]);
    expect(mockRunCliProcess).toHaveBeenCalledTimes(1);

    const call = mockRunCliProcess.mock.calls[0]?.[0] as { stdin: string };
    expect(call.stdin.indexOf("Return ONLY JSON with this shape:")).toBeLessThan(
      call.stdin.indexOf("Run: extract-run-prompt-contract"),
    );
    expect(call.stdin).toContain(
      '{"lessons":[{"pattern":"...","lesson":"...","scope":"project|global","stepId":"optional"}]}',
    );
    expect(call.stdin).toContain(
      '{ "lessons": [{ "pattern": "short-keyword", "lesson": "1-3 sentence insight", "scope": "project|global", "stepId": "optional step id" }] }',
    );
    expect(call.stdin).toContain(
      "Lessons are ONLY for improving the worker prompt (the CLI agent executing individual plan steps).",
    );
    expect(call.stdin).toContain(
      "Do NOT include advice for the planner, plan autocheck/reviewer, manual-test suggester, post-execution reviewer, or any other LLM surface.",
    );
    expect(call.stdin).toContain(
      "Every correction in this summary has ALREADY been applied to the codebase; the code is in its fully fixed, committed state.",
    );
    expect(call.stdin).toContain(
      "Only create a lesson if it captures a forward-looking principle that would NOT be obvious from reading the current source code.",
    );
    expect(call.stdin).toContain(
      "Reject any candidate that merely describes what was changed or fixed in this run.",
    );
    expect(call.stdin).toContain(
      "Reject any candidate that gives advice about things the worker cannot control",
    );
    expect(call.stdin).toContain(
      "Reject any candidate that works around a flaky code path instead of fixing code.",
    );
    expect(call.stdin).toContain(
      "Reject any candidate that restates implementation details already visible in source.",
    );
    expect(call.stdin).toContain(
      "Only include lessons about issues that actually caused problems or confusion in this run.",
    );
    expect(call.stdin).toContain(
      "If unsure whether a lesson should be included, do not include it.",
    );
    expect(call.stdin).toContain(
      'Classify scope for each lesson: "global" for principles that apply to any project, "project" for lessons specific to this working directory.',
    );
    const correctionSummary = [
      `Run ID: ${runId}`,
      `Working directory: ${workingDir}`,
      "Goal: Improve extraction reliability",
      "",
      "Plan history:",
      "- Revision 1 (source: autocheck)",
      "  Summary: Revised plan",
      "  Edit instructions: Fix reliability issue from failed parser run",
      "",
      "Step results:",
      "- step-alpha: failed",
      "  Error: Parser emitted malformed JSON",
      "  Output: pnpm build failed",
    ].join("\n");
    const afterPrompt = buildLessonExtractionPrompt({
      runId,
      workingDir,
      existingLessons: [],
      correctionSummary,
    });
    const oldPrompt = [
      "Extract reusable project lessons from this completed goal run.",
      "",
      `Run: ${runId}`,
      `Working directory: ${workingDir}`,
      "",
      "Existing lessons (do not duplicate or paraphrase these):",
      "None.",
      "",
      "Correction summary artifacts:",
      correctionSummary,
      "",
      "Critical framing:",
      "- Every correction in this summary has ALREADY been applied to the codebase; the code is in its fully fixed, committed state.",
      "- The worker on the next run will see the fixed code directly.",
      "- Only create a lesson if it captures a forward-looking principle that would NOT be obvious from reading the current source code.",
      "",
      "Return ONLY JSON with this shape:",
      '{ "lessons": [{ "pattern": "short-keyword", "lesson": "1-3 sentence insight", "scope": "project|global", "stepId": "optional step id" }] }',
      "",
      "Rules:",
      "- Lessons are ONLY for improving the worker prompt (the CLI agent executing individual plan steps).",
      "- Do NOT include advice for the planner, plan autocheck/reviewer, manual-test suggester, post-execution reviewer, or any other LLM surface.",
      "- Only include lessons about issues that actually caused problems or confusion in this run.",
      "- Lessons must encode forward-looking principles that improve future worker decisions and are not obvious from current source.",
      "- Reject any candidate that merely describes what was changed or fixed in this run.",
      "- Reject any candidate that gives advice about things the worker cannot control (for example system config, hardcoded build-gate policy, Semgrep severity/excludes).",
      "- Reject any candidate that works around a flaky code path instead of fixing code.",
      "- Reject any candidate that restates implementation details already visible in source.",
      "- Pattern should be short and specific (kebab-case preferred).",
      "- Lesson text should be concrete and generalizable.",
      '- Classify scope for each lesson: "global" for principles that apply to any project, "project" for lessons specific to this working directory.',
      "- If unsure whether a lesson should be included, do not include it.",
      '- If no useful new lessons exist, return exactly: {"lessons":[]}.',
    ].join("\n");
    expect(afterPrompt.length).toBeLessThanOrEqual(oldPrompt.length);
    expect(buildClaudeExtractionPrompt(afterPrompt).length).toBeLessThanOrEqual(
      buildClaudeExtractionPrompt(oldPrompt).length,
    );
  });

  it("uses the shared Claude read-only sandbox profile for lesson CLI launches", () => {
    const workingDir = "/repo/lessons-sandbox";
    const settings = buildClaudeCodeSandboxSettingsConfig({
      workingDir,
      runId: "lessons-sandbox",
      purpose: "repo-chat",
      denyReadDeps: {
        homedir: () => "/home/test",
        privateRoot: () => "/managed/private",
        pathExists: () => true,
        realPath: (candidate) => candidate,
      },
    }).settings;

    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.failIfUnavailable).toBe(true);
    expect(settings.sandbox.filesystem.allowRead).toContain(workingDir);
    expect(settings.sandbox.filesystem.allowWrite).toEqual([]);
    expect(settings.sandbox.filesystem.denyRead).toEqual(
      expect.arrayContaining([
        `${workingDir}/.env`,
        `${workingDir}/.env.local`,
        "/managed/private",
        "/home/test/.claude",
      ]),
    );
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining([
        `Read(${workingDir}/.env)`,
        "Read(/home/test/.codex/**)",
        "Read(/home/test/.claude/**)",
      ]),
    );
  });

  it("strips credential env vars from Codex lesson extraction subprocesses", async () => {
    const runId = "extract-run-codex-env-strip";
    const workingDir = "/repo/project-codex-env";
    mockResolveClaudeBinary.mockReturnValue(null);
    saveExtractionRun({
      runId,
      workingDir,
      stepResults: {
        "step-alpha": {
          stepId: "step-alpha",
          success: false,
          output: "pnpm build failed",
          error: "Parser emitted malformed JSON",
          durationMs: 22,
        },
      },
    });
    mockRunCliProcess.mockResolvedValueOnce(makeCliResult({ stdout: '{"lessons":[]}' }));

    await withForbiddenAgentEnv(() => extractRunLessons(runId, workingDir, []));

    const call = mockRunCliProcess.mock.calls[0]?.[0] as {
      command: string;
      args: string[];
      env: Record<string, string | undefined>;
    };
    expect(call.command).toBe("codex");
    expectForbiddenAgentEnvAbsent(call.env);
    expect(call.args).not.toContain("--sandbox");
    expect(call.args).not.toContain("--skip-git-repo-check");
    expect(call.env.CODEX_HOME).toContain(`${runId}-lessons-1-codex-home`);
    expect(mockWriteCodexNativeSandboxConfig).toHaveBeenCalledWith(
      expect.objectContaining({ workingDir, runId: `${runId}-lessons-1`, purpose: "repo-chat" }),
    );
  });

  it("repairs malformed JSONL lines when parsing extracted lessons", async () => {
    const runId = "extract-run-jsonl-repair";
    const workingDir = "/repo/project-jsonl";
    saveExtractionRun({
      runId,
      workingDir,
      stepResults: {
        "step-alpha": {
          stepId: "step-alpha",
          success: false,
          output: "pnpm test failed",
          error: "Intermittent parser failure",
          durationMs: 40,
        },
      },
    });

    mockRunCliProcess.mockResolvedValueOnce(
      makeCliResult({
        stdout: [
          '{"type":"event","message":"starting extraction"}',
          '{"result":{"lessons":[{"pattern":"jsonl-repair","lesson":"Attempt JSON repair for malformed structured lines.","stepId":"step-alpha","scope":"global"}]}}}',
        ].join("\n"),
      }),
    );

    const recorded = await extractRunLessons(runId, workingDir, []);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      pattern: "jsonl-repair",
      lesson: "Attempt JSON repair for malformed structured lines.",
      stepId: "step-alpha",
      source: "autocheck",
      runId,
      workingDir,
      scope: "global",
    });
  });

  it.each([
    {
      scenario: "timeout",
      response: makeCliResult({ timedOut: true }),
    },
    {
      scenario: "bad json",
      response: makeCliResult({ stdout: "not-json-at-all" }),
    },
    {
      scenario: "process error",
      response: makeCliResult({ exitCode: 1, stderr: "spawn failed" }),
    },
  ])("fails open for $scenario", async ({ response, scenario }) => {
    const runId = `extract-run-failure-${scenario.replace(/\s+/g, "-")}`;
    const workingDir = "/repo/project-failures";
    saveExtractionRun({
      runId,
      workingDir,
      stepResults: {
        "step-alpha": {
          stepId: "step-alpha",
          success: false,
          output: "failed",
          error: "failure trigger",
          durationMs: 30,
        },
      },
    });

    mockResolveClaudeBinary.mockReturnValue(null);
    mockRunCliProcess.mockResolvedValueOnce(response);

    const recorded = await extractRunLessons(runId, workingDir, []);
    expect(recorded).toEqual([]);
    expect(loadLessons()).toEqual([]);
  });

  it("returns empty when correction summary has no corrections and skips CLI extraction", async () => {
    const runId = "extract-run-no-corrections";
    const workingDir = "/repo/project-clean";
    saveExtractionRun({
      runId,
      workingDir,
      planHistory: [
        {
          revision: 1,
          source: "user",
          plan: createPlan(workingDir, "Only revision with no edits"),
        },
      ],
      stepResults: {
        "step-alpha": {
          stepId: "step-alpha",
          success: true,
          output: "all checks passed",
          durationMs: 24,
        },
      },
    });

    const recorded = await extractRunLessons(runId, workingDir, [
      { pattern: "already-known", lesson: "Known lesson" },
    ]);
    expect(recorded).toEqual([]);
    expect(mockRunCliProcess).not.toHaveBeenCalled();
    expect(loadLessons()).toEqual([]);
  });
});
