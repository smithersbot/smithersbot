import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "./tools.js";

describe("executeTool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-tools-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("npm_init in dot-prefixed directory", () => {
    it("seeds valid package name for dot-prefixed dirs", () => {
      const dotDir = path.join(tmpDir, ".my-workspace");
      fs.mkdirSync(dotDir, { recursive: true });

      const result = executeTool({ name: "npm_init", args: { directory: "." } }, dotDir);

      expect(result.success).toBe(true);
      const pkg = JSON.parse(fs.readFileSync(path.join(dotDir, "package.json"), "utf8"));
      // Name should not start with "." — the seed package.json should have sanitized it
      expect(pkg.name).not.toMatch(/^\./);
      expect(pkg.name).toBe("my-workspace");
    });

    it("does not overwrite existing package.json in dot-prefixed dir", () => {
      const dotDir = path.join(tmpDir, ".custom");
      fs.mkdirSync(dotDir, { recursive: true });
      fs.writeFileSync(
        path.join(dotDir, "package.json"),
        JSON.stringify({ name: "custom-name", version: "2.0.0" }),
        "utf8",
      );

      const result = executeTool({ name: "npm_init", args: { directory: "." } }, dotDir);

      expect(result.success).toBe(true);
      const pkg = JSON.parse(fs.readFileSync(path.join(dotDir, "package.json"), "utf8"));
      // Existing name should be preserved
      expect(pkg.name).toBe("custom-name");
    });

    it("works normally for non-dot-prefixed dirs", () => {
      const normalDir = path.join(tmpDir, "my-project");
      fs.mkdirSync(normalDir, { recursive: true });

      const result = executeTool({ name: "npm_init", args: { directory: "." } }, normalDir);

      expect(result.success).toBe(true);
      const pkg = JSON.parse(fs.readFileSync(path.join(normalDir, "package.json"), "utf8"));
      expect(pkg.name).toBe("my-project");
    });
  });
});
