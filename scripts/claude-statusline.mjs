#!/usr/bin/env node
// Claude Code statusLine helper.
//
// Claude Code's `statusLine` feature spawns a configured command on every
// status refresh and pipes a JSON payload describing the current session to
// the command's stdin. That payload includes live subscription rate-limit
// data, e.g.:
//   {
//     "rate_limits": {
//       "five_hour": { "used_percentage": 42, "resets_at": "2026-05-23T18:00:00Z" },
//       "seven_day": { "used_percentage": 10, "resets_at": "2026-05-30T00:00:00Z" }
//     }
//   }
//
// This script caches that exact JSON to ~/.cache/claude-code/statusline.json so
// that /usage_status can report live Claude quota without ever running
// `claude -p "/usage"` or `claude /usage`. The cache only refreshes while
// Claude Code is actively running (because Claude is what invokes this script).
//
// To enable, add to ~/.claude/settings.json:
//   { "statusLine": { "type": "command",
//       "command": "node /path/to/scripts/claude-statusline.mjs" } }
//
// The script never throws and always exits 0 so it cannot disrupt Claude Code.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function resolveCacheFile() {
  const base = process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), ".cache");
  return path.join(base, "claude-code", "statusline.json");
}

function readStdin() {
  try {
    // fd 0 is Claude's piped stdin. Reading it synchronously keeps the script
    // simple and avoids leaving the process hanging on the event loop.
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function writeCache(cacheFile, raw) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, raw);
    fs.renameSync(tmp, cacheFile);
  } catch {
    // Caching is best-effort; failures must not break the status line.
  }
}

function pickNumber(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function formatStatusLine(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "";
  }
  const limits = parsed?.rate_limits;
  if (!limits || typeof limits !== "object") return "";
  const fiveHour = pickNumber(limits.five_hour, ["used_percentage"]);
  const sevenDay = pickNumber(limits.seven_day, ["used_percentage"]);
  const parts = [];
  if (typeof fiveHour === "number") parts.push(`5h ${Math.round(fiveHour)}%`);
  if (typeof sevenDay === "number") parts.push(`7d ${Math.round(sevenDay)}%`);
  return parts.length ? `Claude usage: ${parts.join(" · ")}` : "";
}

function main() {
  const raw = readStdin();
  if (raw.trim()) {
    // Store only the JSON Claude itself passes us — no auth, env, or config.
    writeCache(resolveCacheFile(), raw);
  }
  // Echo a compact status line back to Claude Code for display.
  const line = formatStatusLine(raw);
  if (line) process.stdout.write(line);
}

main();
