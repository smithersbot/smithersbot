# Changelog

## SmithersBot — launch-prep docs and runtime cleanup (2026-05-24)

- Removed the `/usage_history` command from the launch-facing operator surface.
- Removed post-exec LLM diff review from launch-facing behavior.
- Disabled `pi` as a selectable launch backend.
- Repaired Telegram multi-message buffering for long freeform operator input.
- Completed Stage 2U-F prompt, history, and runtime mirror cleanup.
- Added manual-tests and lessons runtime evidence for launch auditability.
- Reconciled scout artifacts with the agent-visible history mirror.
- Improved Claude and Codex `/usage_status` reporting.
- Repaired stale blocked-state rendering in backend-limit DAG resume flows.
- Landed repo-wide G2-G10 test hygiene quick wins.
- Deferred the G1 read-only `/tmp` and `/var/tmp` test-environment cleanup batch.

## SmithersBot — fork-start (2026-01-29)

SmithersBot began as a personal fork of OpenClaw, originally forked when the
upstream project was still named Moltbot. Forked at
4583f88626f20efedc454d893afaaf898c23523b. See NOTICE.md for upstream
attribution and license details.
