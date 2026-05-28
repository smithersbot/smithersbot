import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { buildSystemdUnit, parseSystemdExecStart } from "./systemd-unit.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("parseSystemdExecStart", () => {
  it("splits on whitespace outside quotes", () => {
    const execStart = "/usr/bin/moltbot gateway start --foo bar";
    expect(parseSystemdExecStart(execStart)).toEqual([
      "/usr/bin/moltbot",
      "gateway",
      "start",
      "--foo",
      "bar",
    ]);
  });

  it("preserves quoted arguments", () => {
    const execStart = '/usr/bin/moltbot gateway start --name "My Bot"';
    expect(parseSystemdExecStart(execStart)).toEqual([
      "/usr/bin/moltbot",
      "gateway",
      "start",
      "--name",
      "My Bot",
    ]);
  });

  it("parses path arguments", () => {
    const execStart = "/usr/bin/moltbot gateway start --path /tmp/moltbot";
    expect(parseSystemdExecStart(execStart)).toEqual([
      "/usr/bin/moltbot",
      "gateway",
      "start",
      "--path",
      "/tmp/moltbot",
    ]);
  });
});

describe("buildSystemdUnit", () => {
  it("renders gateway unit resilience settings while preserving runtime details", () => {
    const unit = buildSystemdUnit({
      description: "SmithersBot gateway",
      programArguments: ["/usr/bin/node", "scripts/run-node.mjs", "gateway"],
      workingDirectory: "/Users/test/smithersbot repo",
      environment: {
        CLAWDBOT_PORT: "19001",
        CLAWDBOT_TS_COMPILER: "tsc",
        EMPTY_VALUE: "",
      },
    });

    const execStart = unit.match(/^ExecStart=(.+)$/m)?.[1] ?? "";

    expect(unit).toContain("Description=SmithersBot gateway\n");
    expect(parseSystemdExecStart(execStart)).toEqual([
      "/usr/bin/node",
      "scripts/run-node.mjs",
      "gateway",
    ]);
    expect(unit).toContain('WorkingDirectory="/Users/test/smithersbot repo"\n');
    expect(unit).toContain("Environment=CLAWDBOT_PORT=19001\n");
    expect(unit).toContain('Environment="CLAWDBOT_TS_COMPILER=tsc"\n');
    expect(unit).not.toContain("EMPTY_VALUE");
    expect(unit).toContain("Restart=always\n");
    expect(unit).toContain("RestartSec=5\n");
    expect(unit).toContain("KillMode=mixed\n");
    expect(unit).not.toContain("KillMode=process");
  });
});

describe("install-smithersbot-user-service.sh", () => {
  it("dry-runs the same safe user service settings without touching systemd", async () => {
    const { stdout } = await execFileAsync(
      "bash",
      ["scripts/install-smithersbot-user-service.sh", "--dry-run"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: "/Users/test",
          PATH: process.env.PATH,
        },
        encoding: "utf8",
      },
    );

    expect(stdout).toContain(
      "Dry run: would write /Users/test/.config/systemd/user/smithersbot-gateway.service",
    );
    expect(stdout).toContain("Description=SmithersBot gateway\n");
    expect(stdout).toContain("EnvironmentFile=%h/.smithersbot/.env\n");
    expect(stdout).toContain(`WorkingDirectory=${repoRoot}\n`);
    expect(stdout).toContain("ExecStart=");
    expect(stdout).toContain(" scripts/run-node.mjs gateway\n");
    expect(stdout).toContain("Restart=always\n");
    expect(stdout).toContain("RestartSec=5\n");
    expect(stdout).toContain("KillMode=mixed\n");
    expect(stdout).not.toContain("Restart=on-failure");
    expect(stdout).not.toContain("moltbot-gateway-dev.service");
  });
});
