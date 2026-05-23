# Stage 2U Claude Subscription Auth And Sandbox Proof Report

## Root cause

Inherited API-key-style Anthropic environment can poison Claude Code subscription auth. Earlier diagnosis also showed the generated Claude Code settings denied the Claude auth store in both Read-tool permissions and native sandbox filesystem rules, which can hide control-plane subscription auth before sandboxed Bash runs.

This task could not live-confirm the generated-settings failure mode because plain Claude subscription auth failed first in this worker environment with a non-secret API connectivity blocker. The fix still separates the control-plane launch environment from sandboxed Bash file access and keeps the sandbox deny matrix fail-closed.

## Differential probe results

Command run:

```sh
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES=1 node --import tsx --input-type=module -e '<status-only differential probe>'
```

Status-only results:

| Probe | OK | Blocker |
| --- | --- | --- |
| plain_unset_api_key_env | false | generic-failure |
| settings_without_claude_deny | false | generic-failure |
| setting_sources_empty | false | generic-failure |
| permissions_deny_claude_only | false | generic-failure |
| sandbox_deny_claude_only | false | generic-failure |
| full_generated_settings | false | generic-failure |

Summary: `ok=false`, `blocker=generic-failure`. Because the plain no-settings case failed, these results do not isolate `--settings`, `--setting-sources ""`, permission denies, native sandbox denies, or full generated settings as the current live blocker.

## Exact fix

- Claude subscription launches now strip `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY_OLD`, and `ANTHROPIC_BASE_URL`.
- Goal worker, repo-chat, proof, repair, planner/autocheck/review/manual-test/lessons paths use the centralized Claude Code environment strategy or credential-stripped fallback paths covered by tests.
- Generated Claude Code settings keep native sandboxing fail-closed and avoid dangerous skip-permission flags.
- Generated settings preserve required denies for managed private env, repo env files, symlink escape via private-root deny, and sandboxed Bash reads of Claude auth paths.
- README.md and `.env.example` remain allowed by the intended sandbox matrix.

## Live proof results

Standalone auth command:

```sh
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL claude -p "Reply exactly: claude-auth-ok"
```

Result: failed. Non-secret blocker label: `network/environment-blocked` (`API Error: Unable to connect to API (ConnectionRefused)`).

Sandbox proof command:

```sh
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL SMITHERSBOT_SANDBOX_LIVE_PROBES=1 SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES=1 node --import tsx scripts/prove-claude-sandbox.ts
```

Result: failed before sandbox execution. Non-secret blocker label: `timeout/environment-blocked`.

Proof summary emitted by the script:

```text
auth: TIMEOUT (45s) [timeout/environment-blocked]
claude-live-sandbox: not-proven
Claude Code sandboxing proven: no
blocking-phase: auth
classification: timeout/environment-blocked
exit: 2
```

## Sandboxed Bash auth-path read result

Not run. The sandbox proof stopped in the auth phase before sandboxed Bash was launched. No claim is made that sandboxed Bash auth-path reads were live-proven in this run.

## Deny/allow matrix

Live matrix result: not run because auth did not complete.

Required matrix status:

| Boundary | Result |
| --- | --- |
| README.md allowed | not live-proven in this run |
| `.env.example` allowed | not live-proven in this run |
| managed private env denied | not live-proven in this run |
| repo `.env.local` denied | not live-proven in this run |
| symlink escape to managed private env denied | not live-proven in this run |
| Claude auth-path reads denied from sandboxed Bash | not live-proven in this run |

Unit coverage asserts the generated settings preserve these allow/deny rules, but live native sandbox proof remains blocked by auth/connectivity in this environment.

## Real SmithersBot path proof results

Repo-chat command path:

```sh
timeout 70s env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL node --import tsx --input-type=module -e '<runRepoChatWorker claude_code status-only proof>'
```

Result: `repo_chat_ok=false`, `repo_chat_blocker=generic-failure`.

Goal-worker command path:

```sh
timeout 70s env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL node --import tsx --input-type=module -e '<executeTaskWithCliWorker claude_code status-only proof>'
```

Result: `goal_worker_ok=false`, `goal_worker_blocker=generic-failure`.

Planner/scout live proof was not run with Claude Code as a planner or scout because the task explicitly forbids using Claude Code as planner/scout while fixing Claude Code. Planner/scout coverage is by shared launch tests from the prior task, which prove the centralized subscription env strategy and dangerous-flag exclusions on those launch surfaces. Because repo-chat and worker live proofs failed, Claude Code is not safe to re-enable.

## Tests added

The completed implementation tasks added focused regression coverage for:

- differential subscription-auth probe classification and status-only output;
- Claude subscription env stripping in proof, goal-worker, repo-chat, and repair launches;
- remaining planner/scout/autocheck/review/manual-test/lessons launch paths using the centralized strategy or credential-stripped fallback;
- generated settings preserving private env and repo env denies;
- README.md and `.env.example` remaining allowed;
- dangerous skip-permission flags not being emitted;
- classifier distinctions for API-key env poisoning, missing subscription login, generated-settings-hidden auth, native sandbox runtime blocker, and generic failures;
- sandboxed Bash auth-path read denial in final generated settings.

## Verification results

Required verification run for this task:

```sh
pnpm vitest run src/goal/backend-sandbox.test.ts src/goal/cli-worker.test.ts src/repo-chat/repo-chat-worker.test.ts
pnpm exec tsc -p tsconfig.json
pnpm build
pnpm lint
```

Results:

| Command | Result |
| --- | --- |
| `pnpm vitest run src/goal/backend-sandbox.test.ts src/goal/cli-worker.test.ts src/repo-chat/repo-chat-worker.test.ts` | passed: 3 files, 163 tests |
| `pnpm exec tsc -p tsconfig.json` | passed |
| `pnpm build` | passed |
| `pnpm lint` | passed: 0 warnings, 0 errors |

Claude Code sandboxing proven: no
Claude Code safe to re-enable in planner/repo-chat/worker: no
