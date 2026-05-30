import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type GatewayInstanceName,
  resolveGatewayInstanceIdentity,
} from "../config/gateway-instance.js";
import {
  isObservedAgentPathAllowed,
  resolveObservedInstanceForPath,
  resolveWorkspacesRoot,
} from "../config/managed-paths.js";
import type { GoalConfig } from "../config/types.goal.js";

const GATEWAY_INSTANCE_NAMES: GatewayInstanceName[] = ["stable", "dev"];

const HOME_SENSITIVE_DIRS = [
  ".aws",
  ".clawdbot",
  ".clawdbot-dev",
  ".claude",
  ".codex",
  ".config",
  ".gnupg",
  ".moltbot",
  ".smithersbot",
  ".smithersbot-dev",
  ".ssh",
];

type GoalWorkspacePolicyOptions = {
  config?: GoalConfig;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  instance?: string | null;
  observedInstances?: Iterable<string> | null;
  onWarning?: (message: string) => void;
};

export type GoalWorkerWorkspaceParams = GoalWorkspacePolicyOptions & {
  workingDir: string;
};

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

function pathResolvesInsideAnyRoot(candidate: string, roots: string[]): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const allowedRoots = withRealpaths(roots);
  const candidates = pathCandidates(candidate);
  return candidates.every((entry) => allowedRoots.some((root) => isInside(entry, root)));
}

function pathTouchesRoot(candidate: string, root: string): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  return pathCandidates(candidate).some((entry) =>
    withRealpaths([root]).some((rootCandidate) => isInside(entry, rootCandidate)),
  );
}

function resolveCurrentInstance(
  options: GoalWorkspacePolicyOptions,
): ReturnType<typeof resolveGatewayInstanceIdentity> {
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? os.homedir;
  return resolveGatewayInstanceIdentity(options.instance ?? env.SMITHERSBOT_INSTANCE, homedir);
}

function envForInstance(options: GoalWorkspacePolicyOptions): NodeJS.ProcessEnv {
  const env = options.env ?? process.env;
  const instance = resolveCurrentInstance(options);
  return { ...env, SMITHERSBOT_INSTANCE: instance.name };
}

function observedOptions(options: GoalWorkspacePolicyOptions): {
  observedInstances?: Iterable<string> | null;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
} {
  return {
    observedInstances: options.observedInstances,
    env: options.env,
    homedir: options.homedir,
  };
}

function foreignInstanceForPath(
  candidate: string,
  currentInstanceName: GatewayInstanceName,
  homedir: () => string,
): GatewayInstanceName | undefined {
  for (const instanceName of GATEWAY_INSTANCE_NAMES) {
    if (instanceName === currentInstanceName) continue;
    const identity = resolveGatewayInstanceIdentity(instanceName, homedir);
    if (pathTouchesRoot(candidate, identity.managedRoot)) return instanceName;
    if (pathTouchesRoot(candidate, identity.stateDir)) return instanceName;
  }
  return undefined;
}

function homeSensitiveRootForPath(candidate: string, homedir: () => string): string | undefined {
  const home = homedir();
  for (const dirname of HOME_SENSITIVE_DIRS) {
    const sensitiveRoot = path.join(home, dirname);
    if (pathTouchesRoot(candidate, sensitiveRoot)) return sensitiveRoot;
  }
  return undefined;
}

function invalidWorkingDirError(params: {
  workingDir: string;
  currentInstanceName: GatewayInstanceName;
  currentWorkspacesRoot: string;
  detail?: string;
}): Error {
  const detail = params.detail ? ` ${params.detail}` : "";
  return new Error(
    `Goal worker workspace "${params.workingDir}" is outside the current ${params.currentInstanceName} instance's own agent/workspaces tree (${params.currentWorkspacesRoot}).${detail} Choose a workingDir under ${params.currentWorkspacesRoot}.`,
  );
}

/**
 * Enforce the executable/editable goal workspace invariant.
 *
 * A goal worker working directory must resolve under the current gateway
 * instance's own <managed-root>/agent/workspaces tree. Observed instance
 * surfaces may be readable context elsewhere, but they are never accepted as
 * executable/editable goal working directories.
 */
export function assertWorkingDirInsideCurrentInstanceWorkspaces(
  params: GoalWorkerWorkspaceParams,
): void {
  const homedir = params.homedir ?? os.homedir;
  const currentInstance = resolveCurrentInstance(params);
  const env = envForInstance(params);
  const currentWorkspacesRoot = resolveWorkspacesRoot(env, homedir);
  const workingDir = params.workingDir;

  const currentPrivateRoot = path.join(
    path.dirname(path.dirname(currentWorkspacesRoot)),
    "private",
  );
  if (pathTouchesRoot(workingDir, currentPrivateRoot)) {
    throw invalidWorkingDirError({
      workingDir,
      currentInstanceName: currentInstance.name,
      currentWorkspacesRoot,
      detail:
        "It resolves inside SmithersBot private paths, which are never executable goal workspaces.",
    });
  }

  const observedInstance = resolveObservedInstanceForPath(workingDir, observedOptions(params));
  const observedForeignInstance =
    observedInstance && observedInstance !== currentInstance.name ? observedInstance : undefined;
  const foreignInstance =
    observedForeignInstance ?? foreignInstanceForPath(workingDir, currentInstance.name, homedir);
  if (foreignInstance) {
    const isReadableObservedAgentPath = isObservedAgentPathAllowed(
      workingDir,
      foreignInstance,
      observedOptions(params),
    );
    throw invalidWorkingDirError({
      workingDir,
      currentInstanceName: currentInstance.name,
      currentWorkspacesRoot,
      detail: isReadableObservedAgentPath
        ? `It is an observed/foreign ${foreignInstance} agent surface that is read-only for context, not an executable goal workspace.`
        : `It belongs to the foreign ${foreignInstance} gateway instance and cannot be used by the current instance for goal execution.`,
    });
  }

  const currentStateDir = currentInstance.stateDir;
  if (pathTouchesRoot(workingDir, currentStateDir)) {
    throw invalidWorkingDirError({
      workingDir,
      currentInstanceName: currentInstance.name,
      currentWorkspacesRoot,
      detail: "It resolves inside the gateway state/config directory.",
    });
  }

  const homeSensitiveRoot = homeSensitiveRootForPath(workingDir, homedir);
  if (homeSensitiveRoot) {
    throw invalidWorkingDirError({
      workingDir,
      currentInstanceName: currentInstance.name,
      currentWorkspacesRoot,
      detail: `It resolves inside the home/config/auth/session-sensitive root ${homeSensitiveRoot}.`,
    });
  }

  if (pathResolvesInsideAnyRoot(workingDir, [currentWorkspacesRoot])) return;

  throw invalidWorkingDirError({
    workingDir,
    currentInstanceName: currentInstance.name,
    currentWorkspacesRoot,
  });
}

export function assertGoalWorkerWorkspace(params: GoalWorkerWorkspaceParams): void {
  assertWorkingDirInsideCurrentInstanceWorkspaces(params);
}
