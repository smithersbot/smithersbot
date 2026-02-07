// Tool wrapping for capability enforcement.
// Two enforcement points: BashOperations injection and AgentTool execute wrapping.

import path from "node:path";
import type { BashOperations } from "@mariozechner/pi-coding-agent";
import { createCodingTools } from "@mariozechner/pi-coding-agent";

import type { CapabilityPolicy, DeniedAction, EffectiveCapabilities } from "./capability-types.js";
import {
  isCommandDenied,
  isCommandWithinGrants,
  isPathDenied,
  isPathWithinGrants,
  inferMissingCapability,
  getNetworkCommands,
} from "./capability-policy.js";
import { isRepoPrivate } from "./git-privacy.js";

// ---------------------------------------------------------------------------
// Denial result builder
// ---------------------------------------------------------------------------

function deniedResult(reason: string) {
  return {
    content: [{ type: "text" as const, text: `DENIED: ${reason}` }],
    details: {},
  };
}

// ---------------------------------------------------------------------------
// 4a. Enforced BashOperations
// ---------------------------------------------------------------------------

/**
 * Creates a BashOperations wrapper that enforces capability constraints.
 *
 * Check order:
 * 1. Hard deny check (truly dangerous: sudo, force push, deploy, rm -rf, etc.)
 * 2. Network command guard (denies with hardDeny: false if no network.read_only grant)
 * 3. Grant check (exec.* coverage)
 * 4. Git push guard (git.push_private + isRepoPrivate)
 * 5. Delegate to default BashOperations
 */
export function createEnforcedBashOperations(
  effective: EffectiveCapabilities,
  workingDir: string,
  policy: CapabilityPolicy,
  onDenied: (detail: DeniedAction) => void,
  defaultOps: BashOperations,
): BashOperations {
  const networkCommands = getNetworkCommands();
  const hasReadOnlyGrant = effective.grants.some((g) => g.id === "network.read_only");
  const hasPushGrant = effective.grants.some((g) => g.id === "git.push_private");

  return {
    async exec(command, cwd, options) {
      const trimmed = command.trim();
      const lower = trimmed.toLowerCase();
      const firstToken = lower.split(/\s+/)[0] ?? "";

      // 1. Hard deny check (truly dangerous commands only)
      const hardDeny = isCommandDenied(trimmed, effective.denies);
      if (hardDeny) {
        onDenied({
          type: "exec",
          command: trimmed,
          reason: hardDeny.reason,
          hardDeny: true,
        });
        options.onData(Buffer.from(`DENIED: ${hardDeny.reason}\n`));
        return { exitCode: 126 };
      }

      // 2. Network command guard (capability-gated, not hard deny)
      if (networkCommands.includes(firstToken)) {
        if (!hasReadOnlyGrant) {
          onDenied({
            type: "network",
            command: trimmed,
            reason: `${firstToken} requires network capability grant`,
            hardDeny: false,
            missingCapabilityId: "network.read_only",
          });
          options.onData(Buffer.from(`DENIED: ${firstToken} requires network capability grant\n`));
          return { exitCode: 126 };
        }
        // network.read_only is granted — allow through
        return defaultOps.exec(command, cwd, options);
      }

      // 3. Grant check
      if (!isCommandWithinGrants(trimmed, effective.grants)) {
        const missingId = inferMissingCapability({ command: trimmed }, effective, policy);
        onDenied({
          type: "exec",
          command: trimmed,
          reason: `Command not allowed: ${firstToken}`,
          hardDeny: false,
          missingCapabilityId: missingId,
        });
        options.onData(Buffer.from(`DENIED: Command not allowed: ${firstToken}\n`));
        return { exitCode: 126 };
      }

      // 4. Git push guard
      if (lower.startsWith("git push")) {
        if (!hasPushGrant) {
          onDenied({
            type: "git",
            command: trimmed,
            reason: "git push requires git.push_private capability",
            hardDeny: false,
            missingCapabilityId: "git.push_private",
          });
          options.onData(Buffer.from("DENIED: git push requires git.push_private capability\n"));
          return { exitCode: 126 };
        }
        if (!isRepoPrivate(workingDir)) {
          onDenied({
            type: "git",
            command: trimmed,
            reason: "git push denied: repository is not private",
            hardDeny: false,
          });
          options.onData(Buffer.from("DENIED: git push denied: repository is not private\n"));
          return { exitCode: 126 };
        }
      }

      // 5. Pass through to default operations
      return defaultOps.exec(command, cwd, options);
    },
  };
}

// ---------------------------------------------------------------------------
// 4b. Enforced coding tools (wraps Read, Write, Edit)
// ---------------------------------------------------------------------------

/**
 * Create coding tools with enforced capabilities.
 *
 * 1. Creates standard tools with enforced bash operations
 * 2. Wraps Read/Write/Edit execute functions for path enforcement
 */
export function createEnforcedCodingTools(
  workingDir: string,
  effective: EffectiveCapabilities,
  policy: CapabilityPolicy,
  onDenied: (detail: DeniedAction) => void,
  defaultBashOps?: BashOperations,
): ReturnType<typeof createCodingTools> {
  // Get default bash operations by creating a standard bash tool if not provided
  const bashOps = defaultBashOps ?? createDefaultBashOps();

  const enforcedBashOps = createEnforcedBashOperations(
    effective,
    workingDir,
    policy,
    onDenied,
    bashOps,
  );

  // Create tools with enforced bash
  const tools = createCodingTools(workingDir, {
    bash: { operations: enforcedBashOps },
  });

  // Wrap filesystem tools (Read, Write, Edit) for path enforcement
  for (const tool of tools) {
    if (tool.name === "Read") {
      wrapFsTool(tool, "read", effective, workingDir, onDenied, policy);
    } else if (tool.name === "Write") {
      wrapFsTool(tool, "write", effective, workingDir, onDenied, policy);
    } else if (tool.name === "Edit") {
      wrapFsTool(tool, "edit", effective, workingDir, onDenied, policy);
    }
  }

  return tools;
}

/** Wrap a filesystem tool's execute function for path enforcement. */
function wrapFsTool(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: any,
  operation: "read" | "write" | "edit",
  effective: EffectiveCapabilities,
  workingDir: string,
  onDenied: (detail: DeniedAction) => void,
  policy: CapabilityPolicy,
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

      // Hard deny check
      const hardDeny = isPathDenied(resolved, effective.denies);
      if (hardDeny) {
        onDenied({
          type: operation,
          path: resolved,
          reason: hardDeny.reason,
          hardDeny: true,
        });
        return deniedResult(hardDeny.reason);
      }

      // Grant check (read vs write/edit)
      const requiredCapId = operation === "read" ? "fs.read" : "fs.write";
      const fsGrants = effective.grants.filter(
        (g) => g.id === requiredCapId || g.id === "fs.write_config",
      );
      if (!isPathWithinGrants(resolved, fsGrants, workingDir)) {
        const missingId = inferMissingCapability({ path: resolved, operation }, effective, policy);
        const reason = `${operation} denied: path outside allowed scope`;
        onDenied({
          type: operation,
          path: resolved,
          reason,
          hardDeny: false,
          missingCapabilityId: missingId,
        });
        return deniedResult(reason);
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return originalExecute(toolCallId, params, ...(rest as [any, any]));
  };
}

// ---------------------------------------------------------------------------
// Default bash operations (local shell)
// ---------------------------------------------------------------------------

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
