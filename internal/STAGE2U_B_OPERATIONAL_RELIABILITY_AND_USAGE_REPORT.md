# Stage 2U-B Operational Reliability And Usage Report

Generated: 2026-05-23. Host: managed dev VM (Linux 6.8.0). Codex: `codex-cli
0.133.0`. Claude Code: `2.1.149 (Claude Code)`.

This report records BEHAVIOR DESCRIPTIONS, STATUS RESULTS, EXIT CODES, and
NON-SECRET TEST/VERIFICATION COUNTS ONLY. No API key, auth file, token, env
value, raw statusline payload, or config secret was printed, hashed, encoded, or
persisted at any point. No sandbox policy or config was changed by this goal.

Scope: Stage 2U-B made SmithersBot more reliable under real launch conditions by
fixing backend usage-limit handling, fallback behavior, goal interruption/stop
UI, diagram/status rendering, and usage visibility. Token-reduction architecture,
scout/planner/checker redesign, and sandbox-policy changes were explicitly out of
scope.

---

## 1. Summary of changes (required outcomes)

| # | Outcome | Status |
| --- | --- | --- |
| 1 | Backend usage-limit classification + single-attempt fallback (all phases) | ✅ done |
| 2 | `/usage_status` command (Claude statusline cache + codex-limit + ccusage) | ✅ done |
| 3 | Blocked/interrupted message cleanup + attempt-history dedup | ✅ done |
| 4 | Resumed-goal visual-state fix | ✅ done |
| 5 | Redundant Mermaid edge removal (transitive reduction) | ✅ done |
| 6 | `/goal_stop` duplicate-response fix | ✅ done |
| 7 | Flowchart status-meaning documentation | ✅ done |
| 8 | Sandbox proof regression check (no policy change) | ✅ run + recorded |

---

## 2. Usage-limit classification behavior

Implemented in `src/goal/error-patterns.ts` (new `classifyUsageLimit({ backend,
text })`, `extractUsageLimitResetHint()`, and the types `UsageLimitBackend` /
`UsageLimitType` / `UsageLimitClassification`). Existing exports
(`RATE_LIMIT_RE`, `classifyProviderError`, etc.) are unchanged, so the
`cli-worker.ts` / `cli-planner.ts` consumers are unaffected.

- A limit is attributed to the **specific backend** that hit it — a Claude Code
  error such as `API 429: You've hit your org's monthly usage limit` now
  classifies as a **Claude Code** usage limit (not a generic API/org/monthly
  message); a Codex error classifies as a **Codex** usage limit.
- Limit **window** is detected when present: `five_hour`, `weekly`, `burst`,
  `monthly_extra` (extra-usage / monthly cap), or `unknown`.
- **Reset time** is extracted as a hint when the provider includes it.

The shared, channel-agnostic message formatter lives in
`src/goal/usage-limit-message.ts`: `backendDisplayName`, `limitTypeLabel`,
`describeUsageLimitEvent` (e.g. *"Claude Code hit a usage limit (5-hour limit,
resets at 3pm)"*), `formatUsageLimitFallbackMessage`,
`formatUsageLimitRecoveryMessage` (*"… Fell back to Codex. Codex succeeded."*),
`formatUsageLimitExhaustedMessage` (full history + no-fallback reason +
reset-times summary + original question), and `formatResetSummary`.

Backend limit messages therefore include: **backend name**, **limit type when
known**, **reset time when known**, and **whether the system will fall back**.

## 3. Fallback behavior

Worker-path fallback already existed in `src/goal/agent-executor.ts`; this goal
extended the messaging and wired single-attempt fallback into every remaining
backend-driven phase via a shared helper.

- **Shared helper** `src/goal/phase-fallback.ts`: `detectUsageLimitKind(text)`
  (returns `usage_limit` for explicit quota/monthly/weekly/burst caps,
  `rate_limit` for bare 429/overloaded, `undefined` otherwise) and
  `runWithBackendFallback<T>({ backends, attempt, onProgress,
  fallbackOnAnyError })`. The backend list is de-duplicated so **each backend is
  tried at most once → no infinite loops**. It accumulates `UsageLimitEvent`s,
  emits a `[usage-limit]` fallback progress line, a recovery message on success,
  and one clear exhausted message preserving history + reset-time summary.
- **`agent-executor.ts`** (worker path): `formatNoFallbackBlockedMessage`
  delegates to the formatter; the attempt loop accumulates events, emits the
  fallback progress + recovery lines, and builds the exhausted message with
  reset times across both backends. Fallback still tries the other backend at
  most once (`fallbackAttempted` guard).
- **Phases newly wired**: post-execution review
  (`src/goal/post-execution-review.ts`), manual tests generation
  (`src/goal/manual-tests.ts`), lessons extraction (`src/goal/lessons.ts`),
  repo-chat (`src/repo-chat/repo-chat-worker.ts`), plan autocheck / checker /
  review (`src/goal/plan-autocheck.ts`). Non-usage errors (e.g. *"Prompt is too
  long"*) stay terminal — only usage limits trigger fallback.
- **Planner/scout**: `cli-planner.ts` already implements claude→codex
  usage-limit fallback (`detectAnthropicDegradedReason`); no change needed,
  with added `scout.test.ts` coverage tying `classifyScoutError` +
  `detectUsageLimitKind` together.

Preserved failure history reads, e.g.: *"Claude Code hit usage limit, reset at … /
Falling back to Codex / Codex succeeded"*, and on exhaustion a single final
message with reset times where available.

## 4. `/usage_status` behavior and data sources

New command in `src/telegram/usage-status.ts` (follows the `gateway-status.ts`
pattern), registered in `src/telegram/bot-native-commands.ts` and listed in
`src/telegram/public-menu.ts`. It reports **live subscription quota separately
from historical usage**:

- **Claude live quota** — read from the statusline cache written by
  `scripts/claude-statusline.mjs`. That script is the Claude Code `statusLine`
  hook: it reads the JSON Claude pipes on stdin and atomically caches it
  verbatim (only Claude's own payload) to
  `~/.cache/claude-code/statusline.json` (honors `XDG_CACHE_HOME`), exposing
  `rate_limits.five_hour.used_percentage/resets_at` and `seven_day.*`. The
  command states the cache **only updates while Claude Code is running**; if the
  cache is **absent** it says *"No live quota cache found"* and if **stale**
  (mtime older than 15m) it says so — **without failing**. `claude -p "/usage"`
  / `claude /usage` are **not** used.
- **Codex live quota** — `npx -y codex-limit --json`, parsing burst/weekly
  used% + reset. On failure/offline it prints a concise non-secret
  *"unavailable (codex-limit command not found / timed out / …)"* message.
- **Historical usage** — `npx -y ccusage@latest claude daily --json` and
  `npx -y ccusage@latest codex daily --json`, clearly labeled *"Historical
  usage — local logs, not remaining quota"* so token/cost history is never
  confused with live subscription quota.

Security: all external CLIs are invoked with an argv array (no shell strings),
each with an 8s timeout; output is built only from parsed numeric/time fields
(never raw payloads) and passed through `redactSecretValues` from
`src/security/secret-paths.ts` as defense-in-depth. No API keys, auth files,
tokens, env values, raw statusline payloads, or config secrets are printed.

## 5. `/goal_stop` duplicate-response fix

Previously `/goal_stop` sent two messages: `Goal <id> stopped.` followed by
`Goal was stopped.`. Now there is a single clean response:

- `GoalPlanResult` gained `cancelled?: boolean`. `handleGoal`'s
  external-cancellation path returns `{ text: 'Goal was stopped.', runId,
  cancelled: true }`, and `sendGoalPlanResult` early-returns when
  `result.cancelled` is set — suppressing the redundant notice.
- The only user-visible stop response is now `handleGoalStop`'s authoritative
  message (`Goal <id> stopped. / Progress: x/y / **Goal ID:** <id>`), preserving
  goal id and status.

## 6. Blocked/interrupted UI fixes

In `src/telegram/goal-blocked-ui.ts` (`describeBlockedStep`,
`buildBlockedCaption`):

- **"needs input"** now renders only for true `user_input` (or null-reason)
  blockers.
- **Usage-limit blockers** render with backend name + limit window + reset time
  by reusing the shared classifier (`classifyUsageLimit` /
  `describeUsageLimitEvent`); worker-formatted exhausted/fallback histories are
  surfaced as-is.
- **Process loss / missing `worker_result.json` / timeout / turn-limit /
  network / auth** render as categorized *"worker interrupted / process lost /
  resume needed"* phrasing — not as fake user-input requests.
- **Attempt history is shown once** per blocked/interrupted report, not repeated
  under every step. `src/goal/blocked.ts` gained `splitAttemptHistory(text)` and
  `aggregateBlockedDetails` now deduplicates attempt-history blocks across
  multi-step reports (per-step lines show only the message; unique histories are
  appended once at the end). `buildBlockedCaption` strips per-step history and
  appends the deduped history once.

## 7. Resume visual-state fix

In `src/goal/execution-status.ts` (`computeDisplayStatuses`, visual-state
computation only — scheduler/execution semantics untouched):

- Root cause: the executor cascades pending steps to `blocked` on fatal errors
  and resume auto-retries every non-`user_input` block, but the renderer drew
  ANY `status === blocked` as a hard red blocker — so failed/downstream/
  independent/final steps looked permanently blocked even though resume runs
  them.
- Added `isRetryableBlocked(step)` (mirrors the scheduler's `retryableBlockedIds`:
  blocked && reason != null && != `user_input`) and `isHardBlocked(step)` (only
  `user_input` blocks or blocks with no actionable reason).
- `computeDisplayStatuses` now renders **only hard blocks** as `blocked` and
  propagates `soft_blocked` from them; retryable technical blocks
  (error/timeout/turn_limit/usage_limit/process_lost/out_of_credits/…) render as
  pending when their deps will run, and only `soft_blocked` when a genuinely
  hard-blocked dependency is upstream.
- Verified resume restoration paths (`goal-resume.ts` restore, `run-store.ts`
  `migrateRun`) already produce correct retryable data — no semantic change
  needed there; `blocked` now means truly blocked, not merely waiting on
  dependencies after a resume.

## 8. Mermaid redundant-edge fix

In `src/goal/mermaid-render.ts`: added `reduceDependencyEdges(steps)` which
builds a forward dependents adjacency map, computes memoized reachability
(visited-set BFS), and drops an edge `dep → step` when another dependency of
`step` is reachable from `dep`. So `a → b → c` no longer also draws the implied
`a → c`. Edges are returned in original emission order, so critical-path
`linkStyle` indices stay aligned. A cycle guard (only reduce when the alternate
path does not loop back to `dep`) prevents over-reduction on cyclic input.
Diamond, independent, and genuine-shortcut edges are preserved.

## 9. Flowchart status documentation location

Added in **`README.md`**, the `### Reading the goal flowchart` subsection (in
the "How it works" area, after the operator flow). It notes that redundant
arrows are removed and gives a node-style table for: pending/runnable, waiting on
a dependency (purple ⏳), running (orange 🛠), done (green ✅), and blocked-needs-you
(red ⛔). A following paragraph documents that failed attempts, interrupted/lost
workers (missing `worker_result.json`), timeouts, and backend usage limits are
auto-recovered on resume/fallback — so they render pending/waiting rather than
red — and that skipped/cancelled tasks leave active execution rather than getting
a distinct node style. This reflects the corrected resume state semantics from §7.

## 10. Sandbox proof regression results (no policy change)

Both Stage 2U proofs were run and recorded WITHOUT changing any sandbox policy.
Only status markers, exit codes, and CLI versions were emitted — no secrets, env,
auth, session, or file contents.

- **Codex sandbox works: YES.** `codexNativeSandboxStatus({ workingDir, purpose:
  'goal-worker', sandboxRoot: '/var/tmp' })` returned `proven=true` (full
  deny/allow matrix held: `README.md` / `.env.example` readable; repo
  `.env.local` / `.env.production` / `.env.test`, `~/.smithersbot/.env`,
  `~/.smithersbot/smithersbot.json`, managed private env, generated
  `CODEX_HOME/auth.json`, real `~/.codex/auth.json`, and symlink-escape ALL
  denied; managed workspace writable). No deny-read returned exit 0 → no
  `SECURITY_FAILURE_read_succeeded`. **Worker-env caveat:** under the goal-worker
  command filesystem sandbox the proof returns `proven=false /
  blocker=config-generation-failed` because the generated `CODEX_HOME` cannot be
  written under `/var/tmp` (outside the worker command-sandbox write allowlist) —
  a worker-env write limitation, NOT a security/policy failure; it passes when
  that write is permitted. No deny rule was weakened and no read grant broadened.
- **Claude Code sandbox works: YES.** Ran exactly:
  `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL
  SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES=1 node --import tsx
  scripts/prove-claude-sandbox.ts`. Phase summary: auth **PASS**;
  sandbox-basics **PASS** (startup + allowed reads OK, repo/private/symlink
  denied); deny-claude-auth **PASS**. Final: *"claude-live-sandbox: supported"* /
  *"Claude Code sandboxing proven: yes"* / **exit 0**. This is an improvement
  over `STAGE2U_A_LIVE_PROOF_AND_RESTART_GATE_REPORT.md` (Claude was
  environment-blocked / exit 2 there); Claude Code is now logged in on this host
  so the deny/allow live probe ran and passed.

**Security check:** no deny-read probe unexpectedly succeeded in either proof, so
the stop-and-flag security condition was not triggered. No sandbox policy/config
was modified.

---

## 11. Tests added

| Area | Test file | Coverage added |
| --- | --- | --- |
| Classifier + messaging | `src/goal/error-patterns.test.ts` (new) | classifyProviderError regression, Claude vs Codex classification, five_hour/weekly/burst/monthly_extra, reset-hint extraction, all formatter outputs |
| Worker fallback | `src/goal/agent-executor.test.ts` | fallback success preserving history+reset, both backends exhausted with reset times, Claude monthly classification |
| Shared fallback helper | `src/goal/phase-fallback.test.ts` (new) | de-dup backends (no loop), usage vs rate vs other classification, progress/recovery/exhausted messaging |
| Per-phase fallback | `post-execution-review.test.ts`, `manual-tests.test.ts`, `lessons.test.ts`, `repo-chat-worker.test.ts`, `plan-autocheck.test.ts`, `scout.test.ts` | Claude→Codex / Codex→Claude / both-exhausted / non-usage-no-fallback |
| `/usage_status` | `src/telegram/usage-status.test.ts` (new) | Claude cache present, stale cache, missing cache, mocked codex-limit (argv asserted), codex-limit unavailable, historical ccusage shown separately, secret/token redaction, XDG path, public-menu inclusion, native-registry publish+register, send path |
| Blocked/interrupted UI | `src/telegram/goal-commands.test.ts`, `src/goal/blocked.test.ts` | missing worker_result.json → interrupted (not needs-input), needs-input only for user_input, usage-limit backend+reset attribution, exhausted/fallback history preserved, attempt history shown once, attempt-history dedup across cascaded steps |
| `/goal_stop` | `src/telegram/goal-commands.test.ts` | single clean response preserving id/status, no "Goal was stopped.", sendGoalPlanResult suppresses cancelled results |
| Resume visual state | `src/goal/execution-status.test.ts`, `src/goal/run-store.test.ts` | blocked goal resumed, failed step retried → pending, downstream return to waiting/runnable, independent steps not blocked after unrelated resume, final step waiting-not-blocked, isHardBlocked/isRetryableBlocked units, load→display integration |
| Mermaid reduction | `src/goal/mermaid-render.test.ts` | a→b→c drops a→c, longer-chain drops a→d, diamond keeps 4 edges, independent chains intact, genuine shortcut kept, linkStyle realign, cyclic input keeps connecting edges |

---

## 12. Verification results

Run from the repo root
(`/home/matt/smithersbot-goals/agent/workspaces/smithersbot/repo`):

| Command | Result | Exit |
| --- | --- | --- |
| `pnpm vitest run src/telegram/ src/goal/ src/repo-chat/ src/infra/` | **1828 passed, 56 failed, 9 skipped** (169 files: 155 passed, 13 failed, 1 skipped). All 13 failing files are untouched env-limited suites (see note) — 0 failures on goal-changed surfaces | 1 |
| `pnpm exec tsc -p tsconfig.json` | clean | 0 |
| `pnpm build` | tsc + copy steps OK | 0 |
| `pnpm lint` | **0 warnings, 0 errors** | 0 |

### Focused-suite note on pre-existing environment failures

The four-directory vitest sweep returns 56 failures across 13 test files — **all
of them suites this goal did NOT touch**, failing only on the worker
environment's write/sandbox limitations (captured error classes: 30× `EROFS:
read-only file system`, 1× `ENOENT`, 2× `bwrap` sandbox-mount). The 13 failing
files are exactly:

```
src/goal/backend-sandbox.test.ts
src/goal/cli-worker.test.ts
src/goal/git-checkpoint.unit.test.ts
src/goal/goal-workflow-integration.test.ts
src/goal/sandbox-probes.test.ts
src/telegram/sticker-cache.test.ts
src/telegram/bot.create-telegram-bot.accepts-group-messages-mentionpatterns-match-without-botusername.test.ts
src/telegram/bot.create-telegram-bot.applies-topic-skill-filters-system-prompts.test.ts
src/telegram/bot.create-telegram-bot.dedupes-duplicate-callback-query-updates-by-update.test.ts
src/telegram/bot.create-telegram-bot.installs-grammy-throttler.test.ts
src/telegram/bot.create-telegram-bot.matches-usernames-case-insensitively-grouppolicy-is.test.ts
src/telegram/bot.create-telegram-bot.routes-dms-by-telegram-accountid-binding.test.ts
src/telegram/bot.create-telegram-bot.sends-replies-without-native-reply-threading.test.ts
```

These fail because the worker command filesystem sandbox makes `/tmp` / `/var/tmp`
read-only for the test temp dirs they write to (e.g. `EROFS … open
'/tmp/moltbot-test-sticker-cache/…'`) and blocks `bwrap` mounts. Per the
completed-task records they pass when re-run with the command sandbox disabled
(e.g. `cli-worker.test.ts` 64/64, `sticker-cache.test.ts` 17/17). **None of the
13 are files this goal modified.**

Cross-checked against this goal's changed test files — `error-patterns.test.ts`,
`agent-executor.test.ts`, `phase-fallback.test.ts`,
`post-execution-review.test.ts`, `manual-tests.test.ts`, `lessons.test.ts`,
`plan-autocheck.test.ts`, `scout.test.ts`, `repo-chat-worker.test.ts`,
`execution-status.test.ts`, `run-store.test.ts`, `mermaid-render.test.ts`,
`blocked.test.ts`, `goal-commands.test.ts`, `usage-status.test.ts` — **all are in
the 155 passed files; 0 of the 56 failures touch a goal-changed surface.** The
non-zero exit is therefore the documented environment baseline, not a regression
introduced by this goal.

To confirm the changed surface directly, a focused sweep over exactly those 15
goal-changed test files was run and is **fully green**:

```
pnpm vitest run \
  src/goal/error-patterns.test.ts src/goal/agent-executor.test.ts \
  src/goal/phase-fallback.test.ts src/goal/post-execution-review.test.ts \
  src/goal/manual-tests.test.ts src/goal/lessons.test.ts \
  src/goal/plan-autocheck.test.ts src/goal/scout.test.ts \
  src/goal/execution-status.test.ts src/goal/run-store.test.ts \
  src/goal/mermaid-render.test.ts src/goal/blocked.test.ts \
  src/repo-chat/repo-chat-worker.test.ts src/telegram/goal-commands.test.ts \
  src/telegram/usage-status.test.ts
→ Test Files 15 passed (15) | Tests 641 passed (641) | exit 0
```

---

## 13. `git diff --stat`

`git diff --stat` with no arguments fails in this environment with
`error: .env.local: unsupported file type / fatal: cannot hash .env.local` —
a pre-existing host artifact (`.env.local` / `.env.production` / `.env.test` are
special, agent-denied files), unrelated to this goal. The committed change set
for the goal (`HEAD~6..HEAD`) is:

```
 README.md                              |  14 ++
 scripts/claude-statusline.mjs          |  93 ++++++++
 src/goal/agent-executor.test.ts        | 114 +++++++++-
 src/goal/agent-executor.ts             |  86 ++++---
 src/goal/blocked.test.ts               |  31 +++
 src/goal/blocked.ts                    |  47 +++-
 src/goal/error-patterns.test.ts        | 167 ++++++++++++++
 src/goal/error-patterns.ts             |  67 ++++++
 src/goal/execution-status.test.ts      | 150 ++++++++++++-
 src/goal/execution-status.ts           |  53 ++++-
 src/goal/lessons.test.ts               |  79 +++++++
 src/goal/lessons.ts                    |  49 ++--
 src/goal/manual-tests.test.ts          |  81 +++++++
 src/goal/manual-tests.ts               |  86 ++++---
 src/goal/mermaid-render.test.ts        | 113 ++++++++++
 src/goal/mermaid-render.ts             |  79 ++++++-
 src/goal/phase-fallback.test.ts        | 155 +++++++++++++
 src/goal/phase-fallback.ts             | 147 ++++++++++++
 src/goal/plan-autocheck.test.ts        |  94 ++++++++
 src/goal/plan-autocheck.ts             |  85 ++++++-
 src/goal/post-execution-review.test.ts |  73 ++++++
 src/goal/post-execution-review.ts      |  68 ++++--
 src/goal/run-store.test.ts             | 193 ++++++++++++++++
 src/goal/scout.test.ts                 |  28 +++
 src/goal/usage-limit-message.ts        | 138 ++++++++++++
 src/repo-chat/repo-chat-worker.test.ts | 136 +++++++++++
 src/repo-chat/repo-chat-worker.ts      |  46 +++-
 src/telegram/bot-native-commands.ts    |  14 ++
 src/telegram/goal-blocked-ui.ts        |  76 +++++--
 src/telegram/goal-commands.test.ts     | 172 +++++++++++++-
 src/telegram/goal-commands.ts          |  10 +-
 src/telegram/goal-sending.ts           |   3 +
 src/telegram/public-menu.ts            |   5 +
 src/telegram/usage-status.test.ts      | 314 ++++++++++++++++++++++++++
 src/telegram/usage-status.ts           | 396 +++++++++++++++++++++++++++++++++
 35 files changed, 3320 insertions(+), 142 deletions(-)
```

35 files: 13 source files modified/added, 14 colocated test files, 1 statusline
script, 1 README docs section, plus this report (added in the final task).

---

## 14. Audit grep summary

`git grep -n "usage_status|codex-limit|ccusage|statusLine|rate_limits|needs
input|Attempt history|goal_stop|Mermaid|KillMode|prove-claude-sandbox" src
scripts README.md SETUP.md internal` returned 291 matches. Per-token counts and
the confirmed feature-bearing source locations:

| Token | Matches | Key source locations |
| --- | --- | --- |
| `usage_status` | 10 | `src/telegram/usage-status.ts`, `bot-native-commands.ts`, `public-menu.ts`, `scripts/claude-statusline.mjs` |
| `codex-limit` | 9 | `src/telegram/usage-status.ts` (+ test) |
| `ccusage` | 11 | `src/telegram/usage-status.ts` (+ test) |
| `statusLine` | 22 | `scripts/claude-statusline.mjs`, `src/telegram/usage-status.ts` |
| `rate_limits` | 5 | `scripts/claude-statusline.mjs`, `src/telegram/usage-status.ts` (+ test) |
| `needs input` | 19 | `src/telegram/goal-blocked-ui.ts` (+ tests) |
| `Attempt history` | 8 | `src/goal/blocked.ts`, `agent-executor.ts` (+ tests) |
| `goal_stop` | 26 | `src/commands/goal-stop.ts`, `src/telegram/goal-commands.ts` (+ tests) |
| `Mermaid` | 162 | `src/goal/mermaid-render.ts` (+ tests, docs) |
| `KillMode` | 12 | systemd/restart docs + scripts (pre-existing; untouched this goal) |
| `prove-claude-sandbox` | 7 | `scripts/prove-claude-sandbox.ts`, internal Stage 2U reports |

All new feature tokens (`usage_status`, `codex-limit`, `ccusage`, `statusLine`,
`rate_limits`) resolve to real source files, confirming the `/usage_status`
command, statusline script, and registry/menu wiring are present (not test-only).

---

## 15. Remaining known issues

- **Goal-worker command-sandbox write allowlist:** several untouched sandbox/
  worker/integration suites (`backend-sandbox`, `cli-worker`, `sandbox-probes`,
  `git-checkpoint`, `goal-workflow-integration`, some
  `bot.create-telegram-bot.*` / `sticker-cache`) fail on `ENOENT mkdir
  /var/tmp/...` or `/tmp/...` because those paths are outside the worker
  command-sandbox write allowlist. They pass with the sandbox disabled. This is
  an environment limitation, not a code regression, but it means the *full*
  four-directory sweep is not green inside the worker sandbox.
- **Codex sandbox proof under the worker sandbox:** `proven=false /
  blocker=config-generation-failed` when run under the worker command sandbox
  (same `/var/tmp` write limitation); passes when that write is permitted. No
  security failure.
- **Live quota freshness:** the Claude live quota cache only updates while Claude
  Code is running; `/usage_status` reports absent/stale explicitly rather than
  failing, but it cannot produce a fresh Claude quota number when Claude Code is
  not active. `codex-limit` / `ccusage` depend on `npx` network availability and
  degrade to a concise unavailable message offline.
- **Out of scope (unchanged, by design):** token-reduction architecture,
  scout/planner merge, and sandbox policy were not modified.
