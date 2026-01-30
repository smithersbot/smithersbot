import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import type { ToolCall, ToolResult } from "./types.js";

// shell_exec is restricted to read-only commands.
const SHELL_READ_ONLY_ALLOWLIST: readonly string[] = [
  "ls",
  "cat",
  "git status",
  "git diff",
  "git log",
];

function isAllowedShellCommand(command: string): boolean {
  const trimmed = command.trim();
  return SHELL_READ_ONLY_ALLOWLIST.some(
    (prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `),
  );
}

/**
 * Resolves a relative path against the working directory and ensures
 * the result stays inside the sandbox. Throws on path traversal.
 */
export function resolveSafePath(relativePath: string, workingDir: string): string {
  if (!relativePath) throw new Error("Path is required");
  const resolved = path.resolve(workingDir, relativePath);
  // Trailing separator ensures /foo doesn't match /foobar
  if (!resolved.startsWith(workingDir + path.sep) && resolved !== workingDir) {
    throw new Error(`Path escapes working directory: ${relativePath}`);
  }
  return resolved;
}

export function executeTool(tool: ToolCall, workingDir: string): ToolResult {
  try {
    switch (tool.name) {
      case "file_read":
        return fileRead(tool.args, workingDir);
      case "file_write":
        return fileWrite(tool.args, workingDir);
      case "file_modify":
        return fileModify(tool.args, workingDir);
      case "mkdir":
        return mkdirTool(tool.args, workingDir);
      case "git_add":
        return gitAdd(tool.args, workingDir);
      case "npm_init":
        return npmInit(tool.args, workingDir);
      case "shell_exec":
        return shellExec(tool.args, workingDir);
      default:
        return { success: false, output: "", error: `Unknown tool: ${String(tool.name)}` };
    }
  } catch (err) {
    return {
      success: false,
      output: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function fileRead(args: Record<string, string>, workingDir: string): ToolResult {
  const filePath = resolveSafePath(args.path ?? "", workingDir);
  const content = readFileSync(filePath, "utf8");
  return { success: true, output: content };
}

function fileWrite(args: Record<string, string>, workingDir: string): ToolResult {
  const filePath = resolveSafePath(args.path ?? "", workingDir);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, args.content ?? "");
  return { success: true, output: `Wrote ${filePath}` };
}

function fileModify(args: Record<string, string>, workingDir: string): ToolResult {
  const filePath = resolveSafePath(args.path ?? "", workingDir);
  const content = readFileSync(filePath, "utf8");
  const search = args.search ?? "";
  if (!content.includes(search)) {
    return { success: false, output: "", error: `Search string not found in ${filePath}` };
  }
  writeFileSync(filePath, content.replace(search, args.replace ?? ""));
  return { success: true, output: `Modified ${filePath}` };
}

function mkdirTool(args: Record<string, string>, workingDir: string): ToolResult {
  const dirPath = resolveSafePath(args.path ?? "", workingDir);
  mkdirSync(dirPath, { recursive: true });
  return { success: true, output: `Created ${dirPath}` };
}

function gitAdd(args: Record<string, string>, workingDir: string): ToolResult {
  const paths = args.paths ?? ".";
  // Validate each path stays inside working dir
  for (const p of paths.split(/\s+/).filter(Boolean)) {
    resolveSafePath(p, workingDir);
  }
  const output = execSync(`git add ${paths}`, {
    cwd: workingDir,
    timeout: 10_000,
    encoding: "utf8",
  });
  return { success: true, output: output || `Staged: ${paths}` };
}

function npmInit(args: Record<string, string>, workingDir: string): ToolResult {
  const dir = resolveSafePath(args.directory ?? ".", workingDir);
  mkdirSync(dir, { recursive: true });
  const output = execSync("npm init -y", {
    cwd: dir,
    timeout: 30_000,
    encoding: "utf8",
  });
  return { success: true, output: output || `Initialized npm package in ${dir}` };
}

function shellExec(args: Record<string, string>, workingDir: string): ToolResult {
  const command = args.command ?? "";
  if (!isAllowedShellCommand(command)) {
    return {
      success: false,
      output: "",
      error: `Command not allowed (read-only allowlist: ${SHELL_READ_ONLY_ALLOWLIST.join(", ")}): ${command}`,
    };
  }
  const output = execSync(command, {
    cwd: workingDir,
    timeout: 15_000,
    encoding: "utf8",
  });
  return { success: true, output };
}
