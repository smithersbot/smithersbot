import fs from "node:fs";
import path from "node:path";
import {
  resolveAgentGoalHistoryDir,
  resolveAgentRoot,
  resolvePrivateAuthDir,
  resolvePrivateConfigDir,
  resolvePrivateEnvDir,
  resolvePrivateRoot,
  resolvePrivateSessionsDir,
} from "../config/managed-paths.js";
import { resolveCronStorePath } from "../cron/store.js";
import { isSecretPath, redactSecretValues } from "../security/secret-paths.js";
import { resolveRunDir } from "./run-store.js";

export const RUNTIME_MIRROR_TEXT_CAP_BYTES = 10 * 1024 * 1024;
export const RUNTIME_MIRROR_STREAM_CAP_BYTES = 25 * 1024 * 1024;
export const RUNTIME_MIRROR_HARD_CAP_BYTES = 50 * 1024 * 1024;
export const RUNTIME_MIRROR_TRUNCATION_MARKER =
  "\n\n[... runtime mirror truncated: kept head and tail ...]\n\n";
export const RUNTIME_MIRROR_REDACTION = "[REDACTED]";

const SQLITE_OR_DB_EXTENSIONS = new Set([".sqlite", ".sqlite3", ".db", ".db3"]);
const LOCK_EXTENSIONS = new Set([".lock"]);
const FORBIDDEN_FILE_NAMES = new Set([
  "auth.json",
  "oauth.json",
  "moltbot.json",
  "clawdbot.json",
  "smithersbot.json",
]);

export type RuntimeMirrorSourceKind = "goal-runtime" | "cron-runtime";

export type RuntimeMirrorIndexEntry = {
  relativePath: string;
  kind: string;
  category: string;
  originalBytes: number;
  mirroredBytes: number;
  redactionCount: number;
  truncated: boolean;
  skipped: boolean;
  skipReason?: string;
  sourceKind: RuntimeMirrorSourceKind;
};

export type RuntimeMirrorIndex = {
  generatedAt: string;
  sourceKind: RuntimeMirrorSourceKind;
  entries: RuntimeMirrorIndexEntry[];
};

export type RuntimeMirrorCaps = {
  textJsonBytes?: number;
  streamBytes?: number;
  hardBytes?: number;
};

export type MirrorGoalRuntimeParams = {
  workspaceName: string;
  goalId: string;
  goalsDir?: string;
  sourceDir?: string;
  destinationDir?: string;
  caps?: RuntimeMirrorCaps;
  secretValues?: readonly string[];
};

export type MirrorCronRuntimeParams = {
  storePath?: string;
  sourceDir?: string;
  destinationDir?: string;
  caps?: RuntimeMirrorCaps;
  secretValues?: readonly string[];
};

export type RedactedMirrorText = {
  text: string;
  redactionCount: number;
};

type ResolvedCaps = {
  textJsonBytes: number;
  streamBytes: number;
  hardBytes: number;
};

type TruncatedBuffer = {
  buffer: Buffer;
  truncated: boolean;
};

function resolveCaps(caps: RuntimeMirrorCaps | undefined): ResolvedCaps {
  const hardBytes = Math.max(1, caps?.hardBytes ?? RUNTIME_MIRROR_HARD_CAP_BYTES);
  return {
    textJsonBytes: Math.min(
      hardBytes,
      Math.max(1, caps?.textJsonBytes ?? RUNTIME_MIRROR_TEXT_CAP_BYTES),
    ),
    streamBytes: Math.min(
      hardBytes,
      Math.max(1, caps?.streamBytes ?? RUNTIME_MIRROR_STREAM_CAP_BYTES),
    ),
    hardBytes,
  };
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
}

function atomicWriteText(filePath: string, value: string): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, value, "utf8");
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o644);
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function classifyCategory(relativePath: string): string {
  const normalized = toPosixPath(relativePath);
  const [top = "root"] = normalized.split("/");
  if (normalized === "run.json") return "run";
  if (normalized === "WORKING.md") return "working";
  if (top === "workers") return "workers";
  if (top === "scout") return "scout";
  if (top === "autocheck" || top === "replan") return "autocheck";
  if (top === "manual-tests") return "manual-tests";
  if (top === "lessons") return "lessons";
  if (top === "runs") return "cron-runs";
  if (normalized === "jobs.json") return "cron-jobs";
  return top;
}

function classifyKind(relativePath: string, sourceKind: RuntimeMirrorSourceKind): string {
  if (sourceKind === "cron-runtime") {
    return toPosixPath(relativePath) === "jobs.json" ? "cron-jobs" : "cron-run-log";
  }
  const ext = path.extname(relativePath).toLowerCase();
  if (ext === ".json") return "json";
  if (ext === ".jsonl") return "jsonl";
  if (ext === ".md") return "markdown";
  if ([".txt", ".log"].includes(ext)) return "text";
  return "runtime-artifact";
}

function isForbiddenFileName(baseName: string): boolean {
  const lower = baseName.toLowerCase();
  if (lower.startsWith(".env")) return true;
  if (lower.startsWith("credentials")) return true;
  if (lower.endsWith(".pem")) return true;
  if (lower.endsWith(".key")) return true;
  if (lower.endsWith(".p12")) return true;
  if (lower.endsWith(".pfx")) return true;
  if (lower.endsWith(".token")) return true;
  return FORBIDDEN_FILE_NAMES.has(lower);
}

export function classifyRuntimeMirrorSkip(
  relativePath: string,
  stat?: fs.Stats,
): string | undefined {
  const baseName = path.basename(relativePath);
  const lower = baseName.toLowerCase();
  const ext = path.extname(lower);
  if (lower.endsWith(".bak")) return "backup file";
  if (isForbiddenFileName(baseName)) return "forbidden file";
  if (LOCK_EXTENSIONS.has(ext) || lower.endsWith(".lock")) return "lock file";
  if (SQLITE_OR_DB_EXTENSIONS.has(ext)) return "database file";
  if (isSecretPath(relativePath, { cwd: "/", homeDir: "/" })) return "secret path";
  if (stat?.isSocket()) return "socket";
  if (stat && !stat.isFile()) return "non-regular file";
  return undefined;
}

function looksBinary(buffer: Buffer): boolean {
  const sampleSize = Math.min(buffer.length, 8192);
  if (sampleSize === 0) return false;
  let suspicious = 0;
  for (let index = 0; index < sampleSize; index += 1) {
    const byte = buffer[index] ?? 0;
    if (byte === 0) return true;
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1;
  }
  return suspicious / sampleSize > 0.3;
}

function capForPath(relativePath: string, caps: ResolvedCaps): number {
  const normalized = toPosixPath(relativePath).toLowerCase();
  if (
    normalized.includes("stdout") ||
    normalized.includes("stderr") ||
    normalized.includes("response")
  ) {
    return caps.streamBytes;
  }
  return caps.textJsonBytes;
}

function readWithCap(filePath: string, capBytes: number, hardBytes: number): TruncatedBuffer {
  const stat = fs.statSync(filePath);
  const effectiveCap = Math.min(capBytes, hardBytes);
  if (stat.size <= effectiveCap) {
    return { buffer: fs.readFileSync(filePath), truncated: false };
  }

  const marker = Buffer.from(RUNTIME_MIRROR_TRUNCATION_MARKER, "utf8");
  const available = Math.max(0, effectiveCap - marker.length);
  const headSize = Math.floor(available / 2);
  const tailSize = available - headSize;
  const fd = fs.openSync(filePath, "r");
  try {
    const head = Buffer.alloc(headSize);
    const tail = Buffer.alloc(tailSize);
    if (headSize > 0) fs.readSync(fd, head, 0, headSize, 0);
    if (tailSize > 0) fs.readSync(fd, tail, 0, tailSize, stat.size - tailSize);
    return { buffer: Buffer.concat([head, marker, tail]), truncated: true };
  } finally {
    fs.closeSync(fd);
  }
}

function countReplacementDelta(original: string, redacted: string): number {
  const count = (value: string): number => value.split(RUNTIME_MIRROR_REDACTION).length - 1;
  return Math.max(0, count(redacted) - count(original));
}

function replaceAndCount(
  input: string,
  pattern: RegExp,
  replacement:
    | string
    | ((substring: string, ...args: string[]) => string) = RUNTIME_MIRROR_REDACTION,
): { text: string; count: number } {
  let count = 0;
  const text = input.replace(pattern, (substring: string, ...args: string[]) => {
    count += 1;
    return typeof replacement === "function" ? replacement(substring, ...args) : replacement;
  });
  return { text, count };
}

function sensitiveHostPathPatterns(): RegExp[] {
  const escapedRoots = [
    resolvePrivateRoot(),
    resolvePrivateConfigDir(),
    resolvePrivateAuthDir(),
    resolvePrivateSessionsDir(),
    resolvePrivateEnvDir("smithersbot"),
    path.join(process.env.HOME ?? "", ".claude"),
    path.join(process.env.HOME ?? "", ".codex"),
    path.join(process.env.HOME ?? "", ".smithersbot"),
    path.join(process.env.HOME ?? "", ".moltbot"),
    path.join(process.env.HOME ?? "", ".clawdbot"),
    path.join(process.env.HOME ?? "", ".clawdbot-dev"),
  ]
    .filter((value) => value.trim().length > 1)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return escapedRoots.map((root) => new RegExp(`${root}(?:[A-Za-z0-9._~:/\\\\-]*)?`, "g"));
}

export function redactRuntimeMirrorText(
  text: string,
  options: { secretValues?: readonly string[] } = {},
): RedactedMirrorText {
  let redacted = redactSecretValues(text, { secretValues: options.secretValues });
  let redactionCount = countReplacementDelta(text, redacted);

  const patterns: RegExp[] = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\bgh[opsu]_[A-Za-z0-9_]{20,}\b/g,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    /(\b(?:token|password|secret|api[_-]?key|authorization|bot[_-]?token|signing[_-]?secret)\b\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,}]+)/gi,
  ];

  for (const pattern of patterns) {
    const result = replaceAndCount(redacted, pattern, (match, prefix?: string) =>
      typeof prefix === "string" && match.startsWith(prefix)
        ? `${prefix}${RUNTIME_MIRROR_REDACTION}`
        : RUNTIME_MIRROR_REDACTION,
    );
    redacted = result.text;
    redactionCount += result.count;
  }

  for (const pattern of sensitiveHostPathPatterns()) {
    const result = replaceAndCount(redacted, pattern);
    redacted = result.text;
    redactionCount += result.count;
  }

  return { text: redacted, redactionCount };
}

function collectFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];
  const results: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else {
        results.push(fullPath);
      }
    }
  };
  visit(rootDir);
  return results.sort((a, b) => a.localeCompare(b));
}

function mirrorTree(params: {
  sourceDir: string;
  destinationDir: string;
  sourceKind: RuntimeMirrorSourceKind;
  caps?: RuntimeMirrorCaps;
  secretValues?: readonly string[];
  include?: (relativePath: string) => boolean;
}): RuntimeMirrorIndex {
  const sourceDir = path.resolve(params.sourceDir);
  const destinationDir = path.resolve(params.destinationDir);
  const caps = resolveCaps(params.caps);
  const entries: RuntimeMirrorIndexEntry[] = [];

  ensureDir(destinationDir);

  for (const sourcePath of collectFiles(sourceDir)) {
    const relativePath = toPosixPath(path.relative(sourceDir, sourcePath));
    if (!relativePath || relativePath.startsWith("../")) continue;
    if (params.include && !params.include(relativePath)) continue;

    const baseEntry = {
      relativePath,
      kind: classifyKind(relativePath, params.sourceKind),
      category: classifyCategory(relativePath),
      sourceKind: params.sourceKind,
    };

    if (!isInside(sourcePath, sourceDir)) {
      entries.push({
        ...baseEntry,
        originalBytes: 0,
        mirroredBytes: 0,
        redactionCount: 0,
        truncated: false,
        skipped: true,
        skipReason: "outside scoped source tree",
      });
      continue;
    }

    const stat = fs.lstatSync(sourcePath);
    const skipReason = classifyRuntimeMirrorSkip(relativePath, stat);
    if (skipReason) {
      entries.push({
        ...baseEntry,
        originalBytes: stat.size,
        mirroredBytes: 0,
        redactionCount: 0,
        truncated: false,
        skipped: true,
        skipReason,
      });
      continue;
    }

    const { buffer, truncated } = readWithCap(
      sourcePath,
      capForPath(relativePath, caps),
      caps.hardBytes,
    );
    if (looksBinary(buffer)) {
      entries.push({
        ...baseEntry,
        originalBytes: stat.size,
        mirroredBytes: 0,
        redactionCount: 0,
        truncated,
        skipped: true,
        skipReason: "binary file",
      });
      continue;
    }

    const originalText = buffer.toString("utf8");
    const redacted = redactRuntimeMirrorText(originalText, { secretValues: params.secretValues });
    const destinationPath = path.join(destinationDir, relativePath);
    atomicWriteText(destinationPath, redacted.text);
    entries.push({
      ...baseEntry,
      originalBytes: stat.size,
      mirroredBytes: Buffer.byteLength(redacted.text, "utf8"),
      redactionCount: redacted.redactionCount,
      truncated,
      skipped: false,
    });
  }

  const index: RuntimeMirrorIndex = {
    generatedAt: new Date().toISOString(),
    sourceKind: params.sourceKind,
    entries,
  };
  atomicWriteText(path.join(destinationDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

export function mirrorGoalRuntimeToAgentHistory(
  params: MirrorGoalRuntimeParams,
): RuntimeMirrorIndex {
  const sourceDir = params.sourceDir ?? resolveRunDir(params.goalId, params.goalsDir);
  const destinationDir =
    params.destinationDir ??
    path.join(resolveAgentGoalHistoryDir(params.workspaceName, params.goalId), "runtime");
  return mirrorTree({
    sourceDir,
    destinationDir,
    sourceKind: "goal-runtime",
    caps: params.caps,
    secretValues: params.secretValues,
  });
}

export function mirrorCronRuntimeToAgentHistory(
  params: MirrorCronRuntimeParams = {},
): RuntimeMirrorIndex {
  const storePath = path.resolve(params.storePath ?? resolveCronStorePath());
  const sourceDir = params.sourceDir ?? path.dirname(storePath);
  const destinationDir = params.destinationDir ?? path.join(resolveAgentRoot(), "history", "cron");
  const normalizedStore = toPosixPath(path.relative(sourceDir, storePath));
  return mirrorTree({
    sourceDir,
    destinationDir,
    sourceKind: "cron-runtime",
    caps: params.caps,
    secretValues: params.secretValues,
    include: (relativePath) => relativePath === normalizedStore || relativePath.startsWith("runs/"),
  });
}
