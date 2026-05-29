import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveGatewayInstanceFromEnv,
  resolveGatewayInstanceIdentity,
} from "./gateway-instance.js";

/**
 * Managed-workspace path model (Stage 2S).
 *
 * SmithersBot owns a managed root directory that separates two trust zones:
 *
 *   <root>/agent/    - agent-visible (workspaces, sanitized history, indexes)
 *   <root>/private/  - host-only (real env, config, auth, sessions)
 *   <root>/scratch/  - gateway-controlled temporary state
 *
 * Agents (goal workers, repo chat) operate inside <root>/agent. Real env files
 * live in <root>/private/env/<workspace-name>/.env and are not agent-visible.
 *
 * Legacy state directories (~/.smithersbot, ~/.moltbot, ~/.clawdbot) remain
 * supported through the resolvers in ./paths.ts; this file only describes the
 * NEW managed root and adds nothing to the legacy resolution behavior.
 */

export const DEFAULT_MANAGED_ROOT_DIRNAME =
  resolveGatewayInstanceIdentity("stable").managedRootDirName;

const LEGACY_DEFAULT_MANAGED_ROOT_DIRNAME = "smithersbot-goals";

const WORKSPACE_NAME_MAX_LENGTH = 64;

function expandUserPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("~")) {
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, os.homedir());
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}

function isExistingDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the SmithersBot managed root.
 *
 * Default: ~/smithersbot-home.
 * Override: SMITHERSBOT_GOALS_ROOT.
 *
 * Existing installs that used the former ~/smithersbot-goals default continue
 * to resolve there when the new default path is absent.
 */
export function resolveManagedRoot(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const override = env.SMITHERSBOT_GOALS_ROOT?.trim();
  if (override) return expandUserPath(override);
  const home = homedir();
  const instance = resolveGatewayInstanceFromEnv(env, homedir);
  const defaultRoot = instance.managedRoot;
  const legacyRoot = path.join(home, LEGACY_DEFAULT_MANAGED_ROOT_DIRNAME);
  if (
    instance.legacyManagedRootFallback &&
    !isExistingDirectory(defaultRoot) &&
    isExistingDirectory(legacyRoot)
  ) {
    return legacyRoot;
  }
  return defaultRoot;
}

/** Agent-visible root: <root>/agent. */
export function resolveAgentRoot(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return path.join(resolveManagedRoot(env, homedir), "agent");
}

/** Managed workspaces root: <root>/agent/workspaces. */
export function resolveWorkspacesRoot(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return path.join(resolveAgentRoot(env, homedir), "workspaces");
}

/** Private host-only root: <root>/private. */
export function resolvePrivateRoot(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return path.join(resolveManagedRoot(env, homedir), "private");
}

/** Scratch root: <root>/scratch. */
export function resolveScratchRoot(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return path.join(resolveManagedRoot(env, homedir), "scratch");
}

function hasControlOrWhitespace(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
    // U+0020 (space) and other whitespace
    if (/\s/.test(value[i] ?? "")) return true;
  }
  return false;
}

/**
 * Convert an arbitrary workspace identifier into a safe slug suitable for use
 * as a path segment. Rejects values that look like path traversal attempts,
 * absolute paths, control characters, or empty/whitespace-only input.
 *
 * The resulting slug:
 *   - is non-empty
 *   - contains only [A-Za-z0-9._-]
 *   - does not start with `.` or `-`
 *   - is at most WORKSPACE_NAME_MAX_LENGTH characters
 */
export function slugifyWorkspaceName(input: unknown): string {
  if (typeof input !== "string") {
    throw new TypeError("workspace name must be a string");
  }
  const raw = input;
  if (raw.length === 0 || raw.trim().length === 0) {
    throw new Error("workspace name must not be empty");
  }
  if (hasControlOrWhitespace(raw)) {
    throw new Error("workspace name contains whitespace or control characters");
  }
  if (raw.includes("..")) {
    throw new Error("workspace name must not contain '..'");
  }
  if (raw.startsWith("/") || raw.startsWith("\\")) {
    throw new Error("workspace name must not start with a path separator");
  }
  if (path.isAbsolute(raw)) {
    throw new Error("workspace name must not be an absolute path");
  }
  if (raw.includes("/") || raw.includes("\\")) {
    throw new Error("workspace name must not contain path separators");
  }
  if (raw.includes("\0")) {
    throw new Error("workspace name must not contain null bytes");
  }

  const slug = raw.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  if (slug.length === 0) {
    throw new Error("workspace name has no safe characters after slugification");
  }
  if (slug === "." || slug === "..") {
    throw new Error("workspace name resolves to a reserved path segment");
  }
  return slug.slice(0, WORKSPACE_NAME_MAX_LENGTH);
}

function isGitDir(candidate: string): boolean {
  try {
    return fs.statSync(path.join(candidate, ".git")).isDirectory();
  } catch {
    return false;
  }
}

function isNonEmptyDir(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory() && fs.readdirSync(candidate).length > 0;
  } catch {
    return false;
  }
}

function workspaceRootHasProject(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isDirectory()) return true;
  } catch {
    return false;
  }

  if (isGitDir(candidate)) return true;

  const entries = fs.readdirSync(candidate);
  if (entries.length === 0) return false;

  const nonLegacyEntries = entries.filter((entry) => entry !== "repo");
  return nonLegacyEntries.length > 0;
}

/** Workspace project path: <root>/agent/workspaces/<name>, with legacy <name>/repo fallback. */
export function resolveWorkspaceRepoDir(
  workspaceName: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const slug = slugifyWorkspaceName(workspaceName);
  const workspaceRoot = path.join(resolveAgentRoot(env, homedir), "workspaces", slug);
  if (!isPathInsideAgentRoot(workspaceRoot, env, homedir)) {
    throw new Error("resolved workspace path must stay inside the managed agent root");
  }

  const legacyRepo = path.join(workspaceRoot, "repo");
  if (
    !workspaceRootHasProject(workspaceRoot) &&
    isPathInsideAgentRoot(legacyRepo, env, homedir) &&
    (isGitDir(legacyRepo) || isNonEmptyDir(legacyRepo))
  ) {
    return legacyRepo;
  }

  return workspaceRoot;
}

/** Agent-readable goal history dir: <root>/agent/history/goals/<workspace>/<goal-id>. */
export function resolveAgentGoalHistoryDir(
  workspaceName: string,
  goalId: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const workspaceSlug = slugifyWorkspaceName(workspaceName);
  const goalSlug = slugifyWorkspaceName(goalId);
  return path.join(resolveAgentRoot(env, homedir), "history", "goals", workspaceSlug, goalSlug);
}

/** Agent-readable repo-chat history dir: <root>/agent/history/repo-chats/<workspace>. */
export function resolveAgentRepoChatHistoryDir(
  workspaceName: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const slug = slugifyWorkspaceName(workspaceName);
  return path.join(resolveAgentRoot(env, homedir), "history", "repo-chats", slug);
}

/** Agent-readable history index dir: <root>/agent/history/index. */
export function resolveAgentHistoryIndexDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return path.join(resolveAgentRoot(env, homedir), "history", "index");
}

/** Private env file for a workspace: <root>/private/env/<workspace>/.env. */
export function resolvePrivateEnvFile(
  workspaceName: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const slug = slugifyWorkspaceName(workspaceName);
  return path.join(resolvePrivateRoot(env, homedir), "env", slug, ".env");
}

/** Private env workspace dir: <root>/private/env/<workspace>. */
export function resolvePrivateEnvDir(
  workspaceName: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const slug = slugifyWorkspaceName(workspaceName);
  return path.join(resolvePrivateRoot(env, homedir), "env", slug);
}

/** Private config dir: <root>/private/config. */
export function resolvePrivateConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return path.join(resolvePrivateRoot(env, homedir), "config");
}

/** Private auth dir: <root>/private/auth. */
export function resolvePrivateAuthDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return path.join(resolvePrivateRoot(env, homedir), "auth");
}

/** Private sessions dir: <root>/private/sessions. */
export function resolvePrivateSessionsDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return path.join(resolvePrivateRoot(env, homedir), "sessions");
}

/** Scratch dir for a run+task: <root>/scratch/<run-id>/<task-id>. */
export function resolveScratchDir(
  runId: string,
  taskId: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const runSlug = slugifyWorkspaceName(runId);
  const taskSlug = slugifyWorkspaceName(taskId);
  return path.join(resolveScratchRoot(env, homedir), runSlug, taskSlug);
}

function isInside(child: string, parent: string): boolean {
  const normalizedParent = path.resolve(parent);
  const normalizedChild = path.resolve(child);
  if (normalizedChild === normalizedParent) return true;
  const rel = path.relative(normalizedParent, normalizedChild);
  if (!rel) return true;
  if (rel.startsWith("..")) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

function tryRealpath(candidate: string): string | undefined {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return undefined;
  }
}

function pathCandidates(candidate: string): string[] {
  const resolved = path.resolve(candidate);
  const candidates = new Set<string>([resolved]);
  const leafRealpath = tryRealpath(resolved);
  if (leafRealpath) candidates.add(leafRealpath);

  const parsed = path.parse(resolved);
  const parts = path.relative(parsed.root, resolved).split(path.sep).filter(Boolean);
  let current = parsed.root;

  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    const realAncestor = tryRealpath(current);
    if (!realAncestor) continue;
    candidates.add(path.join(realAncestor, ...parts.slice(index + 1)));
  }

  return [...candidates];
}

function pathInsideAnyCandidate(candidate: string, parent: string): boolean {
  return pathCandidates(candidate).some((entry) => isInside(entry, parent));
}

/** True when `candidate` lies inside <root>/agent. */
export function isPathInsideAgentRoot(
  candidate: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  if (pathInsideAnyCandidate(candidate, resolvePrivateRoot(env, homedir))) return false;
  return pathInsideAnyCandidate(candidate, resolveAgentRoot(env, homedir));
}

/**
 * True when `candidate` lies inside <root>/agent/workspaces. Traversal-safe:
 * resolves real paths and rejects `..` escapes via {@link pathInsideAnyCandidate}.
 */
export function isPathInsideWorkspacesRoot(
  candidate: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  return pathInsideAnyCandidate(candidate, resolveWorkspacesRoot(env, homedir));
}

/** True when `candidate` lies inside <root>/private. */
export function isPathInsidePrivateRoot(
  candidate: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  return pathInsideAnyCandidate(candidate, resolvePrivateRoot(env, homedir));
}

/** True when `candidate` lies inside the managed root (agent, private, or scratch). */
export function isPathInsideManagedRoot(
  candidate: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  return pathInsideAnyCandidate(candidate, resolveManagedRoot(env, homedir));
}
