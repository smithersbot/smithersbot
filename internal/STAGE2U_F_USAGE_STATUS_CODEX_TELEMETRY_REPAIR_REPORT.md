# Stage 2U-F Usage Status Codex Telemetry Repair Report

## Live symptom

`/usage_status` rendered Codex quota as unavailable even though Codex execution still worked:

- `Codex: unavailable`
- `Note: Live quota unavailable (codex-limit timed out).`

This was a telemetry failure, not proof that the Codex backend or workers were unusable.

## Manual timing evidence

The operator verified the helper from an interactive shell:

- `npx -y codex-limit --json`: about 7.6 seconds on the first run.
- `npx -y codex-limit --json`: about 6.2 seconds on a later run.
- `npx -y codex-limit --json` with a 60 second allowance: about 6.7 seconds.
- `npm exec --yes codex-limit -- --json`: about 5.6 seconds.
- `codex exec --help`: succeeded quickly.

The returned JSON included primary and secondary quota, credits, plan fields, and `rateLimitReachedType: null`.

## Root cause

The confirmed old `/usage_status` path invoked the quota helper from the Telegram status hot path through `spawnSync` as:

```text
npx -y codex-limit --json
```

The timeout surfaced from the parent `spawnSync` result as `ETIMEDOUT`, which the status renderer reported as `codex-limit timed out`. From this layer alone, the code cannot determine whether the elapsed time was spent in npm/npx package resolution, `codex-limit` startup, nested Codex app-server or auth discovery, npm cache writes, or some other subprocess work before JSON was emitted.

The code-level finding is therefore: `/usage_status` treated a bounded telemetry subprocess timeout as Codex unavailability, while using a fragile hot-path `npx -y` invocation whose runtime depended on the gateway subprocess environment.

The likely environment cause remains a hypothesis to confirm in the live gateway: the systemd/gateway process may not inherit the same interactive-shell assumptions that made manual runs succeed, especially the Node binary directory on `PATH` and a writable npm cache. The repair makes those assumptions explicit. `HOME` and `CODEX_HOME` are preserved for normal Codex auth discovery, but the runner does not read, print, or persist raw auth/session/config contents.

## Why hot-path `npx -y` was fragile

`npx -y` is not a deterministic local binary call in this repository. `codex-limit` is not pinned in `package.json` or `pnpm-lock.yaml`, so the old path could require package-manager resolution and cache writes during a Telegram command. In a gateway/systemd environment, that can differ from an operator shell with NVM or shell startup files already setting `PATH`, npm cache behavior, and executable lookup.

The old timeout message did not distinguish helper startup, package resolution, Codex discovery, and JSON parsing. It also let quota telemetry failure drive user-facing Codex backend availability wording.

## Runner choice

The new runner lives in `src/telegram/codex-quota-runner.ts` and uses:

```text
npm exec --yes codex-limit -- --json
```

This was chosen because `codex-limit` is not available as a pinned local dependency in the repository today, while the operator measured this invocation as working from the shell at about 5.6 seconds. It avoids keeping raw `npx -y codex-limit --json` as the normal Telegram hot path and keeps the argv contract explicit and testable.

The runner:

- Prepends `path.dirname(process.execPath)` to `PATH` so the gateway can find the Node/npm-side binaries associated with the running Node.
- Preserves `HOME` and `CODEX_HOME` when present, and fills `HOME` from the supplied home directory only if missing.
- Sets `npm_config_cache` under the Codex quota cache directory, giving package-manager work a writable runtime cache location.
- Uses a bounded timeout and max buffer.
- Parses only valid JSON stdout through the quota schema.
- Classifies failures as `command not found`, `timed out`, `command failed`, or `unavailable`.
- Never returns or renders raw stdout/stderr.

## Codex telemetry states

`/usage_status` now separates quota telemetry from backend execution:

- Successful probe with no reached limit: `Codex: current`.
- Successful probe with `rateLimitReachedType` indicating a regular limit: `Codex: rate limited`.
- Successful probe with `rateLimitReachedType` indicating credits, quota, usage, or exhaustion: `Codex: exhausted`.
- Probe failure with a valid last-known quota: `Codex: stale`, with a note that refresh failed or timed out.
- Probe failure with no valid cache: `Codex quota: unavailable`, with a note that Codex may still be usable because telemetry is separate from backend execution.

Claude `/usage_status` behavior was kept unchanged.

## File-backed cache rules

The Codex cache is sanitized and file-backed at:

```text
${XDG_CACHE_HOME:-$HOME/.cache}/smithersbot/codex-quota.json
```

The cache stores only parsed quota fields and `cachedAtMs`: primary quota, secondary quota, credits, plan type, and `rateLimitReachedType`. It never stores raw helper stdout, stderr, tokens, auth content, or raw status payloads.

The runner reads the last valid cache before probing. It writes the cache only after successful JSON parsing and schema validation. Invalid JSON, incomplete JSON, timeout, command failure, and missing command results do not overwrite a good cache. Writes are atomic by writing a temporary file and renaming it into place. In-memory state can be cleared and the file cache still survives gateway restart.

## Tests added or updated

`src/telegram/codex-quota-runner.test.ts` covers:

- Command construction uses `npm exec --yes codex-limit -- --json`, not the old `npx -y` hot path.
- Environment construction prepends the Node binary directory, preserves `HOME` and `CODEX_HOME`, and sets a writable npm cache.
- Cache path resolution under `XDG_CACHE_HOME` or `$HOME/.cache`.
- Valid Codex quota JSON writes a sanitized file cache.
- Invalid or incomplete JSON does not overwrite a valid cache.
- Timeout, missing command, and non-zero exit are classified without overwriting the cache.
- Failures return cached quota when available and do not return raw helper output.
- File cache survives a simulated restart after in-memory state is reset.

`src/telegram/usage-status.test.ts` covers:

- Codex current quota rendering from the deterministic runner.
- Telemetry unavailable without implying backend execution is unavailable.
- Timeout with cache renders `Codex: stale`.
- Timeout with no cache renders `Codex quota: unavailable`, not `Codex: unavailable` or `Codex: exhausted`.
- File-backed Codex cache survives a simulated gateway restart.
- `rateLimitReachedType` renders rate-limited or exhausted headings and never current.
- Raw stdout/stderr/token-like values are not rendered.
- Existing Claude statusline behavior remains unchanged.

## Verification results

Passed:

```text
pnpm vitest run src/telegram/usage-status.test.ts src/telegram/codex-quota-runner.test.ts
pnpm vitest run src/telegram/usage-status.test.ts
pnpm vitest run src/telegram/codex-quota-runner.test.ts
pnpm exec tsc -p tsconfig.json
pnpm build
pnpm lint
```

`pnpm lint` reported 0 warnings and 0 errors.

## Manual verification steps

Do not run these from a worker. An operator should verify in the live gateway environment:

1. Restart the gateway.
2. Run `/usage_status`.
3. Confirm Codex live quota renders when telemetry succeeds.
4. Temporarily force or observe a quota telemetry failure and confirm Codex is not mislabeled unavailable when only telemetry fails.
5. Confirm `Codex: stale` can render from the last-valid cache after a gateway restart.
6. Confirm the Claude section still renders correctly.
