import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSecretPath, SECRET_PATH_DENY_REASON, SECRET_PATH_PATTERNS } from "./secret-paths.js";

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
    "~/.claude/settings.json",
    "~/.codex/config.toml",
  ])("blocks canonical and legacy home config path %s", (filePath) => {
    const homeDir = makeTmpDir();
    expect(isSecretPath(filePath, { homeDir })).toBe(true);
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
});
