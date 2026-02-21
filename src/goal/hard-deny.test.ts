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

  it("blocks denied commands hidden behind shell -c wrappers", () => {
    expect(checkCommandDeny("bash -c 'sudo rm -rf /'")).not.toBeNull();
    expect(checkCommandDeny('/bin/sh -c "npm publish"')).not.toBeNull();
    expect(checkCommandDeny("zsh -lc 'echo ok; flyctl deploy'")).not.toBeNull();
  });

  it("blocks denied commands inside command substitution", () => {
    expect(checkCommandDeny("echo $(sudo whoami)")).not.toBeNull();
    expect(checkCommandDeny("echo `npm publish`")).not.toBeNull();
  });

  it("does not flag quoted text that only mentions denied commands", () => {
    expect(checkCommandDeny("echo 'sudo rm -rf /'")).toBeNull();
    expect(checkCommandDeny('echo "npm publish && vercel"')).toBeNull();
    expect(checkCommandDeny("echo '$(sudo whoami)'")).toBeNull();
  });

  it("allows normal safe commands", () => {
    expect(checkCommandDeny("pnpm test")).toBeNull();
    expect(checkCommandDeny('echo "vercel deploy docs"')).toBeNull();
  });
});
