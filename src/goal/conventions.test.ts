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

describe("worker-context mirrors", () => {
  it("keeps source mirrors byte-identical and points workers at GLOSSARY.md", () => {
    const workerContextDir = path.join(process.cwd(), "src", "goal", "worker-context");
    const shared = fs.readFileSync(
      path.join(workerContextDir, "shared-worker-contract.md"),
      "utf8",
    );
    const agents = fs.readFileSync(path.join(workerContextDir, "AGENTS.md"), "utf8");
    const claude = fs.readFileSync(path.join(workerContextDir, "CLAUDE.md"), "utf8");

    expect(agents).toBe(shared);
    expect(claude).toBe(shared);
    expect(shared).toContain("GLOSSARY.md");
    expect(shared).toContain("Blocked, Failed, and Ralph");
    expect(shared).toContain(
      "When verifying a Task, check observable behavior end-to-end (what a user or caller can do and see), not internal wiring.",
    );
    expect(shared).toContain(
      "If a Task's core deliverable is test design/coverage or you must decide what to mock, see docs/goal-engine-guides/testing-guidance.md.",
    );
    expect(shared).toContain(
      "For a hard or intermittent failure, establish a fast, deterministic way to reproduce and check it before theorizing.",
    );
    expect(shared).toContain(
      "For hard or intermittent bugs, follow docs/goal-engine-guides/diagnosis-guide.md.",
    );
    expect(shared).toContain(
      "When a Task's approach is uncertain, prove the core path with the smallest runnable check before expanding.",
    );
    expect(shared).toContain("Don't add indirection that earns nothing.");
    expect(shared).toContain("docs/goal-engine-guides/wiki-conventions.md");
    expect(shared).not.toContain("form 3-5 ranked falsifiable hypotheses");
    expect(shared).not.toContain("[DEBUG-");
  });
});
