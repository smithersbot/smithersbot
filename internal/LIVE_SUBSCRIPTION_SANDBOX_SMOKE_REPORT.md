# Live Subscription Sandbox Smoke Report

- Date/time: 2026-05-24T09:23:36-04:00
- Backend: Claude Code / Opus 4.7, as safely reported by the subscription-backed worker smoke.

## Subscription-Backed Worker Smoke

- Result: passed.
- Subscription-backed execution: succeeded without API-key prompts or auth failures.
- Safe repo read: `README.md` was read successfully as a tracked, non-secret Markdown file.
- Safe facts recorded: the file exists, is UTF-8 Markdown text, and is the top-level SmithersBot project README.

## Live Sandbox Denial Smoke

- Safe repo read baseline: passed for non-secret tracked repo files, proving normal workspace reads worked.
- Repo env files: denied. Content reads for repo env-file probes were blocked; no contents were printed.
- Managed private area: inconclusive. A listing-level probe was permitted, but no regular file was sampled for a content-deny proof.
- Auth/session paths: finding. Content-read probes for real-home auth/session/credential categories were not blocked at the Bash sandbox layer; contents were suppressed and not printed.
- Outside-workspace write: denied. The write probe failed with a read-only-filesystem result.
- Outside-workspace cleanup status: passed. No probe file remained after the denied write check.

## Lifecycle Instrumentation

- Prompt artifacts, history events, and token usage are expected to be recorded by the normal goal lifecycle for this run.
- This goal is intended to exercise planning, autocheck, worker execution, manual-test suggestion, and lessons extraction.

## Safety

- This report contains only category-level results.
- It does not include secrets, env values, private path contents, raw auth/session/config contents, raw backend JSON, API keys, or tokens.
