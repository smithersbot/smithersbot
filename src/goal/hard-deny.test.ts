import { describe, expect, it } from "vitest";
import { checkCommandDeny } from "./hard-deny.js";

describe("checkCommandDeny", () => {
  it("blocks denied commands in compound ';' commands", () => {
    expect(checkCommandDeny("echo ok; sudo whoami")).not.toBeNull();
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
    expect(checkCommandDeny("pnpm publish --tag latest")?.pattern).toBe("pnpm publish");
    expect(checkCommandDeny("yarn publish --new-version 1.2.3")?.pattern).toBe("yarn publish");
  });

  it("blocks fly deploy alias", () => {
    expect(checkCommandDeny("fly deploy")?.pattern).toBe("fly deploy");
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

  it("blocks denied commands hidden behind shell -c wrappers", () => {
    expect(checkCommandDeny("bash -c 'sudo rm -rf /'")).not.toBeNull();
    expect(checkCommandDeny('/bin/sh -c "npm publish"')).not.toBeNull();
    expect(checkCommandDeny("zsh -lc 'echo ok; flyctl deploy'")).not.toBeNull();
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
});
