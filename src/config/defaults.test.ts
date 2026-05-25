import { describe, expect, it } from "vitest";

import { resolveAgentConfig } from "../agents/agent-scope.js";
import { validateConfigObject } from "./validation.js";

describe("agent identity defaults", () => {
  it("validates operatorHonorific on defaults and per-agent identity", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          identity: {
            operatorHonorific: "sir",
          },
        },
        list: [
          {
            id: "main",
            identity: {
              operatorHonorific: "boss",
            },
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.agents?.defaults?.identity?.operatorHonorific).toBe("sir");
    expect(result.config.agents?.list?.[0]?.identity?.operatorHonorific).toBe("boss");
  });

  it("propagates defaults.identity to agents without identity", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          identity: {
            name: "SmithersBot",
            operatorHonorific: "sir",
          },
        },
        list: [{ id: "main" }],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(resolveAgentConfig(result.config, "main")?.identity).toEqual({
      name: "SmithersBot",
      operatorHonorific: "sir",
    });
  });

  it("lets per-agent identity override defaults.identity fields", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          identity: {
            name: "SmithersBot",
            operatorHonorific: "sir",
          },
        },
        list: [
          {
            id: "main",
            identity: {
              operatorHonorific: "boss",
            },
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(resolveAgentConfig(result.config, "main")?.identity).toEqual({
      name: "SmithersBot",
      operatorHonorific: "boss",
    });
  });

  it("keeps configs without operatorHonorific valid", () => {
    const result = validateConfigObject({
      agents: {
        list: [
          {
            id: "main",
            identity: {
              name: "SmithersBot",
            },
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(resolveAgentConfig(result.config, "main")?.identity).toEqual({
      name: "SmithersBot",
    });
  });
});
