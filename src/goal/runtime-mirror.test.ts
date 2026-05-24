import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyRuntimeMirrorSkip,
  mirrorCronRuntimeToAgentHistory,
  mirrorGoalRuntimeToAgentHistory,
  redactRuntimeMirrorText,
  RUNTIME_MIRROR_REDACTION,
  RUNTIME_MIRROR_TRUNCATION_MARKER,
  type RuntimeMirrorIndex,
} from "./runtime-mirror.js";

describe("runtime mirror", () => {
  let tmpDir: string;
  let originalManagedRoot: string | undefined;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "smithersbot-runtime-mirror-"));
    originalManagedRoot = process.env.SMITHERSBOT_GOALS_ROOT;
    originalApiKey = process.env.SMITHERSBOT_RUNTIME_MIRROR_API_KEY;
    process.env.SMITHERSBOT_GOALS_ROOT = path.join(tmpDir, "managed");
    process.env.SMITHERSBOT_RUNTIME_MIRROR_API_KEY = "PLANTED_RUNTIME_MIRROR_ENV_SECRET";
  });

  afterEach(() => {
    if (originalManagedRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
    else process.env.SMITHERSBOT_GOALS_ROOT = originalManagedRoot;
    if (originalApiKey === undefined) delete process.env.SMITHERSBOT_RUNTIME_MIRROR_API_KEY;
    else process.env.SMITHERSBOT_RUNTIME_MIRROR_API_KEY = originalApiKey;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeText(filePath: string, value: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, value, "utf8");
  }

  function readIndex(filePath: string): RuntimeMirrorIndex {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as RuntimeMirrorIndex;
  }

  it("redacts planted secrets, private key blocks, secret key/value pairs, and sensitive host paths", () => {
    const privatePath = path.join(process.env.SMITHERSBOT_GOALS_ROOT!, "private", "auth", "codex");
    const redacted = redactRuntimeMirrorText(
      [
        "token=PLANTED_RUNTIME_MIRROR_ENV_SECRET",
        "apiKey: should-not-survive",
        "github=ghp_FAKEGITHUBTOKEN12345678901234567890",
        "jwt=eyJaaaaaaaaaaa.bbbbbbbbbbbbb.ccccccccccccc",
        "-----BEGIN PRIVATE KEY-----",
        "abc123",
        "-----END PRIVATE KEY-----",
        `auth path ${privatePath}`,
        "repo path /workspaces/smithersbot/repo/src/goal/runtime-mirror.ts",
      ].join("\n"),
      { secretValues: ["should-not-survive"] },
    );

    expect(redacted.text).not.toContain("PLANTED_RUNTIME_MIRROR_ENV_SECRET");
    expect(redacted.text).not.toContain("should-not-survive");
    expect(redacted.text).not.toContain("FAKEGITHUBTOKEN");
    expect(redacted.text).not.toContain("BEGIN PRIVATE KEY");
    expect(redacted.text).not.toContain(privatePath);
    expect(redacted.text).toContain(RUNTIME_MIRROR_REDACTION);
    expect(redacted.text).toContain("/workspaces/smithersbot/repo/src/goal/runtime-mirror.ts");
    expect(redacted.redactionCount).toBeGreaterThanOrEqual(5);
  });

  it("mirrors goal runtime artifacts with directory shape and redacted index metadata", () => {
    const goalsDir = path.join(tmpDir, "runtime", "goals");
    const runDir = path.join(goalsDir, "goal-1");
    const destinationDir = path.join(tmpDir, "agent-history", "runtime");
    const plantedSecret = "PLANTED_RUNTIME_MIRROR_FILE_SECRET";

    writeText(
      path.join(runDir, "run.json"),
      JSON.stringify({ goal: "test", token: plantedSecret }),
    );
    writeText(path.join(runDir, "WORKING.md"), "working notes");
    writeText(path.join(runDir, "scout", "report.md"), "safe repo path src/goal/runtime-mirror.ts");
    writeText(path.join(runDir, "autocheck", "round-1.json"), '{"status":"approved"}');
    writeText(path.join(runDir, "workers", "task-a", "attempt-1", "stdout.txt"), plantedSecret);
    writeText(path.join(runDir, "workers", "task-a", "attempt-1", "stderr.txt"), "stderr");
    writeText(path.join(runDir, "manual-tests", "tests.json"), '{"tests":[]}');
    writeText(path.join(runDir, "lessons", "summary.json"), '{"lessons":[]}');

    const index = mirrorGoalRuntimeToAgentHistory({
      workspaceName: "smithersbot",
      goalId: "goal-1",
      goalsDir,
      destinationDir,
      secretValues: [plantedSecret],
    });

    const expectedFiles = [
      "run.json",
      "WORKING.md",
      "scout/report.md",
      "autocheck/round-1.json",
      "workers/task-a/attempt-1/stdout.txt",
      "workers/task-a/attempt-1/stderr.txt",
      "manual-tests/tests.json",
      "lessons/summary.json",
    ];
    for (const relativePath of expectedFiles) {
      expect(fs.existsSync(path.join(destinationDir, relativePath))).toBe(true);
    }
    const mirroredText = fs.readFileSync(
      path.join(destinationDir, "workers/task-a/attempt-1/stdout.txt"),
      "utf8",
    );
    expect(mirroredText).not.toContain(plantedSecret);
    expect(mirroredText).toContain(RUNTIME_MIRROR_REDACTION);

    expect(index.entries.map((entry) => entry.relativePath).sort()).toEqual(expectedFiles.sort());
    const workerEntry = index.entries.find(
      (entry) => entry.relativePath === "workers/task-a/attempt-1/stdout.txt",
    );
    expect(workerEntry).toMatchObject({
      category: "workers",
      skipped: false,
      redactionCount: 1,
      sourceKind: "goal-runtime",
    });
    expect(
      index.entries.find((entry) => entry.relativePath === "manual-tests/tests.json"),
    ).toMatchObject({
      category: "manual-tests",
      skipped: false,
      sourceKind: "goal-runtime",
    });
    expect(
      index.entries.find((entry) => entry.relativePath === "lessons/summary.json"),
    ).toMatchObject({
      category: "lessons",
      skipped: false,
      sourceKind: "goal-runtime",
    });
    expect(readIndex(path.join(destinationDir, "index.json")).entries).toHaveLength(
      expectedFiles.length,
    );
  });

  it("mirrors large below-cap files fully and truncates over-cap files with head and tail", () => {
    const runDir = path.join(tmpDir, "runtime", "goals", "goal-2");
    const destinationDir = path.join(tmpDir, "agent-history", "runtime");
    const belowCap = `${"a".repeat(512)}SAFE_TAIL`;
    const overCap = `${"HEAD".repeat(200)}${"MIDDLE".repeat(600)}${"TAIL".repeat(200)}`;
    writeText(path.join(runDir, "workers", "task", "below-stdout.txt"), belowCap);
    writeText(path.join(runDir, "workers", "task", "over-stdout.txt"), overCap);

    const index = mirrorGoalRuntimeToAgentHistory({
      workspaceName: "smithersbot",
      goalId: "goal-2",
      sourceDir: runDir,
      destinationDir,
      caps: { textJsonBytes: 2048, streamBytes: 2048, hardBytes: 2048 },
    });

    expect(
      fs.readFileSync(path.join(destinationDir, "workers/task/below-stdout.txt"), "utf8"),
    ).toBe(belowCap);
    const truncated = fs.readFileSync(
      path.join(destinationDir, "workers/task/over-stdout.txt"),
      "utf8",
    );
    expect(truncated).toContain("HEAD");
    expect(truncated).toContain("TAIL");
    expect(truncated).toContain(RUNTIME_MIRROR_TRUNCATION_MARKER.trim());
    expect(
      index.entries.find((entry) => entry.relativePath.endsWith("below-stdout.txt"))?.truncated,
    ).toBe(false);
    expect(
      index.entries.find((entry) => entry.relativePath.endsWith("over-stdout.txt"))?.truncated,
    ).toBe(true);
  });

  it("skips backup, binary, lock, database, and forbidden filename patterns", () => {
    const runDir = path.join(tmpDir, "runtime", "goals", "goal-3");
    const destinationDir = path.join(tmpDir, "agent-history", "runtime");
    writeText(path.join(runDir, "run.json"), '{"ok":true}');
    writeText(path.join(runDir, "workers", "old.log.bak"), "backup");
    writeText(path.join(runDir, "workers", "state.db"), "db");
    writeText(path.join(runDir, "workers", "attempt.lock"), "lock");
    fs.mkdirSync(path.join(runDir, "workers"), { recursive: true });
    fs.writeFileSync(path.join(runDir, "workers", "blob.bin"), Buffer.from([0, 1, 2, 3, 0]));

    const index = mirrorGoalRuntimeToAgentHistory({
      workspaceName: "smithersbot",
      goalId: "goal-3",
      sourceDir: runDir,
      destinationDir,
    });

    expect(classifyRuntimeMirrorSkip("credentials-prod.json")).toBe("forbidden file");
    expect(classifyRuntimeMirrorSkip(".env.local")).toBe("forbidden file");
    expect(fs.existsSync(path.join(destinationDir, "workers/old.log.bak"))).toBe(false);
    expect(fs.existsSync(path.join(destinationDir, "workers/state.db"))).toBe(false);
    expect(fs.existsSync(path.join(destinationDir, "workers/attempt.lock"))).toBe(false);
    expect(fs.existsSync(path.join(destinationDir, "workers/blob.bin"))).toBe(false);
    expect(index.entries.filter((entry) => entry.skipped)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: "workers/old.log.bak", skipReason: "backup file" }),
        expect.objectContaining({ relativePath: "workers/state.db", skipReason: "database file" }),
        expect.objectContaining({ relativePath: "workers/attempt.lock", skipReason: "lock file" }),
        expect.objectContaining({ relativePath: "workers/blob.bin", skipReason: "binary file" }),
      ]),
    );
  });

  it("mirrors cron jobs and run logs while excluding backup files from copied output", () => {
    const cronDir = path.join(tmpDir, "runtime", "cron");
    const destinationDir = path.join(tmpDir, "agent-history", "cron");
    const plantedSecret = "PLANTED_CRON_MIRROR_SECRET";
    writeText(
      path.join(cronDir, "jobs.json"),
      JSON.stringify({ jobs: [{ id: "job-1", token: plantedSecret }] }),
    );
    writeText(path.join(cronDir, "jobs.json.bak"), "backup");
    writeText(path.join(cronDir, "runs", "job-1.jsonl"), `{"summary":"${plantedSecret}"}\n`);
    writeText(path.join(cronDir, "runs", "job-1.jsonl.bak"), "backup");
    writeText(path.join(cronDir, "unrelated.txt"), "ignore");

    const index = mirrorCronRuntimeToAgentHistory({
      storePath: path.join(cronDir, "jobs.json"),
      destinationDir,
      secretValues: [plantedSecret],
    });

    expect(fs.existsSync(path.join(destinationDir, "jobs.json"))).toBe(true);
    expect(fs.existsSync(path.join(destinationDir, "runs/job-1.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(destinationDir, "jobs.json.bak"))).toBe(false);
    expect(fs.existsSync(path.join(destinationDir, "runs/job-1.jsonl.bak"))).toBe(false);
    expect(fs.existsSync(path.join(destinationDir, "unrelated.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(destinationDir, "jobs.json"), "utf8")).not.toContain(
      plantedSecret,
    );
    expect(fs.readFileSync(path.join(destinationDir, "runs/job-1.jsonl"), "utf8")).toContain(
      RUNTIME_MIRROR_REDACTION,
    );
    expect(index.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: "jobs.json",
          category: "cron-jobs",
          skipped: false,
        }),
        expect.objectContaining({
          relativePath: "runs/job-1.jsonl",
          category: "cron-runs",
          skipped: false,
        }),
        expect.objectContaining({
          relativePath: "runs/job-1.jsonl.bak",
          skipped: true,
          skipReason: "backup file",
        }),
      ]),
    );
  });

  it("mirrors cron jobs and writes an index when no run logs exist yet", () => {
    const cronDir = path.join(tmpDir, "runtime", "cron-no-runs");
    const destinationDir = path.join(tmpDir, "agent-history", "cron-no-runs");
    writeText(path.join(cronDir, "jobs.json"), JSON.stringify({ version: 1, jobs: [] }));
    writeText(path.join(cronDir, "jobs.json.bak"), "backup");
    writeText(path.join(cronDir, "unrelated.txt"), "ignore");

    const index = mirrorCronRuntimeToAgentHistory({
      storePath: path.join(cronDir, "jobs.json"),
      destinationDir,
    });

    expect(fs.existsSync(path.join(destinationDir, "index.json"))).toBe(true);
    expect(fs.existsSync(path.join(destinationDir, "jobs.json"))).toBe(true);
    expect(fs.existsSync(path.join(destinationDir, "jobs.json.bak"))).toBe(false);
    expect(fs.existsSync(path.join(destinationDir, "unrelated.txt"))).toBe(false);
    expect(fs.existsSync(path.join(destinationDir, "runs"))).toBe(false);
    expect(index.entries).toEqual([
      expect.objectContaining({
        relativePath: "jobs.json",
        kind: "cron-jobs",
        category: "cron-jobs",
        sourceKind: "cron-runtime",
        skipped: false,
        truncated: false,
      }),
    ]);
    expect(readIndex(path.join(destinationDir, "index.json")).entries).toHaveLength(1);
  });
});
