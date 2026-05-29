import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SECRET_PATH_DENY_REASON, SECRET_PATH_PATTERNS } from "../security/secret-paths.js";
import {
  DEV_GATEWAY_WORKSPACE_DENY_REASON,
  HARD_DENIES,
  buildDevWorkspaceHardDenies,
  checkCommandDeny,
  checkPathDeny,
  renderGroupedHardDenies,
} from "./hard-deny.js";

describe("checkPathDeny", () => {
  it("includes every shared secret path pattern in HARD_DENIES", () => {
    for (const pattern of SECRET_PATH_PATTERNS) {
      expect(HARD_DENIES).toContainEqual({
        pattern,
        reason: SECRET_PATH_DENY_REASON,
        type: "path",
      });
    }
  });

  it("blocks symlink paths that resolve to denied targets", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hard-deny-"));
    const deniedTargetPath = path.join(tempDir, ".env.secret");
    const symlinkPath = path.join(tempDir, "safe.txt");

    try {
      fs.writeFileSync(deniedTargetPath, "secret");
      fs.symlinkSync(deniedTargetPath, symlinkPath, "file");

      expect(checkPathDeny(symlinkPath)?.pattern).toBe(".env*");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to lexical checks when realpath returns ENOENT", () => {
    const missingPath = path.join(os.tmpdir(), `hard-deny-missing-${Date.now()}`, ".env.new");
    expect(() => checkPathDeny(missingPath)).not.toThrow();
    expect(checkPathDeny(missingPath)?.pattern).toBe(".env*");
  });

  it("blocks additional sensitive file patterns", () => {
    const cases = [
      { filePath: "/tmp/auth.json", pattern: "auth.json" },
      { filePath: "/tmp/auth-profiles.json", pattern: "auth-profiles.json" },
      { filePath: "/tmp/client-cert.p12", pattern: "*.p12" },
      { filePath: "/tmp/client-cert.pfx", pattern: "*.pfx" },
      { filePath: "/tmp/client-cert.cer", pattern: "*.cer" },
      { filePath: "/tmp/.gnupg/private-keys-v1.d/keybox", pattern: ".gnupg/**" },
      { filePath: "/tmp/id_ed25519.pub", pattern: "*id_ed25519*" },
      { filePath: "/tmp/id_ecdsa", pattern: "*id_ecdsa*" },
      { filePath: "/tmp/moltbot.json", pattern: "moltbot.json" },
    ];

    for (const testCase of cases) {
      expect(checkPathDeny(testCase.filePath)?.pattern).toBe(testCase.pattern);
    }
  });

  it("blocks canonical and legacy SmithersBot config paths with the shared reason", () => {
    const cases = [
      "~/.smithersbot/.env",
      "~/.smithersbot/smithersbot.json",
      "~/.moltbot/moltbot.json",
      "~/.clawdbot/.env",
      "~/.clawdbot/credentials/oauth.json",
      "~/.clawdbot-dev/.env",
    ];

    for (const filePath of cases) {
      expect(checkPathDeny(filePath)?.reason).toBe(SECRET_PATH_DENY_REASON);
    }
  });

  it("blocks SmithersBot session artifacts with the shared reason", () => {
    expect(checkPathDeny("~/.smithersbot/sessions/abc.json")?.reason).toBe(SECRET_PATH_DENY_REASON);
  });

  it("blocks parent symlink paths that resolve under denied directories", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hard-deny-parent-"));
    const deniedTargetDir = path.join(tempDir, ".ssh");
    const symlinkPath = path.join(tempDir, "jail");

    try {
      fs.mkdirSync(deniedTargetDir);
      fs.symlinkSync(deniedTargetDir, symlinkPath, "dir");

      expect(checkPathDeny(path.join(symlinkPath, "config"))?.pattern).toBe(".ssh/**");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("allows normal repo files", () => {
    for (const filePath of ["README.md", "SETUP.md", "AGENTS.md", "package.json"]) {
      expect(checkPathDeny(filePath)).toBeNull();
    }
  });
});

describe("renderGroupedHardDenies", () => {
  it("groups repeated reasons under one heading without DENIED spam", () => {
    const rendered = renderGroupedHardDenies(HARD_DENIES);

    expect(rendered.startsWith("Hard Denies\n")).toBe(true);
    expect(rendered).toContain(
      "These are enforced by SmithersBot policy and, where available, backend sandbox settings.",
    );
    expect(rendered).toContain(
      "Local secret/config files. Workers cannot read SmithersBot config; ask the user to relay any required value:",
    );
    expect(rendered).toContain("Elevated privileges not permitted:");
    expect(rendered).toContain("Publishing/deployment not permitted:");
    expect(rendered).toContain("Destructive commands not permitted:");
    expect(rendered).not.toContain("DENIED:");

    expect(rendered.match(/Elevated privileges not permitted:/g)).toHaveLength(1);
    expect(rendered.match(/Publishing\/deployment not permitted:/g)).toHaveLength(1);
    expect(rendered.match(/- sudo/g)).toHaveLength(1);
    expect(rendered.match(/- npm publish/g)).toHaveLength(1);
  });

  it("renders policy coverage for sensitive, privileged, deployment, publish, and destructive categories", () => {
    const rendered = renderGroupedHardDenies(HARD_DENIES);

    for (const pattern of [
      ".env",
      "auth.json",
      "~/.clawdbot-dev/**",
      "~/.smithersbot/**",
      "sudo",
      "docker push",
      "npm publish",
      "gh release create",
      "rm -rf /",
      "mkfs",
      "dd if=",
    ]) {
      expect(rendered).toContain(`- ${pattern}`);
    }
  });
});

describe("checkCommandDeny", () => {
  it("blocks denied commands in compound ';' commands", () => {
    expect(checkCommandDeny("echo ok; sudo whoami")).not.toBeNull();
  });

  it("blocks denied commands in newline-separated commands", () => {
    expect(checkCommandDeny("echo ok\nsudo whoami")?.pattern).toBe("sudo");
  });

  it("does not flag quoted newline content that only mentions denied commands", () => {
    expect(checkCommandDeny('echo "ok\nsudo whoami"')).toBeNull();
  });

  it("blocks publish commands in newline-separated commands", () => {
    expect(checkCommandDeny("echo ok\nnpm publish --tag latest")?.pattern).toBe("npm publish");
  });

  it("blocks denied commands in compound '&&' commands", () => {
    expect(checkCommandDeny("echo ok && npm publish")).not.toBeNull();
  });

  it("blocks denied commands in compound '||' commands", () => {
    expect(checkCommandDeny("echo ok || flyctl deploy")).not.toBeNull();
  });

  it("blocks privilege escalation command variants", () => {
    expect(checkCommandDeny("doas whoami")?.pattern).toBe("doas");
    expect(checkCommandDeny("pkexec id")?.pattern).toBe("pkexec");
    expect(checkCommandDeny("nsenter --target 1 --mount")?.pattern).toBe("nsenter");
    expect(checkCommandDeny("unshare --mount /bin/true")?.pattern).toBe("unshare");
    expect(checkCommandDeny("chroot / /bin/sh")?.pattern).toBe("chroot");
  });

  it("blocks additional publish command variants", () => {
    expect(checkCommandDeny("bun publish --tag beta")?.pattern).toBe("bun publish");
    expect(checkCommandDeny("pnpm publish --tag latest")?.pattern).toBe("pnpm publish");
    expect(checkCommandDeny("yarn publish --new-version 1.2.3")?.pattern).toBe("yarn publish");
  });

  it("blocks fly deploy alias", () => {
    expect(checkCommandDeny("fly deploy")?.pattern).toBe("fly deploy");
  });

  it("blocks additional deploy command variants", () => {
    expect(checkCommandDeny("docker push registry.example.com/app:latest")?.pattern).toBe(
      "docker push",
    );
    expect(checkCommandDeny("wrangler deploy")?.pattern).toBe("wrangler deploy");
    expect(checkCommandDeny("cdk deploy production")?.pattern).toBe("cdk deploy");
  });

  it("blocks denied commands in pipelines", () => {
    expect(checkCommandDeny("echo ok | vercel")).not.toBeNull();
  });

  it("blocks denied commands hidden behind env prefix", () => {
    expect(checkCommandDeny("env NODE_ENV=test sudo ls")).not.toBeNull();
    expect(
      checkCommandDeny(
        "/usr/bin/env -i PATH=/usr/bin systemctl --user restart moltbot-gateway-dev",
      ),
    ).not.toBeNull();
  });

  it("handles env unset and split-string flags", () => {
    expect(checkCommandDeny("env -u PATH sudo ls")?.pattern).toBe("sudo");
    expect(checkCommandDeny("env --unset=PATH sudo ls")?.pattern).toBe("sudo");
    expect(checkCommandDeny("env -S 'sudo ls'")?.pattern).toBe("sudo");
    expect(checkCommandDeny("env --split-string='npm publish' echo safe")?.pattern).toBe(
      "npm publish",
    );
    expect(checkCommandDeny("env -u SAFE echo hello")).toBeNull();
  });

  it("strips transparent wrappers before checking denied commands", () => {
    expect(checkCommandDeny("nohup sudo whoami")?.pattern).toBe("sudo");
    expect(checkCommandDeny("nice -n 19 npm publish")?.pattern).toBe("npm publish");
    expect(checkCommandDeny("setsid --fork docker push evil/img")?.pattern).toBe("docker push");
    expect(checkCommandDeny("timeout 30s rm -rf /")?.pattern).toBe("rm -rf /");
    expect(checkCommandDeny("nohup python3 script.py")).toBeNull();
    expect(checkCommandDeny("env nohup sudo rm -rf /")?.pattern).toBe("sudo");
  });

  it("blocks denied commands hidden behind shell -c wrappers", () => {
    expect(checkCommandDeny("bash -c 'sudo rm -rf /'")).not.toBeNull();
    expect(checkCommandDeny('/bin/sh -c "npm publish"')).not.toBeNull();
    expect(checkCommandDeny("zsh -lc 'echo ok; flyctl deploy'")).not.toBeNull();
  });

  it("blocks denied commands hidden behind additional shell -c wrappers", () => {
    expect(checkCommandDeny("fish -c 'bun publish --tag beta'")?.pattern).toBe("bun publish");
    expect(checkCommandDeny("ksh -c 'docker push app:latest'")?.pattern).toBe("docker push");
    expect(checkCommandDeny("/bin/dash -c 'wrangler deploy'")?.pattern).toBe("wrangler deploy");
    expect(checkCommandDeny("csh -c 'cdk deploy prod'")?.pattern).toBe("cdk deploy");
    expect(checkCommandDeny("/usr/bin/tcsh -fc 'sudo whoami'")?.pattern).toBe("sudo");
  });

  it("blocks denied commands hidden in inline interpreter shell-exec calls", () => {
    expect(checkCommandDeny(`python3 -c "import os; os.system('npm publish')"`)?.pattern).toBe(
      "npm publish",
    );
    expect(
      checkCommandDeny(`node -e "require('child_process').execSync('sudo rm -rf /')"`)?.pattern,
    ).toBe("sudo");
    expect(checkCommandDeny(`perl -e 'system("docker push evil/img")'`)?.pattern).toBe(
      "docker push",
    );
    expect(checkCommandDeny(`ruby -e 'system("gh release create")'`)?.pattern).toBe(
      "gh release create",
    );
  });

  it("does not flag safe interpreter usage without inline shell execution", () => {
    expect(checkCommandDeny("python3 script.py")).toBeNull();
    expect(checkCommandDeny(`python3 -c "print('hello')"`)).toBeNull();
    expect(checkCommandDeny(`node -e "console.log('npm publish')"`)).toBeNull();
  });

  it("blocks denied commands inside command substitution", () => {
    expect(checkCommandDeny("echo $(sudo whoami)")).not.toBeNull();
    expect(checkCommandDeny("echo `npm publish`")).not.toBeNull();
  });

  it("blocks denied commands inside process substitution", () => {
    expect(checkCommandDeny("diff <(sudo whoami) file")).not.toBeNull();
    expect(
      checkCommandDeny("cat <(bash -lc 'echo ok') >(dd if=/dev/zero of=/tmp/out)"),
    ).not.toBeNull();
  });

  it("checks each process substitution stream", () => {
    const command = "cat <(npm publish) >(dd if=/dev/zero of=/tmp/out)";
    expect(
      checkCommandDeny(command, [
        { pattern: "npm publish", reason: "Publishing not permitted", type: "command" },
      ]),
    ).not.toBeNull();
    expect(
      checkCommandDeny(command, [
        { pattern: "dd if=", reason: "Raw disk writes not permitted", type: "command" },
      ]),
    ).not.toBeNull();
  });

  it("blocks denied commands in nested process substitutions", () => {
    expect(checkCommandDeny('cat <(bash -c "sudo test")')).not.toBeNull();
  });

  it("denies command substitutions nested beyond the depth limit", () => {
    let deeplyNestedCommand = "sudo whoami";
    for (let i = 0; i < 9; i++) {
      deeplyNestedCommand = `echo $(${deeplyNestedCommand})`;
    }

    expect(checkCommandDeny(deeplyNestedCommand)).toEqual({
      pattern: "<command-nesting-depth-limit>",
      reason: "command nesting too deep to analyze safely",
      type: "command",
    });
  });

  it("does not flag quoted text that only mentions denied commands", () => {
    expect(checkCommandDeny("echo 'sudo rm -rf /'")).toBeNull();
    expect(checkCommandDeny('echo "npm publish && vercel"')).toBeNull();
    expect(checkCommandDeny("echo '$(sudo whoami)'")).toBeNull();
    expect(checkCommandDeny("echo '<(sudo whoami)'")).toBeNull();
    expect(checkCommandDeny('echo "<(sudo whoami)"')).toBeNull();
  });

  it("handles rm short and long force/recursive flags correctly", () => {
    expect(checkCommandDeny("rm --recursive --force /")?.pattern).toBe("rm -rf /");
    expect(checkCommandDeny("rm --verbose --force /")).toBeNull();
    expect(checkCommandDeny("rm -rf /")?.pattern).toBe("rm -rf /");
    expect(checkCommandDeny("rm -r -f /")?.pattern).toBe("rm -rf /");
    expect(checkCommandDeny("rm --recursive -f /")?.pattern).toBe("rm -rf /");
  });

  it("treats home and current-directory rm targets as dangerous", () => {
    expect(checkCommandDeny("rm -rf ~")?.pattern).toBe("rm -rf /");
    expect(checkCommandDeny("rm -rf ~/*")?.pattern).toBe("rm -rf /");
    expect(checkCommandDeny("rm -rf $HOME")?.pattern).toBe("rm -rf /");
    expect(checkCommandDeny("rm -rf ${HOME}")?.pattern).toBe("rm -rf /");
    expect(checkCommandDeny("rm -rf .")?.pattern).toBe("rm -rf /");
    expect(checkCommandDeny("rm -rf ./")?.pattern).toBe("rm -rf /");
    expect(checkCommandDeny("rm -rf ./*")?.pattern).toBe("rm -rf /");
  });

  it("allows normal safe commands", () => {
    expect(checkCommandDeny("pnpm test")).toBeNull();
    expect(checkCommandDeny('echo "vercel deploy docs"')).toBeNull();
  });

  describe("default/stable workers keep denying all gateway restarts", () => {
    it("denies the dev gateway restart in the default (stable) deny list", () => {
      expect(
        checkCommandDeny("systemctl --user restart smithersbot-dev-gateway.service")?.pattern,
      ).toBe("systemctl --user restart");
    });

    it("denies the stable gateway restart in the default deny list", () => {
      expect(
        checkCommandDeny("systemctl --user restart smithersbot-gateway.service")?.pattern,
      ).toBe("systemctl --user restart");
    });
  });
});

describe("buildDevWorkspaceHardDenies", () => {
  const devDenies = buildDevWorkspaceHardDenies();

  it("allows restarting/inspecting only the dev gateway unit", () => {
    expect(
      checkCommandDeny("systemctl --user restart smithersbot-dev-gateway.service", devDenies),
    ).toBeNull();
    expect(
      checkCommandDeny(
        "systemctl --user status smithersbot-dev-gateway.service --no-pager",
        devDenies,
      ),
    ).toBeNull();
    expect(
      checkCommandDeny(
        "journalctl --user -u smithersbot-dev-gateway.service -n 80 --no-pager",
        devDenies,
      ),
    ).toBeNull();
    // Bare unit name (no .service suffix) is still recognized as the dev unit.
    expect(
      checkCommandDeny("systemctl --user restart smithersbot-dev-gateway", devDenies),
    ).toBeNull();
  });

  it("still denies restarting the stable gateway unit", () => {
    expect(
      checkCommandDeny("systemctl --user restart smithersbot-gateway.service", devDenies)?.reason,
    ).toBe(DEV_GATEWAY_WORKSPACE_DENY_REASON);
  });

  it("denies a unit-less or non-dev gateway restart", () => {
    expect(checkCommandDeny("systemctl --user restart", devDenies)?.reason).toBe(
      DEV_GATEWAY_WORKSPACE_DENY_REASON,
    );
    expect(
      checkCommandDeny("systemctl restart smithersbot-gateway.service", devDenies)?.reason,
    ).toBe(DEV_GATEWAY_WORKSPACE_DENY_REASON);
  });

  it("denies stable install/manage paths (enable/start/stop) for the stable unit", () => {
    expect(
      checkCommandDeny("systemctl --user enable --now smithersbot-gateway.service", devDenies)
        ?.reason,
    ).toBe(DEV_GATEWAY_WORKSPACE_DENY_REASON);
    expect(
      checkCommandDeny("systemctl --user start smithersbot-gateway.service", devDenies)?.reason,
    ).toBe(DEV_GATEWAY_WORKSPACE_DENY_REASON);
    expect(checkCommandDeny("systemctl --user stop smithersbot-gateway", devDenies)?.reason).toBe(
      DEV_GATEWAY_WORKSPACE_DENY_REASON,
    );
  });

  it("keeps the moltbot gateway restart and unrelated denies intact", () => {
    expect(checkCommandDeny("moltbot gateway restart", devDenies)?.pattern).toBe(
      "moltbot gateway restart",
    );
    expect(checkCommandDeny("sudo whoami", devDenies)?.pattern).toBe("sudo");
    expect(checkCommandDeny("npm publish", devDenies)?.pattern).toBe("npm publish");
  });

  it("keeps ~/.smithersbot stable-config mutation denied", () => {
    expect(checkPathDeny("~/.smithersbot/.env", devDenies)?.reason).toBe(SECRET_PATH_DENY_REASON);
    expect(checkPathDeny("~/.smithersbot/smithersbot.json", devDenies)?.reason).toBe(
      SECRET_PATH_DENY_REASON,
    );
  });
});
