import fs from "node:fs";
import path from "node:path";

import {
  resolvePrivateEnvDir,
  resolvePrivateEnvFile,
  slugifyWorkspaceName,
} from "../config/managed-paths.js";

export type WorkspacePrivateEnv = Record<string, string>;

/**
 * Host-side-only loader for real workspace env files.
 *
 * This reads <managed-root>/private/env/<workspace>/.env for trusted gateway
 * commands. Goal workers do not receive these values by default, and project
 * code must read normal process env variables instead of this private path.
 */
export function loadWorkspacePrivateEnv(workspaceName: string): WorkspacePrivateEnv {
  const slug = slugifyWorkspaceName(workspaceName);
  const envDir = resolvePrivateEnvDir(slug);
  const envFile = resolvePrivateEnvFile(slug);
  const resolvedDir = path.resolve(envDir);
  const resolvedFile = path.resolve(envFile);
  const rel = path.relative(resolvedDir, resolvedFile);
  if (rel.startsWith("..") || path.isAbsolute(rel) || path.basename(resolvedFile) !== ".env") {
    throw new Error("workspace private env path escaped the managed private env directory");
  }
  if (!fs.existsSync(resolvedFile)) return {};
  return parseDotEnv(fs.readFileSync(resolvedFile, "utf8"));
}

function parseDotEnv(raw: string): WorkspacePrivateEnv {
  const env: WorkspacePrivateEnv = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const assignment = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trim()
      : trimmed;
    const equalsIndex = assignment.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = assignment.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = unquoteEnvValue(assignment.slice(equalsIndex + 1).trim());
  }
  return env;
}

function unquoteEnvValue(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if (first === '"' && last === '"') {
    return value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (first === "'" && last === "'") return value.slice(1, -1);
  return value;
}
