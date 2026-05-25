import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readmePath = path.join(repoRoot, "README.md");

describe("README Git section", () => {
  it("documents cross-workspace Git behavior and launch push expectations", () => {
    const readme = fs.readFileSync(readmePath, "utf8");
    const section = readme.match(/### Git across workspaces\n\n(?<body>[\s\S]*?)(?:\n### |\n## |$)/)
      ?.groups?.body;

    expect(section).toBeDefined();
    expect(section).toContain("any workspace repo");
    expect(section).toContain("goal's working directory");
    expect(section).toContain("claw/run/<timestamp>-<goal-id>");
    expect(section).toContain("autosaves a dirty tree");
    expect(section).toContain("per-task checkpoint commits");
    expect(section).toContain("Git reset");
    expect(section).toContain('no separate final "goal complete" commit');
    expect(section).toContain("Local-only workspaces are valid");
    expect(section).toContain("/goal_github_push");
    expect(section).toContain("off by default");
    expect(section).toContain("push skip or failure is recorded");
    expect(section).toContain("GitHub CI");
    expect(section).toContain("local verification gates are separate from GitHub CI");
  });
});
