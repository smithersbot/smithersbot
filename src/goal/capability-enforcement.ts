// Tool wrapping for hard-deny enforcement.

import path from "node:path";
import type { BashOperations } from "@mariozechner/pi-coding-agent";
import { createCodingTools } from "@mariozechner/pi-coding-agent";

import type { HardDeny } from "./capability-types.js";
import { checkCommandDeny, checkPathDeny } from "./hard-deny.js";

export type DeniedAction = {
  type: "exec" | "read" | "write" | "edit";
  command?: string;
  path?: string;
  reason: string;
};

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
      const resolved = path.resolve(workingDir, filePath);
      const deny = checkPathDeny(resolved, hardDenies);
      if (deny) {
        onDenied?.({ type: operation, path: resolved, reason: deny.reason });
        return deniedResult(deny.reason);
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return originalExecute(toolCallId, params, ...(rest as [any, any]));
  };
}

/** Create default BashOperations that execute locally via child_process. */
function createDefaultBashOps(): BashOperations {
  return {
    async exec(command, cwd, options) {
      const { spawn } = await import("node:child_process");
      return new Promise((resolve) => {
        const child = spawn("bash", ["-c", command], {
          cwd,
          env: options.env ?? process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });

        if (options.signal) {
          options.signal.addEventListener("abort", () => {
            child.kill("SIGTERM");
          });
        }

        if (options.timeout) {
          setTimeout(() => {
            child.kill("SIGTERM");
          }, options.timeout);
        }

        child.stdout?.on("data", (data: Buffer) => options.onData(data));
        child.stderr?.on("data", (data: Buffer) => options.onData(data));

        child.on("close", (code) => {
          resolve({ exitCode: code });
        });

        child.on("error", () => {
          resolve({ exitCode: 1 });
        });
      });
    },
  };
}
