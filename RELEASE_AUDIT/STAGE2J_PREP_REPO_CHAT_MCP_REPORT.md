# Stage 2J-prep — Repo Chat Claude Code MCP Isolation Report

Reliability fix landed before Stage 2J public-surface cleanup. Repo chat is core to the SmithersBot workflow, so Claude Code repo-chat invocations must not inherit the user's global MCP/plugin set by default.

## 1. Root cause summary

A `/repo_chat` request against the `claude_code` backend failed with `Repo chat worker failed (claude exit 1)`. The surfaced detail was only the JSON `system/init` envelope, which already listed the inherited tool/plugin/skill set (Gmail, Google Calendar, Google Drive, financial-analysis providers, etc.). No assistant or result event followed and stderr was empty.

Root cause: the production `buildClaudeRepoChatArgs` path did **not** pass `--strict-mcp-config --mcp-config <empty>`, so Claude Code launched with the user's global plugin/MCP set. One of the inherited MCP servers (or plugin manifest) errored during startup, causing Claude Code to exit `1` before producing an assistant message. The repo-chat error formatter further obscured this: it truncated stderr/stdout aggressively, preferred the head of stdout, and did not include exit/signal/duration.

An equivalent isolation helper already existed under `src/gateway/gateway-cli-backend.live.test.ts` (`withMcpConfigOverrides`), but only for tests.

## 2. Files changed

| Path | Change |
| --- | --- |
| `src/goal/claude-code-mcp-isolation.ts` | **New.** Exports `EMPTY_MCP_CONFIG_PATH`, `ensureEmptyMcpConfig()`, `appendStrictMcpArgs()`. |
| `src/goal/claude-code-mcp-isolation.test.ts` | **New.** 10 tests covering file creation, exact content equality, drift repair, invalid-JSON repair, flag dedup, no-op when both flags already present, non-mutation. |
| `src/repo-chat/repo-chat-worker.ts` | Wired `ensureEmptyMcpConfig()` + `appendStrictMcpArgs()` into `buildClaudeRepoChatArgs`. Bumped `MAX_ERROR_DETAIL_CHARS` from 1000 → 8000. Added `tailErrorDetail`, `parseClaudeStdoutEvents`, `isInitOnlyClaudeStdout`, `CLAUDE_STARTUP_HINT`. Rewrote the exit-code branch to prefer stderr; fall back to tail of stdout; always append `exit=… signal=… durationMs=…`; emit the MCP startup hint when Claude exits non-zero with empty stderr and init-only stdout. |
| `src/repo-chat/repo-chat-worker.test.ts` | Added/updated tests (listed in §4). |
| `RELEASE_AUDIT/STAGE2J_PREP_REPO_CHAT_MCP_REPORT.md` | This report. |

No goal-worker Claude Code call sites were modified (audit only — see §7).

## 3. Exact Claude Code args — before / after

### `buildClaudeRepoChatArgs` — BEFORE

```
[
  "-p",
  "--output-format", "json",
  "--verbose",
  "--allowedTools", "<CLAUDE_ALLOWED_TOOLS_READ_ONLY>",
  "--append-system-prompt", "<read-only prompt + REPO_CHAT_CONTEXT>",
  // optional: "--model", "<model>"
  // optional: "--resume", "<sessionId>"
  "<prompt>"
]
```

### `buildClaudeRepoChatArgs` — AFTER

```
[
  "-p",
  "--output-format", "json",
  "--verbose",
  "--allowedTools", "<CLAUDE_ALLOWED_TOOLS_READ_ONLY>",
  "--append-system-prompt", "<read-only prompt + REPO_CHAT_CONTEXT>",
  "--strict-mcp-config",
  "--mcp-config", "<os.tmpdir()/smithersbot-empty-mcp.json>",
  // optional: "--model", "<model>"
  // optional: "--resume", "<sessionId>"
  "<prompt>"
]
```

The empty MCP config file contents (asserted by tests and confirmed at runtime):

```json
{"mcpServers":{}}
```

### Codex args — UNCHANGED

`buildCodexRepoChatArgs` (initial + resume) does **not** receive any MCP flags. Verified by new negative tests.

### Repair / resume path

`buildResumeArgs` for the Claude branch spreads from `params.args`, so both `--strict-mcp-config` and `--mcp-config <path>` survive the rebuild and the `--resume <sessionId>` pair is spliced **after** the MCP flags. Confirmed by `preserves --strict-mcp-config and --mcp-config on the Claude repair path`.

## 4. Tests added / updated

### `src/goal/claude-code-mcp-isolation.test.ts` (new, 10 it() cases)

- `ensureEmptyMcpConfig() creates the file at EMPTY_MCP_CONFIG_PATH when missing`
- `ensureEmptyMcpConfig() returns the EMPTY_MCP_CONFIG_PATH constant`
- `the written file parses to exactly { mcpServers: {} }`
- `ensureEmptyMcpConfig() does not rewrite the file when the content is already correct`
- `ensureEmptyMcpConfig() repairs content drift (extra keys)`
- `ensureEmptyMcpConfig() repairs invalid JSON`
- `appendStrictMcpArgs() appends --strict-mcp-config and --mcp-config when neither is present`
- `appendStrictMcpArgs() is a no-op when both --strict-mcp-config and --mcp-config are already present`
- `appendStrictMcpArgs() appends only the missing flag when one is already present`
- `appendStrictMcpArgs() does not mutate the input args array`

### `src/repo-chat/repo-chat-worker.test.ts` (new and updated)

New (MCP isolation):

- `claude args include --strict-mcp-config and --mcp-config <path> with prompt last`
- `claude args include MCP isolation flags when no session id is provided`
- `empty MCP config file contains exactly { mcpServers: {} }`
- `codex initial args do not include MCP isolation flags`
- `codex resume args do not include MCP isolation flags`
- `runRepoChatWorker preserves --strict-mcp-config and --mcp-config on the Claude repair path`

New (diagnostics — from `improve-repo-chat-diagnostics`):

- `non-zero exit message includes exit=, signal=, durationMs= tokens`
- `signal=none is rendered when no signal is present`
- `falls back to tail of stdout when stderr is empty and stdout exceeds the cap`
- `appends MCP startup hint when stderr empty and stdout is init-only`
- `does not append MCP startup hint when stdout contains an assistant/result event`
- `truncates stderr at the cap with a trailing ellipsis`
- `truncates stdout tail at the cap with a leading ellipsis`

Pre-existing test kept passing:

- `throws on non-zero exit and includes stderr details` (substring match still satisfied by the new message shape).

## 5. Verification commands + results

| Command | Result |
| --- | --- |
| `pnpm exec tsc -p tsconfig.json` | PASS (no diagnostics) |
| `pnpm build` | PASS (`tsc` + canvas/hooks/build-info scripts succeed) |
| `pnpm lint` | PASS (`Found 0 warnings and 0 errors.` across 2295 files) |
| `pnpm vitest run src/repo-chat/` | PASS — 2 files, 55 tests passed |
| `pnpm vitest run src/telegram/ src/repo-chat/ src/goal/` | PASS — 94 files / 1270 tests passed, 1 file / 8 tests skipped (`src/goal/git-checkpoint.test.ts`, pre-existing dirty-tree skip) |
| `pnpm vitest run src/goal/claude-code-mcp-isolation.test.ts` (covered by the above) | PASS — 10 tests |

### Manual CLI sanity check

Command:

```
claude -p --output-format json --verbose --strict-mcp-config --mcp-config /tmp/smithersbot-empty-mcp.json --allowedTools "Read,Glob,Grep,Bash" "Say only: strict MCP test passed"
```

`claude` 2.1.143 requires the prompt via stdin or `--print`-style positional input — the literal command form above errored with `Input must be provided either through stdin or as a prompt argument when using --print`, so the actual sanity check was run as:

```
echo "Say only: strict MCP test passed" | claude -p --output-format json --verbose --strict-mcp-config --mcp-config /tmp/smithersbot-empty-mcp.json --allowedTools "Read,Glob,Grep,Bash"
```

Outcome: **PASS.** The `system/init` event reported `"mcp_servers":[]` (i.e. strict mode took hold and no global servers were inherited), and the assistant + result events returned `"strict MCP test passed"`. Exit `0`, `duration_ms: 4197`.

## 6. Goal-worker Claude Code call-site audit (read-only)

None of the goal-worker Claude Code invocations currently pass `--strict-mcp-config` or `--mcp-config`. Each path below inherits the user's global MCP/plugin set today and is vulnerable to the same startup failure mode that hit repo chat.

| File | Approx. line | Current Claude args (high level) | `--strict-mcp-config` / `--mcp-config` today? | Recommendation |
| --- | --- | --- | --- | --- |
| `src/goal/cli-worker.ts` — `buildCliArgs` Claude branch | 810–825 | `-p --verbose --output-format stream-json --allowedTools <list> --append-system-prompt <…> [--model …] <prompt>` | No | Wire `ensureEmptyMcpConfig()` + `appendStrictMcpArgs(...)`. Default should be **strict-empty** for parity with repo chat; if goal workers ever need user MCPs, expose a per-goal opt-in flag. |
| `src/goal/cli-worker.ts` — `repairResultFile` (calls `buildCliArgs` then `runCliProcess`) | 175–197 | Inherits from `buildCliArgs` Claude branch | No (inherits) | Fixed automatically once the call site above is wired. |
| `src/goal/cli-planner.ts` — plan revision Claude args | ~491 | `-p --allowedTools <CLAUDE_ALLOWED_TOOLS> [--model …]` (prompt via stdin) | No | Wire the shared helper. Plan revision should also start strict-empty — planning is read-only. |
| `src/goal/cli-planner.ts` — initial planning Claude args | ~635 | `-p --allowedTools <CLAUDE_ALLOWED_TOOLS>` (prompt via stdin) | No | Wire the shared helper. Same default as revision. |
| `src/goal/plan-autocheck.ts` — `buildClaudeReviewerArgs` (initial + resume) | ~343–356 | `-p --verbose --output-format stream-json --allowedTools <read-only> --append-system-prompt <…> [--model …] [--resume <id>] <prompt>` | No | Wire the shared helper. Resume must inherit the same flags from the initial args (mirrors repo-chat repair). |
| `src/goal/post-execution-review.ts` — `runSingleReviewPass` Claude args | ~343–354 | `-p --output-format json --max-turns 1 --allowedTools <read-only> --append-system-prompt <…>` (prompt via stdin) | No | Wire the shared helper. Read-only review — strict-empty default. |
| `src/goal/manual-tests.ts` — `generateManualTestsViaCli` Claude args | ~142 | `-p --output-format json --max-turns 1` (prompt via stdin; no allowed-tools restriction) | No | Wire the shared helper. Also worth adding the read-only allowedTools list to match the other reviewer paths, but that is out of scope here. |
| `src/goal/lessons.ts` — `runClaudeLessonExtraction` Claude args | ~344–355 | `-p --output-format json --max-turns 1 --allowedTools <read-only> --append-system-prompt <…>` (prompt via stdin) | No | Wire the shared helper. Read-only extraction — strict-empty default. |

**Per-file deferral:** none of the goal-worker call sites require new config decisions to flip to strict-empty (they are all read-only or single-turn, and none currently advertise needing user MCPs). Wiring them in a single follow-up PR is straightforward and low-risk. No "configurable inherit" mode is required for v0.

## 7. Repo chat readiness for live Telegram smoke test

**Yes** — repo chat (Claude Code backend) is ready for a live Telegram smoke test:

- Claude Code now launches with `--strict-mcp-config` + an empty `mcpServers` map, so the failure mode that caused the original `exit 1` is gone.
- The repair / resume path preserves both flags (regression-covered).
- Codex behavior is unchanged.
- Diagnostics now surface exit code, signal, durationMs, the tail of stdout when stderr is empty, and an explicit MCP startup hint if the same class of failure ever recurs.
- Full test suite under `src/telegram/`, `src/repo-chat/`, `src/goal/` is green (1270 tests pass, 8 pre-existing skips unrelated to repo chat).
- Manual `claude` sanity check with the production isolation flags returned a clean assistant + result event with `mcp_servers:[]`.

## 8. Out-of-scope confirmations

- No Codex behavior was changed.
- No `--bare` flag was added.
- No user-level Claude config was edited.
- No CI workflow was edited.
- No goal-worker source files were modified (audit only, per task spec).
- No commit, push, or PR was created by this task.
