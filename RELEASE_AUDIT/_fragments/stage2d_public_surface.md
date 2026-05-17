# Stage 2D — Public-Surface Sweep

Sweep target: stale public-facing identity strings, unsupported channel
claims, old paths, and old env prefixes in the documents a stranger to the
project sees first on GitHub.

Trigger strings:
`Moltbot`, `Clawdbot`/`clawdbot`/`clawd`, `docs.molt.bot`,
`molt.bot/install`, `discord.gg`, `clawdhub`, `DeepWiki`, `Star History`,
`EXFOLIATE`; unsupported-channel claims (WhatsApp, Slack, Discord, Signal,
BlueBubbles, Matrix, Zalo, iOS node, Android node, macOS app); old paths
`~/.clawdbot` and `~/clawd`; old env prefixes `CLAWDBOT_*` / `MOLTBOT_*` in
public docs and config examples.

Classification key:
- **Allowed** — internal compat in code, OpenClaw, or
  Moltbot/`moltbot/moltbot` text confined to NOTICE.md / CHANGELOG.md /
  LICENSE attribution/provenance.
- **Public-facing must-fix** — README.md, CONTRIBUTING.md, SECURITY.md,
  NOTICE.md non-attribution body, .github/ISSUE_TEMPLATE/*, top-level docs a
  stranger reads, doc nav.
- **Out of scope (this stage)** — RELEASE_AUDIT/*, nested
  extension/plugin/hook READMEs, docs/** subtree, internal contributor /
  agent guidance files (AGENTS.md / CLAUDE.md / claude.md). Tracked as
  remaining TODOs.

## Classification table

| File | Line | Match | Classification | Action |
|---|---:|---|---|---|
| README.md | — | no hits | Allowed (clean) | none |
| CONTRIBUTING.md | 12 | "There is no Discord, chat room, or private support channel." | Allowed | none — explicit negation, not advertising |
| CONTRIBUTING.md | 42 | "fork of `moltbot/moltbot`" | Allowed | none — upstream attribution pointing at NOTICE.md |
| SECURITY.md | — | no hits | Allowed (clean) | none |
| NOTICE.md | 4 | "upstream project was still named Moltbot" | Allowed | none — historical attribution body |
| NOTICE.md | 9-10 | "Historical upstream at fork point: `moltbot/moltbot`" | Allowed | none — attribution |
| NOTICE.md | 27 | "`moltbot/moltbot`; it has since been renamed to OpenClaw" | Allowed | none — attribution |
| CHANGELOG.md | 6 | "upstream project was still named Moltbot" | Allowed | none — attribution |
| LICENSE | — | no hits | Allowed (clean) | none |
| .github/ISSUE_TEMPLATE/bug_report.md | — | no hits | Allowed (clean) | none |
| .github/ISSUE_TEMPLATE/feature_request.md | — | no hits | Allowed (clean) | none |
| .github/ISSUE_TEMPLATE/config.yml | — | no hits | Allowed (clean) | none |
| docs.acp.md | 1-3 | "Moltbot ACP Bridge" / "Moltbot ACP" | Public-facing must-fix | Renamed to "SmithersBot ACP Bridge" / "SmithersBot ACP" |
| docs.acp.md | 8-10 | "`moltbot acp` …" / "Moltbot Gateway" | Public-facing must-fix | Rebranded to `smithersbot acp` and "SmithersBot Gateway" |
| docs.acp.md | 23-29 | "Moltbot Gateway", `moltbot acp`, `moltbot config set …` | Public-facing must-fix | Rebranded to `smithersbot …` |
| docs.acp.md | 41 | `moltbot acp --url …` | Public-facing must-fix | Rebranded to `smithersbot acp …` |
| docs.acp.md | 51-53 | `moltbot acp --session …` examples | Public-facing must-fix | Rebranded to `smithersbot …` |
| docs.acp.md | 65-95 | Zed `agent_servers` block, `"Moltbot ACP"`, `"command": "moltbot"` | Public-facing must-fix | Rebranded to `"SmithersBot ACP"` / `"command": "smithersbot"` |
| docs.acp.md | 97 | "select \"Moltbot ACP\"" | Public-facing must-fix | Rebranded to "SmithersBot ACP" |
| docs.acp.md | 101 | "ACP client spawns `moltbot acp`" | Public-facing must-fix | Rebranded to `smithersbot acp` |
| docs.acp.md | 117-121 | CLI examples `moltbot acp --session*` | Public-facing must-fix | Rebranded to `smithersbot acp …` |
| docs.acp.md | 167 | "`moltbot acp` resolves the Gateway URL" | Public-facing must-fix | Rebranded to `smithersbot acp` |

## Out-of-scope hits (tracked as remaining TODOs)

These were flagged by the trigger-string greps but lie outside the Stage 2D
public-surface sweep brief. They should be addressed in a follow-on stage.

- **`docs/` subtree (224 files with `Moltbot`/`Clawdbot`/`clawdbot`)** —
  Mintlify nav (`docs/docs.json`), landing page (`docs/index.md`,
  references `whatsapp-clawd.jpg`, mentions WhatsApp/Telegram/Discord/iMessage
  gateway and the upstream Clawd assistant), and the rest of the `docs/`
  tree still present upstream identity, upstream GitHub repo URLs, the
  `docs.molt.bot` host, the upstream channel matrix, and upstream feature
  positioning. Recommend a dedicated Stage 2E "docs tree rewrite-or-cut"
  scope: either rewrite to SmithersBot Telegram-only v0 or remove the whole
  `docs/` tree from the public surface (it is not deployed at SmithersBot
  today). Note: `docs/whatsapp-clawd.jpg` and `docs/index.md` reference the
  upstream Clawd assistant brand.
- **`AGENTS.md` / `CLAUDE.md` (symlink) / `claude.md`** — internal agent /
  contributor instructions at the repo root. Heavy use of `moltbot` CLI
  script aliases, `~/.moltbot/goals/<run_id>/`,
  `systemctl --user restart moltbot-gateway-dev.service`, `pnpm moltbot …`,
  `npm run moltbot --`, `docs.molt.bot` URL guidance, and direct
  references to upstream maintainer ("When Peter asks for links…"). These
  are internal contributor/agent contract docs, but they are visible at the
  GitHub root. Recommend Stage 2E to either (a) move under `.agent/` or
  similar and gitignore from public surface, or (b) rewrite for SmithersBot.
- **`extensions/*/README.md` (Clawdbot plugin READMEs)** — nested plugin
  READMEs (e.g. `extensions/voice-call/README.md`,
  `extensions/zalouser/README.md`, `extensions/zalo/README.md`,
  `extensions/tlon/README.md`, `extensions/nostr/README.md`,
  `extensions/qwen-portal-auth/README.md`,
  `extensions/copilot-proxy/README.md`,
  `extensions/google-gemini-cli-auth/README.md`,
  `extensions/google-antigravity-auth/README.md`) still describe
  themselves as Clawdbot plugins, advertise unsupported channels, and link
  to `docs.molt.bot`. Recommend Stage 2E or a per-extension cleanup pass.
- **`src/hooks/bundled/**/README.md`** — bundled hook docs reference
  `clawdbot hooks …` CLI, `~/.clawdbot/hooks/`, `~/.clawdbot/logs/`,
  `docs.molt.bot/hooks/*`. Internal-ish docs but visible on GitHub.
- **`assets/chrome-extension/README.md`** — refers to "Clawdbot Chrome
  Extension" and `clawdbot browser extension …` CLI.
- **`scripts/**`, `Dockerfile*`, `docker-compose.yml`, `render.yaml`,
  `fly.toml`, `appcast.xml`, `pnpm-workspace.yaml`** — may still contain
  Moltbot/Clawdbot strings, internal env-var defaults, and Mac-app
  artifacts. Per Stage 2D constraints these are internal compat names in
  code/config and are left in place; covered by the deleted-path sweep
  fragment.
- **Files outside the in-scope file set above** — every other hit lives in
  source code, tests, internal tooling, RELEASE_AUDIT/, or build artifacts
  and is out-of-scope here per the task brief.

## Edits applied in this stage

- `docs.acp.md` — rebranded "Moltbot ACP" → "SmithersBot ACP" throughout,
  "Moltbot Gateway" → "SmithersBot Gateway", every `moltbot acp …` CLI
  invocation and Zed `"command": "moltbot"` value to `smithersbot`. The
  `package.json` bin alias is `smithersbot`, so the previous `moltbot acp`
  command examples did not match the published CLI surface and would have
  misled new users.

## Re-run grep verification

After edits, the trigger-string regex
(`Moltbot|Clawdbot|clawdbot|clawd|docs\.molt\.bot|molt\.bot/install|discord\.gg|clawdhub|DeepWiki|Star History|EXFOLIATE|WhatsApp|Slack|Discord|Signal|BlueBubbles|Matrix|Zalo|CLAWDBOT_|MOLTBOT_`)
was re-run against the must-fix file set. Remaining matches:

- `CONTRIBUTING.md:12` — explicit negation "no Discord, chat room…" → Allowed.
- `NOTICE.md:4,9-10,27` — historical upstream attribution → Allowed.
- `CHANGELOG.md:6` — fork-start attribution → Allowed.

Zero remaining **Public-facing must-fix** hits across the in-scope files.

The `~/.clawdbot` / `~/clawd` path grep and the
"iOS node|Android node|macOS app|node:ios|node:android" claim grep both
returned zero hits across the must-fix file set.

## Build / type-check sanity

`pnpm exec tsc -p tsconfig.json` — to be run by the verification gate node
of Stage 2D. The edits in this fragment touch only Markdown content
(`docs.acp.md`); no TypeScript surface area was changed.
