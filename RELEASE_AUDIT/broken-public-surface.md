# Broken Public Surface Audit

## Section 1: package.json metadata audit

Evidence source: `package.json`.

| Field | Evidence | Finding | Recommended action |
| --- | --- | --- | --- |
| `name` | `package.json:2` = `moltbot` | Current package name matches the v0 public project identity. | Keep |
| `description` | `package.json:4` = `WhatsApp gateway CLI (Baileys web) with Pi RPC agent` | Stale and out of v0: public v0 is Telegram-only, while the npm description leads with WhatsApp/Baileys and Pi RPC. | Rewrite |
| `version` | `package.json:3` = `2026.1.29` | Present. No read-only evidence here that it is stale. | Keep |
| `keywords` | `package.json:150` = `[]` | Empty keywords reduce package discoverability and do not communicate Telegram-only v0 positioning. | Rewrite |
| `author` | `package.json:151` = `""` | Empty author/governance metadata is incomplete for a public package. | Rewrite |
| `repository` | No `repository` key found by `rg -n 'repository' package.json`. | Missing repository metadata for npm/GitHub users. | Add |
| `homepage` | No `homepage` key found by `rg -n 'homepage' package.json`. | Missing homepage metadata. | Add or intentionally omit after public surface decision |
| `bugs` | No `bugs` key found by `rg -n 'bugs' package.json`. | Missing issue tracker metadata. | Add |
| `license` | `package.json:152` = `MIT` | Present. | Keep |
| `engines` | `package.json:153-154` requires Node `>=22.12.0`. | Present and consistent with repo guidance that Node 22+ is baseline. | Keep |
| `bin` | `package.json:13-16` exposes `moltbot` and legacy `clawdbot`. | Public install still exposes old-product `clawdbot` binary. | Rewrite or cut legacy alias before public v0 |
| `files` | `package.json:17-79` includes `dist/discord/**`, `dist/imessage/**`, `dist/signal/**`, `dist/slack/**`, `dist/line/**`, `dist/web/**`, `dist/whatsapp/**`, `extensions/**`, `skills/**`, `patches/**`, and `git-hooks/**`. | Package allowlist includes many non-v0 channels and development/plugin surfaces; public v0 ships Telegram only. | Cut from public pack or split into internal/dev package |
| `files` | `package.json:63` includes `README-header.png`. | Present as packaged asset. No issue found in this slice. | Keep |

## Section 2: README.md badges and shields

Evidence sources: `README.md`; workflow check command output: `find .github/workflows -maxdepth 2 -type f` returned `find: '.github/workflows': No such file or directory`.

| README line | Badge/shield URL | Claims | Underlying file/workflow exists? | Recommended action |
| --- | --- | --- | --- | --- |
| `README.md:12` | `https://img.shields.io/github/actions/workflow/status/moltbot/moltbot/ci.yml?branch=main&style=for-the-badge` | CI status for `moltbot/moltbot` workflow `ci.yml` on `main`. | No. `.github/workflows` directory is absent, so `.github/workflows/ci.yml` is not present. | Remove badge or add the workflow in Stage 2 |
| `README.md:13` | `https://img.shields.io/github/v/release/moltbot/moltbot?include_prereleases&style=for-the-badge` | Latest GitHub release for `moltbot/moltbot`. | Not a workflow-backed badge; no local file needed. | Keep if releases are public; otherwise investigate before launch |
| `README.md:14` | `https://img.shields.io/badge/DeepWiki-moltbot-111111?style=for-the-badge` | DeepWiki page for `moltbot`. | Not a workflow-backed badge; no local file needed. | Investigate whether DeepWiki should be part of public v0 surface |
| `README.md:15` | `https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge` | Discord community/server. | Not a workflow-backed badge; no local file needed. | Investigate for Telegram-only v0; likely remove or replace with v0 support channel |
| `README.md:16` | `https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge` | MIT license. | `LICENSE` is referenced by the surrounding link at `README.md:16`; license file existence is handled in attribution audit. | Keep |

