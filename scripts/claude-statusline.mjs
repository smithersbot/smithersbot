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

function pickString(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function pickWindow(value) {
  if (!value || typeof value !== "object") return undefined;
  const usedPercentage = pickNumber(value, [
    "used_percentage",
    "used_percent",
    "usedPercentage",
    "usedPercent",
  ]);
  const resetsAt = pickString(value, ["resets_at", "reset_at", "resetsAt", "reset"]);
  if (usedPercentage == null || !resetsAt) return undefined;
  return { usedPercentage, resetsAt };
}

function parseCompleteStatusline(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const limits = parsed?.rate_limits;
  if (!limits || typeof limits !== "object") return undefined;
  const fiveHour = pickWindow(limits.five_hour ?? limits.fiveHour);
  const sevenDay = pickWindow(limits.seven_day ?? limits.sevenDay);
  if (!fiveHour || !sevenDay) return undefined;
  return { fiveHour, sevenDay };
}

function formatStatusLine(statusline) {
  const parts = [];
  parts.push(`5h ${Math.round(statusline.fiveHour.usedPercentage)}%`);
  parts.push(`7d ${Math.round(statusline.sevenDay.usedPercentage)}%`);
  return parts.length ? `Claude usage: ${parts.join(" · ")}` : "";
}

function main() {
  const raw = readStdin();
  const statusline = raw.trim() ? parseCompleteStatusline(raw) : undefined;
  if (statusline) {
    // Store only the JSON Claude itself passes us — no auth, env, or config.
    writeCache(resolveCacheFile(), raw);
  }
  // Echo a compact status line back to Claude Code for display.
  const line = statusline ? formatStatusLine(statusline) : "";
  if (line) {
    try {
      fs.writeSync(1, line);
    } catch {
      // Display is best-effort, just like caching.
    }
  }
}

main();
