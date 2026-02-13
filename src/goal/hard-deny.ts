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
  const tokens = tokenizeCommand(trimmed).map((token) => token.toLowerCase());
  if (tokens.length === 0) return null;

  const cmdToken = tokens[0]!;
  const cmd = path.posix.basename(cmdToken).replace(/\\/g, "/").split("/").pop() ?? cmdToken;
  const args = tokens.slice(1);

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
        if (isDangerousRm(tokens)) return deny;
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
