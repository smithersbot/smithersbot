import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Bot, Context } from "grammy";

import type { ChannelGroupPolicy } from "../config/group-policy.js";
import type { MoltbotConfig } from "../config/config.js";
import type {
  TelegramAccountConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "../config/types.js";
import { ensureWorkingDir, isGitRepo } from "../goal/git-checkpoint.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { resolveTelegramCommandAuth } from "./telegram-auth.js";

const CREATE_REPO_COMMAND = "create_repo";

export const CREATE_REPO_COMMAND_SPEC = {
  command: CREATE_REPO_COMMAND,
  description: "Create a private GitHub repo for a local directory",
} as const;

type TelegramCreateRepoContext = Context & {
  match?: string;
  message?: {
    chat: { id: number; type: string };
    from?: { id?: number };
  };
};

type RegisterCreateRepoCommandParams = {
  bot: Bot;
  cfg: MoltbotConfig;
  telegramCfg: TelegramAccountConfig;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  useAccessGroups: boolean;
  resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId?: number,
  ) => { groupConfig?: TelegramGroupConfig; topicConfig?: TelegramTopicConfig };
  shouldSkipUpdate: (ctx: unknown) => boolean;
};

/** Sanitize a directory name into a valid GitHub repo name. */
function sanitizeRepoName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[_ ]+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "my-repo"
  );
}

/** Resolve a user-supplied path to an absolute directory path, with fuzzy fallbacks. */
function resolveDirectoryPath(value: string): string | undefined {
  if (!value) return undefined;

  // Absolute or home-relative paths: resolve directly
  if (value.startsWith("~") || path.isAbsolute(value)) {
    const resolved = resolveUserPath(value);
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        return resolved;
      }
    } catch {
      // Fall through
    }
    return undefined;
  }

  // Relative: try common roots
  const cwd = process.cwd();
  const home = os.homedir();
  const candidates = new Set<string>();
  candidates.add(path.resolve(cwd, value));
  candidates.add(path.resolve(home, value));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Keep trying
    }
  }

  return undefined;
}

/** Check if a remote URL points to GitHub. */
function isGithubUrl(url: string): boolean {
  return /github\.com/i.test(url);
}

/** Get the origin remote URL, or null if none exists. */
function getOriginUrl(cwd: string): string | null {
  try {
    return execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

/** Get the current branch name. */
function getCurrentBranch(cwd: string): string {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch {
    return "main";
  }
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr = (error as { stderr?: Buffer | string }).stderr;
  const stderrText =
    typeof stderr === "string" ? stderr : stderr instanceof Buffer ? stderr.toString("utf8") : "";
  return stderrText.trim() || error.message;
}

export function registerCreateRepoCommand({
  bot,
  cfg,
  telegramCfg,
  allowFrom,
  groupAllowFrom,
  useAccessGroups,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
}: RegisterCreateRepoCommandParams): void {
  bot.command(CREATE_REPO_COMMAND, async (ctx: TelegramCreateRepoContext) => {
    const msg = ctx.message;
    if (!msg) return;
    if (shouldSkipUpdate(ctx)) return;

    const chatId = msg.chat.id;

    // Authenticate
    const auth = await resolveTelegramCommandAuth({
      msg,
      bot,
      cfg,
      telegramCfg,
      allowFrom,
      groupAllowFrom,
      useAccessGroups,
      resolveGroupPolicy,
      resolveTelegramGroupConfig,
      requireAuth: true,
    });
    if (!auth) return;

    const rawArgs = (ctx.match ?? "").trim();
    if (!rawArgs) {
      await bot.api.sendMessage(chatId, "Usage: /create_repo <path> [custom-repo-name]");
      return;
    }

    // Parse arguments: try full string as path first, then split off last token as custom name.
    // This handles paths with spaces like "~/Separation Agreement Context".
    let resolvedPath: string | undefined;
    let customRepoName: string | undefined;

    // Strategy 1: try the full rawArgs as a directory path
    resolvedPath = resolveDirectoryPath(rawArgs);

    if (!resolvedPath) {
      // Strategy 2: split off the last token as a candidate custom repo name
      const lastSpaceIdx = rawArgs.lastIndexOf(" ");
      if (lastSpaceIdx > 0) {
        const candidatePath = rawArgs.slice(0, lastSpaceIdx);
        const candidateName = rawArgs.slice(lastSpaceIdx + 1);
        resolvedPath = resolveDirectoryPath(candidatePath);
        if (resolvedPath) {
          customRepoName = candidateName;
        }
      }
    }

    if (!resolvedPath) {
      await bot.api.sendMessage(
        chatId,
        `Directory not found: ${rawArgs}\nPlease provide a valid directory path.`,
      );
      return;
    }

    // Ensure it's a git repo with at least one commit
    try {
      if (!isGitRepo(resolvedPath)) {
        ensureWorkingDir(resolvedPath);
        await bot.api.sendMessage(
          chatId,
          `Initialized git repo in ${shortenHomePath(resolvedPath)}`,
        );
      }
    } catch (err) {
      await bot.api.sendMessage(chatId, `Failed to initialize git repo: ${describeError(err)}`);
      return;
    }

    // Check if origin remote already exists
    const existingOrigin = getOriginUrl(resolvedPath);
    if (existingOrigin) {
      if (isGithubUrl(existingOrigin)) {
        await bot.api.sendMessage(
          chatId,
          `A GitHub remote already exists for this directory:\n${existingOrigin}`,
        );
        return;
      }
      await bot.api.sendMessage(
        chatId,
        `An origin remote already exists but is not GitHub:\n${existingOrigin}\nRemove it first if you want to create a GitHub repo.`,
      );
      return;
    }

    // Derive repo name
    const basename = path.basename(resolvedPath);
    const repoName = customRepoName ? sanitizeRepoName(customRepoName) : sanitizeRepoName(basename);

    // Verify gh CLI is available
    try {
      execFileSync("gh", ["--version"], { encoding: "utf8", timeout: 5000 });
    } catch {
      await bot.api.sendMessage(
        chatId,
        "The GitHub CLI (gh) is not installed or not in PATH. Please install it first.",
      );
      return;
    }

    // Verify gh is authenticated
    try {
      execFileSync("gh", ["auth", "status"], { encoding: "utf8", timeout: 10000 });
    } catch {
      await bot.api.sendMessage(
        chatId,
        "The GitHub CLI is not authenticated. Run `gh auth login` first.",
      );
      return;
    }

    // Create the private repo with gh
    try {
      execFileSync(
        "gh",
        ["repo", "create", repoName, "--private", "--source=.", "--remote=origin"],
        { cwd: resolvedPath, encoding: "utf8", timeout: 30000 },
      );
    } catch (err) {
      const errMsg = describeError(err);
      if (errMsg.includes("already exists")) {
        await bot.api.sendMessage(
          chatId,
          `A GitHub repo named "${repoName}" already exists. Choose a different name:\n/create_repo ${shortenHomePath(resolvedPath)} <new-name>`,
        );
      } else {
        await bot.api.sendMessage(chatId, `Failed to create repo: ${errMsg}`);
      }
      return;
    }

    // Push current branch to origin
    const branch = getCurrentBranch(resolvedPath);
    try {
      execFileSync("git", ["-C", resolvedPath, "push", "-u", "origin", branch], {
        encoding: "utf8",
        timeout: 60000,
      });
    } catch (err) {
      // Repo was created but push failed — still report the repo URL
      const repoUrl = getOriginUrl(resolvedPath) ?? `https://github.com/<user>/${repoName}`;
      await bot.api.sendMessage(
        chatId,
        `Repo created but initial push failed: ${describeError(err)}\nRepo: ${repoUrl}\nYou may need to push manually.`,
      );
      return;
    }

    // Success — get the repo URL from the new origin
    const repoUrl = getOriginUrl(resolvedPath) ?? `https://github.com/<user>/${repoName}`;
    // Normalize SSH URLs to HTTPS for display
    const displayUrl = repoUrl.replace(
      /^git@github\.com:(.+?)(?:\.git)?$/,
      "https://github.com/$1",
    );
    await bot.api.sendMessage(
      chatId,
      `Private GitHub repo created successfully!\n${displayUrl}\n\nDirectory: ${shortenHomePath(resolvedPath)}\nBranch "${branch}" pushed to origin.`,
    );
  });
}
