import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SECRET_PATH_DENY_REASON =
  "is a local secret/config file. Workers cannot read SmithersBot config; ask the user to relay any required value.";

export const SECRET_PATH_PATTERNS = [
  "~/.smithersbot/**",
  "~/.smithersbot/.env",
  "~/.smithersbot/smithersbot.json",
  "~/.smithersbot/credentials/**",
  "~/.smithersbot/sessions/**",
  "~/.moltbot/**",
  "~/.moltbot/.env",
  "~/.moltbot/moltbot.json",
  "~/.clawdbot/**",
  "~/.clawdbot/.env",
  "~/.clawdbot/clawdbot.json",
  "~/.clawdbot/credentials/**",
  "~/.clawdbot-dev/**",
  "~/.claude/**",
  "~/.codex/**",
  ".env",
  ".env.*",
  "*.env",
  "**/.env",
  "**/.env.*",
  "smithersbot.json",
  "moltbot.json",
  "clawdbot.json",
  "goal-lessons.json",
  "oauth.json",
  "credentials*.json",
  "*.token",
  "*.pem",
  "*.key",
  "*.crt",
  "*.cer",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  ".ssh/**",
  ".gnupg/**",
  ".aws/**",
  "*id_rsa*",
  "*id_ed25519*",
  "*id_ecdsa*",
  "*id_dsa*",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  "service-account*.json",
  "gcloud*.json",
  "*.tfvars",
  ".tfstate",
  "kubeconfig",
] as const;

export type SecretPathPattern = (typeof SECRET_PATH_PATTERNS)[number];

export interface IsSecretPathOptions {
  cwd?: string;
  homeDir?: string;
}

const HOME_SECRET_DIRS = [
  ".smithersbot",
  ".moltbot",
  ".clawdbot",
  ".clawdbot-dev",
  ".claude",
  ".codex",
] as const;

const SECRET_DIR_NAMES = new Set([".ssh", ".gnupg", ".aws"]);
const SECRET_FILE_NAMES = new Set([
  ".env",
  "smithersbot.json",
  "moltbot.json",
  "clawdbot.json",
  "goal-lessons.json",
  "oauth.json",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  ".tfstate",
  "kubeconfig",
]);

const SECRET_FILE_EXTENSIONS = new Set([
  ".env",
  ".token",
  ".pem",
  ".key",
  ".crt",
  ".cer",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".tfvars",
]);

function normalizePath(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, "/");
}

function expandHome(filePath: string, homeDir: string): string {
  if (filePath === "~") {
    return homeDir;
  }
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(homeDir, filePath.slice(2));
  }
  return filePath;
}

function resolveInputPath(filePath: string, options: Required<IsSecretPathOptions>): string {
  const expanded = expandHome(filePath, options.homeDir);
  return path.isAbsolute(expanded) ? expanded : path.resolve(options.cwd, expanded);
}

function tryRealpath(filePath: string): string | undefined {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return undefined;
  }
}

function getResolvedPathCandidates(filePath: string): string[] {
  const resolved = path.resolve(filePath);
  const candidates = new Set<string>([normalizePath(resolved)]);

  const leafRealpath = tryRealpath(resolved);
  if (leafRealpath) {
    candidates.add(normalizePath(leafRealpath));
  }

  const parsed = path.parse(resolved);
  const relativeParts = path.relative(parsed.root, resolved).split(path.sep).filter(Boolean);
  let current = parsed.root;

  for (let index = 0; index < relativeParts.length; index += 1) {
    current = path.join(current, relativeParts[index]!);
    const realAncestor = tryRealpath(current);
    if (!realAncestor) {
      continue;
    }

    const remainingParts = relativeParts.slice(index + 1);
    candidates.add(normalizePath(path.join(realAncestor, ...remainingParts)));
  }

  return [...candidates];
}

function isWithinDirectory(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hasSecretHomePrefix(candidate: string, homeDir: string): boolean {
  return HOME_SECRET_DIRS.some((dirName) =>
    isWithinDirectory(candidate, path.join(homeDir, dirName)),
  );
}

function hasSecretDirectorySegment(parts: string[]): boolean {
  return parts.some((part) => SECRET_DIR_NAMES.has(part));
}

function hasSecretFileName(baseName: string): boolean {
  const lower = baseName.toLowerCase();
  if (SECRET_FILE_NAMES.has(lower)) {
    return true;
  }
  if (lower.startsWith(".env.")) {
    return true;
  }
  if (lower.startsWith("credentials") && lower.endsWith(".json")) {
    return true;
  }
  if (lower.startsWith("service-account") && lower.endsWith(".json")) {
    return true;
  }
  if (lower.startsWith("gcloud") && lower.endsWith(".json")) {
    return true;
  }
  if (
    lower.includes("id_rsa") ||
    lower.includes("id_ed25519") ||
    lower.includes("id_ecdsa") ||
    lower.includes("id_dsa")
  ) {
    return true;
  }
  return SECRET_FILE_EXTENSIONS.has(path.extname(lower));
}

function matchesSecretPath(candidate: string, homeDir: string): boolean {
  const normalizedCandidate = path.normalize(candidate);
  if (hasSecretHomePrefix(normalizedCandidate, path.resolve(homeDir))) {
    return true;
  }

  const parts = normalizedCandidate.split(path.sep).filter(Boolean);
  if (hasSecretDirectorySegment(parts)) {
    return true;
  }

  return hasSecretFileName(path.basename(normalizedCandidate));
}

export function isSecretPath(filePath: string, options: IsSecretPathOptions = {}): boolean {
  const resolvedOptions: Required<IsSecretPathOptions> = {
    cwd: options.cwd ?? process.cwd(),
    homeDir: options.homeDir ?? os.homedir(),
  };
  const resolvedPath = resolveInputPath(filePath, resolvedOptions);
  return getResolvedPathCandidates(resolvedPath).some((candidate) =>
    matchesSecretPath(candidate, resolvedOptions.homeDir),
  );
}
