import { describe, expect, it } from "vitest";

import { resolveCliBackendConfig } from "./cli-backends.js";

describe("resolveCliBackendConfig", () => {
  it("does not enable dangerous Claude permissions by default", () => {
    const resolved = resolveCliBackendConfig("claude-cli");

    expect(resolved?.config.args).toEqual(["-p", "--output-format", "json"]);
    expect(resolved?.config.resumeArgs).toEqual([
      "-p",
      "--output-format",
      "json",
      "--resume",
      "{sessionId}",
    ]);
    expect(resolved?.config.args).not.toContain("--dangerously-skip-permissions");
    expect(resolved?.config.resumeArgs).not.toContain("--dangerously-skip-permissions");
  });

  it("allows dangerous Claude permissions through explicit backend args override", () => {
    const resolved = resolveCliBackendConfig("claude-cli", {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"],
            },
          },
        },
      },
    });

    expect(resolved?.config.args).toContain("--dangerously-skip-permissions");
  });
});
