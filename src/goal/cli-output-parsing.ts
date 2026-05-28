import { repairJsonText } from "./json-repair.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function collectText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((entry) => collectText(entry)).join("");
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content))
    return value.content.map((entry) => collectText(entry)).join("");
  if (isRecord(value.message)) return collectText(value.message);
  if (isRecord(value.delta)) return collectText(value.delta);
  if (isRecord(value.item)) return collectText(value.item);
  if (typeof value.result === "string") return value.result;
  if (isRecord(value.result)) return collectText(value.result);
  return "";
}

export function collapseWhitespace(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

export function parseJsonLines(text: string): Record<string, unknown>[] {
  const parsed: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (isRecord(value)) parsed.push(value);
    } catch {
      try {
        const repairedValue = JSON.parse(repairJsonText(trimmed)) as unknown;
        if (isRecord(repairedValue)) parsed.push(repairedValue);
      } catch {
        // Ignore non-JSON lines.
      }
    }
  }
  return parsed;
}

export function formatCliFailure(
  stdout: string,
  stderr: string,
  signal: NodeJS.Signals | null,
): string {
  const detail = collapseWhitespace(stderr || stdout);
  if (detail) return detail.slice(0, 260);
  if (signal) return `terminated by ${signal}`;
  return "unknown CLI error";
}
