import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type GatewayInstanceName,
  type ObservedInstanceOptions,
  normalizeGatewayInstanceSelection,
  resolveGatewayInstanceFromEnv,
  resolveGatewayInstanceIdentity,
  resolveObservedInstanceSet,
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
  if (env.SMITHERSBOT_INSTANCE?.trim()) return instance.managedRoot;
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

/** Each root plus its realpath (when resolvable), de-duplicated. */
function withRealpaths(roots: string[]): string[] {
  const out = new Set<string>();
  for (const root of roots) {
    const resolved = path.resolve(root);
    out.add(resolved);
    const real = tryRealpath(resolved);
    if (real) out.add(real);
  }
  return [...out];
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

/**
 * Observed-instance surface (stable inspects another instance, read-only).
 *
 * These helpers resolve the AGENT-VISIBLE runtime surface of ANOTHER instance
 * (e.g. the dev gateway's ~/smithersbot-dev-home/agent) so the stable gateway
 * can read its workspaces and sanitized history for repo chat, diagnostics, and
 * context — while the observed instance's private/state (env, config, auth,
 * sessions, ~/.smithersbot-dev, Telegram tokens) stays sealed.
 *
 * CRITICAL invariants:
 *   - Built ONLY on the explicit {@link resolveGatewayInstanceIdentity} mapping,
 *     never on the current process's resolveManagedRoot or the checkout path.
 *   - Observation is EXPLICIT opt-in only ({@link resolveObservedInstanceSet});
 *     with no opt-in nothing resolves and the guard denies everything.
 *   - The observed state dir and private root are never resolved or exposed.
 *   - These do NOT alter the current process's own managed-root resolution.
 */

function requireObservedInstance(
  instanceName: string,
  options?: ObservedInstanceOptions,
): GatewayInstanceName {
  const name = normalizeGatewayInstanceSelection(instanceName);
  if (!resolveObservedInstanceSet(options).has(name)) {
    throw new Error(
      `Instance "${name}" is not an opted-in observed instance. ` +
        `Enable it explicitly via SMITHERSBOT_OBSERVED_INSTANCES or gateway.observedInstances.`,
    );
  }
  return name;
}

function observedManagedRoot(instanceName: GatewayInstanceName, homedir: () => string): string {
  // Built on the static instance identity, NOT the current process's resolveManagedRoot.
  return resolveGatewayInstanceIdentity(instanceName, homedir).managedRoot;
}

/** Observed instance managed root, e.g. ~/smithersbot-dev-home. Requires opt-in. */
export function resolveObservedManagedRoot(
  instanceName: string,
  options?: ObservedInstanceOptions,
): string {
  const name = requireObservedInstance(instanceName, options);
  return observedManagedRoot(name, options?.homedir ?? os.homedir);
}

/** Observed agent-visible root: <observed managed root>/agent. Requires opt-in. */
export function resolveObservedAgentRoot(
  instanceName: string,
  options?: ObservedInstanceOptions,
): string {
  return path.join(resolveObservedManagedRoot(instanceName, options), "agent");
}

/** Observed workspaces root: <observed managed root>/agent/workspaces. Requires opt-in. */
export function resolveObservedWorkspacesRoot(
  instanceName: string,
  options?: ObservedInstanceOptions,
): string {
  return path.join(resolveObservedAgentRoot(instanceName, options), "workspaces");
}

/** Observed goal history root: <observed managed root>/agent/history/goals. Requires opt-in. */
export function resolveObservedGoalHistoryRoot(
  instanceName: string,
  options?: ObservedInstanceOptions,
): string {
  return path.join(resolveObservedAgentRoot(instanceName, options), "history", "goals");
}

/** Observed repo-chat history root: <observed managed root>/agent/history/repo-chats. */
export function resolveObservedRepoChatHistoryRoot(
  instanceName: string,
  options?: ObservedInstanceOptions,
): string {
  return path.join(resolveObservedAgentRoot(instanceName, options), "history", "repo-chats");
}

/** Observed history index dir: <observed managed root>/agent/history/index. Requires opt-in. */
export function resolveObservedHistoryIndexDir(
  instanceName: string,
  options?: ObservedInstanceOptions,
): string {
  return path.join(resolveObservedAgentRoot(instanceName, options), "history", "index");
}

/**
 * Traversal-safe guard: true ONLY when `candidate` lies inside the observed
 * instance's allowed agent surface (agent, agent/workspaces, or agent/history)
 * AND every realpath candidate stays
 * within those subtrees.
 *
 * Returns false when:
 *   - the instance is not an opted-in observed instance (or no opt-in at all);
 *   - the path lies inside the observed private root or state dir
 *     (~/smithersbot-dev-home/private, ~/.smithersbot-dev);
 *   - any symlink/realpath escapes the allowed agent subtree (e.g. a symlink
 *     under agent/workspaces pointing into private/ or the state dir).
 */
export function isObservedAgentPathAllowed(
  candidate: string,
  instanceName: string,
  options?: ObservedInstanceOptions,
): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;

  const name = normalizeGatewayInstanceSelection(instanceName);
  if (!resolveObservedInstanceSet(options).has(name)) return false;

  const homedir = options?.homedir ?? os.homedir;
  const identity = resolveGatewayInstanceIdentity(name, homedir);
  const managedRoot = identity.managedRoot;
  const agentRoot = path.join(managedRoot, "agent");
  const privateRoot = path.join(managedRoot, "private");
  const stateDir = identity.stateDir;

  // Reject anything resolving into the observed private root or state dir.
  if (pathInsideAnyCandidate(candidate, privateRoot)) return false;
  if (pathInsideAnyCandidate(candidate, stateDir)) return false;

  // Allowed subtrees, plus their realpaths so a benign symlink in the path
  // prefix (e.g. /tmp -> /private/tmp) does not spuriously reject a real path.
  const allowedRoots = withRealpaths([
    agentRoot,
    path.join(agentRoot, "workspaces"),
    path.join(agentRoot, "history"),
    path.join(agentRoot, "history", "goals"),
    path.join(agentRoot, "history", "repo-chats"),
    path.join(agentRoot, "history", "index"),
  ]);

  // Every realpath candidate must stay inside one of the allowed subtrees, so a
  // symlink/mirror that escapes (into private, the state dir, or anywhere else)
  // is rejected even if its literal path is under an allowed root.
  const candidates = pathCandidates(candidate);
  return candidates.every((entry) => allowedRoots.some((root) => isInside(entry, root)));
}

/**
 * If `candidate` resolves into an opted-in observed instance's managed root or
 * state dir, return that instance name; otherwise undefined. This is the
 * "does this path belong to an observed instance at all" check, made BEFORE the
 * allow/deny split. Built only on the explicit instance identity mapping and the
 * explicit opt-in set — never inferred from the checkout/working directory.
 */
export function resolveObservedInstanceForPath(
  candidate: string,
  options?: ObservedInstanceOptions,
): GatewayInstanceName | undefined {
  if (typeof candidate !== "string" || candidate.length === 0) return undefined;
  const homedir = options?.homedir ?? os.homedir;
  for (const name of resolveObservedInstanceSet(options)) {
    const identity = resolveGatewayInstanceIdentity(name, homedir);
    if (
      pathInsideAnyCandidate(candidate, identity.managedRoot) ||
      pathInsideAnyCandidate(candidate, identity.stateDir)
    ) {
      return name;
    }
  }
  return undefined;
}

/**
 * Result of classifying an inspection target against the observed-instance set:
 *   - `none`   : not an observed-instance path (caller keeps its own behavior).
 *   - `agent`  : an allowed observed agent subtree — read-scope to `agentRoot`.
 *   - `sealed` : an observed private/state target — caller must refuse it.
 */
export type ObservedInspectionTarget =
  | { kind: "none" }
  | { kind: "agent"; instance: GatewayInstanceName; agentRoot: string }
  | { kind: "sealed"; instance: GatewayInstanceName };

/**
 * Classify a repo-chat / inspection target against the explicitly opted-in
 * observed instances, gating every observed path through
 * {@link isObservedAgentPathAllowed}. Callers translate `sealed` into their own
 * private-path refusal and use `agentRoot` to read-scope an allowed agent
 * subtree. With no opt-in this always returns `{ kind: "none" }`, so behavior for
 * the current process's own workspaces/history is unchanged.
 */
export function resolveObservedInspectionTarget(
  target: string,
  options?: ObservedInstanceOptions,
): ObservedInspectionTarget {
  const instance = resolveObservedInstanceForPath(target, options);
  if (!instance) return { kind: "none" };
  if (isObservedAgentPathAllowed(target, instance, options)) {
    return { kind: "agent", instance, agentRoot: resolveObservedAgentRoot(instance, options) };
  }
  return { kind: "sealed", instance };
}

/**
 * Sealed roots of an observed instance — its private root and state dir — that
 * must be DENIED to any inspection sandbox. This is the opposite of exposing
 * them: the paths are computed only to add them to backend deny lists so a broad
 * filesystem read grant cannot reach dev private state. Opt-in gated.
 */
export function resolveObservedSealedRoots(
  instanceName: string,
  options?: ObservedInstanceOptions,
): { privateRoot: string; stateDir: string } {
  const name = requireObservedInstance(instanceName, options);
  const identity = resolveGatewayInstanceIdentity(name, options?.homedir ?? os.homedir);
  return {
    privateRoot: path.join(identity.managedRoot, "private"),
    stateDir: identity.stateDir,
  };
}
