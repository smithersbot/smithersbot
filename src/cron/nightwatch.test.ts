import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoltbotConfig } from "../config/config.js";
import type { NightwatchConfig } from "../config/types.cron.js";

const mockAddLesson = vi.fn();
const mockLoadLessons = vi.fn(() => []);
const mockRemoveLessons = vi.fn(() => 0);
vi.mock("../goal/lessons.js", () => ({
  addLesson: (...args: unknown[]) => mockAddLesson(...args),
  loadLessons: (...args: unknown[]) => mockLoadLessons(...args),
  removeLessons: (...args: unknown[]) => mockRemoveLessons(...args),
}));

const mockResolveClaudeBinary = vi.fn();
vi.mock("../goal/scout.js", () => ({
  resolveClaudeBinary: (...args: unknown[]) => mockResolveClaudeBinary(...args),
}));

const mockRunCliProcess = vi.hoisted(() => vi.fn());
vi.mock("../goal/cli-process.js", () => ({
  runCliProcess: (...args: unknown[]) => mockRunCliProcess(...args),
}));

vi.mock("../goal/backend-availability.js", () => ({
  getCodexAskForApprovalPlacement: () => "before_exec",
}));

import {
  NIGHTWATCH_DEFAULTS,
  NIGHTWATCH_JOB_NAME,
  buildClaudeCondensePrompt,
  buildLessonCondensePrompt,
  buildNightwatchPrompt,
  checkGitChanges,
  expandTilde,
  normalizeCondensedLesson,
  pruneAndCondenseLessons,
  runCodexLessonCondense,
  registerNightwatchJob,
  runNightwatch,
} from "./nightwatch.js";

const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

const mockHandleGoal = vi.fn();
const mockSendGoalPlanResult = vi.fn();
const mockCreateCaptureRuntime = vi.fn(() => ({
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));
vi.mock("../telegram/goal-commands.js", () => ({
  handleGoal: (...args: unknown[]) => mockHandleGoal(...args),
  sendGoalPlanResult: (...args: unknown[]) => mockSendGoalPlanResult(...args),
  createCaptureRuntime: (...args: unknown[]) => mockCreateCaptureRuntime(...args),
}));

const mockResolveTelegramAccount = vi.fn();
vi.mock("../telegram/accounts.js", () => ({
  resolveTelegramAccount: (...args: unknown[]) => mockResolveTelegramAccount(...args),
}));

const mockBotCtor = vi.fn();
vi.mock("grammy", () => ({
  Bot: class {
    readonly token: string;
    readonly api: Record<string, never>;
    constructor(token: string) {
      this.token = token;
      this.api = {};
      mockBotCtor(token);
    }
  },
}));

function mockExecSuccess(stdout: string) {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: { encoding?: string },
      cb: (error: Error | null, stdout: string) => void,
    ) => cb(null, stdout),
  );
}

function makeResolvedAccount(overrides?: Partial<{ token: string; accountId: string }>) {
  return {
    accountId: overrides?.accountId ?? "default",
    enabled: true,
    token: overrides?.token ?? "telegram-token",
    tokenSource: "config" as const,
    config: {},
  };
}

function makeCronServiceMocks() {
  const list = vi.fn(async () => []);
  const add = vi.fn(async () => ({ id: "new-id" }));
  const update = vi.fn(async () => ({}));
  const remove = vi.fn(async () => ({ ok: true, removed: true }));
  const cronService = { list, add, update, remove };
  return { cronService, list, add, update, remove };
}

describe("nightwatch cron", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(os, "homedir").mockReturnValue("/home/tester");
    mockLoadLessons.mockReturnValue([]);
    mockRemoveLessons.mockReturnValue(0);
    mockResolveClaudeBinary.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("expandTilde", () => {
    it("expands home-relative paths", () => {
      expect(expandTilde("~/moltbot")).toBe("/home/tester/moltbot");
    });

    it("returns absolute paths unchanged", () => {
      expect(expandTilde("/absolute/path")).toBe("/absolute/path");
    });

    it("returns empty string unchanged", () => {
      expect(expandTilde("")).toBe("");
    });
  });

  describe("checkGitChanges", () => {
    it("returns hasChanges=true when git log has commits", async () => {
      mockExecSuccess("abc123 commit message\n");

      const result = await checkGitChanges("/repo", "2026-02-18T00:00:00.000Z");

      expect(result).toEqual({
        hasChanges: true,
        summary: "abc123 commit message",
      });
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["-C", "/repo", "log", "--since=2026-02-18T00:00:00.000Z", "--oneline"],
        { encoding: "utf8" },
        expect.any(Function),
      );
    });

    it("returns hasChanges=false when git log is empty", async () => {
      mockExecSuccess("\n");

      const result = await checkGitChanges("/repo", "2026-02-18T00:00:00.000Z");

      expect(result).toEqual({
        hasChanges: false,
        summary: "",
      });
    });

    it("uses a 24h baseline when sinceIso is empty", async () => {
      mockExecSuccess("");

      await checkGitChanges("/repo", "");

      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["-C", "/repo", "log", "--since=24h", "--oneline"],
        { encoding: "utf8" },
        expect.any(Function),
      );
    });

    it("expands ~ paths before git call", async () => {
      mockExecSuccess("");

      await checkGitChanges("~/moltbot", "2026-02-18T00:00:00.000Z");

      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["-C", "/home/tester/moltbot", "log", "--since=2026-02-18T00:00:00.000Z", "--oneline"],
        { encoding: "utf8" },
        expect.any(Function),
      );
    });
  });

  describe("buildNightwatchPrompt", () => {
    it("contains required planning instructions", () => {
      const prompt = buildNightwatchPrompt();
      expect(prompt).toContain("Nightwatch nightly review");
      expect(prompt).toContain("/new_goal workflow");
      expect(prompt).toContain("Telegram UX integration");
      expect(prompt).toContain("Architecture simplification");
      expect(prompt).toContain("Cross-workflow consistency");
      expect(prompt).toContain(
        "Find and prioritize similar patterns where one workflow already has a good practice",
      );
      expect(prompt).not.toContain("done-message callbacks (gTD/gIF) do not add reactions");
      expect(prompt).toContain("Security concerns");
      expect(prompt).toContain("src/security/audit.ts");
      expect(prompt).toContain("OWASP Top 10");
    });

    it("references existing key files and includes current goal architecture files", () => {
      const prompt = buildNightwatchPrompt();
      const keyFilePaths = prompt
        .split("\n")
        .filter((line) => line.startsWith("Key files: "))
        .flatMap((line) =>
          line
            .slice("Key files: ".length)
            .split(", ")
            .map((entry) => entry.replace(/\.$/, "")),
        );

      expect(keyFilePaths).toContain("src/goal/claude-code-constants.ts");
      expect(keyFilePaths).toContain("src/goal/llm-client.ts");

      for (const filePath of keyFilePaths) {
        expect(
          fs.existsSync(path.resolve(process.cwd(), filePath)),
          `${filePath} should exist on disk`,
        ).toBe(true);
      }
    });
  });

  describe("lesson condensation prompt", () => {
    it("contains two-phase categorize-then-act instructions and scope schema", () => {
      const prompt = buildLessonCondensePrompt("/repo/project", [
        {
          id: "lesson-1",
          workingDir: "/repo/project",
          pattern: "old-pattern",
          lesson: "Old lesson text",
          source: "worker",
          runId: "run-1",
          createdAt: "2026-03-01T00:00:00.000Z",
        },
      ]);

      expect(prompt).toContain("Use a required two-phase process:");
      expect(prompt).toContain("Phase 1 — Categorize every input lesson");
      expect(prompt).toContain("already-fixed-bug");
      expect(prompt).toContain("flaky-path-workaround");
      expect(prompt).toContain("cant-control");
      expect(prompt).toContain("genuine");
      expect(prompt).toContain("Phase 2 — Act on each category:");
      expect(prompt).toContain("already-fixed-bug: delete.");
      expect(prompt).toContain("flaky-path-workaround: delete.");
      expect(prompt).toContain("cant-control: delete.");
      expect(prompt).toContain("genuine: keep, classify scope, and merge duplicates.");
      expect(prompt).toContain('"scope":"global|project"');
    });

    it("requires Claude JSON output schema with scope", () => {
      const prompt = buildClaudeCondensePrompt("summarize lessons");
      expect(prompt).toContain('"scope":"global|project"');
    });

    it("normalizes scope and defaults to project when missing/invalid", () => {
      const validIds = new Set(["lesson-1"]);

      const global = normalizeCondensedLesson(
        {
          pattern: "cross-project",
          lesson: "Use deterministic tests for flaky integrations.",
          scope: "global",
          sourceLessonIds: ["lesson-1"],
        },
        validIds,
      );
      expect(global?.scope).toBe("global");
      expect(global?.sourceLessonIds).toEqual(["lesson-1"]);

      const projectDefault = normalizeCondensedLesson(
        {
          pattern: "repo-specific",
          lesson: "Prefer this repo's shared helper for command execution.",
          scope: "invalid",
          sourceLessonIds: ["lesson-1"],
        },
        validIds,
      );
      expect(projectDefault?.scope).toBe("project");
    });
  });

  describe("pruneAndCondenseLessons", () => {
    it("strips forbidden credential env keys from Codex lesson condense", async () => {
      const forbiddenKeys = [
        "TELEGRAM_BOT_TOKEN",
        "SMITHERSBOT_GATEWAY_TOKEN",
        "CLAWDBOT_GATEWAY_TOKEN",
        "MOLTBOT_GATEWAY_TOKEN",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GITHUB_TOKEN",
      ];
      for (const key of forbiddenKeys) {
        vi.stubEnv(key, `${key.toLowerCase()}-secret`);
      }
      mockRunCliProcess.mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: JSON.stringify({
          lessons: [
            {
              pattern: "condensed",
              lesson: "condensed lesson",
              scope: "project",
              sourceLessonIds: ["lesson-1"],
            },
          ],
        }),
        stderr: "",
      });

      await runCodexLessonCondense({
        workingDir: "/repo/a",
        prompt: "Condense lessons.",
        validIds: new Set(["lesson-1"]),
      });

      expect(mockRunCliProcess).toHaveBeenCalledOnce();
      const env = mockRunCliProcess.mock.calls[0]?.[0]?.env as Record<string, string | undefined>;
      for (const key of forbiddenKeys) {
        expect(env).not.toHaveProperty(key);
      }
    });

    it("caps project lessons per workingDir and global lessons across all directories", async () => {
      mockLoadLessons.mockReturnValue([
        {
          id: "a-1",
          workingDir: "/repo/a",
          pattern: "a-pattern-1",
          lesson: "a lesson 1",
          source: "worker",
          runId: "run-a",
          createdAt: "2026-03-01T00:00:00.000Z",
        },
        {
          id: "a-2",
          workingDir: "/repo/a",
          pattern: "a-pattern-2",
          lesson: "a lesson 2",
          source: "worker",
          runId: "run-a",
          createdAt: "2026-03-01T00:01:00.000Z",
        },
        {
          id: "b-1",
          workingDir: "/repo/b",
          pattern: "b-pattern-1",
          lesson: "b lesson 1",
          source: "worker",
          runId: "run-b",
          createdAt: "2026-03-01T00:02:00.000Z",
        },
        {
          id: "b-2",
          workingDir: "/repo/b",
          pattern: "b-pattern-2",
          lesson: "b lesson 2",
          source: "worker",
          runId: "run-b",
          createdAt: "2026-03-01T00:03:00.000Z",
        },
      ]);
      mockRemoveLessons.mockImplementation((ids: string[]) => ids.length);

      const groupAProject = Array.from({ length: 30 }, (_, index) => ({
        pattern: `a-project-${index + 1}`,
        lesson: `A project lesson ${index + 1}`,
        scope: "project",
        sourceLessonIds: ["a-1"],
      }));
      const groupAGlobal = Array.from({ length: 20 }, (_, index) => ({
        pattern: `a-global-${index + 1}`,
        lesson: `A global lesson ${index + 1}`,
        scope: "global",
        sourceLessonIds: ["a-1"],
      }));
      const groupBProject = Array.from({ length: 30 }, (_, index) => ({
        pattern: `b-project-${index + 1}`,
        lesson: `B project lesson ${index + 1}`,
        scope: "project",
        sourceLessonIds: ["b-1"],
      }));
      const groupBGlobal = Array.from({ length: 20 }, (_, index) => ({
        pattern: `b-global-${index + 1}`,
        lesson: `B global lesson ${index + 1}`,
        scope: "global",
        sourceLessonIds: ["b-1"],
      }));

      const runCodexLessonCondenseMock = vi
        .fn()
        .mockResolvedValueOnce([...groupAProject, ...groupAGlobal])
        .mockResolvedValueOnce([...groupBProject, ...groupBGlobal]);
      await pruneAndCondenseLessons({
        resolveClaudeBinary: () => undefined,
        runCodexLessonCondense: runCodexLessonCondenseMock,
      });

      const savedLessons = mockAddLesson.mock.calls.map((call) => call[0]);
      const projectCountDirA = savedLessons.filter(
        (lesson) => lesson.workingDir === "/repo/a" && lesson.scope === "project",
      ).length;
      const projectCountDirB = savedLessons.filter(
        (lesson) => lesson.workingDir === "/repo/b" && lesson.scope === "project",
      ).length;
      const globalCount = savedLessons.filter((lesson) => lesson.scope === "global").length;

      expect(projectCountDirA).toBe(25);
      expect(projectCountDirB).toBe(25);
      expect(globalCount).toBe(25);
      expect(savedLessons).toHaveLength(75);
      expect(runCodexLessonCondenseMock).toHaveBeenCalledTimes(2);
    });

    it("drops non-genuine categorized lessons before saving", async () => {
      mockLoadLessons.mockReturnValue([
        {
          id: "a-1",
          workingDir: "/repo/a",
          pattern: "a-pattern-1",
          lesson: "a lesson 1",
          source: "worker",
          runId: "run-a",
          createdAt: "2026-03-01T00:00:00.000Z",
        },
      ]);
      mockRemoveLessons.mockImplementation((ids: string[]) => ids.length);
      const runCodexLessonCondenseMock = vi.fn().mockResolvedValueOnce([
        {
          pattern: "keep-genuine",
          lesson: "Keep this lesson.",
          scope: "project",
          category: "genuine",
          sourceLessonIds: ["a-1"],
        },
        {
          pattern: "drop-fixed",
          lesson: "Drop already-fixed lesson.",
          scope: "project",
          category: "already-fixed-bug",
          sourceLessonIds: ["a-1"],
        },
        {
          pattern: "drop-flaky",
          lesson: "Drop flaky workaround.",
          scope: "project",
          category: "flaky-path-workaround",
          sourceLessonIds: ["a-1"],
        },
        {
          pattern: "drop-control",
          lesson: "Drop can't-control guidance.",
          scope: "global",
          category: "cant-control",
          sourceLessonIds: ["a-1"],
        },
      ]);

      await pruneAndCondenseLessons({
        resolveClaudeBinary: () => undefined,
        runCodexLessonCondense: runCodexLessonCondenseMock,
      });

      expect(mockAddLesson).toHaveBeenCalledTimes(1);
      expect(mockAddLesson).toHaveBeenCalledWith(
        expect.objectContaining({
          workingDir: "/repo/a",
          pattern: "keep-genuine",
          scope: "project",
        }),
      );
    });
  });

  describe("NIGHTWATCH_DEFAULTS", () => {
    it("exports expected runtime defaults", () => {
      expect(NIGHTWATCH_DEFAULTS).toEqual({
        cronExpr: "0 3 * * *",
        repoPath: "~/moltbot",
        timezone: "America/New_York",
      });
    });
  });

  describe("registerNightwatchJob", () => {
    it("adds first job and updates existing job on subsequent call", async () => {
      const { cronService, list, add, update } = makeCronServiceMocks();
      list
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: "job-1", name: NIGHTWATCH_JOB_NAME }]);

      await registerNightwatchJob(cronService as never, {
        enabled: true,
        cronExpr: "0 3 * * *",
        timezone: "America/New_York",
      });
      await registerNightwatchJob(cronService as never, {
        enabled: true,
        cronExpr: "30 4 * * *",
        timezone: "America/Chicago",
      });

      expect(add).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({
          name: NIGHTWATCH_JOB_NAME,
          enabled: true,
          schedule: { kind: "cron", expr: "0 3 * * *", tz: "America/New_York" },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "__nightwatch__" },
        }),
      );
      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith("job-1", {
        enabled: true,
        schedule: { kind: "cron", expr: "30 4 * * *", tz: "America/Chicago" },
      });
    });

    it("removes existing jobs when disabled", async () => {
      const { cronService, list, remove, add, update } = makeCronServiceMocks();
      list.mockResolvedValue([
        { id: "job-1", name: NIGHTWATCH_JOB_NAME },
        { id: "job-2", name: NIGHTWATCH_JOB_NAME },
      ]);

      await registerNightwatchJob(cronService as never, { enabled: false });

      expect(remove).toHaveBeenCalledTimes(2);
      expect(remove).toHaveBeenNthCalledWith(1, "job-1");
      expect(remove).toHaveBeenNthCalledWith(2, "job-2");
      expect(add).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it("removes existing jobs when config is undefined", async () => {
      const { cronService, list, remove } = makeCronServiceMocks();
      list.mockResolvedValue([{ id: "job-1", name: NIGHTWATCH_JOB_NAME }]);

      await registerNightwatchJob(cronService as never, undefined);

      expect(remove).toHaveBeenCalledWith("job-1");
    });

    it("treats missing enabled field as disabled and removes jobs", async () => {
      const { cronService, list, remove } = makeCronServiceMocks();
      list.mockResolvedValue([{ id: "job-1", name: NIGHTWATCH_JOB_NAME }]);

      await registerNightwatchJob(cronService as never, {} as NightwatchConfig);

      expect(remove).toHaveBeenCalledWith("job-1");
    });

    it("dedupes multiple jobs and keeps one updated", async () => {
      const { cronService, list, remove, update, add } = makeCronServiceMocks();
      list.mockResolvedValue([
        { id: "job-1", name: NIGHTWATCH_JOB_NAME },
        { id: "job-2", name: NIGHTWATCH_JOB_NAME },
        { id: "job-3", name: NIGHTWATCH_JOB_NAME },
      ]);

      await registerNightwatchJob(cronService as never, {
        enabled: true,
        cronExpr: "45 2 * * *",
        timezone: "America/Denver",
      });

      expect(remove).toHaveBeenCalledTimes(2);
      expect(remove).toHaveBeenNthCalledWith(1, "job-2");
      expect(remove).toHaveBeenNthCalledWith(2, "job-3");
      expect(update).toHaveBeenCalledWith("job-1", {
        enabled: true,
        schedule: { kind: "cron", expr: "45 2 * * *", tz: "America/Denver" },
      });
      expect(add).not.toHaveBeenCalled();
    });

    it("uses defaults when cronExpr/timezone are missing", async () => {
      const { cronService, list, add } = makeCronServiceMocks();
      list.mockResolvedValue([]);

      await registerNightwatchJob(cronService as never, { enabled: true });

      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({
          schedule: {
            kind: "cron",
            expr: NIGHTWATCH_DEFAULTS.cronExpr,
            tz: NIGHTWATCH_DEFAULTS.timezone,
          },
        }),
      );
    });
  });

  describe("runNightwatch", () => {
    const cfg: MoltbotConfig = {};

    it("skips when config is undefined", async () => {
      const result = await runNightwatch({ cfg, nightwatchCfg: undefined });
      expect(result).toEqual({
        status: "skipped",
        summary: "Nightwatch is not configured or disabled",
      });
    });

    it("skips when disabled=false", async () => {
      const result = await runNightwatch({ cfg, nightwatchCfg: { enabled: false } });
      expect(result.status).toBe("skipped");
    });

    it("skips when enabled is absent", async () => {
      const result = await runNightwatch({ cfg, nightwatchCfg: {} });
      expect(result.status).toBe("skipped");
    });

    it("returns error for missing telegramChatId before planning", async () => {
      const result = await runNightwatch({ cfg, nightwatchCfg: { enabled: true } });

      expect(result).toEqual({
        status: "error",
        error: "No Telegram chat target configured. Use /nightwatch chat to set one.",
      });
      expect(mockHandleGoal).not.toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("returns error when account token cannot be resolved before planning", async () => {
      mockResolveTelegramAccount.mockReturnValue(makeResolvedAccount({ token: "" }));

      const result = await runNightwatch({
        cfg,
        nightwatchCfg: { enabled: true, telegramChatId: "12345" },
      });

      expect(result).toEqual({
        status: "error",
        error: "Could not resolve Telegram account token. Check your Telegram configuration.",
      });
      expect(mockHandleGoal).not.toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("skips when no git changes are found", async () => {
      mockResolveTelegramAccount.mockReturnValue(makeResolvedAccount());
      mockExecSuccess("");

      const result = await runNightwatch({
        cfg,
        nightwatchCfg: { enabled: true, telegramChatId: "12345" },
      });

      expect(result).toEqual({
        status: "skipped",
        summary: "No git changes since last run",
      });
      expect(mockHandleGoal).not.toHaveBeenCalled();
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["-C", "/home/tester/moltbot", "log", expect.stringMatching(/^--since=/), "--oneline"],
        { encoding: "utf8" },
        expect.any(Function),
      );
    });

    it("runs planning and Telegram delivery when changes are detected", async () => {
      mockResolveTelegramAccount.mockReturnValue(makeResolvedAccount({ token: "night-token" }));
      mockExecSuccess("abc123 init\n");
      const goalPlanResult = {
        text: "plan text",
        runId: "12345678-1234-1234-1234-123456789012",
        revision: 1,
      };
      mockHandleGoal.mockResolvedValue(goalPlanResult);
      const lastRunAtMs = Date.parse("2026-02-18T03:00:00.000Z");

      const result = await runNightwatch({
        cfg,
        nightwatchCfg: {
          enabled: true,
          telegramChatId: 123456,
          telegramThreadId: 88,
        },
        lastRunAtMs,
      });

      expect(result).toEqual({
        status: "ok",
        summary: "Plan delivered to Telegram",
      });
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["-C", "/home/tester/moltbot", "log", "--since=2026-02-18T03:00:00.000Z", "--oneline"],
        { encoding: "utf8" },
        expect.any(Function),
      );
      expect(mockHandleGoal).toHaveBeenCalledTimes(1);
      expect(mockHandleGoal).toHaveBeenCalledWith(
        expect.stringContaining("Nightwatch nightly review"),
        cfg,
      );
      expect(mockBotCtor).toHaveBeenCalledWith("night-token");
      expect(mockSendGoalPlanResult).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 123456,
          threadId: 88,
          result: goalPlanResult,
        }),
      );
    });
  });
});
