import { describe, expect, it } from "vitest";
import { parseGitHubRemote } from "./git-privacy.js";

describe("parseGitHubRemote", () => {
  it("parses SSH format", () => {
    const result = parseGitHubRemote("git@github.com:owner/repo.git");
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses SSH format without .git", () => {
    const result = parseGitHubRemote("git@github.com:owner/repo");
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses HTTPS format", () => {
    const result = parseGitHubRemote("https://github.com/owner/repo.git");
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses HTTPS format without .git", () => {
    const result = parseGitHubRemote("https://github.com/owner/repo");
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  it("returns null for non-GitHub remote", () => {
    expect(parseGitHubRemote("git@gitlab.com:owner/repo.git")).toBeNull();
    expect(parseGitHubRemote("https://bitbucket.org/owner/repo.git")).toBeNull();
  });

  it("returns null for invalid URL", () => {
    expect(parseGitHubRemote("not-a-url")).toBeNull();
    expect(parseGitHubRemote("")).toBeNull();
  });
});

// isRepoPrivate() calls execFileSync so we test it with the URL parser only.
// Full integration tests would require mocking child_process.
describe("isRepoPrivate", () => {
  it("returns false when called in a non-git directory", async () => {
    // Dynamic import to avoid hoisting issues with vi.mock
    const { isRepoPrivate } = await import("./git-privacy.js");
    // /tmp is not a git repo, so this should return false
    expect(isRepoPrivate("/tmp")).toBe(false);
  });
});
