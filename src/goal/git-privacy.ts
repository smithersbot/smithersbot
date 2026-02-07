// Git privacy guard: checks whether the current repo's GitHub remote is private.
// Used by the capability enforcement layer to gate git push operations.

import { execFileSync } from "node:child_process";

const GH_TIMEOUT_MS = 10_000;

/** Parse owner/repo from a GitHub remote URL. Returns null on non-GitHub or parse failure. */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  // SSH format: git@github.com:owner/repo.git
  const sshMatch = /github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(url);
  if (sshMatch?.[1] && sshMatch[2]) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  // HTTPS format: https://github.com/owner/repo.git
  const httpsMatch = /github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(url);
  if (httpsMatch?.[1] && httpsMatch[2]) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  return null;
}

/**
 * Check if the repository at `workingDir` is private on GitHub.
 *
 * Returns false (treat as public = denied) on ANY error:
 * - No `gh` CLI available
 * - Non-GitHub remote
 * - Network failure or timeout
 * - Parse failure
 */
export function isRepoPrivate(workingDir: string): boolean {
  try {
    // Get remote URL
    const remoteUrl = execFileSync("git", ["-C", workingDir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: GH_TIMEOUT_MS,
    }).trim();

    const parsed = parseGitHubRemote(remoteUrl);
    if (!parsed) return false; // Non-GitHub remote

    // Query GitHub API
    const result = execFileSync(
      "gh",
      ["api", `repos/${parsed.owner}/${parsed.repo}`, "--jq", ".private"],
      {
        encoding: "utf8",
        timeout: GH_TIMEOUT_MS,
      },
    ).trim();

    return result === "true";
  } catch {
    // Any error → treat as public → deny push
    return false;
  }
}
