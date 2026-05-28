import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HardDeny } from "./capability-types.js";
import { SECRET_PATH_DENY_REASON, SECRET_PATH_PATTERNS } from "../security/secret-paths.js";

export type HardDenyList = HardDeny[];

const SECRET_PATH_HARD_DENIES: HardDeny[] = SECRET_PATH_PATTERNS.map((pattern) => ({
  pattern,
  reason: SECRET_PATH_DENY_REASON,
  type: "path",
}));

export const HARD_DENIES: HardDeny[] = [
  // --- Path denies (glob-matched against file paths) ---
  { pattern: ".env*", reason: "Environment files may contain secrets", type: "path" },
  { pattern: "*.pem", reason: "Certificate files are sensitive", type: "path" },
  { pattern: "*.key", reason: "Key files are sensitive", type: "path" },
  { pattern: "auth.json", reason: "Credential files are sensitive", type: "path" },
  { pattern: "auth-profiles.json", reason: "Credential files are sensitive", type: "path" },
  { pattern: "*.p12", reason: "Certificate files are sensitive", type: "path" },
  { pattern: "*.pfx", reason: "Certificate files are sensitive", type: "path" },
  { pattern: "*.cer", reason: "Certificate files are sensitive", type: "path" },
  { pattern: "credentials*", reason: "Credential files are sensitive", type: "path" },
  { pattern: ".aws/**", reason: "AWS config may contain secrets", type: "path" },
  { pattern: ".gnupg/**", reason: "GPG keyrings are sensitive", type: "path" },
  { pattern: ".ssh/**", reason: "SSH config may contain secrets", type: "path" },
  { pattern: "*id_ed25519*", reason: "SSH keys are sensitive", type: "path" },
  { pattern: "*id_ecdsa*", reason: "SSH keys are sensitive", type: "path" },
  { pattern: "*id_rsa*", reason: "SSH keys are sensitive", type: "path" },
  { pattern: "moltbot.json", reason: "Config files may contain secrets", type: "path" },
  ...SECRET_PATH_HARD_DENIES,

  // --- Command denies (token-aware matching) ---
  { pattern: "sudo", reason: "Elevated privileges not permitted", type: "command" },
  { pattern: "doas", reason: "Elevated privileges not permitted", type: "command" },
  { pattern: "pkexec", reason: "Elevated privileges not permitted", type: "command" },
  { pattern: "nsenter", reason: "Elevated privileges not permitted", type: "command" },
  { pattern: "unshare", reason: "Elevated privileges not permitted", type: "command" },
  { pattern: "chroot", reason: "Elevated privileges not permitted", type: "command" },
  { pattern: "bun publish", reason: "Publishing not permitted", type: "command" },
  { pattern: "npm publish", reason: "Publishing not permitted", type: "command" },
  { pattern: "pnpm publish", reason: "Publishing not permitted", type: "command" },
  { pattern: "yarn publish", reason: "Publishing not permitted", type: "command" },
  { pattern: "docker push", reason: "Deployment not permitted", type: "command" },
  { pattern: "rm -rf /", reason: "Recursive root deletion not permitted", type: "command" },
  { pattern: "mkfs", reason: "Filesystem formatting not permitted", type: "command" },
  { pattern: "dd if=", reason: "Raw disk writes not permitted", type: "command" },
  {
    pattern: "systemctl --user restart",
    reason: "Restarting the gateway service is not permitted during goal execution",
    type: "command",
  },
  {
    pattern: "moltbot gateway restart",
    reason: "Restarting the gateway service is not permitted during goal execution",
    type: "command",
  },

  // Deploy tools — explicit commands, NOT a *deploy* substring glob.
  // Substring globs cause false positives on filenames, echo statements, docs.
  { pattern: "vercel", reason: "Deployment not permitted", type: "command" },
  { pattern: "flyctl deploy", reason: "Deployment not permitted", type: "command" },
  { pattern: "fly deploy", reason: "Deployment not permitted", type: "command" },
  { pattern: "kubectl apply", reason: "Deployment not permitted", type: "command" },
  { pattern: "helm install", reason: "Deployment not permitted", type: "command" },
  { pattern: "helm upgrade", reason: "Deployment not permitted", type: "command" },
  { pattern: "terraform apply", reason: "Deployment not permitted", type: "command" },
  { pattern: "wrangler deploy", reason: "Deployment not permitted", type: "command" },
  { pattern: "cdk deploy", reason: "Deployment not permitted", type: "command" },
  { pattern: "serverless deploy", reason: "Deployment not permitted", type: "command" },
  { pattern: "gh release create", reason: "Release creation not permitted", type: "command" },
];

const HARD_DENY_ENFORCEMENT_LINE =
  "These are enforced by SmithersBot policy and, where available, backend sandbox settings.";

function hardDenyHeadingFor(deny: HardDeny): string {
  if (deny.type === "path") {
    return "Local secret/config files. Workers cannot read SmithersBot config; ask the user to relay any required value:";
  }
  if (deny.reason === "Elevated privileges not permitted") {
    return "Elevated privileges not permitted:";
  }
  if (
    deny.reason === "Publishing not permitted" ||
    deny.reason === "Deployment not permitted" ||
    deny.reason === "Release creation not permitted"
  ) {
    return "Publishing/deployment not permitted:";
  }
  if (
    deny.reason === "Recursive root deletion not permitted" ||
    deny.reason === "Filesystem formatting not permitted" ||
    deny.reason === "Raw disk writes not permitted"
  ) {
    return "Destructive commands not permitted:";
  }
  return `${deny.reason}:`;
}

export function renderGroupedHardDenies(hardDenies: HardDenyList = HARD_DENIES): string {
  const grouped = new Map<string, string[]>();
  const seenByHeading = new Map<string, Set<string>>();

  for (const deny of hardDenies) {
    const heading = hardDenyHeadingFor(deny);
    let patterns = grouped.get(heading);
    if (!patterns) {
      patterns = [];
      grouped.set(heading, patterns);
      seenByHeading.set(heading, new Set<string>());
    }
    const seen = seenByHeading.get(heading)!;
    if (seen.has(deny.pattern)) continue;
    seen.add(deny.pattern);
    patterns.push(deny.pattern);
  }

  const lines = ["Hard Denies", HARD_DENY_ENFORCEMENT_LINE, ""];
  for (const [heading, patterns] of grouped) {
    lines.push(heading);
    for (const pattern of patterns) {
      lines.push(`- ${pattern}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function resolvePathForDeny(filePath: string): string {
  const expandedPath =
    filePath === "~"
      ? os.homedir()
      : filePath.startsWith("~/") || filePath.startsWith("~\\")
        ? path.join(os.homedir(), filePath.slice(2))
        : filePath;
  const resolvedPath = path.resolve(expandedPath);
  const normalizedResolvedPath = normalizePath(resolvedPath);

  try {
    return normalizePath(fs.realpathSync(resolvedPath));
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return normalizedResolvedPath;
    }
    return normalizedResolvedPath;
  }
}

function resolvePathCandidatesForDeny(filePath: string): string[] {
  const expandedPath =
    filePath === "~"
      ? os.homedir()
      : filePath.startsWith("~/") || filePath.startsWith("~\\")
        ? path.join(os.homedir(), filePath.slice(2))
        : filePath;
  const resolvedPath = path.resolve(expandedPath);
  const candidates = new Set<string>([normalizePath(resolvedPath), resolvePathForDeny(filePath)]);
  const parsed = path.parse(resolvedPath);
  const parts = path.relative(parsed.root, resolvedPath).split(path.sep).filter(Boolean);
  let current = parsed.root;

  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    try {
      const realAncestor = fs.realpathSync(current);
      candidates.add(normalizePath(path.join(realAncestor, ...parts.slice(index + 1))));
    } catch {
      // Missing leaf or unreadable ancestors still get the lexical candidate above.
    }
  }

  return [...candidates];
}

/** Simple glob matching for path patterns. */
function matchPathGlob(pattern: string, filePath: string): boolean {
  const normalizedPattern = normalizePath(pattern);
  const normalizedPath = normalizePath(filePath);

  let regex = "^";
  let i = 0;
  while (i < normalizedPattern.length) {
    const ch = normalizedPattern[i]!;
    if (ch === "*") {
      if (normalizedPattern[i + 1] === "*") {
        if (normalizedPattern[i + 2] === "/") {
          regex += "(?:.*/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
      } else {
        regex += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      regex += "[^/]";
      i += 1;
    } else {
      regex += ch.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
      i += 1;
    }
  }
  regex += "$";

  return new RegExp(regex, "i").test(normalizedPath); // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
}

function matchesPathDenyPattern(pattern: string, candidate: string): boolean {
  if (!pattern.includes("/")) {
    return matchPathGlob(pattern, path.basename(candidate));
  }

  const normalizedPattern = normalizePath(
    pattern === "~"
      ? os.homedir()
      : pattern.startsWith("~/") || pattern.startsWith("~\\")
        ? path.join(os.homedir(), pattern.slice(2))
        : pattern,
  );
  const glob =
    normalizedPattern.startsWith("/") || normalizedPattern.startsWith("**/")
      ? normalizedPattern
      : `**/${normalizedPattern}`;

  return matchPathGlob(glob, candidate);
}

export function checkPathDeny(
  filePath: string,
  hardDenies: HardDenyList = HARD_DENIES,
): HardDeny | null {
  const candidates = resolvePathCandidatesForDeny(filePath);

  for (const deny of hardDenies) {
    if (deny.type !== "path" || deny.reason !== SECRET_PATH_DENY_REASON) continue;
    const pattern = deny.pattern.trim();
    if (!pattern.startsWith("~/")) continue;
    if (candidates.some((candidate) => matchesPathDenyPattern(pattern, candidate))) return deny;
  }

  for (const deny of hardDenies) {
    if (deny.type !== "path") continue;
    const pattern = deny.pattern.trim();
    if (!pattern) continue;

    for (const candidate of candidates) {
      if (matchesPathDenyPattern(pattern, candidate)) return deny;
    }
  }

  return null;
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escape = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      escape = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch as "'" | '"';
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

function normalizeCommandToken(token: string): string {
  const normalized = token.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;
  return base.toLowerCase();
}

function splitCompoundCommand(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escape = false;

  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed) segments.push(trimmed);
    current = "";
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = command[i + 1];

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      current += ch;
      escape = true;
      continue;
    }

    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "'" || ch === '"') {
      current += ch;
      quote = ch as "'" | '"';
      continue;
    }

    if (ch === ";" || ch === "\n") {
      pushCurrent();
      continue;
    }

    if (ch === "&" && next === "&") {
      pushCurrent();
      i += 1;
      continue;
    }

    if (ch === "|" && next === "|") {
      pushCurrent();
      i += 1;
      continue;
    }

    if (ch === "|") {
      pushCurrent();
      continue;
    }

    current += ch;
  }

  pushCurrent();
  return segments;
}

function isEnvAssignment(token: string): boolean {
  const equalsIndex = token.indexOf("=");
  if (equalsIndex <= 0) return false;

  const key = token.slice(0, equalsIndex);
  if (!/^[A-Za-z_]/.test(key)) return false;
  for (let i = 1; i < key.length; i++) {
    const ch = key[i]!;
    if (!/[A-Za-z0-9_]/.test(ch)) return false;
  }
  return true;
}

function stripEnvPrefix(tokens: string[]): string[] {
  if (tokens.length === 0) return tokens;
  if (normalizeCommandToken(tokens[0]!) !== "env") return tokens;

  let i = 1;
  const splitStringTokens: string[] = [];
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token === "--") {
      i += 1;
      break;
    }

    if (token === "-u" || token === "--unset") {
      i += i + 1 < tokens.length ? 2 : 1;
      continue;
    }

    if (token === "-S" || token === "--split-string") {
      const splitValue = tokens[i + 1];
      if (splitValue) {
        splitStringTokens.push(...splitValue.split(/\s+/).filter(Boolean));
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (token.startsWith("-S=") || token.startsWith("--split-string=")) {
      const splitValue = token.split("=", 2)[1] ?? "";
      if (splitValue) {
        splitStringTokens.push(...splitValue.split(/\s+/).filter(Boolean));
      }
      i += 1;
      continue;
    }

    if (token.startsWith("-") || isEnvAssignment(token)) {
      i += 1;
      continue;
    }
    break;
  }

  if (splitStringTokens.length === 0) return tokens.slice(i);
  return [...splitStringTokens, ...tokens.slice(i)];
}

function stripNohupPrefix(tokens: string[]): string[] {
  if (tokens.length === 0) return tokens;
  if (normalizeCommandToken(tokens[0]!) !== "nohup") return tokens;

  const startIndex = tokens[1] === "--" ? 2 : 1;
  return startIndex < tokens.length ? tokens.slice(startIndex) : tokens;
}

function stripNicePrefix(tokens: string[]): string[] {
  if (tokens.length === 0) return tokens;
  if (normalizeCommandToken(tokens[0]!) !== "nice") return tokens;

  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token === "--") {
      i += 1;
      break;
    }

    if (token === "-n" || token === "--adjustment") {
      if (i + 1 >= tokens.length) return tokens;
      i += 2;
      continue;
    }

    if (token.startsWith("--adjustment=") || /^-\d+$/.test(token)) {
      i += 1;
      continue;
    }

    if (token.startsWith("-n") && token.length > 2) {
      i += 1;
      continue;
    }

    if (token.startsWith("-")) return tokens;
    break;
  }

  return i < tokens.length ? tokens.slice(i) : tokens;
}

function stripSetsidPrefix(tokens: string[]): string[] {
  if (tokens.length === 0) return tokens;
  if (normalizeCommandToken(tokens[0]!) !== "setsid") return tokens;

  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token === "--") {
      i += 1;
      break;
    }

    if (token === "--fork" || token === "--wait" || token === "-f" || token === "-w") {
      i += 1;
      continue;
    }

    if (token.startsWith("-")) return tokens;
    break;
  }

  return i < tokens.length ? tokens.slice(i) : tokens;
}

function stripTimePrefix(tokens: string[]): string[] {
  if (tokens.length === 0) return tokens;
  if (normalizeCommandToken(tokens[0]!) !== "time") return tokens;

  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token === "--") {
      i += 1;
      break;
    }

    if (
      token === "-p" ||
      token === "-a" ||
      token === "--append" ||
      token === "--portability" ||
      token === "--quiet" ||
      token === "--verbose"
    ) {
      i += 1;
      continue;
    }

    if (token === "-f" || token === "-o" || token === "--format" || token === "--output") {
      if (i + 1 >= tokens.length) return tokens;
      i += 2;
      continue;
    }

    if (token.startsWith("--format=") || token.startsWith("--output=")) {
      i += 1;
      continue;
    }

    if (token.startsWith("-")) return tokens;
    break;
  }

  return i < tokens.length ? tokens.slice(i) : tokens;
}

function stripTimeoutPrefix(tokens: string[]): string[] {
  if (tokens.length === 0) return tokens;
  if (normalizeCommandToken(tokens[0]!) !== "timeout") return tokens;

  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token === "--") {
      i += 1;
      break;
    }

    if (
      token === "--foreground" ||
      token === "--preserve-status" ||
      token === "-v" ||
      token === "--verbose"
    ) {
      i += 1;
      continue;
    }

    if (token === "-s" || token === "-k" || token === "--signal" || token === "--kill-after") {
      if (i + 1 >= tokens.length) return tokens;
      i += 2;
      continue;
    }

    if (token.startsWith("--signal=") || token.startsWith("--kill-after=")) {
      i += 1;
      continue;
    }

    if (token.startsWith("-")) return tokens;
    break;
  }

  if (i + 1 >= tokens.length) return tokens;
  return tokens.slice(i + 1);
}

function stripStracePrefix(tokens: string[]): string[] {
  if (tokens.length === 0) return tokens;
  if (normalizeCommandToken(tokens[0]!) !== "strace") return tokens;

  const flagsWithValues = new Set([
    "-e",
    "-E",
    "-I",
    "-o",
    "-O",
    "-p",
    "-P",
    "-s",
    "-S",
    "-u",
    "--attach",
    "--env",
    "--inject",
    "--log-file",
    "--output",
    "--output-separately",
    "--seccomp-bpf",
    "--signal",
    "--status",
    "--strings-in-hex",
    "--syscall-limit",
    "--trace",
    "--trace-fds",
    "--trace-path",
  ]);

  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token === "--") {
      i += 1;
      break;
    }

    if (
      token.startsWith("--attach=") ||
      token.startsWith("--env=") ||
      token.startsWith("--inject=") ||
      token.startsWith("--log-file=") ||
      token.startsWith("--output=") ||
      token.startsWith("--output-separately=") ||
      token.startsWith("--seccomp-bpf=") ||
      token.startsWith("--signal=") ||
      token.startsWith("--status=") ||
      token.startsWith("--strings-in-hex=") ||
      token.startsWith("--syscall-limit=") ||
      token.startsWith("--trace=") ||
      token.startsWith("--trace-fds=") ||
      token.startsWith("--trace-path=")
    ) {
      i += 1;
      continue;
    }

    if (token.startsWith("-") && !token.startsWith("--")) {
      if (flagsWithValues.has(token)) {
        if (i + 1 >= tokens.length) return tokens;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (flagsWithValues.has(token)) {
      if (i + 1 >= tokens.length) return tokens;
      i += 2;
      continue;
    }

    if (token.startsWith("--")) return tokens;
    break;
  }

  return i < tokens.length ? tokens.slice(i) : tokens;
}

function stripTransparentWrapperPrefix(tokens: string[]): string[] {
  const strippedByNohup = stripNohupPrefix(tokens);
  if (strippedByNohup !== tokens) return strippedByNohup;

  const strippedByNice = stripNicePrefix(tokens);
  if (strippedByNice !== tokens) return strippedByNice;

  const strippedBySetsid = stripSetsidPrefix(tokens);
  if (strippedBySetsid !== tokens) return strippedBySetsid;

  const strippedByTime = stripTimePrefix(tokens);
  if (strippedByTime !== tokens) return strippedByTime;

  const strippedByTimeout = stripTimeoutPrefix(tokens);
  if (strippedByTimeout !== tokens) return strippedByTimeout;

  return stripStracePrefix(tokens);
}

function stripTransparentPrefix(tokens: string[]): string[] {
  let currentTokens = tokens;

  while (currentTokens.length > 0) {
    const strippedEnv = stripEnvPrefix(currentTokens);
    if (strippedEnv !== currentTokens) {
      currentTokens = strippedEnv;
      continue;
    }

    const strippedWrapper = stripTransparentWrapperPrefix(currentTokens);
    if (strippedWrapper !== currentTokens) {
      currentTokens = strippedWrapper;
      continue;
    }

    return currentTokens;
  }

  return currentTokens;
}

function readBacktickSubstitution(
  command: string,
  startIndex: number,
): { content: string; endIndex: number } | null {
  let escape = false;
  for (let i = startIndex + 1; i < command.length; i++) {
    const ch = command[i]!;

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (ch === "`") {
      return {
        content: command.slice(startIndex + 1, i),
        endIndex: i,
      };
    }
  }

  return null;
}

function readDollarSubstitution(
  command: string,
  startIndex: number,
): { content: string; endIndex: number } | null {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  let escape = false;

  for (let i = startIndex + 2; i < command.length; i++) {
    const ch = command[i]!;

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      escape = true;
      continue;
    }

    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }

    if (quote === '"') {
      if (ch === '"') quote = null;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch as "'" | '"';
      continue;
    }

    if (ch === "$" && command[i + 1] === "(") {
      depth += 1;
      i += 1;
      continue;
    }

    if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          content: command.slice(startIndex + 2, i),
          endIndex: i,
        };
      }
    }
  }

  return null;
}

function readProcessSubstitution(
  command: string,
  startIndex: number,
): { content: string; endIndex: number } | null {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  let escape = false;

  for (let i = startIndex + 2; i < command.length; i++) {
    const ch = command[i]!;

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      escape = true;
      continue;
    }

    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }

    if (quote === '"') {
      if (ch === '"') quote = null;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch as "'" | '"';
      continue;
    }

    if ((ch === "<" || ch === ">") && command[i + 1] === "(") {
      depth += 1;
      i += 1;
      continue;
    }

    if (ch === "$" && command[i + 1] === "(") {
      depth += 1;
      i += 1;
      continue;
    }

    if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          content: command.slice(startIndex + 2, i),
          endIndex: i,
        };
      }
    }
  }

  return null;
}

function extractCommandSubstitutions(command: string): string[] {
  const substitutions: string[] = [];
  let quote: "'" | '"' | null = null;
  let escape = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      escape = true;
      continue;
    }

    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        continue;
      }

      if (ch === "$" && command[i + 1] === "(") {
        const parsed = readDollarSubstitution(command, i);
        if (parsed) {
          substitutions.push(parsed.content);
          i = parsed.endIndex;
        }
        continue;
      }

      if (ch === "`") {
        const parsed = readBacktickSubstitution(command, i);
        if (parsed) {
          substitutions.push(parsed.content);
          i = parsed.endIndex;
        }
        continue;
      }

      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch as "'" | '"';
      continue;
    }

    if (ch === "$" && command[i + 1] === "(") {
      const parsed = readDollarSubstitution(command, i);
      if (parsed) {
        substitutions.push(parsed.content);
        i = parsed.endIndex;
      }
      continue;
    }

    if ((ch === "<" || ch === ">") && command[i + 1] === "(") {
      const parsed = readProcessSubstitution(command, i);
      if (parsed) {
        substitutions.push(parsed.content);
        i = parsed.endIndex;
      }
      continue;
    }

    if (ch === "`") {
      const parsed = readBacktickSubstitution(command, i);
      if (parsed) {
        substitutions.push(parsed.content);
        i = parsed.endIndex;
      }
    }
  }

  return substitutions;
}

function extractShellCommandFromCTokens(tokens: string[]): string | null {
  if (tokens.length < 3) return null;

  const cmd = normalizeCommandToken(tokens[0]!);
  if (
    cmd !== "bash" &&
    cmd !== "sh" &&
    cmd !== "zsh" &&
    cmd !== "fish" &&
    cmd !== "ksh" &&
    cmd !== "dash" &&
    cmd !== "csh" &&
    cmd !== "tcsh"
  ) {
    return null;
  }

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "-c" || token === "--command") {
      return tokens[i + 1] ?? null;
    }

    if (token.startsWith("-") && !token.startsWith("--") && token.includes("c")) {
      return tokens[i + 1] ?? null;
    }

    if (!token.startsWith("-")) return null;
  }

  return null;
}

function extractInterpreterInlineCode(
  tokens: string[],
): { interpreter: string; code: string } | null {
  if (tokens.length < 3) return null;

  const interpreter = normalizeCommandToken(tokens[0]!);
  if (
    interpreter !== "python" &&
    interpreter !== "python3" &&
    interpreter !== "perl" &&
    interpreter !== "ruby" &&
    interpreter !== "node"
  ) {
    return null;
  }

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "-c" || token === "-e") {
      const code = tokens[i + 1];
      return code ? { interpreter, code } : null;
    }

    if (token.startsWith("-") && !token.startsWith("--")) {
      const shortFlags = token.slice(1);
      if (shortFlags.length > 1 && (shortFlags.includes("c") || shortFlags.includes("e"))) {
        const code = tokens[i + 1];
        return code ? { interpreter, code } : null;
      }
      continue;
    }

    return null;
  }

  return null;
}

function readParenthesizedContent(
  input: string,
  startIndex: number,
): { content: string; endIndex: number } | null {
  let depth = 1;
  let quote: "'" | '"' | "`" | null = null;
  let escape = false;

  for (let i = startIndex + 1; i < input.length; i++) {
    const ch = input[i]!;

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      escape = true;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch as "'" | '"' | "`";
      continue;
    }

    if (ch === "(") {
      depth += 1;
      continue;
    }

    if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          content: input.slice(startIndex + 1, i),
          endIndex: i,
        };
      }
    }
  }

  return null;
}

function extractStringLiterals(input: string): string[] {
  const literals: string[] = [];

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch !== "'" && ch !== '"' && ch !== "`") continue;

    const quote = ch;
    let current = "";
    let escape = false;

    for (i += 1; i < input.length; i++) {
      const inner = input[i]!;

      if (escape) {
        current += inner;
        escape = false;
        continue;
      }

      if (inner === "\\" && quote !== "'") {
        escape = true;
        continue;
      }

      if (inner === quote) {
        literals.push(current);
        break;
      }

      current += inner;
    }
  }

  return literals;
}

function extractInterpreterBacktickCommands(code: string): string[] {
  const commands: string[] = [];
  let quote: "'" | '"' | null = null;
  let escape = false;

  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      escape = true;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch as "'" | '"';
      continue;
    }

    if (ch === "`") {
      const parsed = readBacktickSubstitution(code, i);
      if (parsed) {
        commands.push(parsed.content);
        i = parsed.endIndex;
      }
    }
  }

  return commands;
}

function scanInterpreterInlineForDenied(
  tokens: string[],
  hardDenies: HardDenyList,
  depth: number,
): HardDeny | null {
  const inlineCode = extractInterpreterInlineCode(tokens);
  if (!inlineCode) return null;

  // Defense-in-depth heuristic: inspect inline interpreter snippets for obvious
  // shell-exec APIs, then reuse the normal recursive command deny checks.
  const commandCandidates = new Set<string>();
  const callPatterns: RegExp[] = [];

  if (inlineCode.interpreter === "python" || inlineCode.interpreter === "python3") {
    callPatterns.push(/\bos\.system\b/g, /\bsubprocess\.(?:run|call|Popen)\b/g);
  }

  if (inlineCode.interpreter === "node") {
    callPatterns.push(
      /(?:\brequire\(\s*["']child_process["']\s*\)|\bchild_process)\.(?:exec|execSync|spawn)\b/g,
    );
  }

  if (inlineCode.interpreter === "perl" || inlineCode.interpreter === "ruby") {
    callPatterns.push(/(^|[^\w.])system\b/g);
  }

  for (const pattern of callPatterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(inlineCode.code)) !== null) {
      const openParenIndex = inlineCode.code.indexOf("(", match.index + match[0].length);
      if (openParenIndex === -1) continue;

      const args = readParenthesizedContent(inlineCode.code, openParenIndex);
      if (!args) continue;

      const stringArgs = extractStringLiterals(args.content).filter(Boolean);
      for (const stringArg of stringArgs) {
        commandCandidates.add(stringArg);
      }
      if (stringArgs.length > 1) {
        commandCandidates.add(stringArgs.join(" "));
      }

      pattern.lastIndex = args.endIndex + 1;
    }
  }

  if (inlineCode.interpreter === "perl" || inlineCode.interpreter === "ruby") {
    for (const backtickCommand of extractInterpreterBacktickCommands(inlineCode.code)) {
      if (backtickCommand) {
        commandCandidates.add(backtickCommand);
      }
    }
  }

  for (const commandCandidate of commandCandidates) {
    const nestedDeny = checkCommandDenyRecursive(commandCandidate, hardDenies, depth + 1);
    if (nestedDeny) return nestedDeny;
  }

  return null;
}

function isDangerousRm(tokens: string[]): boolean {
  if (tokens.length === 0 || tokens[0] !== "rm") return false;
  const args = tokens.slice(1);
  const flags = args.filter((arg) => arg.startsWith("-"));
  let hasR = false;
  let hasF = false;

  for (const flag of flags) {
    if (flag.startsWith("--")) {
      if (flag === "--recursive") hasR = true;
      if (flag === "--force") hasF = true;
      continue;
    }

    if (flag.includes("r")) hasR = true;
    if (flag.includes("f")) hasF = true;
  }

  if (!hasR || !hasF) return false;

  const targets = args.filter((arg) => !arg.startsWith("-"));
  if (targets.length === 0) return true;

  return targets.some((target) => {
    const normalizedTarget = target === "/" ? target : target.toLowerCase().replace(/\/+$/, "");
    return (
      normalizedTarget === "/" ||
      normalizedTarget === "/*" ||
      normalizedTarget === "~" ||
      normalizedTarget === "~/*" ||
      normalizedTarget === "$home" ||
      normalizedTarget === "$home/*" ||
      normalizedTarget === "${home}" ||
      normalizedTarget === "${home}/*" ||
      normalizedTarget === "." ||
      normalizedTarget === "./" ||
      normalizedTarget === "./*"
    );
  });
}

function checkCommandDenyTokens(tokens: string[], hardDenies: HardDenyList): HardDeny | null {
  if (tokens.length === 0) return null;

  const lowerTokens = tokens.map((token) => token.toLowerCase());
  if (lowerTokens.length === 0) return null;

  const cmdToken = lowerTokens[0]!;
  const cmd = normalizeCommandToken(cmdToken);
  const args = lowerTokens.slice(1);

  for (const deny of hardDenies) {
    if (deny.type !== "command") continue;
    const pattern = deny.pattern.trim().toLowerCase();

    switch (pattern) {
      case "sudo":
        if (cmd === "sudo") return deny;
        break;
      case "doas":
        if (cmd === "doas") return deny;
        break;
      case "pkexec":
        if (cmd === "pkexec") return deny;
        break;
      case "nsenter":
        if (cmd === "nsenter") return deny;
        break;
      case "unshare":
        if (cmd === "unshare") return deny;
        break;
      case "chroot":
        if (cmd === "chroot") return deny;
        break;
      case "bun publish":
        if (cmd === "bun" && args[0] === "publish") return deny;
        break;
      case "npm publish":
        if (cmd === "npm" && args[0] === "publish") return deny;
        break;
      case "pnpm publish":
        if (cmd === "pnpm" && args[0] === "publish") return deny;
        break;
      case "yarn publish":
        if (cmd === "yarn" && args[0] === "publish") return deny;
        break;
      case "docker push":
        if (cmd === "docker" && args[0] === "push") return deny;
        break;
      case "rm -rf /":
        if (isDangerousRm(lowerTokens)) return deny;
        break;
      case "mkfs":
        if (cmd.startsWith("mkfs")) return deny;
        break;
      case "dd if=":
        if (cmd === "dd" && args.some((arg) => arg.startsWith("if="))) return deny;
        break;
      case "systemctl --user restart":
        if (cmd === "systemctl" && args[0] === "--user" && args[1] === "restart") return deny;
        break;
      case "moltbot gateway restart":
        if (cmd === "moltbot" && args[0] === "gateway" && args[1] === "restart") return deny;
        break;
      case "vercel":
        if (cmd === "vercel") return deny;
        break;
      case "flyctl deploy":
        if (cmd === "flyctl" && args[0] === "deploy") return deny;
        break;
      case "fly deploy":
        if (cmd === "fly" && args[0] === "deploy") return deny;
        break;
      case "kubectl apply":
        if (cmd === "kubectl" && args[0] === "apply") return deny;
        break;
      case "helm install":
        if (cmd === "helm" && args[0] === "install") return deny;
        break;
      case "helm upgrade":
        if (cmd === "helm" && args[0] === "upgrade") return deny;
        break;
      case "terraform apply":
        if (cmd === "terraform" && args[0] === "apply") return deny;
        break;
      case "wrangler deploy":
        if (cmd === "wrangler" && args[0] === "deploy") return deny;
        break;
      case "cdk deploy":
        if (cmd === "cdk" && args[0] === "deploy") return deny;
        break;
      case "serverless deploy":
        if (cmd === "serverless" && args[0] === "deploy") return deny;
        break;
      case "gh release create":
        if (cmd === "gh" && args[0] === "release" && args[1] === "create") return deny;
        break;
      default:
        break;
    }
  }

  return null;
}

function checkCommandDenyRecursive(
  command: string,
  hardDenies: HardDenyList,
  depth: number,
): HardDeny | null {
  if (depth > 8) {
    return {
      pattern: "<command-nesting-depth-limit>",
      reason: "command nesting too deep to analyze safely",
      type: "command",
    };
  }

  const segments = splitCompoundCommand(command);
  for (const segment of segments) {
    const tokens = tokenizeCommand(segment);
    if (tokens.length > 0) {
      const stripped = stripTransparentPrefix(tokens);
      if (stripped.length > 0) {
        const deny = checkCommandDenyTokens(stripped, hardDenies);
        if (deny) return deny;

        const nestedShellCommand = extractShellCommandFromCTokens(stripped);
        if (nestedShellCommand) {
          const nestedDeny = checkCommandDenyRecursive(nestedShellCommand, hardDenies, depth + 1);
          if (nestedDeny) return nestedDeny;
        }

        const interpreterInlineDeny = scanInterpreterInlineForDenied(stripped, hardDenies, depth);
        if (interpreterInlineDeny) return interpreterInlineDeny;
      }
    }

    const substitutions = extractCommandSubstitutions(segment);
    for (const nestedCommand of substitutions) {
      const nestedDeny = checkCommandDenyRecursive(nestedCommand, hardDenies, depth + 1);
      if (nestedDeny) return nestedDeny;
    }
  }

  return null;
}

/**
 * Token-aware command deny check.
 *
 * For "rm", checks if args contain -rf with target / or empty expansion.
 * For simple commands like "sudo", checks if the command starts with that token.
 *
 * This avoids false positives from substring matching (e.g., a filename
 * containing "deploy" or an echo statement mentioning "sudo").
 */
export function checkCommandDeny(
  command: string,
  hardDenies: HardDenyList = HARD_DENIES,
): HardDeny | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  return checkCommandDenyRecursive(trimmed, hardDenies, 0);
}
