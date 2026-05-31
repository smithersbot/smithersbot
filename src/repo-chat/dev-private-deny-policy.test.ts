import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDevWorkspaceHardDenies, checkPathDeny, HARD_DENIES } from "../goal/hard-deny.js";
import {
  isSecretPath,
  SECRET_PATH_DENY_REASON,
  SECRET_PATH_PATTERNS,
} from "../security/secret-paths.js";

// Regression guard for "Issue 2" from the stable-to-dev isolation verification:
// a stable worker / repo-chat process running as the same OS user as the dev
// gateway was able to enumerate and read the dev instance's private roots
// (~/.smithersbot-dev and ~/smithersbot-dev-home/private). The stable
// worker/repo-chat deny policy must keep those roots denied for child
// enumeration and content reads, while leaving the dev agent-visible surface
// (~/smithersbot-dev-home/agent/{workspaces,history}) inspectable.
//
// These are pure policy assertions — no real secret files are read. Tilde-form
// paths exercise the static deny list directly; the mocked-home block proves
// the same decisions hold once paths are resolved to absolute form.

// Every dev private root and representative child that must stay denied. The
// pattern is the secret-path deny that should win, proving the entry is present.
const DENIED_PRIVATE_PATHS: ReadonlyArray<{ filePath: string; pattern: string }> = [
  // ~/.smithersbot-dev state dir — root contents and nested children.
  { filePath: "~/.smithersbot-dev/smithersbot.json", pattern: "~/.smithersbot-dev/**" },
  { filePath: "~/.smithersbot-dev/sessions/abc.json", pattern: "~/.smithersbot-dev/**" },
  { filePath: "~/.smithersbot-dev/config", pattern: "~/.smithersbot-dev/**" },
  // ~/smithersbot-dev-home/private — the four named subroots and deeper contents.
  {
    filePath: "~/smithersbot-dev-home/private/env",
    pattern: "~/smithersbot-dev-home/private/**",
  },
  {
    filePath: "~/smithersbot-dev-home/private/config",
    pattern: "~/smithersbot-dev-home/private/**",
  },
  {
    filePath: "~/smithersbot-dev-home/private/auth",
    pattern: "~/smithersbot-dev-home/private/**",
  },
  {
    filePath: "~/smithersbot-dev-home/private/sessions",
    pattern: "~/smithersbot-dev-home/private/**",
  },
  {
    filePath: "~/smithersbot-dev-home/private/env/ws/.env",
    pattern: "~/smithersbot-dev-home/private/**",
  },
  {
    filePath: "~/smithersbot-dev-home/private/auth/auth.json",
    pattern: "~/smithersbot-dev-home/private/**",
  },
  {
    filePath: "~/smithersbot-dev-home/private/config/config.json",
    pattern: "~/smithersbot-dev-home/private/**",
  },
  {
    filePath: "~/smithersbot-dev-home/private/sessions/session.json",
    pattern: "~/smithersbot-dev-home/private/**",
  },
];

// The dev agent-visible surface a stable worker is allowed to inspect.
const ALLOWED_AGENT_PATHS = [
  "~/smithersbot-dev-home/agent/workspaces",
  "~/smithersbot-dev-home/agent/workspaces/smithersbot-dev/package.json",
  "~/smithersbot-dev-home/agent/workspaces/smithersbot-dev/src/index.ts",
  "~/smithersbot-dev-home/agent/history",
  "~/smithersbot-dev-home/agent/history/goals/run.md",
  "~/smithersbot-dev-home/agent/history/repo-chats/chat.md",
] as const;

describe("dev private-root deny policy (stable worker / repo-chat)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("static deny patterns", () => {
    it("registers both dev private roots in the shared secret-path deny list", () => {
      expect(SECRET_PATH_PATTERNS).toContain("~/.smithersbot-dev/**");
      expect(SECRET_PATH_PATTERNS).toContain("~/smithersbot-dev-home/private/**");
    });

    it("carries the dev private-root denies into the dev-workspace hard-deny list", () => {
      const devDenies = buildDevWorkspaceHardDenies();
      const patterns = devDenies.filter((deny) => deny.type === "path").map((deny) => deny.pattern);
      expect(patterns).toContain("~/.smithersbot-dev/**");
      expect(patterns).toContain("~/smithersbot-dev-home/private/**");
    });
  });

  describe("denies private-root enumeration and contents", () => {
    it.each(DENIED_PRIVATE_PATHS)(
      "denies $filePath via the stable HARD_DENIES policy",
      ({ filePath, pattern }) => {
        const deny = checkPathDeny(filePath);
        expect(deny?.reason).toBe(SECRET_PATH_DENY_REASON);
        expect(deny?.pattern).toBe(pattern);
      },
    );

    it.each(DENIED_PRIVATE_PATHS)(
      "denies $filePath via the dev-workspace deny list too",
      ({ filePath }) => {
        const deny = checkPathDeny(filePath, buildDevWorkspaceHardDenies());
        expect(deny?.reason).toBe(SECRET_PATH_DENY_REASON);
      },
    );

    it("treats the private roots as secret for the repo-chat secret-path check", () => {
      const homeDir = path.join(path.sep, "home", "fixture-user");
      for (const { filePath } of DENIED_PRIVATE_PATHS) {
        const absolute = path.join(homeDir, filePath.slice(2));
        expect(isSecretPath(absolute, { homeDir })).toBe(true);
      }
    });

    it("denies child enumeration once private roots resolve to absolute paths", () => {
      const home = path.join(path.sep, "home", "fixture-user");
      vi.spyOn(os, "homedir").mockReturnValue(home);
      const childPaths = [
        path.join(home, ".smithersbot-dev", "sessions"),
        path.join(home, ".smithersbot-dev", "smithersbot.json"),
        path.join(home, "smithersbot-dev-home", "private", "env"),
        path.join(home, "smithersbot-dev-home", "private", "config"),
        path.join(home, "smithersbot-dev-home", "private", "auth"),
        path.join(home, "smithersbot-dev-home", "private", "sessions"),
        path.join(home, "smithersbot-dev-home", "private", "env", "ws", ".env"),
      ];
      for (const childPath of childPaths) {
        expect(checkPathDeny(childPath)?.reason).toBe(SECRET_PATH_DENY_REASON);
      }
    });
  });

  describe("exact-root metadata visibility (unavoidable, same OS user)", () => {
    // ls -ld of the bare root is acceptable; child enumeration / contents are
    // denied by the cases above. This documents the deliberate boundary.
    it("leaves bare-root metadata of the known private roots visible", () => {
      expect(checkPathDeny("~/.smithersbot-dev")).toBeNull();
      expect(checkPathDeny("~/smithersbot-dev-home/private")).toBeNull();
    });
  });

  describe("dev agent-visible surface stays inspectable", () => {
    it.each(ALLOWED_AGENT_PATHS)("permits %s via the stable HARD_DENIES policy", (filePath) => {
      expect(checkPathDeny(filePath)).toBeNull();
    });

    it.each(ALLOWED_AGENT_PATHS)("permits %s via the dev-workspace deny list", (filePath) => {
      expect(checkPathDeny(filePath, buildDevWorkspaceHardDenies())).toBeNull();
    });

    it("does not treat the dev agent surface as secret for the repo-chat check", () => {
      const homeDir = path.join(path.sep, "home", "fixture-user");
      for (const filePath of ALLOWED_AGENT_PATHS) {
        const absolute = path.join(homeDir, filePath.slice(2));
        expect(isSecretPath(absolute, { homeDir })).toBe(false);
      }
    });
  });

  describe("does not weaken existing stable safety", () => {
    it("still denies the stable ~/.smithersbot config root", () => {
      expect(checkPathDeny("~/.smithersbot/smithersbot.json")?.reason).toBe(
        SECRET_PATH_DENY_REASON,
      );
      expect(SECRET_PATH_PATTERNS).toContain("~/.smithersbot/**");
    });

    it("keeps the base HARD_DENIES list intact (no entries removed)", () => {
      expect(HARD_DENIES.some((deny) => deny.pattern === "~/.smithersbot-dev/**")).toBe(true);
      expect(HARD_DENIES.some((deny) => deny.pattern === "~/smithersbot-dev-home/private/**")).toBe(
        true,
      );
    });
  });
});
