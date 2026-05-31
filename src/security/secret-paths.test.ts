import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfigIO } from "../config/config.js";
import {
  isSecretPath,
  redactSecretValues,
  SECRET_PATH_DENY_REASON,
  SECRET_PATH_PATTERNS,
} from "./secret-paths.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smithersbot-secret-paths-"));
  tmpDirs.push(tmp);
  return tmp;
}

afterEach(() => {
  for (const tmp of tmpDirs.splice(0)) {
    fs.rmSync(tmp, { force: true, recursive: true });
  }
});

describe("secret paths", () => {
  it("exports shared deny metadata", () => {
    expect(SECRET_PATH_DENY_REASON).toContain("local secret/config file");
    expect(SECRET_PATH_PATTERNS).toContain("~/.smithersbot/**");
    expect(SECRET_PATH_PATTERNS).toContain("~/.codex/**");
    expect(SECRET_PATH_PATTERNS).toContain("*.pem");
    // Dev-instance private roots must be covered too (Issue 2 from the
    // stable-to-dev isolation verification).
    expect(SECRET_PATH_PATTERNS).toContain("~/.smithersbot-dev/**");
    expect(SECRET_PATH_PATTERNS).toContain("~/smithersbot-dev-home/private/**");
  });

  it.each([
    "~/.smithersbot/.env",
    "~/.smithersbot/smithersbot.json",
    "~/.smithersbot/credentials/oauth.json",
    "~/.smithersbot/sessions/abc.json",
    "~/.moltbot/.env",
    "~/.moltbot/moltbot.json",
    "~/.clawdbot/.env",
    "~/.clawdbot/clawdbot.json",
    "~/.clawdbot/credentials/oauth.json",
    "~/.clawdbot-dev/.env",
    "~/.smithersbot-dev/smithersbot.json",
    "~/.smithersbot-dev/sessions/abc.json",
    "~/smithersbot-dev-home/private/env/ws/.env",
    "~/smithersbot-dev-home/private/config/config.json",
    "~/smithersbot-dev-home/private/auth/auth.json",
    "~/smithersbot-dev-home/private/sessions/session.json",
    "~/.claude/settings.json",
    "~/.codex/config.toml",
  ])("blocks canonical and legacy home config path %s", (filePath) => {
    const homeDir = makeTmpDir();
    expect(isSecretPath(filePath, { homeDir })).toBe(true);
  });

  it.each([
    "smithersbot-dev-home/agent/workspaces/smithersbot-dev/src/index.ts",
    "smithersbot-dev-home/agent/history/goals/run.md",
    "smithersbot-dev-home/agent/history/repo-chats/chat.md",
  ])("keeps dev agent-visible surface readable %s", (relativePath) => {
    const homeDir = makeTmpDir();
    expect(isSecretPath(`~/${relativePath}`, { homeDir })).toBe(false);
  });

  it.each([
    ".env",
    ".env.production",
    "app.env",
    "nested/.env",
    "nested/.env.local",
    "smithersbot.json",
    "moltbot.json",
    "clawdbot.json",
    "goal-lessons.json",
    "oauth.json",
    "credentials.json",
    "credentials-prod.json",
    "session.token",
    ".npmrc",
    ".pypirc",
    ".netrc",
    ".git-credentials",
    "service-account.json",
    "service-account-prod.json",
    "gcloud.json",
    "gcloud-prod.json",
    "terraform.tfvars",
    ".tfstate",
    "kubeconfig",
  ])("blocks repo-local secret file pattern %s", (filePath) => {
    const cwd = makeTmpDir();
    expect(isSecretPath(filePath, { cwd, homeDir: makeTmpDir() })).toBe(true);
  });

  it.each([
    "id_rsa",
    "id_rsa.pub",
    "backup-id_ed25519",
    "id_ecdsa_work",
    "prod_id_dsa_key",
    "server.pem",
    "server.key",
    "server.crt",
    "server.cer",
    "server.p12",
    "server.pfx",
    "truststore.jks",
    "client.keystore",
  ])("blocks private key and certificate pattern %s", (filePath) => {
    const cwd = makeTmpDir();
    expect(isSecretPath(filePath, { cwd, homeDir: makeTmpDir() })).toBe(true);
  });

  it.each([".ssh/config", ".gnupg/pubring.kbx", ".aws/credentials"])(
    "blocks sensitive config directory %s",
    (filePath) => {
      const cwd = makeTmpDir();
      expect(isSecretPath(filePath, { cwd, homeDir: makeTmpDir() })).toBe(true);
    },
  );

  it("blocks symlinked leaf secret files", () => {
    const cwd = makeTmpDir();
    const target = path.join(cwd, ".env");
    const link = path.join(cwd, "linked-env");
    fs.writeFileSync(target, "PLACEHOLDER_SECRET=1");
    fs.symlinkSync(target, link);

    expect(isSecretPath(link, { cwd, homeDir: makeTmpDir() })).toBe(true);
  });

  it("blocks parent symlinks into protected home config directories", () => {
    const homeDir = makeTmpDir();
    const cwd = makeTmpDir();
    const smithersbotDir = path.join(homeDir, ".smithersbot");
    const link = path.join(cwd, "jail");
    fs.mkdirSync(smithersbotDir, { recursive: true });
    fs.symlinkSync(smithersbotDir, link);

    expect(isSecretPath(path.join(link, ".env"), { cwd, homeDir })).toBe(true);
  });

  it.each(["README.md", "SETUP.md", "AGENTS.md", "package.json"])(
    "does not block safe repo file %s",
    (filePath) => {
      const cwd = makeTmpDir();
      expect(isSecretPath(filePath, { cwd, homeDir: makeTmpDir() })).toBe(false);
    },
  );

  it.each([".env.example", "nested/.env.example", "subdir/repo/.env.example", ".ENV.EXAMPLE"])(
    "allows the .env.example variable-name contract %s",
    (filePath) => {
      const cwd = makeTmpDir();
      expect(isSecretPath(filePath, { cwd, homeDir: makeTmpDir() })).toBe(false);
    },
  );

  it.each([".env", ".env.local", ".env.production", ".env.test"])(
    "still denies %s even though .env.example is allowed",
    (filePath) => {
      const cwd = makeTmpDir();
      expect(isSecretPath(filePath, { cwd, homeDir: makeTmpDir() })).toBe(true);
    },
  );
});

describe("secret value redaction", () => {
  it("redacts explicit known secret values", () => {
    const redacted = redactSecretValues(
      ["telegram=FAKE_TELEGRAM_SECRET_123", "gateway=FAKE_GATEWAY_SECRET_456", "safe=visible"].join(
        "\n",
      ),
      {
        secretValues: ["FAKE_TELEGRAM_SECRET_123", "FAKE_GATEWAY_SECRET_456"],
      },
    );

    expect(redacted).toContain("telegram=[REDACTED]");
    expect(redacted).toContain("gateway=[REDACTED]");
    expect(redacted).toContain("safe=visible");
    expect(redacted).not.toContain("FAKE_TELEGRAM_SECRET_123");
    expect(redacted).not.toContain("FAKE_GATEWAY_SECRET_456");
  });

  it("redacts documented provider token prefixes without redacting git shas", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const redacted = redactSecretValues(
      [
        `sha=${sha}`,
        "openai=sk-FAKE_TELEGRAM_SECRET_123",
        "github=ghp_FAKEGITHUBSECRET1234567890",
        "slack=xoxb-1234567890-abcdefghi",
        "aws=AKIA1234567890ABCDEF",
        "jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturepart",
      ].join("\n"),
    );

    expect(redacted).toContain(`sha=${sha}`);
    expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(5);
    expect(redacted).not.toContain("sk-FAKE_TELEGRAM_SECRET_123");
    expect(redacted).not.toContain("ghp_FAKEGITHUBSECRET1234567890");
    expect(redacted).not.toContain("xoxb-1234567890-abcdefghi");
    expect(redacted).not.toContain("AKIA1234567890ABCDEF");
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("leaves gateway config loading unchanged when redaction is not invoked", () => {
    const homeDir = makeTmpDir();
    const configPath = path.join(makeTmpDir(), "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        gateway: {
          auth: {
            mode: "token",
            token: "FAKE_GATEWAY_SECRET_456",
          },
        },
      }),
    );

    const cfg = createConfigIO({
      configPath,
      env: {},
      homedir: () => homeDir,
      logger: {
        error: () => undefined,
        warn: () => undefined,
      },
    }).loadConfig();

    expect(cfg.gateway?.auth?.token).toBe("FAKE_GATEWAY_SECRET_456");
  });
});
