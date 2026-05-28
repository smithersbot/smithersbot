import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EMPTY_MCP_CONFIG_PATH,
  appendStrictMcpArgs,
  ensureEmptyMcpConfig,
} from "./claude-code-mcp-isolation.js";

describe("claude-code-mcp-isolation", () => {
  beforeEach(() => {
    fs.rmSync(EMPTY_MCP_CONFIG_PATH, { force: true });
  });

  afterEach(() => {
    fs.rmSync(EMPTY_MCP_CONFIG_PATH, { force: true });
  });

  describe("ensureEmptyMcpConfig", () => {
    it("creates the empty mcp config file when missing", () => {
      expect(fs.existsSync(EMPTY_MCP_CONFIG_PATH)).toBe(false);
      const returned = ensureEmptyMcpConfig();
      expect(returned).toBe(EMPTY_MCP_CONFIG_PATH);
      expect(fs.existsSync(EMPTY_MCP_CONFIG_PATH)).toBe(true);
    });

    it("writes exactly an empty mcpServers object (JSON.parse equality)", () => {
      ensureEmptyMcpConfig();
      const raw = fs.readFileSync(EMPTY_MCP_CONFIG_PATH, "utf-8");
      expect(JSON.parse(raw)).toEqual({ mcpServers: {} });
    });

    it("does not rewrite the file when contents are already correct", () => {
      ensureEmptyMcpConfig();
      const firstMtime = fs.statSync(EMPTY_MCP_CONFIG_PATH).mtimeMs;
      // Wait at least the filesystem resolution to ensure mtime would change if rewritten.
      const start = Date.now();
      while (Date.now() - start < 20) {
        /* busy-wait a hair */
      }
      ensureEmptyMcpConfig();
      const secondMtime = fs.statSync(EMPTY_MCP_CONFIG_PATH).mtimeMs;
      expect(secondMtime).toBe(firstMtime);
    });

    it("rewrites the file when content has drifted", () => {
      fs.writeFileSync(EMPTY_MCP_CONFIG_PATH, '{"mcpServers":{"oops":{}}}', "utf-8");
      ensureEmptyMcpConfig();
      const raw = fs.readFileSync(EMPTY_MCP_CONFIG_PATH, "utf-8");
      expect(JSON.parse(raw)).toEqual({ mcpServers: {} });
    });

    it("rewrites the file when existing content is not valid JSON", () => {
      fs.writeFileSync(EMPTY_MCP_CONFIG_PATH, "not json", "utf-8");
      ensureEmptyMcpConfig();
      const raw = fs.readFileSync(EMPTY_MCP_CONFIG_PATH, "utf-8");
      expect(JSON.parse(raw)).toEqual({ mcpServers: {} });
    });
  });

  describe("appendStrictMcpArgs", () => {
    it("appends both flags when missing", () => {
      const result = appendStrictMcpArgs(["-p", "--verbose"], "/tmp/empty.json");
      expect(result).toEqual([
        "-p",
        "--verbose",
        "--strict-mcp-config",
        "--mcp-config",
        "/tmp/empty.json",
      ]);
    });

    it("is a no-op when both flags are already present", () => {
      const input = ["-p", "--strict-mcp-config", "--mcp-config", "/existing.json", "prompt"];
      const result = appendStrictMcpArgs(input, "/tmp/empty.json");
      expect(result).toEqual(input);
    });

    it("only adds --strict-mcp-config when --mcp-config is already present", () => {
      const input = ["-p", "--mcp-config", "/existing.json", "prompt"];
      const result = appendStrictMcpArgs(input, "/tmp/empty.json");
      expect(result).toEqual([
        "-p",
        "--mcp-config",
        "/existing.json",
        "prompt",
        "--strict-mcp-config",
      ]);
    });

    it("only adds --mcp-config when --strict-mcp-config is already present", () => {
      const input = ["-p", "--strict-mcp-config", "prompt"];
      const result = appendStrictMcpArgs(input, "/tmp/empty.json");
      expect(result).toEqual([
        "-p",
        "--strict-mcp-config",
        "prompt",
        "--mcp-config",
        "/tmp/empty.json",
      ]);
    });

    it("does not mutate the input array", () => {
      const input = ["-p", "--verbose"];
      const result = appendStrictMcpArgs(input, "/tmp/empty.json");
      expect(input).toEqual(["-p", "--verbose"]);
      expect(result).not.toBe(input);
    });

    it("throws when mcpConfigPath is undefined", () => {
      expect(() =>
        appendStrictMcpArgs(["-p", "--verbose"], undefined as unknown as string),
      ).toThrow(/non-empty string/);
    });

    it("throws when mcpConfigPath is an empty string", () => {
      expect(() => appendStrictMcpArgs(["-p", "--verbose"], "")).toThrow(/non-empty string/);
    });

    it("places the path immediately after --mcp-config even when a trailing positional prompt is present", () => {
      const result = appendStrictMcpArgs(["-p", "--verbose", "User prompt"], "/tmp/empty.json");
      const mcpIdx = result.indexOf("--mcp-config");
      expect(mcpIdx).toBeGreaterThanOrEqual(0);
      expect(result[mcpIdx + 1]).toBe("/tmp/empty.json");
      expect(result[mcpIdx + 1]).not.toBe("User prompt");
    });
  });
});
