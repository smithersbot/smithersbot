import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it("leaves gateway --dev for subcommands", () => {
    const res = parseCliProfileArgs([
      "node",
      "moltbot",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
    if (!res.ok) throw new Error(res.error);
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual(["node", "moltbot", "gateway", "--dev", "--allow-unconfigured"]);
  });

  it("still accepts global --dev before subcommand", () => {
    const res = parseCliProfileArgs(["node", "moltbot", "--dev", "gateway"]);
    if (!res.ok) throw new Error(res.error);
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "moltbot", "gateway"]);
  });

  it("parses --profile value and strips it", () => {
    const res = parseCliProfileArgs(["node", "moltbot", "--profile", "work", "status"]);
    if (!res.ok) throw new Error(res.error);
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "moltbot", "status"]);
  });

  it("rejects missing profile value", () => {
    const res = parseCliProfileArgs(["node", "moltbot", "--profile"]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (dev first)", () => {
    const res = parseCliProfileArgs(["node", "moltbot", "--dev", "--profile", "work", "status"]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (profile first)", () => {
    const res = parseCliProfileArgs(["node", "moltbot", "--profile", "work", "--dev", "status"]);
    expect(res.ok).toBe(false);
  });
});

describe("applyCliProfileEnv", () => {
  it("fills env defaults for dev profile", () => {
    const env: Record<string, string | undefined> = {};
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/matt",
    });
    const expectedStateDir = path.join("/home/matt", ".clawdbot-dev");
    const expectedInstanceStateDir = path.join("/home/matt", ".smithersbot-dev");
    expect(env.CLAWDBOT_PROFILE).toBe("dev");
    expect(env.CLAWDBOT_STATE_DIR).toBe(expectedStateDir);
    expect(env.CLAWDBOT_CONFIG_PATH).toBe(path.join(expectedStateDir, "moltbot.json"));
    expect(env.CLAWDBOT_GATEWAY_PORT).toBe("19001");
    expect(env.SMITHERSBOT_INSTANCE).toBe("dev");
    expect(env.SMITHERSBOT_GOALS_ROOT).toBe("/home/matt/smithersbot-dev-home");
    expect(env.SMITHERSBOT_STATE_DIR).toBe(expectedInstanceStateDir);
    expect(env.SMITHERSBOT_CONFIG_PATH).toBe(
      path.join(expectedInstanceStateDir, "smithersbot.json"),
    );
  });

  it("does not override explicit env values", () => {
    const env: Record<string, string | undefined> = {
      SMITHERSBOT_GOALS_ROOT: "/explicit/managed-root",
      SMITHERSBOT_STATE_DIR: "/explicit/state",
      SMITHERSBOT_CONFIG_PATH: "/explicit/config.json",
      CLAWDBOT_STATE_DIR: "/custom",
      CLAWDBOT_GATEWAY_PORT: "19099",
    };
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.CLAWDBOT_STATE_DIR).toBe("/custom");
    expect(env.CLAWDBOT_GATEWAY_PORT).toBe("19099");
    expect(env.CLAWDBOT_CONFIG_PATH).toBe(path.join("/custom", "moltbot.json"));
    expect(env.SMITHERSBOT_GOALS_ROOT).toBe("/explicit/managed-root");
    expect(env.SMITHERSBOT_STATE_DIR).toBe("/explicit/state");
    expect(env.SMITHERSBOT_CONFIG_PATH).toBe("/explicit/config.json");
  });
});

describe("formatCliCommand", () => {
  it("returns command unchanged when no profile is set", () => {
    expect(formatCliCommand("moltbot doctor --fix", {})).toBe("smithersbot doctor --fix");
  });

  it("returns command unchanged when profile is default", () => {
    expect(formatCliCommand("moltbot doctor --fix", { CLAWDBOT_PROFILE: "default" })).toBe(
      "smithersbot doctor --fix",
    );
  });

  it("returns command unchanged when profile is Default (case-insensitive)", () => {
    expect(formatCliCommand("moltbot doctor --fix", { CLAWDBOT_PROFILE: "Default" })).toBe(
      "smithersbot doctor --fix",
    );
  });

  it("returns command unchanged when profile is invalid", () => {
    expect(formatCliCommand("moltbot doctor --fix", { CLAWDBOT_PROFILE: "bad profile" })).toBe(
      "smithersbot doctor --fix",
    );
  });

  it("returns command unchanged when --profile is already present", () => {
    expect(
      formatCliCommand("moltbot --profile work doctor --fix", { CLAWDBOT_PROFILE: "work" }),
    ).toBe("smithersbot --profile work doctor --fix");
  });

  it("returns command unchanged when --dev is already present", () => {
    expect(formatCliCommand("moltbot --dev doctor", { CLAWDBOT_PROFILE: "dev" })).toBe(
      "smithersbot --dev doctor",
    );
  });

  it("inserts --profile flag when profile is set", () => {
    expect(formatCliCommand("moltbot doctor --fix", { CLAWDBOT_PROFILE: "work" })).toBe(
      "smithersbot --profile work doctor --fix",
    );
  });

  it("trims whitespace from profile", () => {
    expect(formatCliCommand("moltbot doctor --fix", { CLAWDBOT_PROFILE: "  jbclawd  " })).toBe(
      "smithersbot --profile jbclawd doctor --fix",
    );
  });

  it("handles command with no args after moltbot", () => {
    expect(formatCliCommand("moltbot", { CLAWDBOT_PROFILE: "test" })).toBe(
      "smithersbot --profile test",
    );
  });

  it("handles pnpm wrapper", () => {
    expect(formatCliCommand("pnpm moltbot doctor", { CLAWDBOT_PROFILE: "work" })).toBe(
      "pnpm smithersbot --profile work doctor",
    );
  });
});
