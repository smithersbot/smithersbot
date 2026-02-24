import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureGlobalConventions } from "./conventions.js";

describe("ensureGlobalConventions", () => {
  let tempHome: string;

  const claudePath = () => path.join(tempHome, ".claude", "CLAUDE.md");
  const codexPath = () => path.join(tempHome, ".codex", "AGENTS.md");

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "goal-conventions-home-"));
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("creates both global convention files when missing", () => {
    ensureGlobalConventions();

    expect(fs.existsSync(claudePath())).toBe(true);
    expect(fs.existsSync(codexPath())).toBe(true);
  });

  it("does not overwrite existing global convention files", () => {
    fs.mkdirSync(path.dirname(claudePath()), { recursive: true });
    fs.mkdirSync(path.dirname(codexPath()), { recursive: true });
    fs.writeFileSync(claudePath(), "custom claude\n", "utf8");
    fs.writeFileSync(codexPath(), "custom codex\n", "utf8");

    ensureGlobalConventions();

    expect(fs.readFileSync(claudePath(), "utf8")).toBe("custom claude\n");
    expect(fs.readFileSync(codexPath(), "utf8")).toBe("custom codex\n");
  });

  it("writes concise files with required workflow principles", () => {
    ensureGlobalConventions();

    const claude = fs.readFileSync(claudePath(), "utf8");
    const codex = fs.readFileSync(codexPath(), "utf8");

    expect(claude).toContain("Verify before done");
    expect(claude).toContain("more elegant solution");
    expect(claude).toContain("bug report");
    expect(claude).toContain("commits concise");
    expect(claude).toContain("minimal, focused changes");

    expect(codex).toContain("Verify before done");
    expect(codex).toContain("more elegant solution");
    expect(codex).toContain("bug report");
    expect(codex).toContain("commits concise");
    expect(codex).toContain("minimal, focused changes");

    expect(claude.trimEnd().split("\n").length).toBeLessThanOrEqual(40);
    expect(codex.trimEnd().split("\n").length).toBeLessThanOrEqual(40);
  });
});
