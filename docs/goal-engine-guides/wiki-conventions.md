# Wiki conventions

Two lightweight, navigable-history conventions adopted in principle for goal-owned
artifacts. They are structural conventions of the goal-history layer, not prompt
text — no agent prompt injects them. They pair with the `Sources Section` and
`Source Link` definitions in `GLOSSARY.md` (link that file; do not restate it).

These are the only two ideas kept from the `llm-wiki` sample skill — the full
knowledge-base tooling (ingest, embedding search, lint, external clippers) is
deliberately out of scope.

## Per-Goal index

Each Goal keeps one `index.md` listing every goal-owned artifact — ScoutReport,
Goal Brief, Plan Report, Worker Summary, and any snapshots — each as a relative
`Source Link` with a one-line summary of what it is. The index is updated as
artifacts are created, so an agent (or a person) can find the current set of goal
history from a single place without grepping the tree. Keep entries to one line;
the artifact itself, not the index, holds the detail.

## Append-only, greppable log

Each Goal keeps one `log.md` of chronological goal events, append-only, with a
consistent line prefix so a single grep finds the whole history. A suggested shape:

```
## [YYYY-MM-DD] <event> | <artifact>
```

Using a fixed prefix (`## [`) means `grep "^## \["` returns the full ordered event
list. Append new events; never rewrite past lines — the value is an honest,
ordered record of what happened and which artifact each event produced.

## How they fit the Sources convention

The index and log are the navigation surface; the per-artifact `Sources Section`
is the link graph. Together they let an agent that needs more history follow the
chain — task → node spec → ScoutReport → prior Goal Brief snapshot → prior Plan
Report — and confirm ordering against the log.

## Sources

- [`GLOSSARY.md`](../../GLOSSARY.md) — defines `Sources Section` and `Source Link`,
  the terms these conventions build on.
- [`docs/goal-engine-audit/01-context-flow-and-conventions.md`](../goal-engine-audit/01-context-flow-and-conventions.md)
  — owner of the wiki/source-link conventions; the followable-history and
  link-back-with-trigger rules these conventions support.
- [`docs/goal-engine-audit/02-sample-skills.md`](../goal-engine-audit/02-sample-skills.md)
  — the audit row (`llm-wiki` skill) scoping these to index + log only, with the
  rest of that skill explicitly excluded.
