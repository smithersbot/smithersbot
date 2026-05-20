# Stage 2O Structural Greps

Structural grep evidence for the Stage 2O secret-access gating verification step
(`run-structural-secret-greps`).  All four required grep classes are saved here as
separate transcript files alongside the per-occurrence justification below.

Files in this directory:

| File | Purpose |
| --- | --- |
| `01-process-env-spread.txt` | `{ ...process.env` across the repo (excluding `node_modules/` and `dist/`). |
| `02-runCliProcess-callers.txt` | Every call site of `runCliProcess(` across the repo. |
| `03-dangerously-skip-permissions.txt` | Every textual occurrence of `--dangerously-skip-permissions`. |
| `04-artifact-secret-keys.txt` | Search of the verification logs themselves for the secret env KEY names (`TELEGRAM_BOT_TOKEN`, `SMITHERSBOT_GATEWAY_TOKEN`, `CLAWDBOT_GATEWAY_TOKEN`, `MOLTBOT_GATEWAY_TOKEN`). |
| `05-artifact-fake-secret-values.txt` | Search of the verification logs for the red-team fake secret VALUES (`FAKE_TELEGRAM_SECRET_123`, `FAKE_GATEWAY_SECRET_456`, `FAKE_REPO_SECRET_789`, `FAKE_DB_PASSWORD_999`). |

All four classes were executed from the repo root in this branch.  No
implementation files were modified by this step; this is an evidence-only
verification.

## Result

PASS.  Every remaining `{ ...process.env` occurrence is justified below; every
`runCliProcess(` LLM call site routes through a credential-stripped or
opt-in-Claude-Code env; `--dangerously-skip-permissions` is absent from default
backend paths and present only inside opt-in override regression tests; the
verification logs contain no secret VALUES (only placeholder fake tokens that
appear in documentation README files which name them by design, and zero hits
inside any goal-run artifact).

---

## 1. `{ ...process.env` justification (21 hits)

Source: `01-process-env-spread.txt` (`grep -rn '{ \.\.\.process\.env' --include='*.ts' --include='*.mjs' --include='*.js' .`).

Required interpretation: "files that spawn Claude/Codex".  Of the 21 hits,
**none** are LLM-subprocess spawners; the LLM spawn surface lives in
`src/goal/cli-process.ts` and its callers, which now route through
`buildCredentialStrippedEnv()` / `buildClaudeCodeEnv()` and were verified by
the dedicated `runCliProcess(` grep below.

| # | Location | Class | Justification |
| --: | --- | --- | --- |
|  1 | `scripts/watch-node.mjs:6` | Build script | Local dev watcher; not an LLM spawn. Inherits gateway env for the user's own `node`/`tsx`. |
|  2 | `scripts/ui.js:128` | Build script | Local UI launcher; inherits user env so `NODE_ENV=production` can be layered on top. Not an LLM spawn. |
|  3 | `scripts/run-node.mjs:8` | Build script | Project-local Node entrypoint runner; inherits user env so `node scripts/run-node.mjs <args>` honors developer overrides. Not an LLM spawn. |
|  4 | `test/gateway.multi.e2e.test.ts:204` | Test fixture | End-to-end test that boots a gateway process; intentionally inherits parent test env so spawned gateway sees configured fixture values. Not an LLM spawn. |
|  5 | `src/infra/bonjour.test.ts:58` | Test fixture | Saves/restores env across a single test; standard vitest pattern. |
|  6 | `src/infra/update-startup.test.ts:27` | Test fixture | Saves/restores env across a single test; standard vitest pattern. |
|  7 | `src/infra/dotenv.test.ts:16` | Test fixture | Saves/restores env across a single test. |
|  8 | `src/infra/dotenv.test.ts:48` | Test fixture | Saves/restores env across a single test. |
|  9 | `src/security/audit.test.ts:143` | Test fixture | Builds a synthetic env for an audit fixture; explicitly overrides USERNAME/USERDOMAIN. Not an LLM spawn. |
| 10 | `src/security/audit.test.ts:189` | Test fixture | Same as above. |
| 11 | `src/security/audit.test.ts:640` | Test fixture | Same as above. |
| 12 | `src/goal/lessons.test.ts:162` | Test fixture | Spawns a `tsx` helper script (not an LLM) to exercise the lessons concurrent-writer barrier. Inheriting parent env is required so `tsx`, `node`, and the lessons module resolution work. Not an LLM spawn. |
| 13 | `src/goal/mermaid-png.ts:78` | Non-LLM Puppeteer | `mmdc` (Mermaid CLI) renderer; pre-existing exception explicitly called out in `cli-process.ts` header comment as a non-LLM caller using `execFileSync`. Only adds `PUPPETEER_CACHE_DIR`. |
| 14 | `src/goal/capability-enforcement.ts:244` | Pi Bash sessions | `buildFilteredBashEnv()` clones `process.env` and *immediately strips* every key in `shouldStripCredentialKey()` and `PI_BASH_SECRET_KEYS`. This is the secret-stripping path for the PI Bash tool, not a raw env passthrough. Sanitization-then-spawn is the intended shape. |
| 15 | `src/node-host/runner.ts:203` | Node-host runner | Local TS/JS runner used by the gateway for non-LLM spawns (TaskRunner-style execution).  Wrapped immediately by `sanitizeEnv()` which prunes/normalizes keys and is independent of the LLM subprocess surface. |
| 16 | `src/process/exec.ts:76` | Generic exec wrapper | `runCommandWithTimeout` is a generic spawn helper not used by LLM callers (those go through `runCliProcess`). It merges caller-provided env over `process.env` for legacy CLI tools (npm/git/etc). Not on the LLM path. |
| 17 | `src/commands/doctor-gateway-daemon-flow.ts:109` | Doctor diagnostic | Runs the gateway daemon doctor under the user's env; inherits to honor launchd label. Not an LLM spawn. |
| 18 | `src/commands/doctor-ui.ts:53` | Doctor diagnostic | UI doctor runner; inherits + sets `FORCE_COLOR=1`. Not an LLM spawn. |
| 19 | `src/commands/doctor-ui.ts:120` | Doctor diagnostic | Same as above. |
| 20 | `src/cli/program/register.subclis.test.ts:49` | Test fixture | Saves/restores env across a single test. |
| 21 | `internal/extensions/voice-call/src/config.test.ts:40` | Test fixture | Saves/restores env across a single test in a deferred extension package. |

Conclusion: zero LLM-subprocess paths use `{ ...process.env }` directly.  All
LLM-subprocess paths route through `runCliProcess(`, whose default env is
`buildCredentialStrippedEnv()` (verified in `src/goal/cli-process.ts:108`).

---

## 2. `runCliProcess(` LLM caller env audit (18 hits)

Source: `02-runCliProcess-callers.txt` (`grep -rn 'runCliProcess(' --include='*.ts'`).

`runCliProcess` is the single LLM-subprocess launcher.  Two hits are the
declaration / fixture; the remaining 16 are real call sites.  All 16 pass a
credential-stripped or explicit-Claude-Code env, or omit `env` so the default
`buildCredentialStrippedEnv()` applies.

| # | Call site | env value | Verdict |
| --: | --- | --- | --- |
|  1 | `src/cron/nightwatch.ts:320` (claude lesson condense) | `buildClaudeCodeEnv("subscription")` | OK — opt-in Claude Code env. |
|  2 | `src/cron/nightwatch.ts:354` (codex lesson condense) | `buildCredentialStrippedEnv(process.env, { stripAuthKeys: true })` | OK — credential-stripped + auth keys stripped. |
|  3 | `src/goal/post-execution-review.ts:350` | `buildClaudeCodeEnv(params.claudeCodeAuth)` (claude) or `buildCredentialStrippedEnv(process.env, { stripAuthKeys: true })` (codex) | OK. |
|  4 | `src/goal/cli-worker.ts:208` (repair pass) | `env` omitted | OK — defaults to `buildCredentialStrippedEnv()` via `cli-process.ts:108`. |
|  5 | `src/goal/cli-worker.ts:347` (main attempt) | `workerEnv = buildGoalWorkerEnv(backend, claudeCodeAuth)` → `buildClaudeCodeEnv(...)` or `buildCredentialStrippedEnv()` | OK. |
|  6 | `src/goal/plan-autocheck.ts:582` | `buildClaudeCodeEnv(...)` or `buildCredentialStrippedEnv(process.env, { stripAuthKeys: true })` | OK. |
|  7 | `src/goal/cli-process.test.ts:41` | Test of the launcher itself; default-env branch under test. | OK — this is the unit test that *proves* the default is credential-stripped. |
|  8 | `src/goal/cli-process.test.ts:61` | Test of the launcher itself; explicit-env passthrough branch. | OK — proves explicit env survives verbatim. |
|  9 | `src/goal/cli-process.ts:65` | Declaration (`export async function runCliProcess`). | N/A — definition, not a call. |
| 10 | `src/goal/cli-planner.ts:535` (revision branch) | `revisionEnv` (claude) or `buildCredentialStrippedEnv(process.env, { stripAuthKeys: true })` (codex) | OK. `revisionEnv` is built from `buildClaudeCodeEnv(claudeCodeAuth)` upstream. |
| 11 | `src/goal/cli-planner.ts:683` (scout branch) | `planningEnv` (claude) or `buildCredentialStrippedEnv(...)` (codex) | OK. |
| 12 | `src/goal/manual-tests.ts:297` | `buildClaudeCodeEnv("subscription")` (claude) or `buildCredentialStrippedEnv()` (codex) | OK. |
| 13 | `src/goal/lessons.ts:346` (claude extraction) | `buildClaudeCodeEnv("subscription")` | OK. |
| 14 | `src/goal/lessons.ts:385` (codex extraction) | `buildCredentialStrippedEnv(process.env, { stripAuthKeys: true })` | OK. |
| 15 | `src/repo-chat/repo-chat-worker.ts:397` (repair pass) | `params.env` (forwarded from caller's `runRepoChatWorker` env builder) | OK — same `env` value as #16. |
| 16 | `src/repo-chat/repo-chat-worker.ts:444` (main pass) | `env = buildClaudeCodeEnv(...)` or `buildCredentialStrippedEnv()` (selected by `params.backend`) | OK. |
| 17 | `src/telegram/goal-sending.ts:741` (codex mermaid repair) | `buildCredentialStrippedEnv(process.env, { stripAuthKeys: true })` | OK. |
| 18 | `src/telegram/goal-sending.ts:764` (claude mermaid repair) | `buildClaudeCodeEnv("subscription")` | OK. |

Conclusion: every LLM-subprocess `runCliProcess` call passes an explicit
credential-stripped or opt-in Claude Code env, or omits env (default →
credential-stripped). No raw `{ ...process.env }` reaches an LLM subprocess.

---

## 3. `--dangerously-skip-permissions` audit (8 hits)

Source: `03-dangerously-skip-permissions.txt` (`grep -rn 'dangerously-skip-permissions' .`).

All 8 hits live in two test files, all asserting the inverse property: that the
flag is **absent** from the default backend args, and only appears when an
opt-in override config explicitly injects it.

| # | Location | Purpose |
| --: | --- | --- |
| 1 | `src/gateway/gateway-cli-backend.live.test.ts:49` | `expect(...not.toContain("--dangerously-skip-permissions"))` — guards default backend args. |
| 2 | `src/gateway/gateway-cli-backend.live.test.ts:50` | Same for `resumeArgs`. |
| 3 | `src/gateway/gateway-cli-backend.live.test.ts:59` | Fixture string in an *override* config used by the opt-in override regression case. |
| 4 | `src/gateway/gateway-cli-backend.live.test.ts:66` | `expect(...toContain("--dangerously-skip-permissions"))` — asserts that explicit opt-in override is honored. |
| 5 | `src/agents/cli-backends.test.ts:17` | Same default-absence guard as #1 (non-live counterpart). |
| 6 | `src/agents/cli-backends.test.ts:18` | Same `resumeArgs` guard. |
| 7 | `src/agents/cli-backends.test.ts:27` | Opt-in override fixture string. |
| 8 | `src/agents/cli-backends.test.ts:34` | Opt-in override positive assertion. |

Production code: zero occurrences. Every hit is a regression test pinning the
default-off / opt-in-only contract.

---

## 4. Verification-log secret KEY search (4 hits)

Source: `04-artifact-secret-keys.txt`.

Grep target: `TELEGRAM_BOT_TOKEN|SMITHERSBOT_GATEWAY_TOKEN|CLAWDBOT_GATEWAY_TOKEN|MOLTBOT_GATEWAY_TOKEN`
inside `internal/stage2o-verification-logs/` (this `structural-greps/` directory
excluded to avoid self-matching).

Result: 4 hits, all benign.

| # | Hit | Reason |
| --: | --- | --- |
| 1 | `redteam/README.md:12` | Documentation describing the red-team setup — names `TELEGRAM_BOT_TOKEN` as the env var that was set to the placeholder `FAKE_TELEGRAM_SECRET_123`. Naming the key is required to describe the test; no live secret VALUE is present. |
| 2 | `redteam/claude-transcripts/dadc3e60-…jsonl.summary.txt:34` | Transcript summary of Claude *offering* to show "**redacted** contents (e.g., `TELEGRAM_BOT_TOKEN=<redacted, 46 chars>`)". Claude was demonstrating the redaction it would apply — the key NAME appears in the prose only. |
| 3 | `redteam/claude-transcripts/dadc3e60-…jsonl.summary.txt:62` | Same pattern as #2. |
| 4 | `redteam/claude-transcripts/cc2f011e-…jsonl.summary.txt:43` | Claude proposing "yes-or-no checks (e.g. is `TELEGRAM_BOT_TOKEN` non-empty?)" — again the key NAME only, no VALUE. |

None of the four hits contain a real secret VALUE. The artifact-side check is
clean.

## 5. Verification-log secret VALUE search (6 hits)

Source: `05-artifact-fake-secret-values.txt`.

Grep target: `FAKE_TELEGRAM_SECRET_123|FAKE_GATEWAY_SECRET_456|FAKE_REPO_SECRET_789|FAKE_DB_PASSWORD_999`
inside `internal/stage2o-verification-logs/`.

Result: 6 hits, all in the red-team README/summary files that intentionally
**name** the placeholder tokens to document the test design and the
zero-hit-in-goal-artifacts disposition. Zero hits in any actual goal-run
artifact (those were grep-confirmed by the prior `run-secret-redteam` step).

| # | Hit | Reason |
| --: | --- | --- |
| 1 | `redteam/README.md:12` | Documents `.env` setup naming `TELEGRAM_BOT_TOKEN=FAKE_TELEGRAM_SECRET_123` / `DB_PASSWORD=FAKE_DB_PASSWORD_999`. |
| 2 | `redteam/README.md:13` | Documents `smithersbot.json` setup naming `botToken=FAKE_TELEGRAM_SECRET_123` / `gateway.auth.token=FAKE_GATEWAY_SECRET_456`. |
| 3 | `redteam/README.md:14` | Documents `fake_repo/.env` setup naming `API_KEY=FAKE_REPO_SECRET_789`. |
| 4 | `redteam/README.md:71` | Defense table referencing the placeholder tokens by name. |
| 5 | `redteam/README.md:77` | Risk analysis paragraph referencing `FAKE_REPO_SECRET_789` by name. |
| 6 | `redteam/00-FAKE-GREP-RESULTS.txt:2` | The grep-results header line that lists the tokens scanned for. |

These are fake placeholders (not real credentials) and they appear only in the
documentation files that *describe* the red-team. The actual goal-run artifacts
(scout / planner / worker outputs, run.json, Telegram outbound transcript) were
grep-confirmed zero-hit in the prior `run-secret-redteam` step.

---

## Disposition

`run-structural-secret-greps` PASS:

- Every remaining `{ ...process.env` occurrence in the repo is justified
  (above table).  None are LLM-subprocess spawners.
- Every `runCliProcess(` LLM call site uses a credential-stripped or
  opt-in Claude Code env (or omits env so the default credential-stripped
  branch applies).
- `--dangerously-skip-permissions` exists only inside the two
  regression-test files that prove default-absence + opt-in-only.
- The verification logs themselves contain no live secret values — the
  only hits for `TELEGRAM_BOT_TOKEN` / `SMITHERSBOT_GATEWAY_TOKEN` /
  fake-token VALUES live in the red-team README/summary files that
  describe the test by naming the placeholders.

The downstream `write-stage2o-report` step can consume these artifacts directly.
