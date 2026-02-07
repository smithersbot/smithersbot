import { describe, expect, it } from "vitest";
import {
  createDefaultPolicy,
  isPathDenied,
  isCommandDenied,
  isPathWithinGrants,
  isCommandWithinGrants,
  inferMissingCapability,
} from "./capability-policy.js";
import type { EffectiveCapabilities } from "./capability-types.js";

const WORKING_DIR = "/home/user/project";

describe("createDefaultPolicy", () => {
  it("produces valid baseline with expected grants and denies", () => {
    const policy = createDefaultPolicy(WORKING_DIR);
    expect(policy.baseline.length).toBeGreaterThan(0);
    expect(policy.hardDenies.length).toBeGreaterThan(0);
    expect(policy.expandableIds.length).toBeGreaterThan(0);

    const grantIds = policy.baseline.map((g) => g.id);
    expect(grantIds).toContain("fs.read");
    expect(grantIds).toContain("fs.write");
    expect(grantIds).toContain("exec.safe");
    expect(grantIds).toContain("git.checkpoint");
  });

  it("baseline fs grants scope to workingDir", () => {
    const policy = createDefaultPolicy(WORKING_DIR);
    const fsRead = policy.baseline.find((g) => g.id === "fs.read");
    expect(fsRead?.pathGlobs?.[0]).toBe(`${WORKING_DIR}/**`);
  });
});

describe("isPathDenied", () => {
  const policy = createDefaultPolicy(WORKING_DIR);
  const denies = policy.hardDenies;

  it("matches .env files", () => {
    const result = isPathDenied(`${WORKING_DIR}/.env`, denies);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("secrets.read");
  });

  it("matches .env.local", () => {
    const result = isPathDenied(`${WORKING_DIR}/.env.local`, denies);
    expect(result).not.toBeNull();
  });

  it("matches .pem files", () => {
    const result = isPathDenied(`${WORKING_DIR}/cert.pem`, denies);
    expect(result).not.toBeNull();
  });

  it("matches .aws directory", () => {
    const result = isPathDenied("/home/user/.aws/credentials", denies);
    expect(result).not.toBeNull();
  });

  it("matches .ssh directory", () => {
    const result = isPathDenied("/home/user/.ssh/config", denies);
    expect(result).not.toBeNull();
  });

  it("matches credentials files", () => {
    const result = isPathDenied(`${WORKING_DIR}/credentials.json`, denies);
    expect(result).not.toBeNull();
  });

  it("matches id_rsa", () => {
    const result = isPathDenied("/home/user/.ssh/id_rsa", denies);
    expect(result).not.toBeNull();
  });

  it("returns null for normal repo files", () => {
    expect(isPathDenied(`${WORKING_DIR}/src/index.ts`, denies)).toBeNull();
    expect(isPathDenied(`${WORKING_DIR}/package.json`, denies)).toBeNull();
    expect(isPathDenied(`${WORKING_DIR}/README.md`, denies)).toBeNull();
  });
});

describe("isCommandDenied", () => {
  const policy = createDefaultPolicy(WORKING_DIR);
  const denies = policy.hardDenies;

  it("catches sudo", () => {
    const result = isCommandDenied("sudo apt-get install vim", denies);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("exec.sudo");
  });

  it("catches git push --force", () => {
    const result = isCommandDenied("git push --force origin main", denies);
    expect(result).not.toBeNull();
  });

  it("catches git push -f", () => {
    const result = isCommandDenied("git push -f origin main", denies);
    expect(result).not.toBeNull();
  });

  it("catches deploy commands", () => {
    expect(isCommandDenied("fly deploy", denies)).not.toBeNull();
    expect(isCommandDenied("npm publish", denies)).not.toBeNull();
  });

  it("catches rm -rf /", () => {
    expect(isCommandDenied("rm -rf /", denies)).not.toBeNull();
  });

  it("catches network tools", () => {
    expect(isCommandDenied("curl https://example.com", denies)).not.toBeNull();
    expect(isCommandDenied("wget https://evil.com", denies)).not.toBeNull();
  });

  it("allows safe commands", () => {
    expect(isCommandDenied("pnpm test", denies)).toBeNull();
    expect(isCommandDenied('git commit -m "fix"', denies)).toBeNull();
    expect(isCommandDenied("node script.js", denies)).toBeNull();
  });
});

describe("isCommandWithinGrants", () => {
  const policy = createDefaultPolicy(WORKING_DIR);
  const grants = policy.baseline;

  it("allows safe commands", () => {
    expect(isCommandWithinGrants("pnpm test", grants)).toBe(true);
    expect(isCommandWithinGrants("git status", grants)).toBe(true);
    expect(isCommandWithinGrants("git commit -m 'fix'", grants)).toBe(true);
    expect(isCommandWithinGrants("node script.js", grants)).toBe(true);
    expect(isCommandWithinGrants("ls -la", grants)).toBe(true);
  });

  it("rejects bash-bypass commands (cat, head, cp, mv, rm, sed, awk, tee, dd)", () => {
    expect(isCommandWithinGrants("cat .env", grants)).toBe(false);
    expect(isCommandWithinGrants("head -n 10 /etc/passwd", grants)).toBe(false);
    expect(isCommandWithinGrants("cp .env .env.bak", grants)).toBe(false);
    expect(isCommandWithinGrants("mv file1 file2", grants)).toBe(false);
    expect(isCommandWithinGrants("rm -rf node_modules", grants)).toBe(false);
    expect(isCommandWithinGrants("sed -i 's/old/new/' file", grants)).toBe(false);
    expect(isCommandWithinGrants("awk '{print $1}' file", grants)).toBe(false);
    expect(isCommandWithinGrants("tee output.txt", grants)).toBe(false);
    expect(isCommandWithinGrants("dd if=/dev/zero of=file", grants)).toBe(false);
  });

  it("rejects install commands (requires exec.install_deps)", () => {
    expect(isCommandWithinGrants("npm install express", grants)).toBe(false);
    expect(isCommandWithinGrants("pnpm install", grants)).toBe(false);
    expect(isCommandWithinGrants("bun install", grants)).toBe(false);
    expect(isCommandWithinGrants("pip install requests", grants)).toBe(false);
    expect(isCommandWithinGrants("yarn add lodash", grants)).toBe(false);
  });

  it("allows install commands when exec.install_deps is granted", () => {
    const withInstall = [
      ...grants,
      {
        id: "exec.install_deps" as const,
        commandPatterns: ["npm install", "pnpm install", "bun install", "pip install", "yarn add"],
      },
    ];
    expect(isCommandWithinGrants("npm install express", withInstall)).toBe(true);
    expect(isCommandWithinGrants("pnpm install", withInstall)).toBe(true);
  });

  it("rejects network tools", () => {
    expect(isCommandWithinGrants("curl https://example.com", grants)).toBe(false);
    expect(isCommandWithinGrants("wget https://example.com", grants)).toBe(false);
  });
});

describe("isPathWithinGrants", () => {
  const policy = createDefaultPolicy(WORKING_DIR);
  const grants = policy.baseline;

  it("allows repo-scoped paths", () => {
    expect(isPathWithinGrants(`${WORKING_DIR}/src/index.ts`, grants, WORKING_DIR)).toBe(true);
    expect(isPathWithinGrants(`${WORKING_DIR}/package.json`, grants, WORKING_DIR)).toBe(true);
  });

  it("rejects paths outside workingDir", () => {
    expect(isPathWithinGrants("/etc/passwd", grants, WORKING_DIR)).toBe(false);
    expect(isPathWithinGrants("/home/user/.bashrc", grants, WORKING_DIR)).toBe(false);
    expect(isPathWithinGrants("/tmp/secret.txt", grants, WORKING_DIR)).toBe(false);
  });
});

describe("inferMissingCapability", () => {
  const policy = createDefaultPolicy(WORKING_DIR);
  const effective: EffectiveCapabilities = {
    grants: policy.baseline,
    denies: policy.hardDenies,
    nodeGrants: [],
  };

  it('returns "exec.install_deps" for npm install', () => {
    expect(inferMissingCapability({ command: "npm install express" }, effective, policy)).toBe(
      "exec.install_deps",
    );
  });

  it('returns "git.push_private" for git push', () => {
    expect(inferMissingCapability({ command: "git push origin main" }, effective, policy)).toBe(
      "git.push_private",
    );
  });

  it('returns "network.read_only" for curl', () => {
    expect(inferMissingCapability({ command: "curl https://example.com" }, effective, policy)).toBe(
      "network.read_only",
    );
  });

  it('returns "network.registry_only" for curl to known registry', () => {
    expect(
      inferMissingCapability(
        { command: "curl https://registry.npmjs.org/lodash" },
        effective,
        policy,
      ),
    ).toBe("network.registry_only");
  });

  it("returns undefined for unrecognized command", () => {
    expect(
      inferMissingCapability({ command: "some-unknown-tool --flag" }, effective, policy),
    ).toBeUndefined();
  });

  it('returns "exec.long_running" for commands with --watch', () => {
    expect(inferMissingCapability({ command: "tsc --watch" }, effective, policy)).toBe(
      "exec.long_running",
    );
  });
});
