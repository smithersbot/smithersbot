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
