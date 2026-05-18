# Stage 2A Notes

## HEAD anchor (rollback point)

Start-of-2A HEAD:

```text
2de36795c63f55a9cc7aef97091572ebf041d7ef
```

## Canonical identity

Source: `RELEASE_AUDIT/SUMMARY.md` §6 Answers #1.

```text
Project: SmithersBot
Owner/name: Matthew Overing
Public email: contact@smithersbot.com
X: @moovering
LinkedIn: https://linkedin.com/in/matthewovering
Website: https://smithersbot.com
Support: GitHub Issues only, no SLA
Security contact: contact@smithersbot.com
Community/support: No Discord
```

Canonical one-line identity:

```text
SmithersBot · Matthew Overing · contact@smithersbot.com · X @moovering · https://linkedin.com/in/matthewovering · https://smithersbot.com · GitHub Issues only · No Discord
```

## Working-tree state at W0 start

`git status --porcelain` output:

```text

```

Gate result: clean working tree; no dirty paths outside `RELEASE_AUDIT/`; proceed.

## Remote/branch baseline at W0 start

`git remote -v` output:

```text
openclaw	https://github.com/openclaw/openclaw.git (fetch)
openclaw	https://github.com/openclaw/openclaw.git (push)
origin	https://github.com/smithersbot/smithersbot.git (fetch)
origin	https://github.com/smithersbot/smithersbot.git (push)
personal	https://github.com/moocember/moltbot-private.git (fetch)
personal	DISABLED (push)
upstream	https://github.com/moltbot/moltbot (fetch)
upstream	https://github.com/moltbot/moltbot (push)
```

`git branch -a | wc -l` output:

```text
799
```

## Fork-point SHA for NOTICE.md

Optional merge-base refinement command:

```text
git fetch upstream main 2>/dev/null && git merge-base upstream/main HEAD
```

Result: fetch/merge-base refinement failed on the single allowed attempt; keep the §6 fallback fork-point SHA.

```text
4583f88626f20efedc454d893afaaf898c23523b
```

## macOS-app onboarding deferred to 2B

`docs/start/onboarding.md` is titled "Onboarding (macOS app)" end-to-end, and
`docs/start/setup.md` describes the macOS-app stable/bleeding-edge workflows.
Stage 2A only mechanically replaced legacy `~/.clawdbot` and `~/clawd` path
strings with `~/.smithersbot/...` (v0) placeholders; it did **not** rewrite the
macOS-app onboarding flow bodies (page order, Local-vs-Remote choices,
TCC permissions checklist, Moltbot.app references, etc.). Native-app surface
cleanup — including the full macOS-app onboarding rewrite or removal — is
deferred to Stage 2B alongside the broader `apps/macos` decision.

## W5 — package.json identity outcome

- tsc verification: PASS (`pnpm exec tsc -p tsconfig.json` exit 0, zero output).
- Commit: a57d42ed812ef72901794b254e8429f9bf441244 — `build(pkg): SmithersBot identity in package.json (name, bin, description, author, homepage, repository, bugs, keywords)`.
- Fields written: name=smithersbot; bin={smithersbot:./moltbot.mjs}; description='SmithersBot — a personal Telegram-first AI assistant. Fork of moltbot/moltbot.'; author='Matthew Overing <contact@smithersbot.com>'; homepage=https://smithersbot.com; repository.url=git+https://github.com/smithersbot/smithersbot.git; bugs.url=https://github.com/smithersbot/smithersbot/issues; keywords=[telegram, bot, agent, assistant, cli, ai].
- Fields preserved untouched: version, type, main, exports, files, scripts, license, engines, packageManager, dependencies, optionalDependencies, devDependencies, overrides, pnpm, vitest.
