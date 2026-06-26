import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildClaudeCodeEnv,
  shouldStripCredentialKey,
  stripClaudeSubscriptionAuthEnv,
} from "./claude-code-env.js";

const PROVIDER_KEYS_TO_STRIP = [
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_KEY",
  "HF_TOKEN",
  "HUGGING_FACE_HUB_TOKEN",
  "COHERE_API_KEY",
  "MISTRAL_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "REPLICATE_API_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_USER_TOKEN",
  "SMITHERSBOT_GATEWAY_TOKEN",
  "SMITHERSBOT_GATEWAY_PASSWORD",
  "CLAWDBOT_GATEWAY_TOKEN",
  "CLAWDBOT_GATEWAY_PASSWORD",
] as const;

const TEST_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY_OLD",
  "ANTHROPIC_BASE_URL",
  ...PROVIDER_KEYS_TO_STRIP,
  "DATABASE_URL",
  "GH_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "MY_CUSTOM_API_KEY",
  "API_KEY_ROTATION_DAYS",
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "NODE_ENV",
  "OP_SESSION_my",
  "APP_SECRET",
  "APP_PRIVATE_KEY",
] as const;

type TestKey = (typeof TEST_KEYS)[number];

let priorEnv: Record<TestKey, string | undefined>;

beforeEach(() => {
  priorEnv = TEST_KEYS.reduce(
    (acc, key) => {
      acc[key] = process.env[key];
      return acc;
    },
    {} as Record<TestKey, string | undefined>,
  );

  process.env.ANTHROPIC_API_KEY = "anthropic-test-key";
  process.env.ANTHROPIC_AUTH_TOKEN = "anthropic-auth-token";
  process.env.ANTHROPIC_API_KEY_OLD = "anthropic-old-key";
  process.env.ANTHROPIC_BASE_URL = "https://anthropic-proxy.invalid";
  for (const key of PROVIDER_KEYS_TO_STRIP) {
    process.env[key] = `${key.toLowerCase()}-test-value`;
  }
  process.env.DATABASE_URL = "postgres://user:pass@db.local:5432/app";
  process.env.GH_TOKEN = "ghp_test";
  process.env.AWS_SECRET_ACCESS_KEY = "aws-secret";
  process.env.MY_CUSTOM_API_KEY = "custom-api-key";
  process.env.API_KEY_ROTATION_DAYS = "30";
  process.env.PATH = "/usr/bin:/bin";
  process.env.HOME = "/tmp/home";
  process.env.USER = "test-user";
  process.env.SHELL = "/bin/bash";
  process.env.LANG = "en_US.UTF-8";
  process.env.NODE_ENV = "test";
  process.env.OP_SESSION_my = "one-password-session";
  process.env.APP_SECRET = "secret";
  process.env.APP_PRIVATE_KEY = "private-key";
});

afterEach(() => {
  for (const key of TEST_KEYS) {
    const prior = priorEnv[key];
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
});

describe("buildClaudeCodeEnv", () => {
  it("strips Claude API-key style env in subscription mode", () => {
    const env = buildClaudeCodeEnv("subscription");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY_OLD).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("keeps subscription API-key env stripped when filesystem credentials are exposed", () => {
    // The driven-session credential carve-out is a sandbox filesystem setting only;
    // subscription-mode process env must remain scrubbed.
    const env = buildClaudeCodeEnv("subscription", {
      ANTHROPIC_API_KEY: "placeholder-api-key",
      ANTHROPIC_AUTH_TOKEN: "placeholder-auth-token",
      ANTHROPIC_API_KEY_OLD: "placeholder-old-api-key",
      ANTHROPIC_BASE_URL: "https://placeholder.invalid",
      PATH: "/usr/bin",
    });

    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it.each(["subscription", "api_key"] as const)(
    "strips configured LLM provider keys in %s mode",
    (mode) => {
      const env = buildClaudeCodeEnv(mode);

      for (const key of PROVIDER_KEYS_TO_STRIP) {
        expect(env[key]).toBeUndefined();
      }
    },
  );

  it.each(["subscription", "api_key"] as const)(
    "strips credential-bearing keys in %s mode",
    (mode) => {
      const env = buildClaudeCodeEnv(mode);

      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.MY_CUSTOM_API_KEY).toBeUndefined();
      expect(env.OP_SESSION_my).toBeUndefined();
      expect(env.APP_SECRET).toBeUndefined();
      expect(env.APP_PRIVATE_KEY).toBeUndefined();
    },
  );

  it.each(["subscription", "api_key"] as const)(
    "preserves safe baseline keys in %s mode",
    (mode) => {
      const env = buildClaudeCodeEnv(mode);

      expect(env.PATH).toBe("/usr/bin:/bin");
      expect(env.HOME).toBe("/tmp/home");
      expect(env.USER).toBe("test-user");
      expect(env.SHELL).toBe("/bin/bash");
      expect(env.LANG).toBe("en_US.UTF-8");
      expect(env.NODE_ENV).toBe("test");
    },
  );

  it("preserves ANTHROPIC_API_KEY in api_key mode", () => {
    const env = buildClaudeCodeEnv("api_key");
    expect(env.ANTHROPIC_API_KEY).toBe("anthropic-test-key");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("anthropic-auth-token");
    expect(env.ANTHROPIC_API_KEY_OLD).toBe("anthropic-old-key");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://anthropic-proxy.invalid");
  });

  it("exposes a reusable subscription env scrubber for proof and launch paths", () => {
    const env = stripClaudeSubscriptionAuthEnv({
      ANTHROPIC_API_KEY: "placeholder-api-key",
      ANTHROPIC_AUTH_TOKEN: "placeholder-auth-token",
      ANTHROPIC_API_KEY_OLD: "placeholder-old-api-key",
      ANTHROPIC_BASE_URL: "https://placeholder.invalid",
      PATH: "/usr/bin",
    });

    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it.each(["subscription", "api_key"] as const)(
    "preserves non-secret API_KEY metadata in %s mode",
    (mode) => {
      const env = buildClaudeCodeEnv(mode);
      expect(env.API_KEY_ROTATION_DAYS).toBe("30");
    },
  );

  it("only matches end-anchored _API_KEY names outside auth keys", () => {
    expect(shouldStripCredentialKey("MY_CUSTOM_API_KEY")).toBe(true);
    expect(shouldStripCredentialKey("API_KEY_ROTATION_DAYS")).toBe(false);
    expect(shouldStripCredentialKey("ANTHROPIC_API_KEY")).toBe(false);
  });
});
