import { describe, expect, it } from "vitest";

import { buildConfigSchema } from "./schema.js";
import { MoltbotSchema } from "./zod-schema.js";

describe("config schema", () => {
  it("exports schema + hints", () => {
    const res = buildConfigSchema();
    const schema = res.schema as {
      properties?: Record<string, { properties?: Record<string, unknown> }>;
    };
    expect(schema.properties?.gateway).toBeTruthy();
    expect(schema.properties?.gateway?.properties?.observedInstances).toBeTruthy();
    expect(schema.properties?.agents).toBeTruthy();
    expect(res.uiHints.gateway?.label).toBe("Gateway");
    expect(res.uiHints["gateway.auth.token"]?.sensitive).toBe(true);
    expect(res.version).toBeTruthy();
    expect(res.generatedAt).toBeTruthy();
  });

  it("accepts gateway observedInstances without making it required", () => {
    const withObserved = MoltbotSchema.safeParse({ gateway: { observedInstances: ["dev"] } });
    expect(withObserved.success).toBe(true);
    if (!withObserved.success) return;
    expect(withObserved.data.gateway?.observedInstances).toEqual(["dev"]);

    const withoutObserved = MoltbotSchema.safeParse({ gateway: { mode: "local" } });
    expect(withoutObserved.success).toBe(true);
    if (!withoutObserved.success) return;
    expect(withoutObserved.data.gateway?.observedInstances).toBeUndefined();
  });

  it("accepts goal claudeDriver values while allowing omission to default at runtime", () => {
    const omitted = MoltbotSchema.safeParse({ goal: {} });
    expect(omitted.success).toBe(true);
    if (!omitted.success) return;
    expect(omitted.data.goal?.claudeDriver).toBeUndefined();

    const direct = MoltbotSchema.safeParse({ goal: { claudeDriver: "direct" } });
    expect(direct.success).toBe(true);
    if (!direct.success) return;
    expect(direct.data.goal?.claudeDriver).toBe("direct");

    const tuiPilot = MoltbotSchema.safeParse({
      goal: { claudeDriver: "tui-pilot", tuiPilotBinary: "/usr/local/bin/tui-pilot" },
    });
    expect(tuiPilot.success).toBe(true);
    if (!tuiPilot.success) return;
    expect(tuiPilot.data.goal?.claudeDriver).toBe("tui-pilot");
    expect(tuiPilot.data.goal?.tuiPilotBinary).toBe("/usr/local/bin/tui-pilot");
  });

  it("rejects unknown goal claudeDriver values", () => {
    const res = MoltbotSchema.safeParse({ goal: { claudeDriver: "claude-p" } });
    expect(res.success).toBe(false);
  });

  it("accepts the goal.tuiPilot operational block with a per-site driver map", () => {
    const res = MoltbotSchema.safeParse({
      goal: {
        claudeDriver: "direct",
        tuiPilot: {
          version: "0.8.60",
          preflight: "enforce",
          maxConcurrent: 3,
          maxQueued: 64,
          queueTimeoutMs: 600_000,
          sites: {
            "cli-worker": "tui-pilot",
            "cli-planner": "tui-pilot",
            "post-execution-report": "tui-pilot",
            "repo-chat-worker": "tui-pilot",
          },
        },
      },
    });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.goal?.tuiPilot?.version).toBe("0.8.60");
    expect(res.data.goal?.tuiPilot?.maxConcurrent).toBe(3);
    expect(res.data.goal?.tuiPilot?.sites?.["cli-worker"]).toBe("tui-pilot");
  });

  it("rejects invalid goal.tuiPilot values (bad site driver, sub-1 concurrency)", () => {
    expect(
      MoltbotSchema.safeParse({ goal: { tuiPilot: { sites: { "cli-worker": "codex" } } } }).success,
    ).toBe(false);
    expect(MoltbotSchema.safeParse({ goal: { tuiPilot: { maxConcurrent: 0 } } }).success).toBe(
      false,
    );
    expect(MoltbotSchema.safeParse({ goal: { tuiPilot: { preflight: "loud" } } }).success).toBe(
      false,
    );
    expect(
      MoltbotSchema.safeParse({ goal: { tuiPilot: { sites: { "not-a-site": "direct" } } } })
        .success,
    ).toBe(false);
  });

  it("merges plugin ui hints", () => {
    const res = buildConfigSchema({
      plugins: [
        {
          id: "voice-call",
          name: "Voice Call",
          description: "Outbound voice calls",
          configUiHints: {
            provider: { label: "Provider" },
            "twilio.authToken": { label: "Auth Token", sensitive: true },
          },
        },
      ],
    });

    expect(res.uiHints["plugins.entries.voice-call"]?.label).toBe("Voice Call");
    expect(res.uiHints["plugins.entries.voice-call.config"]?.label).toBe("Voice Call Config");
    expect(res.uiHints["plugins.entries.voice-call.config.twilio.authToken"]?.label).toBe(
      "Auth Token",
    );
    expect(res.uiHints["plugins.entries.voice-call.config.twilio.authToken"]?.sensitive).toBe(true);
  });

  it("merges plugin + channel schemas", () => {
    const res = buildConfigSchema({
      plugins: [
        {
          id: "voice-call",
          name: "Voice Call",
          configSchema: {
            type: "object",
            properties: {
              provider: { type: "string" },
            },
          },
        },
      ],
      channels: [
        {
          id: "matrix",
          label: "Matrix",
          configSchema: {
            type: "object",
            properties: {
              accessToken: { type: "string" },
            },
          },
        },
      ],
    });

    const schema = res.schema as {
      properties?: Record<string, unknown>;
    };
    const pluginsNode = schema.properties?.plugins as Record<string, unknown> | undefined;
    const entriesNode = pluginsNode?.properties as Record<string, unknown> | undefined;
    const entriesProps = entriesNode?.entries as Record<string, unknown> | undefined;
    const entryProps = entriesProps?.properties as Record<string, unknown> | undefined;
    const pluginEntry = entryProps?.["voice-call"] as Record<string, unknown> | undefined;
    const pluginConfig = pluginEntry?.properties as Record<string, unknown> | undefined;
    const pluginConfigSchema = pluginConfig?.config as Record<string, unknown> | undefined;
    const pluginConfigProps = pluginConfigSchema?.properties as Record<string, unknown> | undefined;
    expect(pluginConfigProps?.provider).toBeTruthy();

    const channelsNode = schema.properties?.channels as Record<string, unknown> | undefined;
    const channelsProps = channelsNode?.properties as Record<string, unknown> | undefined;
    const channelSchema = channelsProps?.matrix as Record<string, unknown> | undefined;
    const channelProps = channelSchema?.properties as Record<string, unknown> | undefined;
    expect(channelProps?.accessToken).toBeTruthy();
  });

  it("adds heartbeat target hints with dynamic channels", () => {
    const res = buildConfigSchema({
      channels: [
        {
          id: "bluebubbles",
          label: "BlueBubbles",
          configSchema: { type: "object" },
        },
      ],
    });

    const defaultsHint = res.uiHints["agents.defaults.heartbeat.target"];
    const listHint = res.uiHints["agents.list.*.heartbeat.target"];
    expect(defaultsHint?.help).toContain("bluebubbles");
    expect(defaultsHint?.help).toContain("last");
    expect(listHint?.help).toContain("bluebubbles");
  });
});
