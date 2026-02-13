import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RepoChatMessageRef, RepoChatSession } from "./types.js";

const REPO_CHATS_DIRNAME = "repo-chats";
const SESSION_FILENAME = "session.json";

type RepoChatIndex = {
  warmed: boolean;
  messageToSession: Map<string, string>;
  sessionToKeys: Map<string, Set<string>>;
};

const INDEX_BY_DIR = new Map<string, RepoChatIndex>();

function getIndex(repoChatsDir: string): RepoChatIndex {
  const normalized = path.resolve(repoChatsDir);
  const existing = INDEX_BY_DIR.get(normalized);
  if (existing) return existing;
  const created: RepoChatIndex = {
    warmed: false,
    messageToSession: new Map(),
    sessionToKeys: new Map(),
  };
  INDEX_BY_DIR.set(normalized, created);
  return created;
}

function messageKey(ref: RepoChatMessageRef): string {
  return `${ref.chatId}:${ref.messageId}`;
}

function isRepoChatMessageRef(value: unknown): value is RepoChatMessageRef {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.chatId === "number" && typeof record.messageId === "number";
}

function isRepoChatBackend(value: unknown): value is RepoChatSession["backend"] {
  return value === "codex" || value === "claude_code";
}

function isRepoChatSession(value: unknown): value is RepoChatSession {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id.trim()) return false;
  if (!isRepoChatBackend(record.backend)) return false;
  if (typeof record.workingDir !== "string") return false;
  if (record.cliSessionId != null && typeof record.cliSessionId !== "string") return false;
  if (typeof record.createdAt !== "string") return false;
  if (typeof record.updatedAt !== "string") return false;
  if (!Array.isArray(record.messageRefs)) return false;
  return record.messageRefs.every((entry) => isRepoChatMessageRef(entry));
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

function readSessionAtPath(filePath: string): RepoChatSession | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRepoChatSession(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function indexSession(index: RepoChatIndex, session: RepoChatSession): void {
  const priorKeys = index.sessionToKeys.get(session.id);
  if (priorKeys) {
    for (const key of priorKeys) {
      if (index.messageToSession.get(key) === session.id) {
        index.messageToSession.delete(key);
      }
    }
  }

  const nextKeys = new Set<string>();
  for (const ref of session.messageRefs) {
    const key = messageKey(ref);
    nextKeys.add(key);
    index.messageToSession.set(key, session.id);
  }
  index.sessionToKeys.set(session.id, nextKeys);
}

function warmMessageIndex(repoChatsDir: string): void {
  const index = getIndex(repoChatsDir);
  if (index.warmed) return;

  index.messageToSession.clear();
  index.sessionToKeys.clear();

  if (!fs.existsSync(repoChatsDir)) {
    index.warmed = true;
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(repoChatsDir, { withFileTypes: true });
  } catch {
    index.warmed = true;
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(repoChatsDir, entry.name, SESSION_FILENAME);
    const session = readSessionAtPath(filePath);
    if (!session) continue;
    indexSession(index, session);
  }
  index.warmed = true;
}

export function resolveRepoChatsDir(homedir: () => string = os.homedir): string {
  return path.join(homedir(), ".moltbot", REPO_CHATS_DIRNAME);
}

export function resolveRepoChatDir(
  sessionId: string,
  repoChatsDir: string = resolveRepoChatsDir(),
): string {
  return path.join(repoChatsDir, sessionId);
}

function resolveSessionPath(
  sessionId: string,
  repoChatsDir: string = resolveRepoChatsDir(),
): string {
  return path.join(resolveRepoChatDir(sessionId, repoChatsDir), SESSION_FILENAME);
}

export function saveRepoChatSession(
  session: RepoChatSession,
  repoChatsDir: string = resolveRepoChatsDir(),
): void {
  const filePath = resolveSessionPath(session.id, repoChatsDir);
  atomicWriteJson(filePath, session);
  indexSession(getIndex(repoChatsDir), session);
}

export function loadRepoChatSession(
  sessionId: string,
  repoChatsDir: string = resolveRepoChatsDir(),
): RepoChatSession | undefined {
  const session = readSessionAtPath(resolveSessionPath(sessionId, repoChatsDir));
  if (session) {
    indexSession(getIndex(repoChatsDir), session);
  }
  return session;
}

export function findRepoChatSessionByMessageId(params: {
  chatId: number;
  messageId: number;
  repoChatsDir?: string;
}): RepoChatSession | undefined {
  const repoChatsDir = params.repoChatsDir ?? resolveRepoChatsDir();
  warmMessageIndex(repoChatsDir);

  const index = getIndex(repoChatsDir);
  const key = messageKey({ chatId: params.chatId, messageId: params.messageId });
  const sessionId = index.messageToSession.get(key);
  if (!sessionId) return undefined;

  const session = loadRepoChatSession(sessionId, repoChatsDir);
  if (!session) {
    index.messageToSession.delete(key);
  }
  return session;
}

export function resetRepoChatStoreIndexForTests(): void {
  INDEX_BY_DIR.clear();
}
