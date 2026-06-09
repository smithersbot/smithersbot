# Testing guidance

A linked durable guide for Workers (and Checkers reviewing a Plan's verification)
when a Task's core deliverable is test design or coverage, or when a behavior is
hard to verify without deciding where to mock. For ordinary Tasks the inline
"verify observable behavior, not internal wiring" line is enough — open this guide
only when the trigger applies.

Terms (Task, Plan, Worker, Checker, Manual Test, verification) are used as defined
in `GLOSSARY.md`; link that file rather than restating its definitions.

## The core idea

A good check confirms what a user or caller can actually do and see, end to end.
It should keep passing after an internal rewrite that preserves behavior, and
should start failing when the behavior a user depends on breaks. Tie each check to
an observable outcome ("the caller does X and gets Y"), not to the internal steps
that happen to produce it.

## Mock only at true boundaries

Replace something with a stand-in only when it is a real external system the Task
does not own — a remote API, the network, the clock, the filesystem when it is the
thing under test, a paid or rate-limited service. Do not stand in for the code the
Task itself produces or controls; exercising the real thing is what gives the check
its value. Over-mocking turns a check green while the real path stays broken, which
is worse than no check.

## Good vs. weak check shapes

- **Good:** drive the same entry point a user or caller uses, then assert the
  observable result and any durable state change. Cover the success path plus the
  failure or edge a user could realistically hit.
- **Good:** when a Task fixes a specific defect, add a check that fails before the
  fix and passes after, expressed in terms of the observable symptom.
- **Weak:** asserting that an internal helper was called, or pinning the exact
  sequence of internal steps — these break on harmless refactors and pass even when
  the user-visible behavior is wrong.
- **Weak:** standing in for the code under test, so the check only confirms the
  stand-in, not the real behavior.

## Scope

Run the smallest check slice that actually exercises the changed behavior rather
than the whole suite, and name the exact command in the Task's verification. When a
behavior genuinely cannot be checked automatically, say so as a finding and propose
a Manual Test that states what to do, what to observe, and what counts as pass or
fail.

## Sources

- [`GLOSSARY.md`](../../GLOSSARY.md) — shared terms (Task, Worker, Checker, Manual
  Test, verification) this guide uses.
- [`docs/goal-engine-audit/02-sample-skills.md`](../goal-engine-audit/02-sample-skills.md)
  — the audit row (`tdd` skill) that this guide de-jargons into SmithersBot
  vocabulary; the observable-behavior and mock-only-at-boundaries principles come
  from there.
