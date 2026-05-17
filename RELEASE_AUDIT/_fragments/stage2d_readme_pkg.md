# Stage 2D — README & package.json coherence audit

**Task:** `readme-pkg-coherence`
**HEAD at task start:** `0103df510234aecd2d9ee1f05966fc266ecc22dc`
**Result:** **No change.** Every checked surface already passes Stage 2D coherence requirements.

## Files reviewed

- `README.md` (entire file, 360 lines)
- `CONTRIBUTING.md`
- `SECURITY.md`
- `NOTICE.md`
- `.github/ISSUE_TEMPLATE/bug_report.md`
- `.github/ISSUE_TEMPLATE/feature_request.md`
- `.github/ISSUE_TEMPLATE/config.yml`
- `package.json` (GitHub-visible metadata only)

## README.md verification

| Check | Result | Evidence |
| --- | --- | --- |
| SmithersBot-first identity | Pass | Title line 1 (`# SmithersBot`); product name used consistently throughout. |
| Telegram-only v0 voice | Pass | Grep for `WhatsApp|Discord|Slack|Signal|BlueBubbles|Matrix|Zalo|iOS|Android|macOS app|Mac app`: 0 matches. Telegram is the only operator surface advertised. |
| No stale upstream product names in body | Pass | Grep for `moltbot|clawdbot|molt.bot|discord.gg|clawdhub|DeepWiki|Star History|EXFOLIATE`: only hit is line 355 (Attribution section) referencing `moltbot/moltbot` for fork history — allowed by Stage 2D policy. |
| Local image refs resolve | Pass | Only image referenced in README body is `./smithersbot-flowchart.png` (line 69); file exists at repo root (PNG, valid). `README-header.png` is not referenced in README (only listed in `package.json` "files" allowlist); not a dead README ref. |
| Mermaid source syntactically valid | Pass | Rendered with `node_modules/.bin/mmdc 11.12.0`: produced 35 KB SVG with no syntax-error nodes (`error-icon` / `error-text` matches in output are the default CSS classes from the Mermaid stylesheet, not error-banner elements). The `T .->|"no"| J` form on line 117 is a valid Mermaid dotted-arrow alternative and is accepted by the renderer. |
| No broken links to deleted-app/native/channel/plugin paths | Pass | Grep across `apps/(ios|android|macos|shared)`, `extensions/(diagnostics-otel|llm-task|lobster|memory-lancedb|open-prose|twitch|whatsapp|discord|slack|signal|imessage|line)`, `packages/(clawdbot|moltbot)`, `src/(web|whatsapp|discord|slack|signal|imessage|line|channels/web)`, `src/provider-web`, `src/channel-web`, `Swabble`, `smithersbot_marketing`: 0 matches in README. Only outbound link in README body is `https://platform.claude.com/docs/en/build-with-claude/compaction` (line 13). |
| Obvious public-polish gaps limited to top README/demo placeholder | Pass | The only intentional placeholder is the **Demo** section (line 44: "Demo coming soon."). No other "TODO" / "FIXME" / placeholder markers in README. |

## Supporting docs verification

| File | SmithersBot identity | Notes |
| --- | --- | --- |
| `CONTRIBUTING.md` | Pass | Line 1 title, line 9 maintainer email, line 12 explicitly negates Discord. Only stale string is `moltbot/moltbot` on line 42 — allowed attribution. |
| `SECURITY.md` | Pass | All SmithersBot identity strings (lines 1, 3, 7, 18, 24, 37, 46, 47). No stale upstream names. |
| `NOTICE.md` | Pass | Body intentionally references `Moltbot` and `moltbot/moltbot` for attribution and fork history — allowed by Stage 2D policy. Maintainer email correct (line 35). |
| `.github/ISSUE_TEMPLATE/bug_report.md` | Pass | Front matter and body reference SmithersBot. |
| `.github/ISSUE_TEMPLATE/feature_request.md` | Pass | Front matter and body reference SmithersBot. |
| `.github/ISSUE_TEMPLATE/config.yml` | Pass | Support URL `https://github.com/smithersbot/smithersbot/issues`. |

## package.json GitHub-visible metadata

| Field | Expected | Actual | Status |
| --- | --- | --- | --- |
| `name` | `smithersbot` | `smithersbot` | Pass |
| `description` | SmithersBot-first | `SmithersBot — a Telegram-controlled multi-agent goal execution harness. Personal fork of OpenClaw.` | Pass |
| `author` | `Matthew Overing <contact@smithersbot.com>` | `Matthew Overing <contact@smithersbot.com>` | Pass |
| `repository.url` | `git+https://github.com/smithersbot/smithersbot.git` | `git+https://github.com/smithersbot/smithersbot.git` | Pass |
| `bugs.url` | `https://github.com/smithersbot/smithersbot/issues` | `https://github.com/smithersbot/smithersbot/issues` | Pass |
| `homepage` | `https://smithersbot.com` | `https://smithersbot.com` | Pass |
| `keywords` | non-empty, generic | `["telegram", "bot", "agent", "assistant", "cli", "ai"]` | Pass |
| `bin.smithersbot` | `./moltbot.mjs` | `./moltbot.mjs` (rename out of scope per task constraints) | Pass |

Untouched (per task constraints): `dependencies`, `devDependencies`, `optionalDependencies`, `scripts`, `files`, `exports`, `main`, `version`, `engines`, `packageManager`, `pnpm`, `vitest`, `overrides`. The deleted-path-sweep node already cleaned the deleted `dist/*` entries from `files`; nothing further to fix here.

## Edits applied

None. All surfaces already coherent.

## Verification

- `pnpm exec tsc -p tsconfig.json` → exit 0 (no source edits made).
- Mermaid render via `node_modules/.bin/mmdc -i /tmp/.../before.mmd -o /tmp/.../before.svg` → SVG generated without syntax-error banner.

## Notes for STAGE2D_REPORT synthesis

- README and supporting docs require no Stage 2D edits — Stage 2A and the public-surface-sweep task closed everything in scope.
- Out-of-scope public-polish gaps confirmed by the public-surface-sweep node (docs/ subtree, AGENTS.md/CLAUDE.md, extensions/*/README.md, src/hooks/bundled/**/README.md, assets/chrome-extension/README.md) remain documented in `stage2d_public_surface.md` and are *not* surfaced by the README itself.
- The README "Demo" section (line 42-46) is the documented placeholder for the upcoming demo asset and is the only intentional pre-launch polish gap visible from the top of README.
