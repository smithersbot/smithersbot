# Stage 2U Gateway And Repo-Chat Recovery Report

Generated: 2026-05-22.

This report closes the recovery work for stale goal `f5fe0803`. The stale run was
not resumed. Completed work from that run was preserved, and the remaining gateway,
interruption, and repo-chat regressions were finished from the current repository
state.

No live gateway restart was run by the worker. No operator-local systemd files were
edited. All gateway restart verification described here is mock/unit verification
unless explicitly listed as a manual operator step.

## Preserved From `f5fe0803`

- The runner compiler fallback work was preserved.
- `/gateway_status` support was preserved.
- Existing gateway/service naming and legacy compatibility behavior were preserved,
  including `smithersbot-gateway.service` and legacy `moltbot-gateway-dev.service`
  handling.

## Newly Fixed

- Generated gateway systemd units now render `KillMode=mixed`.
- The installer-generated user service content now includes `KillMode=mixed` while
  preserving `WorkingDirectory`, `EnvironmentFile`, `ExecStart`, `Restart=always`,
  and `RestartSec=5`.
- `/gateway_restart` mock coverage now exercises active legacy unit resolution,
  `smithersbot-gateway.service`, persisted restart request state, duplicate
  suppression, responsiveness gating, stale port/orphaned PID diagnostics, and
  user-facing secret redaction.
- Technical worker failures no longer render as "needs input" unless the blocker is
  a true `user_input` blocker.
- Missing `worker_result.json` with `exitCode: null` and `signal: null` is
  classified as technical process loss/missing result instead of user input.
- Error-blocked/interrupted goal runs retry the failed step before unrelated later
  steps continue.
- Codex repo-chat sessions persist a stable sandbox state handle and reuse the same
  generated `CODEX_HOME` for follow-up resume calls.
- Codex repo-chat follow-ups call exec resume with the prior thread id, and missing
  rollout state is converted into a safe "start a fresh repo-chat session" message
  instead of leaking raw `no rollout found` RPC text.
- Adjacent long `/repo_chat` chunks from the same chat/thread/user are coalesced
  safely through the existing command-fragment path. Unrelated later messages start
  separate sessions, and replies to previous repo-chat messages continue the intended
  session.

## `KillMode=mixed` Status

`KillMode=mixed` is now part of the generated gateway unit text and the
`scripts/install-smithersbot-user-service.sh` dry-run/install output. The change is
covered by rendered-unit and installer-output assertions only; the worker did not
run `systemctl restart`, `systemctl start`, `systemctl stop`, or any live gateway
restart command.

The local operator override that currently sets `CLAWDBOT_TS_COMPILER=tsc` and
`KillMode=mixed` can remain in place until the operator has reinstalled or updated
the user service from this repository and completed the manual verification steps
below.

## `/gateway_restart` Regression Status

The restart path is covered with mocks for:

- active legacy `moltbot-gateway-dev.service` resolution;
- `smithersbot-gateway.service` support;
- avoiding assumptions that only the new service name exists;
- persisting inbound Telegram update/restart request state before restart side
  effects;
- sending one accepted/success/failure response without delayed duplicate replies;
- waiting for the restarted gateway to be running/responsive before claiming
  success;
- clear stale port `19001` / orphaned process diagnostics;
- redaction of gateway token, Telegram token, environment values, and config secrets
  from user-facing restart/status text.

The worker did not invoke the live restart command.

## Goal Interruption UI And Classification

The blocked UI now reserves "needs input" for true `user_input` blockers. Technical
failures are rendered as worker failed/interrupted/process-lost/resume-needed style
states, with attempt history surfaced when available. The regression case where
Codex hit a usage limit, Claude Code fallback emitted only init output, and no
`worker_result.json` was produced is classified as retryable technical failure
rather than fake domain input.

Missing `worker_result.json` with `exitCode: null` and `signal: null` is explicitly
classified as missing result / process lost / interrupted. Resume ordering retries
the failed error-blocked/interrupted step before continuing unrelated later steps.

## Codex Repo-Chat Resume State

Repo-chat sessions now persist a stable Codex sandbox state handle. Codex
repo-chat derives the generated `CODEX_HOME` from the repo-chat session state
instead of a per-turn response UUID, so follow-up replies reuse the same sandbox
home/state and call exec resume with the prior thread id.

If the Codex rollout state is missing, Telegram receives a safe message telling the
user to start a fresh repo-chat session. The raw `no rollout found` error is not
sent to Telegram.

## Long `/repo_chat` Chunk Handling

Adjacent long `/repo_chat` chunks from the same keyed chat/thread/user append to
the pending repo-chat command fragment within the existing strict id/time limits.
This avoids starting multiple unrelated repo-chat sessions for one split prompt.

The continuation behavior is intentionally narrow:

- repeated adjacent `/repo_chat` chunks can coalesce while the fragment is pending;
- delayed or unrelated later commands start separate sessions;
- replies to known repo-chat sessions take precedence over pending fragment append;
- text is appended without duplicate or dropped content.

## Tests Added Or Updated

- `src/daemon/systemd-unit.test.ts`
- `src/daemon/systemd.test.ts`
- `src/infra/restart.test.ts`
- `src/telegram/gateway-restart.test.ts`
- `src/telegram/gateway-status.test.ts`
- `src/telegram/bot-native-commands.gateway-status.test.ts`
- `src/auto-reply/commands-registry.test.ts`
- `src/telegram/goal-commands.test.ts`
- `src/goal/cli-worker.test.ts`
- `src/goal/agent-executor.test.ts`
- `src/repo-chat/repo-chat-store.test.ts`
- `src/repo-chat/repo-chat-worker.test.ts`
- `src/telegram/repo-chat-commands.test.ts`
- `src/telegram/command-fragments.test.ts`
- `src/telegram/bot-handlers.repo-chat-routing.test.ts`

## Verification Results

Completed dependency tasks reported these passing verification commands:

```sh
pnpm vitest run src/daemon/systemd-unit.test.ts src/daemon/systemd.test.ts src/infra/restart.test.ts
pnpm vitest run src/telegram/gateway-restart.test.ts src/telegram/gateway-status.test.ts src/telegram/bot-native-commands.gateway-status.test.ts src/auto-reply/commands-registry.test.ts
pnpm vitest run src/telegram/goal-commands.test.ts src/goal/cli-worker.test.ts src/goal/agent-executor.test.ts
pnpm vitest run src/repo-chat/ src/telegram/repo-chat-commands.test.ts
pnpm vitest run src/telegram/command-fragments.test.ts src/telegram/repo-chat-commands.test.ts src/telegram/bot-handlers.repo-chat-routing.test.ts
pnpm exec tsc -p tsconfig.json
pnpm build
pnpm lint
```

For this report task, the worker verified:

```sh
test -f internal/STAGE2U_GATEWAY_AND_REPOCHAT_RECOVERY_REPORT.md
rg -n "KillMode=mixed|gateway_restart|repo-chat|worker_result|CODEX_HOME|96-stage2u-stabilize" internal/STAGE2U_GATEWAY_AND_REPOCHAT_RECOVERY_REPORT.md
pnpm build
```

## Manual Operator Service Update

Run these commands from the repository root on the gateway host:

```sh
bash scripts/install-smithersbot-user-service.sh --dry-run
bash scripts/install-smithersbot-user-service.sh
systemctl --user daemon-reload
systemctl --user enable smithersbot-gateway.service
```

The worker did not run these commands against live systemd.

After the service file has been updated and the manual Telegram verification below
passes, it is safe to remove the temporary `96-stage2u-stabilize.conf` override if
the installed unit already contains `KillMode=mixed` and the runtime no longer
depends on the override for `CLAWDBOT_TS_COMPILER=tsc`.

## Manual Gateway Verification

Use Telegram after the operator has updated the user service:

1. Run `/gateway_status`.
2. Record the reported PID/start time.
3. Run `/gateway_restart`.
4. Wait for the restart response.
5. Run `/gateway_status` again.
6. Confirm the PID/start time changed and the gateway reports healthy/running.

If `/gateway_restart` reports stale port `19001`, an orphaned process, or a unit
resolution problem, do not remove `96-stage2u-stabilize.conf` yet. Resolve the
operator-side process/service state first, then rerun the status → restart → status
sequence.
