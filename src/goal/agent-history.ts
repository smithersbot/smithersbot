import fs from "node:fs";
import path from "node:path";
import {
  resolveAgentGoalHistoryDir,
  resolveAgentHistoryIndexDir,
  resolveAgentRepoChatHistoryDir,
  resolveAgentRoot,
  slugifyWorkspaceName,
} from "../config/managed-paths.js";
import { redactSecretValues } from "../security/secret-paths.js";
import type { SerializedRun } from "./types.js";
import type { RepoChatSession } from "../repo-chat/types.js";

const SUMMARY_FILENAME = "summary.json";
const GOAL_INDEX_FILENAME = "all-goals.jsonl";
const REPO_CHAT_INDEX_FILENAME = "all-repo-chats.jsonl";
const MAX_SAFE_EXCERPT_CHARS = 4_000;

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o644);
}

function appendJsonlOnce(params: {
  filePath: string;
  id: string;
  payload: Record<string, unknown>;
}): void {
  const dir = path.dirname(params.filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  }

  if (fs.existsSync(params.filePath)) {
    const existing = fs.readFileSync(params.filePath, "utf8");
    for (const line of existing.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { id?: unknown; runId?: unknown; sessionId?: unknown };
        if (
          parsed.id === params.id ||
          parsed.runId === params.id ||
          parsed.sessionId === params.id
        ) {
          return;
        }
      } catch {
        continue;
      }
    }
  }

  fs.appendFileSync(params.filePath, `${JSON.stringify(params.payload)}\n`, "utf8");
  fs.chmodSync(params.filePath, 0o644);
}

function truncateSafeExcerpt(value: string): string {
  const redacted = redactSecretValues(value);
  if (redacted.length <= MAX_SAFE_EXCERPT_CHARS) return redacted;
  return `${redacted.slice(0, MAX_SAFE_EXCERPT_CHARS)}...`;
}

export function workspaceNameFromWorkingDir(workingDir: string): string {
  const resolved = path.resolve(workingDir);
  const agentRoot = resolveAgentRoot();
  const rel = path.relative(agentRoot, resolved);
  const parts = rel.split(path.sep).filter(Boolean);
  if (parts[0] === "workspaces" && parts[1] && parts[2] === "repo") {
    return slugifyWorkspaceName(parts[1]);
  }
  return slugifyWorkspaceName(path.basename(resolved) || "default");
}

function sanitizeBuildGateResults(run: SerializedRun): SerializedRun["buildGateResults"] {
  if (!run.buildGateResults) return undefined;
  return Object.fromEntries(
    Object.entries(run.buildGateResults).map(([stepId, result]) => [
      stepId,
      {
        passed: result.passed,
        failedCommand: result.failedCommand ? redactSecretValues(result.failedCommand) : undefined,
        output: result.output ? truncateSafeExcerpt(result.output) : undefined,
        timestamp: result.timestamp,
      },
    ]),
  );
}

function sanitizeGithubPushOutcome(
  run: SerializedRun,
): SerializedRun["githubPushOutcome"] | undefined {
  if (!run.githubPushOutcome) return undefined;
  return {
    ...run.githubPushOutcome,
    branch: redactSecretValues(run.githubPushOutcome.branch),
    remote: run.githubPushOutcome.remote
      ? truncateSafeExcerpt(run.githubPushOutcome.remote)
      : undefined,
    prUrl: run.githubPushOutcome.prUrl
      ? truncateSafeExcerpt(run.githubPushOutcome.prUrl)
      : undefined,
    message: run.githubPushOutcome.message
      ? truncateSafeExcerpt(run.githubPushOutcome.message)
      : undefined,
  };
}

export function mirrorGoalRunToAgentHistory(run: SerializedRun): void {
  const workspace = workspaceNameFromWorkingDir(run.workingDir);
  const historyDir = resolveAgentGoalHistoryDir(workspace, run.runId);
  const summaryPath = path.join(historyDir, SUMMARY_FILENAME);
  const steps = (run.plan?.steps ?? []).map((step) => ({
    id: redactSecretValues(step.id),
    title: redactSecretValues(step.shortSummary || step.description),
    status: step.status,
  }));

  const summary = {
    kind: "goal-run-summary",
    runId: redactSecretValues(run.runId),
    workspace,
    goal: redactSecretValues(run.goal),
    state: run.state,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    plan: run.plan
      ? {
          summary: redactSecretValues(run.plan.summary),
          stepCount: run.plan.steps.length,
          steps,
        }
      : null,
    blocked: run.blocked
      ? {
          blockedAt: run.blocked.blockedAt,
          stepId: run.blocked.stepId ? redactSecretValues(run.blocked.stepId) : undefined,
          requiredInputKey: redactSecretValues(run.blocked.requiredInputKey),
          prompt: redactSecretValues(run.blocked.prompt),
        }
      : null,
    lastError: run.lastError ? truncateSafeExcerpt(run.lastError) : undefined,
    buildGateResults: sanitizeBuildGateResults(run),
    githubPushOutcome: sanitizeGithubPushOutcome(run),
  };

  atomicWriteJson(summaryPath, summary);
  appendJsonlOnce({
    filePath: path.join(resolveAgentHistoryIndexDir(), GOAL_INDEX_FILENAME),
    id: run.runId,
    payload: {
      id: run.runId,
      runId: run.runId,
      workspace,
      timestamp: run.updatedAt,
      status: run.state,
      summaryPath,
    },
  });
}

export function mirrorRepoChatSessionToAgentHistory(session: RepoChatSession): void {
  const workspace = workspaceNameFromWorkingDir(session.workingDir);
  const historyDir = path.join(resolveAgentRepoChatHistoryDir(workspace), session.id);
  const summaryPath = path.join(historyDir, SUMMARY_FILENAME);
  const summary = {
    kind: "repo-chat-session-summary",
    sessionId: redactSecretValues(session.id),
    workspace,
    backend: session.backend,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messageRefs.length,
    cliSessionId:
      session.cliSessionId == null ? undefined : redactSecretValues(session.cliSessionId),
  };

  atomicWriteJson(summaryPath, summary);
  appendJsonlOnce({
    filePath: path.join(resolveAgentHistoryIndexDir(), REPO_CHAT_INDEX_FILENAME),
    id: session.id,
    payload: {
      id: session.id,
      sessionId: session.id,
      workspace,
      timestamp: session.updatedAt,
      status: "active",
      summaryPath,
    },
  });
}
