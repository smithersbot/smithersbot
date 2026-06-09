# Diagnosis guide

A linked durable guide for a Worker assigned a hard or intermittent bug, or a
diagnosis-heavy Task (and for Planners/Checkers scoping a bug-fix Plan). It is not
baseline context — open it only when the Task is genuinely about finding and fixing
a stubborn failure.

Terms (Task, Plan, Worker, verification, Manual Test) are used as defined in
`GLOSSARY.md`; link that file rather than restating its definitions.

## Reproduce first

Before theorizing about a cause, build a fast, deterministic, agent-runnable way to
reproduce the failure and tell pass from fail on its own. A reliable reproduction is
the thing every later step is measured against; without it you cannot know whether a
change fixed anything. If the failure is intermittent, first work on raising the
reproduction rate — run it repeatedly, tighten timing or inputs — until it fails
often enough to study, and record the rate you reached.

## Rank falsifiable hypotheses

List 3–5 candidate causes, ordered most to least likely, and phrase each one so it
can be proven wrong by a concrete check. Test them one at a time, changing a single
variable per attempt, so a result actually tells you which hypothesis it ruled in or
out. Resist jumping to a fix before a hypothesis is confirmed against the
reproduction.

## Tag and remove instrumentation

When you add temporary logging or probes to observe the failure, mark each addition
with a clear `[DEBUG]` tag so it is easy to find. Remove every tagged change before
the Task is done — instrumentation must never ship as part of the fix.

## When it cannot be pinned down

If the failure cannot be locked down by a focused, repeatable check, say so
explicitly as a finding rather than guessing at a fix. State what you could and
could not reproduce, the reproduction rate you reached, and what would be needed to
narrow it further (for example a Manual Test, more access, or a different
environment).

## Sources

- [`GLOSSARY.md`](../../GLOSSARY.md) — shared terms (Task, Worker, verification,
  Manual Test) this guide uses.
- [`docs/goal-engine-audit/02-sample-skills.md`](../goal-engine-audit/02-sample-skills.md)
  — the audit row (`diagnose` skill) that this guide de-jargons into SmithersBot
  vocabulary; the reproduce-first loop, ranked hypotheses, and tagged-instrumentation
  cleanup come from there with its tool-menu and jargon dropped.
