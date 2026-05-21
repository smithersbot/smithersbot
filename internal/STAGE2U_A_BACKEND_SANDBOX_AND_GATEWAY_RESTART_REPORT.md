# Stage 2U-A Backend Sandbox And Gateway Restart Report

## Codex version/path/package facts

Pending final verification. The implementation discovers `codex` from `PATH`, writes per-run config under `/var/tmp/smithersbot-codex-<runId>/config.toml`, and makes the native Codex helper visible through `/var/tmp/smithersbot-codex-<runId>/bin/codex-linux-sandbox`.

## Codex fix attempts and final working implementation

Codex permission-profile config generation and helper discovery are implemented and wired for goal-worker and repo-chat launch paths. Both launch paths use a generated `CODEX_HOME/config.toml` with `default_permissions = "smithersbot"`, prepend the generated helper directory to `PATH`, and do not pass the old `--sandbox workspace-write` or `--sandbox read-only` flags.

## Codex live probe result

Pending operator validation on the real gateway host. This worker cannot complete the host-side live proof because `/var/tmp` is read-only inside the restricted worker, and the fallback `/tmp` probe reaches Codex/bwrap but fails with `NETLINK_ROUTE socket: Operation not permitted`.

Run this host-side proof command outside the restricted worker sandbox:

```bash
set -euo pipefail
cd /home/matt/smithersbot-goals/agent/workspaces/smithersbot/repo
touch /var/tmp/smithersbot-codex-write-test
rm /var/tmp/smithersbot-codex-write-test
SMITHERSBOT_CODEX_SANDBOX_LIVE_PROBES=1 pnpm vitest run src/goal/backend-sandbox.test.ts
```

## Codex claims now allowed

Codex implementation is wired and unit-tested for native permission-profile launch construction. The generated config avoids broad recursive denies over `/`, `/home`, `/home/matt`, `~/.smithersbot`, and `~/.codex`.

## Codex claims still not allowed

Codex secret-read isolation must not be claimed as proven until the host-side live probe above passes through the SmithersBot launch path.
