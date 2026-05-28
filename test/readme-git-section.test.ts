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
    expect(section).toContain("any workspace");
    expect(section).toContain("goal branch named like `smithersbot/<timestamp>-<goal-id>`");
    expect(section).toContain("Before each task, it records a checkpoint");
    expect(section).toContain("Local-only workspaces are valid");
    expect(section).toContain("/goal_github_push");
    expect(section).toContain("off by default");
    expect(section).toContain("links to the pushed branch at `tree/<branch-name>` for review");
    expect(section).toContain("does not automatically create pull requests");
    expect(section).toContain("push skip or failure is recorded");
    expect(section).toContain("GitHub CI");
    expect(section).toContain("local build/test gates are separate from GitHub CI");
    expect(section).not.toContain("claw/run/");
  });
});
