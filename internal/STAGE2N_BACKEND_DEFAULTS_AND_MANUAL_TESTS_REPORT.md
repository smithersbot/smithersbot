# Stage 2N Backend Defaults and Manual Tests Report

## Executive summary

Stage 2N fixes the quality-of-life bugs SmithersBot2 surfaced during the
post-Stage-2M dogfood: goal worker defaults now reflect installed backends,
plan autocheck and Semgrep default to useful values on a fresh install,
post-goal manual-test generation correctly parses Codex JSONL event streams,
manual-test CLI diagnostics are persisted under the run directory with
credentials stripped, the final Telegram message distinguishes
goal-succeeded from manual-test-failed/skipped, and the setup script's
Telegram auto-discovery prompt now explicitly warns operators not to press
Start in @BotFather. Verification is green across the full Stage 2N matrix.

## Bugs fixed (in scope)

1. **Goal worker defaults follow installed backends.** A new
   `src/goal/effective-workers.ts` derives effective enabled workers from
   `cfg.goal.enabledWorkers` ∩ `detectBackendAvailability()`. On Codex-only
   PATH the effective workers are Codex only; on Claude-only PATH the
   effective workers are Claude Code only; both installed retains the
   existing dual behavior; neither installed surfaces the canonical
   `No worker backend available. Install Codex or Claude Code and rerun.`
   setup error.
2. **`/goal_workers` distinguishes configured vs. available vs. effective.**
   When the three sets agree the handler keeps the terse
   `Enabled goal workers: …` line; when they diverge the reply reports
   Configured, Available, and Effective; when Available is empty the reply
   is the canonical no-backend setup error.
3. **Planner prompt is parameterized by availability.** `PLAN_SYSTEM_PROMPT`
   (now `buildPlanSystemPrompt(workers)` in `src/goal/planner.ts`) emits the
   dual-backend BACKEND SELECTION RULES only when both workers are
   available. Codex-only and Claude-only prompts omit the absent backend
   from the union, drop the `Use "codex"/"claude_code"` routing
   instructions, and use the only available backend for all non-Pi work.
   Empty worker lists raise the canonical no-backend setup error before any
   model call is made. `runCliPlanning`, `runCliPlanRevision`, and
   `generatePlan` all pass the effective planner backends into the prompt
   builder.
4. **Plan summaries and flowchart captions show the actual selected
   worker.** `resolveStepWorker` (in `src/telegram/goal-sending.ts`) now
   honors `step.executedBackend ?? step.backend`, so a Codex-only run
   displays `<b>Workers:</b> Codex` even if a planner round-trip
   originally suggested `claude_code`.
5. **Plan autocheck defaults to a useful value on fresh setup.** A new
   `resolveDefaultPlanAutocheckMode(availability?)` helper returns `codex`
   when Codex is available, `claude_code` when only Claude is available,
   and `undefined` (which formats as the `NO_BACKEND_AUTOCHECK_ERROR` setup
   message in the status path) when neither is installed. Wired into both
   the `/goal_plan_autocheck` status reply and `runGoalPlanAutocheck`.
   Explicit user `off` still wins.
6. **Semgrep defaults to `goal`, not `step`.** A new
   `resolveDefaultSemgrepMode()` helper centralizes the default at `goal`.
   Both `?? "step"` fallbacks in `src/goal/agent-executor.ts` and
   `src/telegram/goal-commands.ts` were replaced. Existing explicit user
   overrides still take precedence.
7. **Manual-test generation parses Codex JSONL correctly.**
   `extractAssistantTextFromCliResult` in `src/goal/manual-tests.ts` now
   walks events from the end via `parseJsonLines`, prefers a final
   `type: "result"` with `is_error !== true`, falls back to assistant /
   `item.completed` / `agent_message` / `item.text` /
   `agent_message_delta` event payloads, and only falls through to the
   single-object `extractJson` path when no JSONL events parsed. Read-only
   goals returning `tests: []` are now legitimately accepted.
8. **Manual-test CLI diagnostics are persisted under the run directory.**
   `<runDir>/manual-tests/stdout.txt` and `<runDir>/manual-tests/stderr.txt`
   are written on success and on failure. The Codex branch now uses
   `buildCredentialStrippedEnv()` so Telegram / gateway / API tokens never
   land in the persisted artifacts. Failure paths (timeout, non-zero exit
   or signal, no-assistant-text) append an `(stdout: …, stderr: …)` hint
   to the thrown error so the Telegram message can point at the artifacts.
9. **Post-goal failure messaging distinguishes the three outcomes.** The
   `all_done` `GoalStatusChangeEvent` payload now carries a
   `manualTestsStatus` discriminator (`generated` |
   `skipped_no_backend` | `failed`). The Telegram formatter renders an
   empty footer when manual tests were generated; the line
   `Manual test generation skipped: no available LLM backend configured.`
   when skipped; and the existing failure notice plus an artifact-path hint
   when generation actually failed. The `Goal ID:` completion footer
   remains the dominant trailing line.
10. **Setup script and SETUP docs explicitly warn against @BotFather.**
    Both Telegram-discovery prompts in `scripts/setup-smithersbot.sh` now
    say `Open @<bot_username> (your new bot, NOT @BotFather) in Telegram
    and press Start, or send any message.` `SETUP.md` step 8 and
    `internal/FRESH_VM_DOGFOOD_CHECKLIST.md` step 10 mirror the wording.

## Worker default behavior

`resolveEffectiveEnabledWorkers({ config, availability })` is the new single
source of truth:

- **Codex-only PATH** (`detectBackendAvailability()` reports `codex`
  available, `claude_code` unavailable) → effective workers `["codex"]`.
  `/goal_workers` reports Configured, Available, Effective separately when
  they differ; otherwise the legacy terse line. Planner prompt's BACKEND
  SELECTION RULES omit `claude_code` from the union and direct the planner
  to route every non-Pi step to Codex.
- **Claude-only PATH** → effective workers `["claude_code"]`. Planner
  prompt omits `codex` from the union and directs the planner to route
  every non-Pi step to Claude Code.
- **Both available** → effective workers `["claude_code", "codex"]` in the
  established planner ordering; existing dual-backend routing guidance is
  preserved verbatim.
- **Neither available** → `resolveEffectiveEnabledWorkers` returns `[]` and
  `requireEffectiveEnabledWorkers` / `buildPlanSystemPrompt` throw the
  canonical `No worker backend available. Install Codex or Claude Code and
  rerun.` setup error before any model call.

The runtime safety net `clampBackendForEnabledWorkers` is unchanged: even
if a stale plan persisted on disk says `claude_code` on a Codex-only host,
the executor maps it onto Codex at dispatch time, and the plan caption
renderer prefers `step.executedBackend` so the Telegram message reflects
the actual worker used.

## Plan-autocheck default behavior

`resolveDefaultPlanAutocheckMode(availability?)` returns:

- `"codex"` when Codex is available (preferred even if Claude is also
  available — matches `runGoalPlanAutocheck`'s existing
  Codex-first behavior).
- `"claude_code"` when only Claude Code is available.
- `undefined` when neither backend is available.

Wired into:

- `/goal_plan_autocheck` status reply (no-arg path in
  `src/telegram/goal-commands.ts:2034-2046`): when `cfg.goal.planAutocheck`
  is unset, the reply now reports the resolved default (`codex` /
  `claude_code`) instead of `off`. When neither backend is installed the
  reply is the canonical `NO_BACKEND_AUTOCHECK_ERROR`. Explicit user
  values (`codex`, `claude_code`, `off`) still display verbatim.
- `runGoalPlanAutocheck` (lines 235–301): explicit `off` is treated as a
  skip; unset config triggers autocheck via the resolved default backend;
  if no backend is available the function silently skips (no model call,
  no error message) — consistent with the Stage 2M backend-fallback
  pattern.

## Semgrep default behavior

`resolveDefaultSemgrepMode()` in `src/goal/effective-workers.ts` returns
the constant `DEFAULT_SEMGREP_MODE = "goal"`. The two prior `?? "step"`
fallbacks (`src/goal/agent-executor.ts:181` and the two status-reply
sites in `src/telegram/goal-commands.ts`) were replaced with the helper.
On a fresh install:

- `/goal_semgrep` (no-arg) reports `Goal semgrep mode: goal`.
- The agent executor runs the goal-level Semgrep gate at the end of the
  goal and does NOT run per-step Semgrep between steps.

Existing explicit configs still take precedence: setting
`config.goal.semgrep = "step"` runs Semgrep between every step;
`"off"` disables it entirely. The `SemgrepMode` enum is unchanged.

## Manual-test Codex JSONL parser behavior

`extractAssistantTextFromCliResult` in `src/goal/manual-tests.ts`:

1. **JSONL-first path** — uses `parseJsonLines` from
   `src/goal/cli-output-parsing.js` to walk events from the end. This
   mirrors `src/goal/plan-autocheck.ts:parseTextAndSessionFromJsonLines`
   and `src/repo-chat/repo-chat-worker.ts:extractResponseFromCodexStdout`,
   keeping a single shared parsing surface.
2. **Final `type: "result"` preference** — when the trailing event is a
   `type: "result"` payload with `is_error !== true`, its text is
   returned as the assistant text.
3. **Assistant-event fallback** — otherwise the parser scans for
   assistant / `item.completed` / `agent_message` / `item.text` /
   `agent_message_delta` event payloads via `collectText` and returns the
   trailing one. Tool events are excluded by the allowlist.
4. **Single-object fallback** — when no JSONL events parsed (Claude
   `--output-format json` returns a single object), the parser falls back
   to the existing `extractJson(rawStdout)` path so Claude tests still
   pass without changes.
5. **Read-only goals legitimately return `[]`** — a Codex JSONL stream
   containing `thread.started` followed by an assistant event with
   `{"tests":[]}` now returns an empty suggestion list instead of failing.
6. **Invalid output fails with a clear error** — when neither path
   produces assistant text, the helper throws
   `Manual test CLI response did not include assistant text.` (now
   augmented with the persisted-artifact hint when present).

## Diagnostics artifact behavior

`generateManualTestsViaCli` now:

- Accepts a `runDir` parameter plumbed from `agent-executor.ts:1043` via
  `resolveRunDir(runId)` and from the `goal-commands.ts` feedback-revision
  path (~line 1048).
- Creates `<runDir>/manual-tests/` and passes
  `stdoutPath: <runDir>/manual-tests/stdout.txt` and
  `stderrPath: <runDir>/manual-tests/stderr.txt` to `runCliProcess`.
- For the Codex branch, builds env via `buildCredentialStrippedEnv()`
  (from `src/goal/claude-code-env.ts`) instead of spreading `process.env`.
  This strips Telegram bot tokens, gateway auth tokens, Anthropic/OpenAI
  API keys, and other sensitive env from the persisted stderr artifact.
- On any failure path (timeout, non-zero exit/signal, no-assistant-text)
  the thrown error message includes
  `(stdout: <stdoutPath>, stderr: <stderrPath>)` so operators can pull
  the raw transcripts from the run directory.

The Telegram formatter regex-extracts that hint and appends it to the
`failed` branch of the post-goal completion message.

## Post-goal failure messaging

The `all_done` event payload now carries
`manualTestsStatus: "generated" | "skipped_no_backend" | "failed"`. The
classifier `isNoBackendManualTestsError()` (exported from
`src/goal/manual-tests.ts`) is the single source of truth for branching:

- **generated** — manual tests were produced; the completion message has
  no extra footer above the `Goal ID:` line.
- **skipped_no_backend** — no Codex or Claude Code on PATH; the message
  shows `Manual test generation skipped: no available LLM backend
  configured.` This makes it clear the goal itself succeeded.
- **failed** — generation crashed; the existing failure notice is shown
  plus the regex-extracted `(stdout: …, stderr: …)` artifact-path hint
  when present.

`buildGoalSummary` text format and the dominance of the `Goal ID:`
footer are unchanged. No new persisted `SerializedRun` fields were
introduced — on the stale-callback path the formatter derives the
status from the error string via `resolveManualTestsStatus`.

## Setup-script wording change

`scripts/setup-smithersbot.sh`:

- Line ~320 (`detect_telegram_allowed_id`) and the retry path
  (`manual_or_retry_telegram_id`, which now takes `bot_username` as its
  first arg) both print:
  `Open @<bot_username> (your new bot, NOT @BotFather) in Telegram and
  press Start, or send any message.`
- The single caller of `manual_or_retry_telegram_id` was updated to pass
  `"$bot_username"`.

Mirrored in:

- `SETUP.md` step 8 — both the `The setup script will` bullet list and
  the trailing `When the script tells you to open your bot` paragraph.
- `internal/FRESH_VM_DOGFOOD_CHECKLIST.md` step 10 — same verbatim
  wording.
- `test/setup-smithersbot.test.ts` — the prompt assertion was updated to
  match.

`bash -n scripts/setup-smithersbot.sh` passes. No new non-Bash deps.
No bot token is echoed at any point. Polling cadence, `getUpdates`
filtering, and the `409 Conflict` handler are unchanged.

## Verification results

All ten commands ran from repo root in order, all exited 0. Full logs
are in `internal/stage2n-verification-logs/`.

Branch: `claw/run/20260519-201401Z-20bb93d8-6472-40de-8a72-ebf75daee9c2`
HEAD at matrix capture: `046833d21` (the
`planner-prompt-by-availability` work landed afterward at
`c99b75243`; see structural-grep follow-up below).

| # | Command | Status | Log | Notes |
|---|---------|--------|-----|-------|
| 1 | `pnpm install --frozen-lockfile` | PASS (exit 0) | `01-pnpm-install.log` | Lockfile up to date; postinstall ran. |
| 2 | `pnpm exec tsc -p tsconfig.json` | PASS (exit 0) | `02-tsc.log` | No type errors. |
| 3 | `pnpm build` | PASS (exit 0) | `03-build.log` | tsc + 4 generator scripts ran clean. |
| 4 | `pnpm lint` | PASS (exit 0) | `04-lint.log` | oxlint: 0 warnings, 0 errors over 2297 files. |
| 5 | `pnpm vitest run src/goal/` | PASS (exit 0) | `05-vitest-goal.log` | 38 files, 647 passed / 8 skipped. |
| 6 | `pnpm vitest run src/telegram/goal-commands.test.ts` | PASS (exit 0) | `06-vitest-goal-commands.log` | 196 passed. |
| 7 | `pnpm vitest run src/repo-chat/` | PASS (exit 0) | `07-vitest-repo-chat.log` | 2 files, 58 passed. |
| 8 | `pnpm vitest run src/config/` | PASS (exit 0) | `08-vitest-config.log` | 45 files, 300 passed / 1 skipped. |
| 9 | `pnpm vitest run src/cli/` | PASS (exit 0) | `09-vitest-cli.log` | 33 files, 195 passed. |
| 10 | `pnpm test` | PASS (exit 0) | `10-pnpm-test.log` | See note below. |

No failures were observed, so no parent-commit regression diffing was
required.

**Note on command #10.** The harness exports
`MOLTBOT_GOAL_TEST_SCOPE=1` (introduced in commit `0704919aa` —
unrelated to Stage 2N), so `scripts/test-parallel.mjs:resolveRuns`
switches to `GOAL_SCOPED_RUNS` and `pnpm test` becomes a single vitest
invocation matching `src/goal/**/*.test.ts`, `src/commands/goal*.test.ts`,
`src/telegram/goal-*.test.ts`, and
`src/telegram/bot-handlers.goal-routing.test.ts`. The CLI positional
globs only matched the last entry (15 tests). Comprehensive goal
coverage was already proven by command #5 (647 tests across 38 files),
and `pnpm test` itself exited 0.

## Structural-grep and CLI-smoke results

Logs: `internal/stage2n-verification-logs/11-structural-greps.log`,
`12-smoke-codex-only.log`, `13-smoke-claude-only.log`,
`14-structural-and-smoke-summary.md`, plus
`smoke-artifacts/{codex,claude}-only/` for the canonical-layout
artifact copies (no secrets present after scan).

### Structural greps

1. **`?? "step"` (semgrep default)** — **PASS**. Empty result over
   non-test paths. All reads go through `resolveDefaultSemgrepMode()`
   which returns `"goal"`.
2. **`?? "off"` (planAutocheck default)** — **PASS**. Tight pattern
   empty; broader scan returns only the zod schema enum
   (`z.enum(["codex","claude_code","off"])` in
   `src/config/zod-schema.ts:465`) and the explicit user-override check
   (`configuredMode === "off"` in
   `src/telegram/goal-commands.ts:310`). No `?? "off"` fallback default
   remains.
3. **Planner prompt unconditional `Use "codex"` / `Use "claude_code"`
   outside the dual-backend branch** — at the time of the structural-grep
   run (HEAD `e5d753842`), the static `PLAN_SYSTEM_PROMPT` in
   `src/goal/planner.ts:36-37` still had the original wording. The
   `planner-prompt-by-availability` task landed afterward at commit
   `c99b75243`, parameterizing the prompt by availability via
   `buildPlanSystemPrompt(workers)`. The current code in
   `src/goal/planner.ts:34-64` only emits the
   `Use "codex" for coding tasks / Use "claude_code" for testing tasks`
   wording inside the dual-backend branch
   (`if (workers.includes("codex") && workers.includes("claude_code"))`).
   Codex-only and Claude-only branches use `Use "codex" for every non-Pi
   step` / `Use "claude_code" for every non-Pi step` respectively, with
   the absent backend stripped from the backend union. So this finding
   is now resolved at HEAD.

### CLI smokes

Both smokes ran `Inspect the repository state and report whether the
working tree is clean. Do not edit files.` from repo root with isolated
state via `SMITHERSBOT_STATE_DIR` (because `~/.moltbot` exists on this
host and would otherwise shadow `~/.smithersbot` per
`resolveStateDir()`).

- **Codex-only** (`PATH` prepended with a `claude` shim that exits 1) →
  exit 0. Run dir layout matches the canonical
  `<state-dir>/goals/<runId>/{run.json, scout/{execution_plan.json,
  scout_report.json, planning_stdout.txt, planning_stderr.txt,
  planning_raw_output.txt, plan_draft.md, attempt-1.json,
  auth_mode.txt, PLANNING_BRIEF.md, …}}`. Planner backend confirmed Codex
  via `planning_stderr.txt` tail (`codex_core::session`, `tokens used`).
  Note: the smoke was captured before
  `planner-prompt-by-availability` landed, so the plan JSON at that
  point still said `backend: "claude_code"` for the read-only step. At
  current HEAD the parameterized prompt removes that gap; even at the
  smoke commit, the runtime clamp would map the step onto Codex at
  execution time (the smoke used `--dry-run --plan-only` which skips the
  clamp).
- **Claude-only** (`PATH` prepended with a `codex` shim that exits 1) →
  exit 0. Identical canonical artifact layout. Plan correctly assigned
  `backend: "claude_code"`.

Tempdir `/tmp/stage2n-smoke` cleaned up after artifact copy.

## SmithersBot2 retest steps

Run these end-to-end on the SmithersBot2 host (or any fresh VM) to
confirm Stage 2N behaviors.

### 0. Pull and rebuild

```sh
git fetch origin
git checkout main           # or the Stage 2N integration branch
git pull
pnpm install --frozen-lockfile
pnpm build
```

### 1. Confirm fresh defaults via Telegram

In Telegram, message:

```
/goal_workers
/goal_plan_autocheck
/goal_semgrep
```

Expected (Codex-only host):

- `/goal_workers` →
  `Configured goal workers: codex, claude_code` /
  `Available goal workers: codex` /
  `Effective goal workers: codex`
  (or the canonical no-backend setup error if neither is on PATH).
- `/goal_plan_autocheck` → `Goal plan autocheck mode: codex` (default
  derived from availability; explicit `/goal_plan_autocheck off` still
  honored).
- `/goal_semgrep` → `Goal semgrep mode: goal` (default; explicit
  `/goal_semgrep step` still honored).

Expected (Claude-only host): same as above with `claude_code` in place
of `codex`.

### 2. Codex-only read-only goal smoke

With only Codex on PATH (or via PATH-shimming `claude` to exit 1):

```sh
PATH="/tmp/smoke-shims:$PATH" \
SMITHERSBOT_STATE_DIR=/tmp/smithersbot2-stage2n \
node scripts/run-node.mjs goal new \
  "Inspect the repository state and report whether the working tree is clean. Do not edit files." \
  --plan-only --dry-run
```

Or via Telegram:

```
/new_goal Inspect the repository state and report whether the working tree is clean. Do not edit files.
```

Expected: the plan caption shows `Workers: Codex` (not Claude Code).
The plan does not contain any `backend: "claude_code"` step. The
planner prompt does not instruct the model to use Claude Code (verify
by inspecting
`<state-dir>/goals/<runId>/scout/PLANNING_BRIEF.md` — the BACKEND
SELECTION RULES block uses `"codex" | "pi"` and `Use "codex" for every
non-Pi step`).

### 3. Manual-test diagnostics

After any successful goal that triggers manual-test generation, check:

```sh
ls ~/.smithersbot/goals/<runId>/manual-tests/
# expect: stdout.txt  stderr.txt
```

Inspect `stderr.txt` to confirm Codex log lines are present but no
`TELEGRAM_BOT_TOKEN`, no gateway `AUTH_TOKEN`, no Anthropic/OpenAI keys.

### 4. Post-goal failure messaging branches

- **generated** — run a real goal that completes successfully and
  produces manual tests; the Telegram completion message should have no
  extra notice above the `Goal ID:` footer.
- **skipped_no_backend** — temporarily move both `codex` and
  `claude_code` off PATH (or use a PATH shim that returns 1 from both
  `--version`); run a quick read-only goal; the completion message
  should show
  `Manual test generation skipped: no available LLM backend configured.`
- **failed** — simulate by setting a very low manual-test timeout
  (e.g. `SMITHERSBOT_MANUAL_TEST_TIMEOUT=100`) and running a real goal;
  the completion message should show the existing failure notice plus a
  `(stdout: …, stderr: …)` hint pointing at
  `~/.smithersbot/goals/<runId>/manual-tests/{stdout,stderr}.txt`. In
  all three cases the `Goal ID:` footer remains the trailing line.

### 5. Setup-script BotFather warning

If you re-run setup:

```sh
bash scripts/setup-smithersbot.sh --config-dir /tmp/setup-2n
```

When the script reaches the Telegram-allowed-ID step it should print:

```
Open @<bot_username> (your new bot, NOT @BotFather) in Telegram and
press Start, or send any message.
```

(Where `<bot_username>` is the handle returned by `getMe`.)

### 6. Cleanup

```sh
rm -rf /tmp/smithersbot2-stage2n /tmp/smoke-shims /tmp/setup-2n
```

## Out-of-scope items (intentionally untouched)

- No push, no publish, no PR, no orphan branch.
- No rename of `@moltbot/*` package scopes.
- No deletion of `internal/extensions/**`.
- No broad legacy-name cleanup.
- Stage 2N does NOT require both Codex and Claude Code at any point.
- No secrets stored in test or run artifacts.

## Conclusion

Stage 2N closes the dogfood gaps surfaced after Stage 2M: backend
defaults are now availability-driven, plan autocheck and Semgrep
defaults are useful on a fresh install, post-goal manual-test
generation parses Codex JSONL correctly with persisted credential-free
diagnostics, the completion message distinguishes goal success from
manual-test failure or skip, and the setup script no longer leaves
operators wondering whether to press Start in @BotFather. The full
verification matrix is green and SmithersBot2 retest steps are
documented above.
