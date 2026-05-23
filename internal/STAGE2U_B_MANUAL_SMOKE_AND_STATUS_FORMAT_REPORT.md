# Stage 2U-B Manual Smoke And Status-Format Report

Generated: 2026-05-23. Host: managed dev VM (Linux 6.8.0). Gateway version:
`2026.1.29 (07a3231)`. Codex: `codex-cli 0.133.0`. Claude Code: `2.1.149 (Claude
Code)`.

This report records BEHAVIOR DESCRIPTIONS, STATUS RESULTS, EXIT CODES, and
NON-SECRET TEST/VERIFICATION COUNTS ONLY. No API key, auth file, token, env
value, raw statusline payload, or config secret was printed, hashed, encoded, or
persisted at any point. The automated verification matrix (§9) was run by the
worker; the live Telegram smoke tests (§1–§8) are **operator steps** with
fill-in result fields — they were **not** executed by the worker because they
require a live gateway, live `/gateway_restart`, live `/goal_stop`, and live
Telegram round-trips that are out of scope for the worker.

Scope: this task polishes the Telegram status-command formatting (shared compact
formatter, bold title + bold labels, no double blank lines, compressed rows,
`current`/`stale`/`unavailable` wording, historical usage moved behind
`/usage_history`) and records the Stage 2U-B manual smoke tests that validate the
reliability fixes. No sandbox proof, quota-refresh mechanic, or goal-execution
architecture was changed by this task. The gateway was **NOT** restarted.

Relevant commits / surfaces:

- `bc1f6b453` — `shared-status-formatter` (`src/telegram/status-format.ts`)
- `b31699ea1` — `clean-usage-status` (`src/telegram/usage-status.ts`, `/usage_history`)
- `07a3231f9` — `clean-gateway-status` (`src/telegram/gateway-status.ts`)

**Legend (result fields):**

- `[AUTO]` — already enforced by an automated test/mock listed in §9; the
  operator step is a live confirmation, not the primary proof.
- `PASS / FAIL` — operator fills in after the live run.
- `OBSERVED:` — operator records the literal observed value (counts, PID, etc.).

Note on bold rendering: the builders emit Markdown (`**Title**`, `**Label:**`);
the send path converts to Telegram HTML via `renderTelegramHtmlText` and sends
with `parse_mode: "HTML"`, so the operator sees real bold, never literal
asterisks. The examples below show the **rendered** shape.

---

## 1. `/usage_status` — compact live quota

**Operator steps**

1. Ensure the Claude statusLine wiring is present in `~/.claude/settings.json`
   (see the Stage 2U-B freshness report §8); otherwise Claude live quota will
   refresh on demand or report stale/unavailable.
2. From an authorized Telegram chat, send `/usage_status`.
3. Read the rendered message on a mobile-width screen.

**Expected rendered shape** (values illustrative):

```
SmithersBot usage status
Claude Code: current
5-hour: 0% used, resets 2026-05-23T16:50:00.000Z
7-day: 24% used, resets 2026-05-28T16:00:00.000Z
Updated: 2026-05-23T12:30:00.000Z (1m ago)

Codex: current
Primary (5h): 1% used, resets 2026-05-23T17:00:00.000Z
Secondary (7d): 52% used, resets 2026-05-28T14:16:00.000Z
Credits: none available
```

**Result / status fields**

| Check | Coverage | Result |
| --- | --- | --- |
| Header `SmithersBot usage status` is **bold** | [AUTO] usage-status.test.ts (bold header) | PASS / FAIL |
| Labels before `:` are **bold** (`Claude Code:`, `5-hour:`, `Codex:`, `Credits:`) | [AUTO] usage-status.test.ts (bold labels) | PASS / FAIL |
| Compact one-line rows, readable on mobile | [AUTO] formatter rows | PASS / FAIL |
| Claude **5-hour** and **7-day** reset times visible | [AUTO] usage-status.test.ts (reset times) | PASS / FAIL |
| Codex Primary/Secondary reset times visible | [AUTO] usage-status.test.ts (Codex windows) | PASS / FAIL |
| Status uses only `current`/`stale`/`unavailable` (no "refreshed/current", no "refreshed now") | [AUTO] usage-status.test.ts (wording) | PASS / FAIL |
| **No** historical-usage block in default output (no "Historical usage — local logs, not remaining quota") | [AUTO] usage-status.test.ts (no history) | PASS / FAIL |
| No two blank lines in a row | [AUTO] status-format.test.ts (collapse) | PASS / FAIL |
| No secrets / no raw statusline payload (`session_id`, `auth`, token-like values) printed | [AUTO] usage-status.test.ts (redaction) | PASS / FAIL |
| Stale cache clearly labeled `stale` with reason + age | [AUTO] usage-status.test.ts (stale label) | PASS / FAIL |

OBSERVED freshness label for Claude: `__________` (current / stale / unavailable)
OBSERVED freshness label for Codex: `__________` (current / stale / unavailable)

---

## 2. `/gateway_status` — compact service status

**Operator steps**

1. From an authorized Telegram chat, send `/gateway_status`.
2. Read the rendered message.

**Expected rendered shape** (values illustrative):

```
Gateway status
Unit: moltbot-gateway-dev.service
PID: 43987
Started: 2026-05-23T11:59:00.000Z
Uptime: 2m 8s
CWD: managed workspace repo
Port: 19001
Profile: dev
Version: 2026.1.29 (07a3231)
Systemd: active/running
```

**Result / status fields**

| Check | Coverage | Result |
| --- | --- | --- |
| Header `Gateway status` is **bold** | [AUTO] gateway-status.test.ts (bold header) | PASS / FAIL |
| Every label before `:` is **bold** | [AUTO] gateway-status.test.ts (bold labels) | PASS / FAIL |
| No two blank lines in a row | [AUTO] status-format.test.ts (collapse) | PASS / FAIL |
| `Managed workspace: yes` compressed to `CWD: managed workspace repo` | [AUTO] gateway-status.test.ts (CWD summary) | PASS / FAIL |
| `Service marker: profile=…, marker=…, kind=…` compressed to `Profile: dev` | [AUTO] gateway-status.test.ts (Profile) | PASS / FAIL |
| `Systemd: active=…, sub=…, mainPid=…` compressed to `Systemd: active/running` | [AUTO] gateway-status.test.ts (Systemd) | PASS / FAIL |
| Correct **unit** (`moltbot-gateway-dev.service` on this host) | operator confirm | PASS / FAIL |
| Correct **process** (PID + uptime + started time) | operator confirm | PASS / FAIL |
| Correct **workspace** (managed workspace repo) | operator confirm | PASS / FAIL |
| Correct **version** (`2026.1.29 (<commit>)`) | operator confirm | PASS / FAIL |
| No secrets / token-like values printed | [AUTO] gateway-status.test.ts (redaction) | PASS / FAIL |
| Delivered with `parse_mode: HTML` so bold renders | [AUTO] bot-native-commands.gateway-status.test.ts | PASS / FAIL |

OBSERVED unit: `__________`
OBSERVED PID: `__________`
OBSERVED started time: `__________`

---

## 3. `/gateway_restart` — PID / start-time change

> Worker did NOT run this. The worker is denied live restart. Operator-only.

**Operator steps**

1. Send `/gateway_status`; record `PID` and `Started`.
2. Send `/gateway_restart` and wait for the restart to complete.
3. Send `/gateway_status` again; record the new `PID` and `Started`.

**Expected result**

- The post-restart `PID` differs from the pre-restart `PID`.
- The post-restart `Started` time is later than the pre-restart `Started` time.
- `Systemd: active/running` after the restart.

**Result / status fields**

| Field | Result |
| --- | --- |
| OBSERVED PID before | `__________` |
| OBSERVED PID after | `__________` |
| PID changed | PASS / FAIL |
| OBSERVED Started before | `__________` |
| OBSERVED Started after | `__________` |
| Started time advanced | PASS / FAIL |
| Systemd `active/running` after restart | PASS / FAIL |

---

## 4. `/goal_stop` — exactly one stop confirmation

> Worker did NOT run this. Operator-only (live goal + live stop).

**Operator steps**

1. Start a tiny safe goal, e.g. `/new_goal Report repo status only; edit no
   files; run no destructive commands.`
2. Note the goal id printed at planning start.
3. Shortly after planning starts (before/while workers run), send
   `/goal_stop <id>`.
4. Count the user-facing **stop confirmation** messages that appear.

**Expected result**

- **Exactly one** user-facing stop confirmation appears, not two.

**Result / status fields**

| Field | Result |
| --- | --- |
| Goal id used | `__________` |
| Number of stop-confirmation messages observed | OBSERVED: `____` (expect 1) |
| Exactly one confirmation (not two) | PASS / FAIL |

---

## 5. Codex repo-chat smoke

> Worker did NOT run this (live repo-chat round-trip). Operator-only.

**Operator steps**

1. Send `/chat_backend codex`.
2. Send `/repo_chat say exactly: codex repo chat smoke works`.

**Expected exact response**

```
codex repo chat smoke works
```

**Result / status fields**

| Field | Result |
| --- | --- |
| Backend switched to `codex` (confirmation shown) | PASS / FAIL |
| OBSERVED response | `__________` |
| Response matches exactly | PASS / FAIL |

---

## 6. Claude Code repo-chat smoke

> Worker did NOT run this (live repo-chat round-trip). Operator-only.

**Operator steps**

1. Send `/chat_backend claude_code`.
2. Send `/repo_chat say exactly: claude_code repo chat smoke works`.

**Expected exact response**

```
claude_code repo chat smoke works
```

**Result / status fields**

| Field | Result |
| --- | --- |
| Backend switched to `claude_code` (confirmation shown) | PASS / FAIL |
| OBSERVED response | `__________` |
| Response matches exactly | PASS / FAIL |

---

## 7. Codex worker smoke

> Worker did NOT run this (live goal execution). Operator-only.

**Operator steps**

1. Send `/goal_workers codex`.
2. Start a tiny safe goal that edits nothing and only reports status, e.g.
   `/new_goal Report current repo status only; do not edit any files; do not run
   destructive commands.`

**Expected result**

- The goal **completes** with a status report and no file edits.

**Result / status fields**

| Field | Result |
| --- | --- |
| Worker backend set to `codex` (confirmation shown) | PASS / FAIL |
| Goal id | `__________` |
| Goal completed | PASS / FAIL |
| No files edited | PASS / FAIL |

---

## 8. Claude Code worker smoke

> Worker did NOT run this (live goal execution). Operator-only.

**Operator steps**

1. Send `/goal_workers claude_code`.
2. Start the same tiny safe report-only goal as §7.

**Expected result**

- The goal **completes** with a status report and no file edits.

**Result / status fields**

| Field | Result |
| --- | --- |
| Worker backend set to `claude_code` (confirmation shown) | PASS / FAIL |
| Goal id | `__________` |
| Goal completed | PASS / FAIL |
| No files edited | PASS / FAIL |

---

## 8b. `/usage_history` (moved historical usage)

Historical usage now lives behind a separate command instead of the
`/usage_status` default output.

**Operator steps**

1. Send `/usage_history`.

**Expected rendered shape** (values illustrative):

```
SmithersBot usage history
Source: local logs, not remaining quota
Claude Code: 7 day(s), 1,234,567 tokens, $12.34
Codex: 7 day(s), 2,345,678 tokens, $23.45
```

**Result / status fields**

| Check | Coverage | Result |
| --- | --- | --- |
| Header bold, labels bold, no double blank lines | [AUTO] usage-status.test.ts / status-format.test.ts | PASS / FAIL |
| Source labeled "local logs, not remaining quota" | [AUTO] usage-status.test.ts | PASS / FAIL |
| Registered in native command registry + public menu | [AUTO] usage-status.test.ts (registry/menu) | PASS / FAIL |
| Stale cache labeled `stale` with reason + age | [AUTO] usage-status.test.ts | PASS / FAIL |

---

## 8c. Usage-exhausted follow-up note

When Claude or Codex quota is **naturally exhausted** later (not forced), the
operator should rerun `/usage_status` and verify the limit/reset rendering:

- Claude: high used-percentage with a visible 5-hour / 7-day reset time, status
  still labeled `current`/`stale`/`unavailable` (never errors).
- Codex: when `rateLimitReachedType` is present, a `Rate limit: <type>` row
  appears alongside the Primary/Secondary reset times; `Credits:` reflects the
  live availability.

**Result / status fields**

| Field | Result |
| --- | --- |
| Date checked | `__________` |
| Claude limit/reset rendered clearly | PASS / FAIL |
| Codex limit/reset (and rate-limit row if applicable) rendered clearly | PASS / FAIL |

---

## 9. Automated verification matrix

Run by the worker from the repo root
(`/home/matt/smithersbot-goals/agent/workspaces/smithersbot/repo`) on
2026-05-23:

| Command | Result | Exit |
| --- | --- | --- |
| `pnpm vitest run src/telegram/usage-status.test.ts src/telegram/gateway-status.test.ts src/telegram/bot-native-commands.gateway-status.test.ts src/auto-reply/commands-registry.test.ts src/telegram/status-format.test.ts` | 5 files, **49 passed** (usage-status 24, commands-registry 15, gateway-status 5, status-format 4, bot-native-commands.gateway-status 1) | 0 |
| `pnpm exec tsc -p tsconfig.json` | clean | 0 |
| `pnpm build` | tsc + copy steps OK | 0 |
| `pnpm lint` | **0 warnings / 0 errors** (oxlint `--type-aware src test`, 2338 files, 104 rules) | 0 |

The new `/usage_history` command is covered within
`src/telegram/usage-status.test.ts` (no separate test file was added); its
registry-and-menu checks are part of that suite's 24 tests.

All four commands exited 0. No secret, env value, token, raw statusline payload,
or config secret was printed or persisted by any command above.

---

## 10. What is proven by this task vs. operator-pending

| Item | Status |
| --- | --- |
| Shared compact formatter (bold title/labels, blank-line collapse) | ✅ proven (automated) |
| `/usage_status` compact output, reset times, `current/stale/unavailable`, no default history, redaction | ✅ proven (automated) |
| `/usage_history` historical output + registry/menu registration | ✅ proven (automated) |
| `/gateway_status` compact bold output, compressed CWD/Profile/Systemd, HTML send | ✅ proven (automated) |
| tsc / build / lint clean | ✅ proven (automated) |
| Live `/usage_status` & `/gateway_status` render on Telegram | ⏳ operator-pending (§1, §2) |
| `/gateway_restart` PID/start-time change | ⏳ operator-pending (§3) |
| `/goal_stop` single confirmation | ⏳ operator-pending (§4) |
| Codex / Claude repo-chat smoke | ⏳ operator-pending (§5, §6) |
| Codex / Claude worker smoke | ⏳ operator-pending (§7, §8) |
| Usage-exhausted limit/reset rendering | ⏳ operator-pending follow-up (§8c) |
