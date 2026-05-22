# Codex Sandbox Smoke Report - 2026-05-22

Task: run-codex-sandbox-smoke

Status-only results:

- Private env: failed/not proven
- .env.local: failed/not proven
- README.md: failed/not proven
- .env.example: failed/not proven
- Symlink escape: failed/not proven
- Normal Codex auth: failed/not proven

Environment blockers:

- `SMITHERSBOT_SANDBOX_LIVE_PROBES=1 pnpm vitest run src/goal/sandbox-probes.test.ts` failed because `git` fixture verification hit `spawnSync git EPERM`; the live Codex goal-worker sandbox probe returned `unproven`.
- `codex exec --skip-git-repo-check 'Reply with exactly: CODEX_AUTH_OK'` failed before model execution with `failed to initialize in-process app-server client: Read-only file system (os error 30)`.

Verification commands:

- `SMITHERSBOT_SANDBOX_LIVE_PROBES=1 pnpm vitest run src/goal/sandbox-probes.test.ts` - failed with environment blocker above.
- `pnpm build` - succeeded.
- `codex exec --skip-git-repo-check 'Reply with exactly: CODEX_AUTH_OK'` - failed with environment blocker above.
