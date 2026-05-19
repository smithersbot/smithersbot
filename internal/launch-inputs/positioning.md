# SmithersBot Positioning

## Core line

Leave agents running without giving up control.

## What SmithersBot is

SmithersBot is a Telegram-controlled agent harness for people who want Claude Code and Codex to keep working for hours without babysitting every permission prompt or blindly trusting an agent with their machine.

## Who it is for

Technical founders, solo builders, and power users who already use coding agents and want longer-running work without losing control.

## The problem

Long agent runs are useful, but they break down in predictable ways:

- context degrades
- permission prompts force babysitting
- unattended agents feel risky
- plans stall when one task blocks
- agents often claim success without proving it
- long runs become hard to understand afterward

## SmithersBot’s answer

SmithersBot adds an operator loop around agent work:

- repo chat helps the operator think before acting
- `/new_goal` turns a request into a reviewed plan
- Claude Code drafts and Codex reviews when both are available
- the operator can approve, edit, or reject the plan
- each task runs with a fresh worker
- git checkpoints make recovery possible
- build/test checks run outside the worker
- the whole execution trail is saved to disk
- SmithersBot asks the operator only when human judgement is needed

## What should be obvious in 10 seconds

SmithersBot lets agents keep working, but the human stays in control.

## Proof points

Use real product evidence where possible:

- Telegram command/control screenshots
- plan flowchart screenshot
- Plan Detail screenshot
- repo chat screenshot
- goal status/completion screenshot
- external verification/checks
- setup guide
- CI passing

## Important claims to avoid

Do not claim:

- fully autonomous coding
- safe by default
- enterprise-ready
- hosted SaaS
- multi-user team workflow
- no need for review
- no need for isolated environment
- guaranteed success

## Best CTA

Watch the demo.

Secondary CTA:

View on GitHub.
