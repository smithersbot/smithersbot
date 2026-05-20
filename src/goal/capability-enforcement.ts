// Tool wrapping for hard-deny enforcement.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BashOperations } from "@mariozechner/pi-coding-agent";
import { createCodingTools } from "@mariozechner/pi-coding-agent";

import type { HardDeny } from "./capability-types.js";
import { AUTH_KEYS_TO_STRIP, shouldStripCredentialKey } from "./claude-code-env.js";
import { checkCommandDeny, checkPathDeny } from "./hard-deny.js";

type DeniedAction = {
  type: "exec" | "read" | "write" | "edit";
  command?: string;
  path?: string;
  reason: string;
};

const PI_BASH_SECRET_KEYS = new Set([
  ...AUTH_KEYS_TO_STRIP,
  "CLAWDBOT_GATEWAY_TOKEN",
  "CLAWDBOT_GATEWAY_PASSWORD",
  "SMITHERSBOT_GATEWAY_TOKEN",
  "SMITHERSBOT_GATEWAY_PASSWORD",
  "MOLTBOT_GATEWAY_TOKEN",
  "DISCORD_BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_APP_TOKEN",
]);

function formatDeniedMessage(reason: string): string {
  return `Denied: ${reason}. This action is not permitted. Try a different approach.`;
}

function deniedResult(reason: string) {
  return {
    content: [{ type: "text" as const, text: formatDeniedMessage(reason) }],
    details: {},
  };
}

/**
 * Creates a BashOperations wrapper that enforces hard-deny constraints.
 */
export function createEnforcedBashOperations(
  hardDenies: HardDeny[],
  onDenied: ((detail: DeniedAction) => void) | undefined,
  defaultOps: BashOperations,
): BashOperations {
  return {
    async exec(command, cwd, options) {
      const deny = checkCommandDeny(command, hardDenies);
      if (deny) {
        onDenied?.({ type: "exec", command, reason: deny.reason });
        options.onData(Buffer.from(`${formatDeniedMessage(deny.reason)}\n`));
        return { exitCode: 126 };
      }

      const pathDeny = checkCommandPathDeny(command, cwd, hardDenies);
      if (pathDeny) {
        onDenied?.({ type: "exec", command, reason: pathDeny.reason });
        options.onData(Buffer.from(`${formatDeniedMessage(pathDeny.reason)}\n`));
        return { exitCode: 126 };
      }

      return defaultOps.exec(command, cwd, options);
    },
  };
}

/**
 * Create coding tools with hard-deny enforcement.
 */
export function createEnforcedCodingTools(
  workingDir: string,
  hardDenies: HardDeny[],
  onDenied?: (detail: DeniedAction) => void,
  defaultBashOps?: BashOperations,
): ReturnType<typeof createCodingTools> {
  const bashOps = defaultBashOps ?? createDefaultBashOps();

  const enforcedBashOps = createEnforcedBashOperations(hardDenies, onDenied, bashOps);

  const tools = createCodingTools(workingDir, {
    bash: { operations: enforcedBashOps },
  });

  for (const tool of tools) {
    if (tool.name === "Read") {
      wrapFsTool(tool, "read", hardDenies, workingDir, onDenied);
    } else if (tool.name === "Write") {
      wrapFsTool(tool, "write", hardDenies, workingDir, onDenied);
    } else if (tool.name === "Edit") {
      wrapFsTool(tool, "edit", hardDenies, workingDir, onDenied);
    }
  }

  return tools;
}

function wrapFsTool(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: any,
  operation: "read" | "write" | "edit",
  hardDenies: HardDeny[],
  workingDir: string,
  onDenied?: (detail: DeniedAction) => void,
): void {
  const originalExecute = tool.execute.bind(tool);

  tool.execute = async (
    toolCallId: string,
    params: Record<string, unknown>,
    ...rest: unknown[]
  ) => {
    const filePath = typeof params.path === "string" ? params.path : "";

    if (filePath) {
      const resolved = resolveToolPath(workingDir, filePath);
      const pathsToCheck = getDenyCheckPaths(resolved);

      for (const candidatePath of pathsToCheck) {
        const deny = checkPathDeny(candidatePath, hardDenies);
        if (deny) {
          onDenied?.({ type: operation, path: candidatePath, reason: deny.reason });
          return deniedResult(deny.reason);
        }
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return originalExecute(toolCallId, params, ...(rest as [any, any]));
  };
}

function resolveToolPath(workingDir: string, filePath: string): string {
  if (filePath === "~" || filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return filePath;
  }
  return path.resolve(workingDir, filePath);
}

function expandHome(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function getDenyCheckPaths(resolvedPath: string): string[] {
  const expandedPath = expandHome(resolvedPath);
  const absolutePath = path.resolve(expandedPath);
  const pathsToCheck = new Set<string>([resolvedPath, absolutePath]);

  try {
    // Check the canonical filesystem path so symlink targets cannot bypass denies.
    pathsToCheck.add(fs.realpathSync(absolutePath));
  } catch (error) {
    // Missing files are expected for new writes; fall back to lexical path checks.
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "ENOENT") return [...pathsToCheck];
  }

  const parsed = path.parse(absolutePath);
  const parts = path.relative(parsed.root, absolutePath).split(path.sep).filter(Boolean);
  let current = parsed.root;

  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    try {
      const realAncestor = fs.realpathSync(current);
      pathsToCheck.add(path.join(realAncestor, ...parts.slice(index + 1)));
    } catch {
      // Missing leaf or unreadable ancestors still get the lexical candidate above.
    }
  }

  return [...pathsToCheck];
}

function extractCommandPathTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escape = false;

  const pushCurrent = () => {
    if (current) tokens.push(current);
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escape) {
      current += char;
      escape = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escape = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s|[;&|<>]/.test(char)) {
      pushCurrent();
      continue;
    }
    current += char;
  }

  pushCurrent();
  return tokens.filter((token) => token.includes("/") || token === "~" || token.startsWith("~"));
}

function checkCommandPathDeny(
  command: string,
  cwd: string,
  hardDenies: HardDeny[],
): HardDeny | null {
  for (const token of extractCommandPathTokens(command)) {
    const resolved = resolveToolPath(cwd, token);
    for (const candidatePath of getDenyCheckPaths(resolved)) {
      const deny = checkPathDeny(candidatePath, hardDenies);
      if (deny) return deny;
    }
  }

  return null;
}

function buildFilteredBashEnv(): Record<string, string | undefined> {
  const env = { ...process.env };

  for (const key of Object.keys(env)) {
    // Pi bash sessions should keep a usable shell env without inheriting ambient secrets.
    if (shouldStripCredentialKey(key) || PI_BASH_SECRET_KEYS.has(key)) {
      delete env[key];
    }
  }

  return env;
}

/** Create default BashOperations that execute locally via child_process. */
function createDefaultBashOps(): BashOperations {
  return {
    async exec(command, cwd, options) {
      const { spawn } = await import("node:child_process");
      return new Promise((resolve) => {
        const child = spawn("bash", ["-c", command], {
          cwd,
          env: buildFilteredBashEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        });

        if (options.signal) {
          options.signal.addEventListener("abort", () => {
            child.kill("SIGTERM");
          });
        }

        let timeout: ReturnType<typeof setTimeout> | undefined;

        const finish = (exitCode: number | null) => {
          if (timeout) {
            clearTimeout(timeout);
            timeout = undefined;
          }
          resolve({ exitCode });
        };

        if (options.timeout) {
          timeout = setTimeout(() => {
            child.kill("SIGTERM");
          }, options.timeout);
        }

        child.stdout?.on("data", (data: Buffer) => options.onData(data));
        child.stderr?.on("data", (data: Buffer) => options.onData(data));

        child.on("close", finish);

        child.on("error", () => {
          finish(1);
        });
      });
    },
  };
}
