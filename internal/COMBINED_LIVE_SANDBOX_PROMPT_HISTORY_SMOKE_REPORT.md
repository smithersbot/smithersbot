# Combined Live Sandbox, Prompt, History, and Cron Smoke Report

Generated: 2026-05-24T13:18:17-04:00

Goal ID: b64106a5-dea5-4c62-ad37-3634b1978a3b

## Summary

This disposable live validation goal completed the four prerequisite smoke branches and synthesized their findings here. The run verified subscription-backed worker execution, live sandbox denial behavior, Stage 2U-F redacted goal runtime mirroring, prompt cleanup/redaction behavior, and cron mirror availability where safely inspectable.

No secret contents, raw environment values, raw auth/session/config contents, API keys, tokens, raw statusline JSON, or raw backend JSON are included in this report.

## Backend and Execution

- Backend information safely available from mirrored metadata: planner used `claude_code`, autocheck used `codex`, and workers used `claude_code`.
- Subscription-backed execution result: PASS. A normal worker executed successfully through the configured subscription-backed backend with no API-key prompt and no auth failure.
- Autocheck result: autocheck ran and was approved; it was not skipped.
- Gateway restart: not performed.

## Safe Repo Read

- Safe tracked repo reads succeeded.
- `README.md`: tracked top-level project README, text file, read successfully without printing contents.
- `package.json`: tracked Node package manifest, JSON file, read successfully without printing dependency values or private configuration.

## Sandbox Denial

All sensitive content probes redirected file contents away from output and recorded only category-level outcomes.

- Normal repo reads: allowed, proving ordinary tracked repository reads still work.
- Repo env file category: denied for present-or-denylisted env files.
- Managed private env/config category: denied for the sensitive file probe; directory-only probes were inconclusive because reading a directory with `cat` is not a content-read test.
- Claude auth/session/config category: denied for sensitive file probes; directory-only probe was inconclusive for the same reason.
- Codex auth/config category: denied for sensitive file probes.
- SSH/GPG credential category: denied where credential files existed; private SSH key files probed by category were absent.
- Additional credential category: denied for the local git credential probe.
- Outside-workspace write probe: denied by the filesystem as read-only. No probe file was created, and no cleanup was required.

Inconclusive sandbox items: only directory targets were inconclusive because `cat` reports a directory condition rather than proving content denial. Sensitive files inside those categories were probed separately and denied.

## Goal Runtime Mirror

- Mirrored artifacts were inspected only under agent-visible `agent/history` paths.
- `.clawdbot-dev` was not inspected directly.
- Confirmed present in the runtime mirror snapshot: `events.jsonl`, `prompts/`, `runtime/`, `runtime/index.json`, `runtime/run.json`, `runtime/scout/`, and `runtime/autocheck/`.
- Scout artifacts included execution plan, scout report, plan draft, planning brief, planning raw output/stdout/stderr, auth mode, and node specs.
- Autocheck artifacts included round output, prompt, response, metadata, backend, and session id artifacts.
- `runtime/WORKING.md`, `runtime/workers/`, and `runtime/manual-tests/` were absent in the inspected snapshot because the mirror was captured at the planner/autocheck checkpoint before worker and post-completion manual-test artifacts were produced. This was expected snapshot timing, not a mirror failure.
- No mirror failure warning events were found.

## Runtime Index

- `runtime/index.json` was present and valid.
- Entries included the required fields: relative path, kind/category, original bytes, mirrored bytes, redaction count, truncated flag, skipped flag, and skip reason when skipped.
- No entries in the inspected snapshot were truncated.
- No skipped entries appeared in that snapshot because no forbidden-pattern source artifacts were present to skip.
- Present large-but-normal artifacts mirrored fully. The illustrative larger worker/autocheck artifacts mentioned in the goal text were not present in the inspected snapshot, so no pointless truncation was observed.

## Prompt Cleanup

- Worker prompts did not instruct agents to read from, write to, or output to `.clawdbot-dev`.
- `.clawdbot-dev` appeared in worker prompt material only as a denied/private path or as task text instructing agents not to inspect it.
- Worker hard-deny sections were grouped, deduped, and appeared once near the beginning of inspected worker prompts.
- Planner prompt had distinct Scout and Planner phases.
- History and artifact references in worker-facing prompt material pointed to `agent/history`.
- Residual finding: the planner/scout prompt still named a live planning artifact store under `.clawdbot-dev`, while also explaining that artifacts are mirrored to `agent/history`. Worker-facing cleanup was complete, but planner/scout cleanup was not fully complete.

## Redaction

- No real secret values were found in the inspected mirrored runtime tree.
- Token/key marker strings found by scan were only examples embedded in goal/plan prose or quoted smoke-test text, not real secret bodies.
- No real auth/config credential directory paths were found in mirrored artifacts except scan-target descriptions or zero-match reports from prior workers.
- Redaction placeholders appeared where the mirror engine removed sensitive material.
- Runtime JSON artifacts remained parseable and useful for debugging after redaction.
- Safe repo-relative paths and JSON shape remained readable.

## Forbidden-File Skips

- No forbidden-pattern files were physically copied into the mirror.
- Forbidden patterns checked included env files, private key/certificate-like files, auth/config credential files, SmithersBot/MoltBot/ClawdBot config filenames, credential filenames, and backup files.
- Skip-recording was not exercised in this run because the source runtime store did not contain forbidden-pattern files to skip. The important negative condition held: none were copied or leaked.

## Cron Mirror

- Cron mirror result: inconclusive.
- `agent/history/cron/` was not present at inspection time.
- No mirrored cron `jobs.json`, run JSONL files, or cron `index.json` were available to validate.
- No completed cron run was safely available from this read-only worker context, and triggering one was not safe or required here.
- No cron backup files were present in an agent-visible cron mirror because no cron mirror directory existed.

## Explicit Confirmations

- Mirrored goal artifacts confirmed under `agent/history`, not by direct inspection of `.clawdbot-dev`.
- Prompts inspected for workers do not instruct agents to use `.clawdbot-dev` as a read/write/output location.
- Worker hard-deny prompt content was grouped and deduped where visible.
- Inconclusive categories are listed above with reasons: directory-only sandbox probes, pre-worker/manual-test snapshot timing, skip path not exercised, and no completed cron run available.
- No secret contents appear in this report.
