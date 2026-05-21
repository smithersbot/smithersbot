import path from "node:path";
import {
  isPathInsideAgentRoot,
  isPathInsidePrivateRoot,
  resolveAgentRoot,
} from "../config/managed-paths.js";

export type CodexSandboxPurpose = "goal-worker" | "repo-chat";

export type CodexSandboxConfig = {
  mode: "read-only" | "workspace-write";
  executionRoot: string;
  configOverrides: string[];
};

export function resolveManagedExecutionRoot(params: {
  workingDir: string;
  purpose: CodexSandboxPurpose;
}): string {
  if (isPathInsidePrivateRoot(params.workingDir)) {
    throw new Error("Backend execution cannot run from SmithersBot private paths.");
  }

  if (params.purpose === "repo-chat" && isPathInsideAgentRoot(params.workingDir)) {
    return resolveAgentRoot();
  }

  return params.workingDir;
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildCodexSandboxConfig(params: {
  workingDir: string;
  purpose: CodexSandboxPurpose;
  requiresNetwork?: boolean;
}): CodexSandboxConfig {
  const executionRoot = resolveManagedExecutionRoot({
    workingDir: params.workingDir,
    purpose: params.purpose,
  });

  if (params.purpose === "repo-chat") {
    return {
      mode: "read-only",
      executionRoot,
      configOverrides: [`net.allowed=${params.requiresNetwork === true ? "true" : "false"}`],
    };
  }

  const gitWritablePath = path.join(params.workingDir, ".git");
  return {
    mode: "workspace-write",
    executionRoot,
    configOverrides: [
      `net.allowed=${params.requiresNetwork === true ? "true" : "false"}`,
      `sandbox_workspace_write.writable_roots=["${escapeTomlString(gitWritablePath)}"]`,
    ],
  };
}

export function appendCodexSandboxArgs(args: string[], config: CodexSandboxConfig): string[] {
  args.push("--sandbox", config.mode, "--cd", config.executionRoot);
  for (const override of config.configOverrides) {
    args.push("-c", override);
  }
  return args;
}

export function claudeCodeNativeSandboxStatus(): {
  supported: false;
  reason: string;
} {
  return {
    supported: false,
    reason:
      "Claude Code CLI help in this environment exposes permission/tool flags but no native filesystem sandbox root or fail-closed sandbox configuration surface.",
  };
}
