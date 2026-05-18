import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const EMPTY_MCP_CONFIG_PATH = path.join(os.tmpdir(), "smithersbot-empty-mcp.json");
const EMPTY_MCP_CONFIG_CONTENT = '{"mcpServers":{}}';

function isEmptyMcpServersObject(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "mcpServers") return false;
  const servers = record.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return false;
  return Object.keys(servers as Record<string, unknown>).length === 0;
}

export function ensureEmptyMcpConfig(): string {
  let needsWrite = true;
  try {
    const existing = fs.readFileSync(EMPTY_MCP_CONFIG_PATH, "utf-8");
    try {
      const parsed: unknown = JSON.parse(existing);
      if (isEmptyMcpServersObject(parsed)) {
        needsWrite = false;
      }
    } catch {
      needsWrite = true;
    }
  } catch {
    needsWrite = true;
  }

  if (needsWrite) {
    fs.writeFileSync(EMPTY_MCP_CONFIG_PATH, EMPTY_MCP_CONFIG_CONTENT, "utf-8");
  }
  return EMPTY_MCP_CONFIG_PATH;
}

export function appendStrictMcpArgs(args: string[], mcpConfigPath: string): string[] {
  const next = [...args];
  if (!next.includes("--strict-mcp-config")) {
    next.push("--strict-mcp-config");
  }
  if (!next.includes("--mcp-config")) {
    next.push("--mcp-config", mcpConfigPath);
  }
  return next;
}
