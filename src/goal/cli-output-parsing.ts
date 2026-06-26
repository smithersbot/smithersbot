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

const SESSION_ID_FIELDS = [
  "session_id",
  "sessionId",
  "conversation_id",
  "conversationId",
  "thread_id",
  "threadId",
] as const;

const NESTED_SESSION_ID_FIELDS = ["id", "session_id", "sessionId", "thread_id", "threadId"];
const NESTED_SESSION_ENVELOPES = ["session_configured", "session", "thread"];

export function pickCliSessionId(parsed: Record<string, unknown>): string | undefined {
  let latest: string | undefined;

  for (const field of SESSION_ID_FIELDS) {
    const value = parsed[field];
    if (typeof value === "string" && value.trim()) latest = value.trim();
  }

  for (const envelope of NESTED_SESSION_ENVELOPES) {
    const value = parsed[envelope];
    if (!isRecord(value)) continue;
    for (const field of NESTED_SESSION_ID_FIELDS) {
      const nested = value[field];
      if (typeof nested === "string" && nested.trim()) latest = nested.trim();
    }
  }

  return latest;
}

export function parseCliJsonEvents(text: string): Record<string, unknown>[] {
  const trimmed = text.trim();
  if ((trimmed.startsWith("[") || (trimmed.startsWith("{") && trimmed.includes("\n"))) && trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is Record<string, unknown> => isRecord(entry));
      }
      if (isRecord(parsed)) return [parsed];
    } catch {
      // Fall through to JSONL parsing.
    }
  }

  const lineEvents = parseJsonLines(text);
  if (lineEvents.length > 0) return lineEvents;

  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is Record<string, unknown> => isRecord(entry));
    }
    if (isRecord(parsed)) return [parsed];
  } catch {
    // Ignore non-JSON output.
  }
  return [];
}

function isAssistantLikeEvent(entry: Record<string, unknown>): boolean {
  const type = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
  const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
  const message = isRecord(entry.message) ? entry.message : undefined;
  const messageRole = typeof message?.role === "string" ? message.role.toLowerCase() : "";

  if (role === "assistant" || messageRole === "assistant") return true;
  if (!type) return false;
  return (
    type === "assistant" ||
    type.includes("assistant") ||
    type === "agent_message" ||
    type === "agent_message_delta" ||
    type === "item.completed" ||
    type === "item.text"
  );
}

function stringifyIfStructured(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  const text = collectText(value).trim();
  if (text) return text;
  if (isRecord(value) || Array.isArray(value)) return JSON.stringify(value);
  return "";
}

export function extractCliTextAndSession(raw: string): { text: string; sessionId?: string } {
  const events = parseCliJsonEvents(raw);
  let sessionId: string | undefined;
  let finalResultText: string | undefined;
  let latestAssistantText: string | undefined;
  const assistantParts: string[] = [];

  for (const event of events) {
    sessionId = pickCliSessionId(event) ?? sessionId;
    const type = typeof event.type === "string" ? event.type : "";
    const isError = event.is_error === true;

    if (type === "result" && !isError) {
      const resultText = stringifyIfStructured(event.result).trim();
      if (resultText) finalResultText = resultText;
      continue;
    }

    if (!isAssistantLikeEvent(event)) continue;
    const eventText =
      collectText(event.message).trim() ||
      collectText(event.content).trim() ||
      collectText(event.item).trim() ||
      collectText(event.delta).trim() ||
      collectText(event).trim();
    if (!eventText) continue;
    if (type === "assistant") {
      latestAssistantText = eventText;
    } else if (assistantParts.at(-1) !== eventText) {
      assistantParts.push(eventText);
    }
  }

  const text = finalResultText ?? latestAssistantText ?? assistantParts.join("\n");
  return {
    text: text.trim(),
    ...(sessionId ? { sessionId } : {}),
  };
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
