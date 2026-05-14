# W1 Brand & Naming References

Scope: static `rg`/`find` audit only. Exclusions used for the scan: `node_modules`, `dist`, `.git`, `.tmp*`, `.moltbot-goal-worker-results`, `vendor`, and `RELEASE_AUDIT`.

## Token Frequency By Top-Level Directory

Counts are `rg -o` match counts by token and top-level path. `ROOT` is the whole repo scan and is included for a total, not as an additional directory.

| Top-level path | moltbot | Moltbot | clawdbot | Clawdbot | openclaw | OpenClaw | smithersbot | Smithersbot | SmithersBot | clawd | molt.bot |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ROOT | 6030 | 6441 | 1149 | 72 | 257 | 141 | 3 | 0 | 7 | 2040 | 499 |
| .github | 0 | 2 | 0 | 5 | 0 | 0 | 0 | 0 | 0 | 2 | 0 |
| apps | 373 | 1349 | 63 | 3 | 0 | 0 | 0 | 0 | 0 | 120 | 1 |
| assets | 0 | 13 | 2 | 3 | 0 | 0 | 0 | 0 | 0 | 2 | 2 |
| docs | 2649 | 1035 | 405 | 2 | 0 | 0 | 0 | 0 | 7 | 701 | 58 |
| extensions | 209 | 628 | 297 | 24 | 0 | 0 | 0 | 0 | 0 | 304 | 10 |
| openclaw-starter-kit | 3 | 2 | 3 | 2 | 257 | 141 | 0 | 0 | 0 | 3 | 0 |
| packages | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| scripts | 202 | 103 | 30 | 0 | 0 | 0 | 0 | 0 | 0 | 40 | 6 |
| skills | 80 | 23 | 21 | 0 | 0 | 0 | 0 | 0 | 0 | 47 | 0 |
| src | 2232 | 3158 | 299 | 34 | 0 | 0 | 3 | 0 | 0 | 762 | 115 |
| Swabble | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 14 | 0 |
| test | 12 | 8 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 5 | 0 |
| ui | 37 | 73 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 5 |

Material pattern: `Moltbot` and `moltbot` dominate the current product surface, but legacy `clawdbot`/`clawd` is still broad in code, docs, scripts, extensions, app internals, and generated-facing documentation. `openclaw` is concentrated in `openclaw-starter-kit/`, and `SmithersBot` is concentrated in one customer guide plus Telegram goal test fixtures.

## Files Where Two Or More Brand Tokens Coexist

Full scan returned hundreds of coexistence files. The material examples below are representative and actionable:

| Path | Tokens | Evidence | Recommendation |
|---|---|---|---|
| `README.md` | `moltbot`, `Moltbot`, `clawdbot`, `Clawdbot`, `clawd`, `molt.bot` | Hero image alt says `Clawdbot` at `README.md:4`; legacy shim note at `README.md:53`; old workspace/config paths at `README.md:298`, `README.md:304`; contributor grid includes `Clawdbot Maintainers` at `README.md:506`. | Rewrite public README for v0. Keep `moltbot`/`Moltbot`; move compatibility references to migration/compat docs if retained. |
| `package.json` | `moltbot`, `Moltbot`, `clawdbot`, `clawd` | Package name is `moltbot` at `package.json:2`; bin exposes both `moltbot` and `clawdbot` at `package.json:13-15`. | Keep `moltbot`; investigate whether `clawdbot` bin should remain in public v0 or be removed from pack after migration policy is decided. |
| `src/config/paths.ts` | `moltbot`, `Moltbot`, `clawdbot` | Legacy state/config names are explicit at `src/config/paths.ts:19-22`; comments keep `CLAWDBOT_*` env support at `src/config/paths.ts:42-44`, `src/config/paths.ts:74-75`, `src/config/paths.ts:190`. | Keep only if compatibility is a v0 requirement; otherwise rewrite defaults/docs and remove legacy env exposure in Stage 2. |
| `src/compat/legacy-names.ts` | `Moltbot`, `clawdbot` | Declares `LEGACY_PROJECT_NAME = "clawdbot"` at `src/compat/legacy-names.ts:1` and legacy macOS source dir at `src/compat/legacy-names.ts:9`. | Keep as internal migration compatibility unless public pack removes legacy support. |
| `src/daemon/constants.ts` | `moltbot`, `Moltbot`, `clawdbot` | New service names at `src/daemon/constants.ts:3-10`; legacy launchd labels at `src/daemon/constants.ts:14-15`; generated legacy profile labels at `src/daemon/constants.ts:44`. | Keep legacy labels as migration cleanup logic; hide from public docs. |
| `docs/start/lore.md` | `Moltbot`, `Clawd`, `Clawdbot`, `clawd` | Rebrand story at `docs/start/lore.md:16-20`; old handle incident text at `docs/start/lore.md:91-97`; personal workspace note at `docs/start/lore.md:55`. | Cut from public v0 docs or move to private/internal lore. |
| `docs/customer-guide.md` | `SmithersBot`, `clawdbot` | SmithersBot guide title/content at `docs/customer-guide.md:2`, `docs/customer-guide.md:7`, `docs/customer-guide.md:104`, `docs/customer-guide.md:134`; `.clawdbot-dev` at `docs/customer-guide.md:127`. | Cut from public v0 pack; it is customer-specific and not Telegram-only generic docs. |
| `extensions/voice-call/README.md` | `clawdbot`, `Clawdbot`, `molt.bot` | Header and install instructions use `@clawdbot/voice-call` and `clawdbot` at `extensions/voice-call/README.md:1`, `extensions/voice-call/README.md:16-19`, `extensions/voice-call/README.md:103-109`. | Cut from v0; if extension remains in repo, rewrite before public extension release. |
| `extensions/zalo/README.md` | `clawdbot`, `Clawdbot` | Header and install examples use `@clawdbot/zalo` and `clawdbot` at `extensions/zalo/README.md:1`, `extensions/zalo/README.md:3`, `extensions/zalo/README.md:8`, `extensions/zalo/README.md:14`. | Cut from v0; rewrite before public extension release. |
| `apps/android/README.md` | `Clawdbot`, `clawdbot` | Android internal README title and commands at `apps/android/README.md:1`, `apps/android/README.md:3`, `apps/android/README.md:28`, `apps/android/README.md:37-38`. | Cut from v0 with Android app; rewrite if apps are later public. |
| `openclaw-starter-kit/docs/MIGRATION.md` | `OpenClaw`, `Clawdbot`, `Moltbot` | Migration doc positions both Clawdbot and Moltbot as sources for OpenClaw at `openclaw-starter-kit/docs/MIGRATION.md:20-22`, `openclaw-starter-kit/docs/MIGRATION.md:46-71`. | Cut from v0 pack unless OpenClaw starter kit is intentionally shipped. |
| `src/telegram/goal-commands.test.ts` | `smithersbot`, `moltbot` | Test fixture project names include `smithersbot-marketing-*` at `src/telegram/goal-commands.test.ts:2874`, `src/telegram/goal-commands.test.ts:2882`, `src/telegram/goal-commands.test.ts:2890`. | Rewrite fixture names to generic examples for public release. |

## Bin And CLI Naming Exposure

| Surface | Evidence | Recommendation |
|---|---|---|
| npm package identity | `package.json:2` names the package `moltbot`; `package.json:11` exports `./cli-entry` to `./moltbot.mjs`. | Keep. This matches the current product name. |
| CLI bins | `package.json:13-15` exposes `moltbot` and `clawdbot` to the same entrypoint. | Investigate. Public v0 can keep this only as an explicitly documented compatibility shim; otherwise remove `clawdbot` from the public package. |
| README CLI examples | Public quick-start uses `moltbot` at `README.md:46-49`, but mentions `clawdbot` compatibility at `README.md:53` and old paths at `README.md:298`, `README.md:304`, `README.md:326`. | Rewrite public README around Telegram-only v0 and current state paths. |
| CLI help | `src/cli/program/help.ts:11` still leads with WhatsApp login, while Telegram appears at `src/cli/program/help.ts:25`; dev profile copy references `~/.clawdbot-dev` and `CLAWDBOT_*` at `src/cli/program/help.ts:37-41`. | Rewrite help for Telegram-only v0; keep legacy env copy only if compatibility is public. |
| Setup command copy | `src/cli/program/register.setup.ts:13` says setup initializes `~/.clawdbot/moltbot.json`; `src/cli/program/register.setup.ts:21` defaults workspace to `~/clawd`. | Rewrite if public v0 uses `.moltbot`/non-`clawd` defaults; otherwise document as legacy compatibility. |
| Shell scripts | Script coexistence includes `scripts/restart-mac.sh`, `scripts/auth-monitor.sh`, `scripts/claude-auth-status.sh`, Docker install test scripts, and Termux helpers from the coexistence scan. | Cut or keep internal. Most are ops/dev surfaces, not Telegram-only v0 public UX. |
| systemd units | Current restart service is `scripts/systemd/moltbot-gateway-restart.service:2`; auth monitor files still use `clawdbot-auth-monitor.*` filenames with Moltbot descriptions at `scripts/systemd/clawdbot-auth-monitor.service:2`, `scripts/systemd/clawdbot-auth-monitor.timer:2`. | Rewrite unit filenames/names before public Linux service documentation. |
| launchd labels | macOS app current labels are `bot.molt.mac` and `bot.molt.gateway` at `apps/macos/Sources/Moltbot/Constants.swift:3-4`; legacy launchd labels are retained at `apps/macos/Sources/Moltbot/LaunchAgentManager.swift:4-6`; daemon constants also retain legacy gateway labels at `src/daemon/constants.ts:14-15`. | Since macOS is out of v0, cut app from public v0. If kept later, preserve legacy cleanup labels internally but do not market them. |
| Bundle/app names | macOS Info.plist uses Moltbot at `apps/macos/Sources/Moltbot/Resources/Info.plist:8`, `apps/macos/Sources/Moltbot/Resources/Info.plist:14`, `apps/macos/Sources/Moltbot/Resources/Info.plist:22`. iOS Info.plist uses Moltbot at `apps/ios/Sources/Info.plist:8`. | Cut apps from v0 per scope; current user-visible names are mostly current-brand. |

## Per-Surface Recommendations

| Surface | Recommendation | Evidence |
|---|---|---|
| Core product name in package/CLI/docs | Keep | `package.json:2`, `README.md:1`, `README.md:19`. |
| `clawdbot` CLI bin shim | Investigate | `package.json:13-15`; README calls it legacy at `README.md:53`. Decide whether public v0 supports migration from upstream/private installs. |
| Legacy config/state/env names | Investigate | `src/config/paths.ts:19-22`, `src/config/paths.ts:42-44`, `src/config/paths.ts:74-75`, `src/config/paths.ts:190`; public docs expose `~/.clawdbot` at `README.md:304`, `README.md:326`. |
| Public README | Rewrite | README advertises out-of-v0 channels at `README.md:120`, `README.md:142`, apps at `README.md:125`, `README.md:146-148`, and old Clawdbot/Clawd surfaces at `README.md:4`, `README.md:53`, `README.md:298`, `README.md:304`, `README.md:506`. |
| Public docs under `docs/` | Rewrite or cut by v0 scope | Broad old-brand and out-of-v0 mentions are visible in docs counts; specific examples include lore at `docs/start/lore.md:16-20`, customer-specific SmithersBot doc at `docs/customer-guide.md:7`, and old channel/docs surfaces in README links. |
| Extension READMEs and channel plugins | Cut from v0 | Voice-call and Zalo README examples still use `@clawdbot/*`/`clawdbot` at `extensions/voice-call/README.md:1-19` and `extensions/zalo/README.md:1-14`; non-Telegram extensions are out of v0. |
| Mobile/mac apps | Cut from v0 | Android README is still old-branded at `apps/android/README.md:1-3`; app directories are out of v0. |
| systemd/install scripts | Rewrite or internal-only | Auth monitor service/timer filenames retain `clawdbot` while descriptions say Moltbot at `scripts/systemd/clawdbot-auth-monitor.service:2`, `scripts/systemd/clawdbot-auth-monitor.timer:2`. |
| `openclaw-starter-kit/` | Cut | OpenClaw migration and docs are a separate product surface at `openclaw-starter-kit/docs/MIGRATION.md:20-22`, `openclaw-starter-kit/docs/MIGRATION.md:46-71`. |
| SmithersBot references | Cut or rewrite | Customer guide is SmithersBot-specific at `docs/customer-guide.md:7`; Telegram tests use `smithersbot-marketing-*` fixture names at `src/telegram/goal-commands.test.ts:2874-2890`. |

## Inventory JSONL

```jsonl
{"path":"README.md","category":"brand","finding":"Public README mixes current Moltbot identity with Clawdbot/Clawd legacy names and out-of-v0 positioning.","severity":"blocker","action":"rewrite","v0_scope":"in","notes":"Evidence: README.md:4, README.md:53, README.md:120, README.md:142, README.md:298, README.md:304, README.md:506."}
{"path":"package.json","category":"brand","finding":"Public package exposes a clawdbot bin alongside moltbot.","severity":"risk","action":"investigate","v0_scope":"in","notes":"Evidence: package.json:13-15. Keep only if public v0 intentionally supports the legacy CLI shim."}
{"path":"src/config/paths.ts","category":"brand","finding":"Legacy .clawdbot state/config paths and CLAWDBOT_* env names remain in core config resolution.","severity":"risk","action":"investigate","v0_scope":"in","notes":"Evidence: src/config/paths.ts:19-22, src/config/paths.ts:42-44, src/config/paths.ts:74-75, src/config/paths.ts:190."}
{"path":"src/cli/program/help.ts","category":"brand","finding":"CLI help still centers WhatsApp and legacy CLAWDBOT state naming instead of Telegram-only v0 copy.","severity":"risk","action":"rewrite","v0_scope":"in","notes":"Evidence: src/cli/program/help.ts:11, src/cli/program/help.ts:25, src/cli/program/help.ts:37-41."}
{"path":"src/cli/program/register.setup.ts","category":"brand","finding":"Setup command help exposes ~/.clawdbot and ~/clawd defaults.","severity":"risk","action":"rewrite","v0_scope":"in","notes":"Evidence: src/cli/program/register.setup.ts:13, src/cli/program/register.setup.ts:21."}
{"path":"docs/start/lore.md","category":"brand","finding":"Lore doc includes old Clawdbot/Clawd rebrand story, personal details, and non-generic tone for public v0.","severity":"risk","action":"cut","v0_scope":"out","notes":"Evidence: docs/start/lore.md:16-20, docs/start/lore.md:55, docs/start/lore.md:81-97."}
{"path":"docs/customer-guide.md","category":"brand","finding":"Customer-specific SmithersBot guide is not generic public Moltbot documentation.","severity":"blocker","action":"cut","v0_scope":"out","notes":"Evidence: docs/customer-guide.md:2, docs/customer-guide.md:7, docs/customer-guide.md:104, docs/customer-guide.md:127, docs/customer-guide.md:134."}
{"path":"extensions/voice-call/README.md","category":"brand","finding":"Voice-call extension README uses @clawdbot package names and clawdbot commands.","severity":"risk","action":"cut","v0_scope":"out","notes":"Evidence: extensions/voice-call/README.md:1, extensions/voice-call/README.md:3, extensions/voice-call/README.md:16-19, extensions/voice-call/README.md:103-109."}
{"path":"extensions/zalo/README.md","category":"brand","finding":"Zalo extension README uses @clawdbot package names and clawdbot install commands.","severity":"risk","action":"cut","v0_scope":"out","notes":"Evidence: extensions/zalo/README.md:1, extensions/zalo/README.md:3, extensions/zalo/README.md:8, extensions/zalo/README.md:14."}
{"path":"apps/android/README.md","category":"brand","finding":"Android README is old-branded as Clawdbot Node and uses clawdbot commands.","severity":"risk","action":"cut","v0_scope":"out","notes":"Evidence: apps/android/README.md:1, apps/android/README.md:3, apps/android/README.md:28, apps/android/README.md:37-38."}
{"path":"scripts/systemd/clawdbot-auth-monitor.service","category":"brand","finding":"systemd auth monitor unit filename remains clawdbot-branded while description says Moltbot.","severity":"nit","action":"rewrite","v0_scope":"internal","notes":"Evidence: scripts/systemd/clawdbot-auth-monitor.service:2."}
{"path":"scripts/systemd/clawdbot-auth-monitor.timer","category":"brand","finding":"systemd auth monitor timer filename remains clawdbot-branded while description says Moltbot.","severity":"nit","action":"rewrite","v0_scope":"internal","notes":"Evidence: scripts/systemd/clawdbot-auth-monitor.timer:2."}
{"path":"apps/macos/Sources/Moltbot/LaunchAgentManager.swift","category":"brand","finding":"macOS launch agent manager retains legacy Clawdbot launchd labels.","severity":"info","action":"keep","v0_scope":"out","notes":"Evidence: apps/macos/Sources/Moltbot/LaunchAgentManager.swift:4-6. Apps are out of v0; labels may be needed for cleanup compatibility later."}
{"path":"src/daemon/constants.ts","category":"brand","finding":"Daemon constants retain legacy Clawdbot launchd labels for gateway cleanup/migration.","severity":"info","action":"keep","v0_scope":"internal","notes":"Evidence: src/daemon/constants.ts:14-15, src/daemon/constants.ts:44."}
{"path":"openclaw-starter-kit/docs/MIGRATION.md","category":"brand","finding":"OpenClaw starter kit presents a separate product migration path from Clawdbot/Moltbot to OpenClaw.","severity":"risk","action":"cut","v0_scope":"out","notes":"Evidence: openclaw-starter-kit/docs/MIGRATION.md:20-22, openclaw-starter-kit/docs/MIGRATION.md:46-71."}
{"path":"src/telegram/goal-commands.test.ts","category":"brand","finding":"Telegram test fixtures use SmithersBot marketing project names.","severity":"nit","action":"rewrite","v0_scope":"in","notes":"Evidence: src/telegram/goal-commands.test.ts:2874, src/telegram/goal-commands.test.ts:2882, src/telegram/goal-commands.test.ts:2890."}
{"path":".github/ISSUE_TEMPLATE/config.yml","category":"brand","finding":"Issue-template config still exposes Clawdbot/clawd naming in public GitHub surface.","severity":"risk","action":"rewrite","v0_scope":"in","notes":"Evidence from coexistence scan: .github/ISSUE_TEMPLATE/config.yml contains Clawdbot and clawd tokens."}
{"path":"assets/chrome-extension/README.md","category":"brand","finding":"Chrome extension README still uses Clawdbot/clawd naming.","severity":"risk","action":"cut","v0_scope":"out","notes":"Evidence from coexistence scan: assets/chrome-extension/README.md contains clawdbot, Clawdbot, and clawd tokens; browser extension is out of Telegram-only v0."}
```
