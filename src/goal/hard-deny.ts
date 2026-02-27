import path from "node:path";
import type { HardDeny } from "./capability-types.js";

export type HardDenyList = HardDeny[];

export const HARD_DENIES: HardDeny[] = [
  // --- Path denies (glob-matched against file paths) ---
  { pattern: ".env*", reason: "Environment files may contain secrets", type: "path" },
  { pattern: "*.pem", reason: "Certificate files are sensitive", type: "path" },
  { pattern: "*.key", reason: "Key files are sensitive", type: "path" },
  { pattern: "credentials*", reason: "Credential files are sensitive", type: "path" },
  { pattern: ".aws/**", reason: "AWS config may contain secrets", type: "path" },
  { pattern: ".ssh/**", reason: "SSH config may contain secrets", type: "path" },
  { pattern: "*id_rsa*", reason: "SSH keys are sensitive", type: "path" },

  // --- Command denies (token-aware matching) ---
  { pattern: "sudo", reason: "Elevated privileges not permitted", type: "command" },
  { pattern: "npm publish", reason: "Publishing not permitted", type: "command" },
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
  { pattern: "kubectl apply", reason: "Deployment not permitted", type: "command" },
  { pattern: "helm install", reason: "Deployment not permitted", type: "command" },
  { pattern: "helm upgrade", reason: "Deployment not permitted", type: "command" },
  { pattern: "terraform apply", reason: "Deployment not permitted", type: "command" },
  { pattern: "serverless deploy", reason: "Deployment not permitted", type: "command" },
  { pattern: "gh release create", reason: "Release creation not permitted", type: "command" },
];

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
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

  return new RegExp(regex, "i").test(normalizedPath);
}

export function checkPathDeny(
  filePath: string,
  hardDenies: HardDenyList = HARD_DENIES,
): HardDeny | null {
  const resolved = normalizePath(path.resolve(filePath));
  const base = path.basename(resolved);

  for (const deny of hardDenies) {
    if (deny.type !== "path") continue;
    const pattern = deny.pattern.trim();
    if (!pattern) continue;

    if (!pattern.includes("/")) {
      if (matchPathGlob(pattern, base)) return deny;
      continue;
    }

    const normalizedPattern = normalizePath(pattern);
    const glob =
      normalizedPattern.startsWith("/") || normalizedPattern.startsWith("**/")
        ? normalizedPattern
        : `**/${normalizedPattern}`;

    if (matchPathGlob(glob, resolved)) return deny;
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

    if (ch === ";") {
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
  if (cmd !== "bash" && cmd !== "sh" && cmd !== "zsh") return null;

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

function isDangerousRm(tokens: string[]): boolean {
  if (tokens.length === 0 || tokens[0] !== "rm") return false;
  const args = tokens.slice(1);
  const flags = args.filter((arg) => arg.startsWith("-"));
  const hasR = flags.some((flag) => flag.includes("r"));
  const hasF = flags.some((flag) => flag.includes("f"));
  if (!hasR || !hasF) return false;

  const targets = args.filter((arg) => !arg.startsWith("-"));
  if (targets.length === 0) return true;

  return targets.some((target) => target === "/" || target === "/*");
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
      case "npm publish":
        if (cmd === "npm" && args[0] === "publish") return deny;
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
  if (depth > 8) return null;

  const segments = splitCompoundCommand(command);
  for (const segment of segments) {
    const tokens = tokenizeCommand(segment);
    if (tokens.length > 0) {
      const stripped = stripEnvPrefix(tokens);
      if (stripped.length > 0) {
        const deny = checkCommandDenyTokens(stripped, hardDenies);
        if (deny) return deny;

        const nestedShellCommand = extractShellCommandFromCTokens(stripped);
        if (nestedShellCommand) {
          const nestedDeny = checkCommandDenyRecursive(nestedShellCommand, hardDenies, depth + 1);
          if (nestedDeny) return nestedDeny;
        }
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
