import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  resolveAgentGoalHistoryDir,
  resolveAgentRepoChatHistoryDir,
  slugifyWorkspaceName,
} from "../config/managed-paths.js";
import { redactSecretValues } from "../security/secret-paths.js";

const EVENTS_FILENAME = "events.jsonl";
const PROMPTS_DIRNAME = "prompts";

export type AgentHistoryScope =
  | {
      kind: "goal";
      workspaceName: string;
      goalId: string;
    }
  | {
      kind: "repo-chat";
      workspaceName: string;
      sessionId: string;
    };

export type AgentBackendUsage =
  | {
      available: true;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      totalTokens?: number;
      totalCostUsd?: number;
      source: "claude-stream-json" | "codex-json";
    }
  | {
      available: false;
      reason: string;
    };

export type AgentHistoryEvent = {
  event: string;
  timestamp?: string;
  phase?: string;
  backend?: string;
  runId?: string;
  goalId?: string;
  repoChatId?: string;
  sessionId?: string;
  stepId?: string;
  attemptNumber?: number;
  status?: string;
  transition?: {
    from?: string;
    to?: string;
  };
  argv?: readonly string[];
  command?: string;
  promptArtifactPath?: string;
  outputSummary?: string;
  tokenUsage?: AgentBackendUsage;
  errorClass?: string;
  artifactPaths?: readonly string[];
  [key: string]: unknown;
};

export type WriteAgentPromptArtifactParams = {
  scope: AgentHistoryScope;
  phase: string;
  prompt: string;
  backend?: string;
  timestamp?: string;
};

export type WriteCriticalAgentLaunchEventParams = {
  scope: AgentHistoryScope;
  phase: string;
  backend: string;
  prompt: string;
  argv?: readonly string[];
  command?: string;
  timestamp?: string;
  event?: Omit<
    AgentHistoryEvent,
    "event" | "timestamp" | "phase" | "backend" | "argv" | "command" | "promptArtifactPath"
  >;
};

export type WriteCriticalAgentLaunchEventResult = {
  promptArtifactPath: string;
  eventPath: string;
};

export type BestEffortAgentHistoryWriteResult =
  | {
      ok: true;
      eventPath: string;
    }
  | {
      ok: false;
      warning: string;
    };

function resolveScopeDir(scope: AgentHistoryScope): string {
  if (scope.kind === "goal") {
    return resolveAgentGoalHistoryDir(scope.workspaceName, scope.goalId);
  }
  return path.join(
    resolveAgentRepoChatHistoryDir(scope.workspaceName),
    slugifyWorkspaceName(scope.sessionId),
  );
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
}

function atomicWriteText(filePath: string, value: string): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, value, "utf8");
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o644);
}

function safeFilePart(value: string): string {
  return slugifyWorkspaceName(value).slice(0, 80);
}

function safeTimestampPart(timestamp: string): string {
  return timestamp.replace(/[^0-9A-Za-z._-]+/g, "-");
}

function redactJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecretValues(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        redactSecretValues(key),
        redactJsonValue(entry),
      ]),
    );
  }
  return value;
}

export function resolveAgentHistoryEventsPath(scope: AgentHistoryScope): string {
  return path.join(resolveScopeDir(scope), EVENTS_FILENAME);
}

export function appendAgentHistoryEvent(
  scope: AgentHistoryScope,
  event: AgentHistoryEvent,
): string {
  const eventPath = resolveAgentHistoryEventsPath(scope);
  ensureDir(path.dirname(eventPath));
  const payload = redactJsonValue({
    ...event,
    timestamp: event.timestamp ?? new Date().toISOString(),
  });
  fs.appendFileSync(eventPath, `${JSON.stringify(payload)}\n`, "utf8");
  fs.chmodSync(eventPath, 0o644);
  return eventPath;
}

export function writeAgentPromptArtifact(params: WriteAgentPromptArtifactParams): string {
  const timestamp = params.timestamp ?? new Date().toISOString();
  const promptDir = path.join(resolveScopeDir(params.scope), PROMPTS_DIRNAME);
  const backendPart = params.backend ? `-${safeFilePart(params.backend)}` : "";
  const fileName = `${safeTimestampPart(timestamp)}-${safeFilePart(params.phase)}${backendPart}-${crypto.randomUUID()}.txt`;
  const promptPath = path.join(promptDir, fileName);
  atomicWriteText(promptPath, redactSecretValues(params.prompt));
  return promptPath;
}

export function writeCriticalAgentLaunchEvent(
  params: WriteCriticalAgentLaunchEventParams,
): WriteCriticalAgentLaunchEventResult {
  const timestamp = params.timestamp ?? new Date().toISOString();
  const promptArtifactPath = writeAgentPromptArtifact({
    scope: params.scope,
    phase: params.phase,
    backend: params.backend,
    prompt: params.prompt,
    timestamp,
  });
  const eventPath = appendAgentHistoryEvent(params.scope, {
    ...params.event,
    event: "launch",
    timestamp,
    phase: params.phase,
    backend: params.backend,
    argv: params.argv,
    command: params.command,
    promptArtifactPath,
  });
  return { promptArtifactPath, eventPath };
}

export function appendAgentHistoryEventBestEffort(
  scope: AgentHistoryScope,
  event: AgentHistoryEvent,
): BestEffortAgentHistoryWriteResult {
  try {
    return { ok: true, eventPath: appendAgentHistoryEvent(scope, event) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      warning: `agent history event write failed: ${redactSecretValues(message)}`,
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function collectJsonCandidates(value: unknown): unknown[] {
  if (typeof value !== "string") return [value];
  const trimmed = value.trim();
  if (!trimmed) return [];
  const candidates: unknown[] = [];
  try {
    candidates.push(JSON.parse(trimmed));
  } catch {
    // JSONL or mixed output is handled line-by-line below.
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const lineTrimmed = line.trim();
    if (!lineTrimmed) continue;
    try {
      candidates.push(JSON.parse(lineTrimmed));
    } catch {
      continue;
    }
  }
  return candidates;
}

function normalizeClaudeUsage(candidate: unknown): AgentBackendUsage | null {
  const record = asRecord(candidate);
  if (!record) return null;
  const usage = asRecord(record.usage);
  if (!usage) return null;

  const inputTokens = numberFrom(usage.input_tokens);
  const outputTokens = numberFrom(usage.output_tokens);
  const cacheReadTokens = numberFrom(usage.cache_read_input_tokens);
  const cacheCreationTokens = numberFrom(usage.cache_creation_input_tokens);
  const totalCostUsd = numberFrom(record.total_cost_usd ?? usage.total_cost_usd);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheCreationTokens === undefined &&
    totalCostUsd === undefined
  ) {
    return null;
  }

  return {
    available: true,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalCostUsd,
    source: "claude-stream-json",
  };
}

function normalizeCodexUsage(candidate: unknown): AgentBackendUsage | null {
  const record = asRecord(candidate);
  if (!record) return null;
  const usage = asRecord(record.usage);
  const tokenCount = asRecord(record.token_count ?? record.tokenCount);
  const source = usage ?? tokenCount ?? record;

  const inputTokens =
    numberFrom(source.input_tokens) ??
    numberFrom(source.inputTokens) ??
    numberFrom(source.prompt_tokens) ??
    numberFrom(source.promptTokens);
  const outputTokens =
    numberFrom(source.output_tokens) ??
    numberFrom(source.outputTokens) ??
    numberFrom(source.completion_tokens) ??
    numberFrom(source.completionTokens);
  const cacheReadTokens =
    numberFrom(source.cache_read_tokens) ??
    numberFrom(source.cacheReadTokens) ??
    numberFrom(source.cached_input_tokens) ??
    numberFrom(source.cachedInputTokens);
  const cacheCreationTokens =
    numberFrom(source.cache_creation_tokens) ?? numberFrom(source.cacheCreationTokens);
  const totalTokens =
    numberFrom(source.total_tokens) ?? numberFrom(source.totalTokens) ?? numberFrom(source.total);
  const totalCostUsd =
    numberFrom(source.total_cost_usd) ??
    numberFrom(source.totalCostUsd) ??
    numberFrom(record.total_cost_usd) ??
    numberFrom(record.totalCostUsd);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheCreationTokens === undefined &&
    totalTokens === undefined &&
    totalCostUsd === undefined
  ) {
    return null;
  }

  return {
    available: true,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    totalCostUsd,
    source: "codex-json",
  };
}

export function parseBackendUsage(output: unknown): AgentBackendUsage {
  const candidates = collectJsonCandidates(output);
  for (const candidate of candidates) {
    const claudeUsage = normalizeClaudeUsage(candidate);
    if (claudeUsage) return claudeUsage;
    const codexUsage = normalizeCodexUsage(candidate);
    if (codexUsage) return codexUsage;
  }
  return {
    available: false,
    reason: "per-run token usage metadata was not found in backend output",
  };
}
