# Stage 2U-B `/usage_status` Freshness Fix Report

Generated: 2026-05-23. Host: managed dev VM (Linux 6.8.0). Codex: `codex-cli
0.133.0`. Claude Code: `2.1.149 (Claude Code)`.

This report records BEHAVIOR DESCRIPTIONS, STATUS RESULTS, EXIT CODES, and
NON-SECRET TEST/VERIFICATION COUNTS ONLY. No API key, auth file, token, env
value, raw statusline payload, or config secret was printed, hashed, encoded, or
persisted at any point. No new behavior was introduced by this report step; it
documents the freshness fix delivered by tasks `usage-status-claude-active-refresh`
and `usage-status-codex-ccusage-reliability`.

Scope: a follow-up discovered during manual testing of the Stage 2U-B
`/usage_status` command — Claude Code live quota rendered **stale**, and the Codex
`codex-limit` and `ccusage` historical sources were unreliable (timed out before
producing data). This report explains the root cause, the proofs that motivated
the chosen refresh mechanism, the exact implementation, and the verification.

Relevant commits:

- `daf448b9b` — `add-usage-status-command` (original `/usage_status` + statusline cache script)
- `6b8642f12` — `usage-status-claude-active-refresh` (bounded pseudo-TTY refresh)
- `342d7a09c` — `usage-status-codex-ccusage-reliability` (Codex/ccusage timeout + caching)

---

## 1. Root cause of stale Claude values

`/usage_status` reads Claude Code live quota from a local cache file:

```
~/.cache/claude-code/statusline.json   (honors XDG_CACHE_HOME)
```

That cache is written **only** by `scripts/claude-statusline.mjs`, which is
invoked by Claude Code's `statusLine` feature. Claude Code spawns the configured
`statusLine` command on each status refresh and pipes a JSON payload (containing
`rate_limits.five_hour.*` and `rate_limits.seven_day.*`) to the command's stdin;
the script atomically writes that exact payload to the cache.

The consequence: **the cache only advances while Claude Code is actively
running.** When an operator runs `/usage_status` from Telegram, no Claude session
is necessarily live, so the file still holds whatever values were current the
last time Claude itself ran the statusLine command. The numbers therefore looked
"stale" — they were a frozen snapshot, not current quota.

The fix is to give `/usage_status` a way to *actively* trigger a single,
bounded Claude statusLine refresh when the cache is missing or stale, then read
the freshly written cache — without ever calling `claude -p "/usage"` /
`claude /usage`, and without leaking secrets or leaving processes behind.

---

## 2. Proofs that motivated the pseudo-TTY refresh

During the freshness investigation, three Claude invocation modes were tried to
see which one actually causes Claude Code to run its `statusLine` command (and so
update the cache). Observed behavior:

| Invocation | Refreshes `statusline.json`? |
| --- | --- |
| `claude -p "..."` (print / headless mode) | **No** — print mode does not render the status line, so the `statusLine` command is never invoked and the cache is unchanged. |
| Headless non-PTY `claude "..."` (no TTY attached) | **No** — without an interactive terminal the status line is not rendered, so the cache is unchanged. |
| Pseudo-TTY `claude "..."` (run under a PTY) | **Yes** — Claude renders the interactive status line, invokes the `statusLine` command, and the cache is rewritten. |

Empirical confirmation of the working mode: a pseudo-TTY `claude "..."` run moved
the cache from **5h 23% / 7d 19%** to **~5h 90% / 7d 23%**, and after the run
**no lingering `claude` / `script` / child processes remained** (process-group
cleanup verified — see §4).

Because only the pseudo-TTY path refreshes the cache, the implementation wraps
Claude in a PTY via `script` rather than using `claude -p` or `--bare`.

---

## 3. Exact refresh implementation

Implemented in `src/telegram/usage-status.ts`.

**Command** — `buildClaudeStatuslineRefreshCommand()` returns a fixed pseudo-TTY
wrapper:

```
script -q -e -c 'claude "respond with only a period"' /dev/null
```

- `script` provides the pseudo-TTY so Claude renders its status line (the only
  mode that refreshes the cache; see §2).
- `-q` quiet, `-e` returns the child's exit code, `-c` runs the command, output
  discarded to `/dev/null`.
- The Claude prompt is a trivial `"respond with only a period"` to keep the
  session as short as possible.
- It deliberately does **not** use `claude -p` or `--bare` (asserted by tests).

**Credential-stripped environment** — `buildClaudeRefreshEnv()` clones the env
and deletes the whole Anthropic API-key family so the refresh authenticates via
the operator's Claude subscription/OAuth session rather than an inherited API
key (consistent with the `subscription-auth-env-isolation` lesson):

```
ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY_OLD
```

**Spawn + cleanup** — the child is spawned `detached: true` (its own process
group), `stdio: "ignore"`, then `unref()`ed. Cleanup runs in a `finally` block
via `terminateProcessGroup(proc)` so it executes on success, timeout, and error:

- Sends `SIGTERM` to the **process group** (`-proc.pid`); on failure it falls
  back to `proc.kill("SIGTERM")`.
- If the process is still alive (`process.kill(pid, 0)` probe), it escalates to
  `SIGKILL` on the group, with the same per-process fallback.
- Net effect: no leftover `claude` / `script` / process-group members remain
  after either a successful observation or a timeout.

`refreshClaudeStatuslineCache(...)` is only attempted when the cache is missing
or older than the stale threshold (`STALE_THRESHOLD_MS = 15 min`); a fresh cache
is used as-is with no refresh. The refresher is fully injectable
(`refreshClaudeStatusline` option) so tests never spawn real processes.

---

## 4. Corrected exit condition

The poll loop reads the cache every `CLAUDE_REFRESH_POLL_MS` (250 ms) up to
`CLAUDE_REFRESH_TIMEOUT_MS` (20 s). It does **not** stop merely because the file
mtime changed (a partial / mid-write payload would otherwise be accepted).
Success is declared only when **both** conditions hold:

1. `current.mtimeMs > beforeMtimeMs` — the cache was rewritten since the refresh
   began (captured as `beforeMtimeMs` before spawning), **and**
2. `hasCompleteClaudeStatusline(current)` — all four rate-limit fields are
   present:
   - `rate_limits.five_hour.used_percentage`
   - `rate_limits.five_hour.resets_at`
   - `rate_limits.seven_day.used_percentage`
   - `rate_limits.seven_day.resets_at`

Other outcomes:

- Spawn error (e.g. `script` unavailable) → `{ status: "unavailable" }`.
- Deadline reached without a complete observation → `{ status: "timeout" }`,
  after which the section falls back to the stale cache (clearly labeled) or
  "unavailable".

This is the corrected behavior: **mtime change AND all four fields present.**

---

## 5. Reset-time display behavior

- `formatResetAt()` accepts both epoch-seconds and ISO strings. An all-digits
  value is treated as epoch seconds and rendered via
  `new Date(epochSeconds * 1000).toISOString()`; any other string is passed
  through (already an ISO timestamp).
- Each window renders as, e.g., `5-hour: 90% used, resets 2026-05-23T12:40:00.000Z`
  (and `7-day: 23% used, resets ...`). When a window has no data it shows
  `not reported`.
- **Freshness label** on the Claude section:
  - `refreshed/current` — an active refresh succeeded this run.
  - `current` — cache age ≤ 15 min, no refresh needed.
  - `stale` — cache age > 15 min and no successful refresh; values are shown but
    **explicitly labeled stale**, with the cache "Updated …(<age> ago)" line and,
    when applicable, the refresh failure class (e.g. `Refresh failed: refresh
    timed out.`).
  - `unavailable` — no cache present or cache unparseable (with the refresh
    failure reason when known). Never throws.
- Every Claude section restates that the cache "only updates while Claude Code is
  running."

---

## 6. Codex `codex-limit` timeout / caching fix and parsed shape

Codex live quota is fetched with an argv array (no shell string):

```
npx -y codex-limit --json     timeout = CODEX_LIMIT_TIMEOUT_MS (15 s)
```

The 15 s bound is large enough for the observed ~4.2 s runtime while staying
bounded so the Telegram command stays responsive. `-y` keeps `npx`
non-interactive.

**Parsed shape** (`parseCodexLimit` → `firstWindow`/`pickWindow`), tolerant of
both flat and `rate_limits`-nested payloads and both camelCase/snake_case:

- `primary` window (keys `primary` / `burst` / `five_hour` / `fiveHour`):
  `usedPercent` / `used_percentage` / `usedPercentage`, `windowDurationMins`,
  `resetsAt` / `reset_at` (epoch seconds or ISO).
- `secondary` window (keys `secondary` / `weekly` / `seven_day` / `sevenDay`):
  same fields.
- `credits.hasCredits` (boolean) and `credits.balance` (number).
- `planType` / `plan_type`.
- `rateLimitReachedType` / `rate_limit_reached_type`.

**Rendering** shows `Primary (<duration>): X% used, resets <time>` and the same
for Secondary, a `Details:` line (`plan …; credits available, balance …`), and —
when `rateLimitReachedType` is set — an explicit
`Status: exhausted/rate-limit reached (<type>).`

**Caching / fallback** (`codexQuotaCache`): the last successfully parsed result is
cached in-process. On timeout, failure, or unrecognized output, the section shows
the cached value clearly labeled `Status: stale (cached <ts> (<age> ago);
codex-limit <reason>)`. If no cache exists it shows
`Live quota unavailable (codex-limit <reason>)` (e.g. `command not found`,
`timed out`). No secrets are emitted.

---

## 7. `ccusage` timeout / caching fix

Historical usage is fetched with argv arrays:

```
npx -y ccusage@latest claude daily --json    timeout = CCUSAGE_TIMEOUT_MS (20 s)
npx -y ccusage@latest codex  daily --json    timeout = CCUSAGE_TIMEOUT_MS (20 s)
```

The 20 s bound accommodates the observed runtimes (Claude ~7.4 s, Codex ~13.1 s)
while staying bounded. `parseCcusageDaily` extracts `days` (`daily.length`),
`totalCost`, and `totalTokens` from `totals`. Each result is cached per key
(`historicalUsageCache.claude` / `.codex`); on timeout/failure the cached summary
is shown labeled `(stale; cached <ts> (<age> ago); ccusage <reason>)`, otherwise
`unavailable (<reason>)`.

The whole block is rendered under the header **"Historical usage — local logs,
not remaining quota"**, after both live sections, so historical token/cost usage
is never confused with live remaining quota.

All CLIs run with a 4 MB `maxBuffer`, and the final message is passed through
`redactSecretValues` (`includeConfigSecrets: false` + token-like env values) as
defense in depth. Output is built only from parsed numeric/time fields, never raw
payloads.

---

## 8. statusLine wiring (operator setup, unchanged here)

`scripts/claude-statusline.mjs` writes **only Claude's own statusLine payload**
to `~/.cache/claude-code/statusline.json` (atomic temp-then-rename), echoes a
compact `Claude usage: 5h X% · 7d Y%` line back to Claude, and never throws /
always exits 0. `/usage_status` never prints the raw statusline JSON to Telegram.

To enable cache writes while Claude runs, operators add to their **user-level**
`~/.claude/settings.json` (do not overwrite unrelated settings):

```json
{ "statusLine": { "type": "command",
    "command": "node /path/to/scripts/claude-statusline.mjs" } }
```

---

## 9. Tests added

All external CLIs and the pseudo-TTY refresh are mocked; no real network or
process is spawned. `src/telegram/usage-status.test.ts` covers:

Message rendering (`buildUsageStatusMessage`):
- Claude live quota rendered from a fresh cache (`Status: current`, 5h/7d lines).
- Cache marked **stale only after refresh fails** (shows stale values + failure class).
- Missing cache reported gracefully (`unavailable`, no throw).
- **Stale cache refreshed**, reset times rendered **from epoch seconds**
  (5h 90% and 7d 23%, matching the observed real-world move).
- Raw statusline payload fields (`session_id`, `auth`) and token-like values
  never appear in the output.
- Codex parsed from `codex-limit --json` (Primary/Secondary + Details), asserting
  the **argv array** `["-y","codex-limit","--json"]` and **15 s** timeout.
- `codex-limit` unavailable → concise message.
- Codex **stale cached** value reused on timeout; timeout with no cache →
  unavailable.
- Codex **exhausted** state from `rateLimitReachedType`.
- Historical ccusage rendered **separately from / after** live quota.
- Historical **stale cached** values reused on later timeout, asserting **20 s**
  timeout.
- Token-like values redacted (`[REDACTED]`).
- `XDG_CACHE_HOME` cache-path resolution.

Active refresh (`refreshClaudeStatuslineCache` / `buildClaudeStatuslineRefreshCommand`):
- Command uses a pseudo-TTY `claude "..."` with **no `-p` / no `--bare`**.
- Succeeds only on **mtime change AND all four rate_limit fields** present.
- **Process-group cleanup** on timeout (SIGTERM then SIGKILL to `-pid`).
- Anthropic API credential env vars (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY_OLD`) unset for the refresh; unrelated
  env preserved.

Registration:
- Appears in the public Telegram menu.
- Published + registered through the native command registry.
- Sends the message to the requesting chat.

Total: **21 tests** in `src/telegram/usage-status.test.ts`.

---

## 10. Verification results

Run from the repo root on 2026-05-23:

| Command | Result |
| --- | --- |
| `pnpm vitest run src/telegram/usage-status.test.ts` | ✅ 1 file, **21 passed**, exit 0 |
| `pnpm exec tsc -p tsconfig.json` | ✅ clean, exit 0 |
| `pnpm build` | ✅ success, exit 0 |
| `pnpm lint` | ✅ **0 warnings / 0 errors**, exit 0 |

`pnpm lint` runs `oxlint --type-aware src test` over 2336 files with 104 rules.

---

## 11. Manual verification steps

To validate live on an operator host:

1. Ensure the statusLine wiring from §8 is present in `~/.claude/settings.json`.
2. Run `/usage_status` from an authorized Telegram chat.
3. **Claude live quota** — confirm it shows either `refreshed/current` (the
   command actively refreshed the cache) or a clearly **stale** state with the
   reason and cache age. It must never error out.
4. Confirm the Claude **5-hour and 7-day reset times** are displayed (epoch
   seconds rendered as ISO timestamps).
5. **Codex live quota** — confirm Primary/Secondary usage + reset times appear,
   or a clearly labeled cached/`unavailable` state with the failure class.
6. **Historical usage** — confirm it is labeled "Historical usage — local logs,
   not remaining quota" and rendered separately from the live sections.
7. Confirm no leftover `claude` / `script` processes remain after the command
   (e.g. via a process check); the refresh process group is cleaned up on both
   success and timeout.
8. **Exhausted-state check (later)** — when Claude or Codex quota is actually
   exhausted, rerun `/usage_status` and confirm the exhausted / rate-limit-reached
   state and reset times render clearly (Codex `Status: exhausted/rate-limit
   reached (<type>)`; Claude high-percentage with reset time).

---

## 12. Remaining known issues

- The Claude active refresh starts a short real Claude session (a few seconds)
  when the cache is stale; this consumes a negligible amount of subscription
  usage. It is bounded (20 s) and only triggered when the cache is missing/stale.
- If `script` (util-linux) is unavailable on a host, the pseudo-TTY refresh
  reports `unavailable` and `/usage_status` falls back to the stale/missing cache
  message rather than refreshing — no heavy dependency was added to work around
  this.
- Live quota accuracy still depends on the operator having wired the statusLine
  command (§8); without it, Claude live quota will report missing/stale until a
  successful active refresh writes the cache.
