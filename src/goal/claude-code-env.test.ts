import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildClaudeCodeEnv } from "./claude-code-env.js";

const TEST_KEYS = [
  "ANTHROPIC_API_KEY",
  "DATABASE_URL",
  "GH_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
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
  process.env.DATABASE_URL = "postgres://user:pass@db.local:5432/app";
  process.env.GH_TOKEN = "ghp_test";
  process.env.AWS_SECRET_ACCESS_KEY = "aws-secret";
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
  it("strips ANTHROPIC_API_KEY in subscription mode", () => {
    const env = buildClaudeCodeEnv("subscription");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it.each(["subscription", "api_key"] as const)(
    "strips credential-bearing keys in %s mode",
    (mode) => {
      const env = buildClaudeCodeEnv(mode);

      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
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
  });
});
