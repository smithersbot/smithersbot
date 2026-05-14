# W2 — Attribution Debt

Status: Stage 1, read-only. No files outside `RELEASE_AUDIT/` were modified.

This report enumerates everywhere the repo credits people or organisations
and identifies the rewrite/keep/delete/replace work needed before any public
fork release. All counts and line references are produced from allowed
read-only commands (cat / ripgrep / `git log` restricted to specific refs /
`git remote -v` / `git for-each-ref refs/remotes/upstream`).

The repo is a hard fork of the upstream `moltbot/moltbot` project, retains
upstream `Copyright (c) 2025 Peter Steinberger` under MIT, and ships an
attribution surface (README avatar grid, CONTRIBUTING maintainers,
CHANGELOG thanks, FUNDING.yml, SECURITY contact) that still credits the
upstream maintainers and crediting tooling (`scripts/update-clawtributors*`,
`scripts/clawtributors-map.json`). For a public Stage 2 release the project
must (a) preserve MIT's required attribution as a NOTICE/THIRD_PARTY file,
(b) replace project-governance surfaces with the new fork's identity, and
(c) decide whether the upstream contributor avatar grid stays, shrinks, or
moves to `THIRD_PARTY_NOTICES.md`.

## Upstream provenance (lightweight)

Allowed commands used: `git remote -v`, `git for-each-ref refs/remotes/upstream`,
`git log <ref>`. **No** `merge-base`, `rev-list`, `diff`, or `cherry`.

- `upstream` remote is configured: `https://github.com/moltbot/moltbot` (`git remote -v`).
- `upstream/main` tip: `b40da2cb7aa4643c5f3cc36a66b01db9aac6e666` "fix: remove dead restore control-ui step from update runner" (2026-02-05 22:10:55 -0500).
- HEAD tip: `6765a4cd0092e534e806fcd63fdffeed78f1d636` "claw: w1-brand-references ..." (2026-05-14 19:05:53 -0400).
- **Most recent shared commit between `upstream/main` and HEAD** (intersection of `git log <ref> --format=%H` listings): `4583f88626f20efedc454d893afaaf898c23523b` — "fix: preserve reasoning tags inside code blocks (#4118) (thanks @vinaygit18)" (2026-01-29 18:53:05 +0000). This is the most-recent commit on HEAD that also appears on `upstream/main`; everything above it on HEAD is fork-only (mostly `claw: …` autocommits) and everything above it on `upstream/main` is upstream-only.
- This is the fork-point SHA/date to cite in a Stage 2 NOTICE.md ("Forked from moltbot/moltbot at 4583f886 on 2026-01-29.").

Open question for operator: this is computed as the most-recent shared commit observable from `git log` over each ref's history — sufficient for a NOTICE attribution date. If a precise merge-base is needed for legal/license review, please run `git merge-base upstream/main HEAD` manually (out of Stage 1 scope).

## LICENSE (`LICENSE`)

```
1: MIT License
2:
3: Copyright (c) 2025 Peter Steinberger
```

- MIT requires preserving the copyright line and the licence text in any
  redistribution of substantial portions of the software.
- Action: **keep** the existing `Copyright (c) 2025 Peter Steinberger` line verbatim under MIT, and add a new copyright line for the fork's maintainer/org alongside it. Do **not** delete or rewrite the upstream copyright — that would violate MIT § "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software."

## CHANGELOG.md

Counts (ripgrep / grep on `CHANGELOG.md`):

- 22 version headings (`grep -cE '^## [0-9]+\.[0-9]+\.[0-9]+'`).
- 114 `Thanks @…` lines (`grep -c 'Thanks @'`).
- 468 inline `#NNN` PR references (`grep -cE '#[0-9]{2,5}'`); 485 unique IDs (`grep -oE … | sort -u`).
- 107 unique @-handles thanked (`grep -oE 'Thanks @…' | … sort -u`).
- 26 mentions of `steipete|thewilloftheshadow|joshp123` (CHANGELOG only).

What this means for a public fork release:

- Every `#NNNN` reference in `CHANGELOG.md` resolves against `github.com/<active-remote>/<repo>/issues/NNNN`. Once this repo is pushed under a new public owner the numbers no longer point at the upstream PRs that introduced the change.
- The `Thanks @user` lines credit upstream contributors for upstream PRs — these are legitimate historical attributions and should be preserved if the changelog is preserved.
- Sample (CHANGELOG.md:9): `Rebrand: rename the npm package/CLI to moltbot ... Thanks @thewilloftheshadow.` — references upstream PR work.
- Sample (CHANGELOG.md:68): `TTS: Edge fallback (keyless) + /tts auto modes. (#1668, #1667) Thanks @steipete, @sebslight.`

Action options (operator must pick one in Stage 2):

1. **rewrite** — Replace `CHANGELOG.md` with a new fork-zero entry ("v0.0.0 initial public release from upstream fork") and preserve the upstream history in `CHANGELOG_UPSTREAM.md` with an explicit note that PR numbers link to `github.com/moltbot/moltbot`.
2. **keep + annotate** — Keep the file as-is, prepend a top-of-file note: "Sections below dated 2026-01 and earlier refer to the upstream `moltbot/moltbot` project; PR numbers reference upstream issues." This is the minimum-effort attribution-correct option.
3. **delete** — Drop the changelog entirely. Loses attribution history; not recommended for an MIT fork.

## README.md — avatar grid + "by …" line

- Line 462–463: `Moltbot was built for **Molty**, a space lobster AI assistant. 🦞\nby Peter Steinberger and the community.` — explicit upstream "by" line.
- Line 467: `- [steipete.me](https://steipete.me)` — upstream maintainer personal site link.
- Line 475–476: `Special thanks to [Mario Zechner](https://mariozechner.at/) for his support and for [pi-mono](https://github.com/badlogic/pi-mono).` — third-party dependency credit; **keep**.
- Lines 480–~510: ~350 contributor `<a href=".../username"><img src=".../avatars/…">` entries (`grep -oE '<a href="https://github.com/[^"]+"' | wc -l`) across ~37 paragraph rows. Includes upstream maintainers (`steipete`, `thewilloftheshadow`, `joshp123`), helper bots (`google-labs-jules[bot]`, `dependabot[bot]`, `blacksmith-sh[bot]`, `MaudeBot`), and the upstream contributor base.
- Action: **rewrite** the "Molty / by Peter Steinberger" attribution into a NOTICE/credits pointer (e.g. "Forked from moltbot/moltbot. See `THIRD_PARTY_NOTICES.md` for upstream attribution."). The avatar grid is generated by `scripts/update-clawtributors.ts` (see below) — operator must decide whether to **delete** it, **shrink** it to the fork's actual contributors, or **move** it into `THIRD_PARTY_NOTICES.md`.

## CONTRIBUTING.md (named maintainers + social handles)

- Line 6: `**GitHub:** https://github.com/moltbot/moltbot` — upstream repo URL.
- Line 7: `**Discord:** https://discord.gg/qkhbAGHRBT` — upstream community.
- Line 8: `**X/Twitter:** [@steipete](https://x.com/steipete) / [@moltbot](https://x.com/moltbot)` — upstream socials.
- Lines 12–13: `**Peter Steinberger** - Benevolent Dictator … GitHub: [@steipete] · X: [@steipete]`.
- Lines 15–16: `**Shadow** - Discord + Slack subsystem … GitHub: [@thewilloftheshadow] · X: [@4shad0wed]`.
- Lines 18–19: `**Jos** - Telegram, API, Nix mode … GitHub: [@joshp123] · X: [@jjpcodes]`.
- Line 23: `https://github.com/moltbot/moltbot/discussions`.
- Line 47: `Stability: Fixing edge cases in channel connections (WhatsApp/Telegram).` — refers to in-scope and out-of-v0 channels.
- Line 52: `https://github.com/moltbot/moltbot/issues` "good first issue" pointer.

Action: **replace with project-governance text.** This is a fork-owned operational doc; the upstream maintainers should not be named here. Stage 2 should write a new `CONTRIBUTING.md` that documents *this fork's* maintainers, contact channels, and Telegram-only v0 scope, and acknowledges the upstream fork in a single line at the bottom.

## .github/FUNDING.yml

- Line 1: `custom: ['https://github.com/sponsors/steipete']` — directs sponsorship to the upstream maintainer.

Action: **delete** for v0 (or rewrite to point at the fork owner's sponsorship URL). Leaving this file in place would route public sponsorship clicks to the upstream maintainer.

## SECURITY.md

- Line 7: `Email: steipete@gmail.com` — upstream maintainer's personal email is the documented security contact.
- Line 14: `https://docs.molt.bot/gateway/security` — upstream documentation site.
- Line 53: `detect-secrets` baseline reference — keep.

Action: **rewrite** the contact (security disclosures must reach the fork's actual maintainer, not the upstream maintainer). Either replace `steipete@gmail.com` with a fork-owned address or replace the whole reporting block with a GitHub Security Advisories pointer for the new repository.

## scripts/clawtributors-map.json

40 lines. Defines an attribution map that ships in the public artifact and references real people by login/email:

- Lines 2–19: `ensureLogins` — 16 GitHub logins forced into the grid even if not detected from `git log`.
- Line 20: `"seedCommit": "d6863f87"` — references an upstream commit SHA used as a "seed README" by the regenerator (see `update-clawtributors.ts`).
- Lines 25–32: `nameToLogin` — maps real names ("peter steinberger", "eng. juan combetto", "mariano belinky", "vasanth rao naik sabavat") to GitHub logins.
- Lines 33–38: `emailToLogin` — maps 4 real personal email addresses (e.g. `steipete@gmail.com`, `sbarrios93@gmail.com`, `rltorres26+github@gmail.com`, `hixvac@gmail.com`) to GitHub logins.

Action: **delete** for a fork v0. This file's purpose is to maintain the upstream contributor grid; once the README grid is replaced or removed it has no caller. Also embeds personal email addresses — see `secrets-and-pii.md` for the duplicate finding.

## scripts/update-clawtributors.ts (+ `update-clawtributors.types.ts`)

- 473 + 32 lines (`wc -l`).
- Line 6: `const REPO = "moltbot/moltbot";` — hardcoded upstream slug; would query upstream's API even after a fork rename.
- Line 21: `const raw = run(\`gh api "repos/${REPO}/contributors?per_page=100&anon=1" --paginate\`);` — calls `gh api`, requires GitHub auth and a `gh` install, and targets upstream.
- Reads `scripts/clawtributors-map.json` (line 10) and rewrites `README.md` avatar grid (line 17, plus regen logic referenced from CLAUDE.md and `CONTRIBUTING.md`-style guidance).

Action: **delete** the script + map + types together unless the operator wants to keep an "avatar grid" for the fork. If kept, **rewrite** the `REPO` constant, the seed commit, and the personal-email map. Either way this script must not be shipped pointing at upstream from the public fork.

## Search for remaining personal handles

`grep -lE 'steipete|thewilloftheshadow|joshp123'` over the repo (head 65 results) flags many additional surfaces. Per-file counts of those three tokens:

| File | Count |
|------|-------|
| README.md | 4 |
| CHANGELOG.md | 26 |
| CONTRIBUTING.md | 4 |
| SECURITY.md | 1 |
| .github/FUNDING.yml | 1 |

Plus matches in: `scripts/clawtributors-map.json`, `docs/start/lore.md`, `docs/start/showcase.md`, `docs/index.md`, `docs/channels/discord.md`, `docs/platforms/mac/icon.md`, `docs/platforms/mac/logging.md`, `docs/platforms/gcp.md`, `docs/platforms/hetzner.md`, `docs/gateway/configuration.md`, `docs/gateway/configuration-examples.md`, ~26 `skills/*/SKILL.md` files, `apps/macos/Sources/Moltbot/*.swift`, `apps/macos/Package.swift`, `apps/shared/MoltbotKit/Package.swift`, `Swabble/Package.swift`, `Swabble/README.md`, `Swabble/docs/spec.md`, `appcast.xml`, `src/discord/monitor.test.ts`, `src/agents/pi-tools.read.ts`, `src/agents/tools/image-tool.test.ts`, `src/auto-reply/reply.triggers.trigger-handling.ignores-inline-elevated-directive-unapproved-sender.e2e.test.ts`, `src/commands/doctor.*.test.ts`, `src/commands/gateway-status.test.ts`, `src/commands/health-format.test.ts`, `src/config/config.discord.test.ts`, `src/daemon/constants.ts`, `src/infra/ssh-config.test.ts`.

Many of these (skills, apps/macos, Swabble, docs/platforms) are already marked **out of v0** by W3 (`keep-vs-cut.md`); cutting those surfaces removes most personal-handle references in one step. The remaining authoritative attribution surfaces (LICENSE, README, CONTRIBUTING, FUNDING, SECURITY, CHANGELOG, scripts/clawtributors-*) are the small set to address explicitly in Stage 2.

## Per-file action table

| Path | Action | Notes |
|------|--------|-------|
| `LICENSE` | **keep** + add fork copyright | MIT requires preserving the existing `Copyright (c) 2025 Peter Steinberger`; append a new copyright line for the fork. |
| `CHANGELOG.md` | **rewrite** (prepend annotation; or replace with fork-zero entry + `CHANGELOG_UPSTREAM.md`) | 468 PR refs and 114 `Thanks @user` lines. PR numbers resolve against the new remote and will mislead readers; operator decides between annotated keep, full rewrite, or delete. |
| `README.md` (lines 462–463: "by Peter Steinberger") | **rewrite** | Replace with attribution that points at NOTICE / `THIRD_PARTY_NOTICES.md`. |
| `README.md` (line 467: `steipete.me`) | **delete** | Personal-site link from upstream maintainer; not appropriate for the fork's README. |
| `README.md` (lines 480–~510: avatar grid) | **delete or rewrite** | Generated by `scripts/update-clawtributors.ts`; ~350 entries crediting upstream contributors. For v0 either remove or relocate into `THIRD_PARTY_NOTICES.md`. |
| `README.md` (line 475–476: Mario Zechner / pi-mono) | **keep** | Third-party dependency credit unrelated to upstream maintainers. |
| `CONTRIBUTING.md` | **replace-with-project-governance** | Maintainer list, Discord invite, X/Twitter handles, GitHub URLs all point upstream. Rewrite with fork-owned governance. |
| `.github/FUNDING.yml` | **delete** (or rewrite to fork owner) | Routes sponsorship to upstream maintainer. |
| `SECURITY.md` | **rewrite** | Replace `steipete@gmail.com` and `docs.molt.bot` references with fork-owned contact and docs (or use GitHub Security Advisories). |
| `scripts/clawtributors-map.json` | **delete** | Hardcoded upstream contributor map + personal emails. Stage 2 should drop or move under a fork-owned name. |
| `scripts/update-clawtributors.ts` | **delete** | Hardcoded `REPO = "moltbot/moltbot"` and `gh api` dependency. No use case after the avatar grid is removed. |
| `scripts/update-clawtributors.types.ts` | **delete** | Companion types file; same fate as the script. |

## NOTICE.md proposal (descriptive — do NOT write the file in Stage 1)

For Stage 2 the fork should add a top-level `NOTICE.md` (or `THIRD_PARTY_NOTICES.md`) that:

1. Names the upstream project, license, copyright holder, and fork date:

   > This project is a fork of `moltbot/moltbot` (https://github.com/moltbot/moltbot), MIT-licensed, Copyright (c) 2025 Peter Steinberger. Forked at commit `4583f886` on 2026-01-29.

2. Includes the verbatim upstream MIT licence body (kept in `LICENSE` already; NOTICE.md can reference rather than duplicate).
3. Optionally moves the README avatar grid here under a "Upstream contributors" heading, so the fork's README is no longer a personal-attribution surface but credit is preserved.
4. Credits any other third-party code/assets bundled in the fork (e.g. `pi-mono` by Mario Zechner, plus any vendored packages — out of scope for this audit).

Operator decision points for Stage 2:

- Keep or drop the upstream contributor avatar grid (NOTICE.md vs delete)?
- Maintain a fork-side `CHANGELOG.md` from v0 forward, or keep upstream's history annotated?
- Sponsorship policy for `.github/FUNDING.yml` — delete or repoint?

## Inventory fragment

JSONL findings produced for this worker live at:

- `RELEASE_AUDIT/inventory-W2.jsonl`
- `RELEASE_AUDIT/_fragments/w2-attribution.jsonl` (mirror)

```jsonl
{"path":"LICENSE","category":"attribution","finding":"MIT copyright line credits upstream maintainer; must be preserved verbatim and supplemented with fork's copyright","severity":"info","action":"keep","v0_scope":"in","notes":"LICENSE:3 — Copyright (c) 2025 Peter Steinberger. MIT requires preservation."}
{"path":"CHANGELOG.md","category":"attribution","finding":"468 PR refs (#NNN) and 114 'Thanks @user' lines reference upstream moltbot/moltbot; numbers will misresolve after public push","severity":"risk","action":"rewrite","v0_scope":"in","notes":"Counts via grep; sample CHANGELOG.md:9, :68."}
{"path":"README.md","category":"attribution","finding":"'by Peter Steinberger and the community' attribution line credits upstream maintainer","severity":"risk","action":"rewrite","v0_scope":"in","notes":"README.md:462-463."}
{"path":"README.md","category":"attribution","finding":"Personal-site link [steipete.me] in product 'Molty' section","severity":"risk","action":"rewrite","v0_scope":"in","notes":"README.md:467."}
{"path":"README.md","category":"attribution","finding":"~350 contributor avatar entries crediting upstream contributors; generated by scripts/update-clawtributors.ts","severity":"risk","action":"rewrite","v0_scope":"in","notes":"README.md:480-510; grep -oE '<a href=\"https://github.com/[^\"]+\"' counts 350. Move to THIRD_PARTY_NOTICES.md or delete."}
{"path":"README.md","category":"attribution","finding":"Mario Zechner / pi-mono dependency credit","severity":"info","action":"keep","v0_scope":"in","notes":"README.md:475-476. Third-party-dep credit, not upstream-maintainer attribution."}
{"path":"CONTRIBUTING.md","category":"attribution","finding":"Named maintainers, Discord invite, X/Twitter handles, and GitHub URLs all credit/point to upstream","severity":"blocker","action":"rewrite","v0_scope":"in","notes":"CONTRIBUTING.md:6-19,23,52 — replace with project-governance text owned by the fork."}
{"path":".github/FUNDING.yml","category":"attribution","finding":"Sponsorship link routes to https://github.com/sponsors/steipete (upstream maintainer)","severity":"blocker","action":"rewrite","v0_scope":"in","notes":".github/FUNDING.yml:1 — cut (delete the file) or rewrite to fork owner."}
{"path":"SECURITY.md","category":"attribution","finding":"Security contact is steipete@gmail.com (upstream maintainer's personal email)","severity":"blocker","action":"rewrite","v0_scope":"in","notes":"SECURITY.md:7. Public security disclosures should reach the fork's maintainer."}
{"path":"SECURITY.md","category":"attribution","finding":"References upstream docs at https://docs.molt.bot/gateway/security","severity":"risk","action":"rewrite","v0_scope":"in","notes":"SECURITY.md:14 — repoint to fork docs or remove."}
{"path":"scripts/clawtributors-map.json","category":"attribution","finding":"Hardcoded upstream contributor map with personal emails (steipete@gmail.com, sbarrios93@gmail.com, rltorres26+github@gmail.com, hixvac@gmail.com)","severity":"blocker","action":"cut","v0_scope":"out","notes":"scripts/clawtributors-map.json:33-38 — also flagged by W4 PII sweep. Action=cut (delete the file)."}
{"path":"scripts/update-clawtributors.ts","category":"attribution","finding":"Hardcoded REPO='moltbot/moltbot' and gh-api call generates README avatar grid against upstream","severity":"blocker","action":"cut","v0_scope":"out","notes":"scripts/update-clawtributors.ts:6,21 — no caller after avatar grid is rewritten. Action=cut (delete the file)."}
{"path":"scripts/update-clawtributors.types.ts","category":"attribution","finding":"Companion types file for the upstream avatar-grid generator","severity":"risk","action":"cut","v0_scope":"out","notes":"32 LOC; cut alongside update-clawtributors.ts."}
{"path":"NOTICE.md","category":"attribution","finding":"Missing top-level NOTICE / THIRD_PARTY_NOTICES file required to carry upstream MIT attribution after fork-side rewrites","severity":"blocker","action":"fix","v0_scope":"in","notes":"Stage 2: add NOTICE.md citing upstream moltbot/moltbot at fork-point 4583f886 (2026-01-29), under MIT, Copyright (c) 2025 Peter Steinberger; optionally include upstream contributor list."}
```
