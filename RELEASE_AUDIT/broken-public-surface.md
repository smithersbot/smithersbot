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

## Section 3: Issue/PR templates

Evidence sources: `find .github -maxdepth 3 -type f` listed `.github/dependabot.yml`, `.github/ISSUE_TEMPLATE/config.yml`, `.github/ISSUE_TEMPLATE/feature_request.md`, `.github/ISSUE_TEMPLATE/bug_report.md`, `.github/actionlint.yaml`, `.github/FUNDING.yml`, `.github/labeler.yml`. A second pass for `pull_request_template*` / `*pull*` / `*PR*` under `.github/` returned no matches.

| Path | Finding | Recommended action |
| --- | --- | --- |
| `.github/ISSUE_TEMPLATE/config.yml:3-8` | Both contact links point to `https://discord.gg/clawd` and reference "Clawdbot" and "Krill in #help" — old-product brand + non-v0 (Discord) support surface for a Telegram-only public v0. | Rewrite to project-governance contact (Telegram support channel or GitHub Discussions); drop old-product/Krill references |
| `.github/ISSUE_TEMPLATE/feature_request.md:3` (`about: Suggest an idea or improvement for Clawdbot.`) | Template still names the old product. | Rewrite to "Moltbot" |
| `.github/ISSUE_TEMPLATE/feature_request.md:12` (`What would you like Clawdbot to do?`) | Old-product brand in template body. | Rewrite to "Moltbot" |
| `.github/ISSUE_TEMPLATE/bug_report.md:3` (`about: Report a problem or unexpected behavior in Clawdbot.`) | Template still names the old product. | Rewrite to "Moltbot" |
| `.github/ISSUE_TEMPLATE/bug_report.md:23` (`- Clawdbot version:`) | Bug environment field hardcodes the old-product name. | Rewrite to "Moltbot version:" |
| `.github/PULL_REQUEST_TEMPLATE.md` | Missing — no PR template found under `.github/` (no `pull_request_template*` matches). | Investigate: add a project-governance PR template (test plan + changelog reminder) or document the intentional absence |
| `.github/dependabot.yml:53-97` | Dependabot updates configured for non-v0 surfaces: `/apps/macos`, `/apps/shared/MoltbotKit`, `/Swabble`, `/apps/android`. | Cut from v0 dependabot config or move to internal-only branch (per W3 keep-vs-cut, apps/* and Swabble are out of v0) |

## Section 4: Docker defaults

Evidence sources: `docker-compose.yml`, `Dockerfile`, `Dockerfile.sandbox`, `Dockerfile.sandbox-browser`, `docker-setup.sh`, `scripts/e2e/Dockerfile`.

| Surface | Evidence | Finding | Recommended action |
| --- | --- | --- | --- |
| docker-compose.yml service names | `docker-compose.yml:2` (`moltbot-gateway`), `:30` (`moltbot-cli`) | Service names use current brand `moltbot-*`. | Keep |
| docker-compose.yml image default | `docker-compose.yml:3` and `:31` use `${CLAWDBOT_IMAGE:-moltbot:local}` | Image tag default is current-brand but the env-var prefix is `CLAWDBOT_*` (old-product). | Rewrite env-var prefix to `MOLTBOT_*` (or document alias) |
| docker-compose.yml env-var prefix | `docker-compose.yml:7,12,13,15,16,25,27` (`CLAWDBOT_GATEWAY_TOKEN`, `CLAWDBOT_CONFIG_DIR`, `CLAWDBOT_WORKSPACE_DIR`, `CLAWDBOT_GATEWAY_PORT`, `CLAWDBOT_BRIDGE_PORT`, `CLAWDBOT_GATEWAY_BIND`) | All operator-facing env vars carry the old-product `CLAWDBOT_*` prefix; same prefix is repeated across `docker-setup.sh:7-46,155-166` and Dockerfile build arg `CLAWDBOT_DOCKER_APT_PACKAGES` (`Dockerfile:11-17,170`). | Rewrite to `MOLTBOT_*` prefix; provide compatibility alias only if needed |
| docker-compose.yml bind addresses | `docker-compose.yml:25` sets gateway bind default to `lan` via `${CLAWDBOT_GATEWAY_BIND:-lan}` | `lan` bind exposes the gateway on the host's LAN interface by default (not loopback). For a public v0 default, this is an insecure default that contradicts README "Default behavior" / pairing guidance. | Investigate: switch compose default to `loopback` and require explicit opt-in for `lan`; or keep `lan` and document the trust model |
| docker-compose.yml exposed ports | `docker-compose.yml:14-16` publishes `${CLAWDBOT_GATEWAY_PORT:-18789}` and `${CLAWDBOT_BRIDGE_PORT:-18790}` to the host | Two host ports are published by default; the bridge port (18790) is published unconditionally even when not in use. | Investigate: scope port publishing to required v0 ports only; document the bridge port purpose |
| docker-compose.yml mount targets | `docker-compose.yml:12-13` mounts `${CLAWDBOT_CONFIG_DIR}:/home/node/.clawdbot` and `${CLAWDBOT_WORKSPACE_DIR}:/home/node/clawd` | Container paths are `/home/node/.clawdbot` and `/home/node/clawd` (old-product). | Rewrite to `/home/node/.moltbot` and `/home/node/moltbot` (or document keep) |
| docker-compose.yml claude env vars | `docker-compose.yml:8-10,36-38` (`CLAUDE_AI_SESSION_KEY`, `CLAUDE_WEB_SESSION_KEY`, `CLAUDE_WEB_COOKIE`) | Compose service ingests claude.ai session cookies/keys directly into the container via env. This is an upstream-relevant credential surface; flag for review before public v0. | Investigate: confirm whether these legacy claude-web env vars are still required for v0 and document; otherwise drop |
| Dockerfile root user during build | `Dockerfile:1-31` runs as root for `apt-get`/`pnpm install`/`pnpm build`; `:38` switches to `USER node` only for runtime CMD. | Build-time root is standard; runtime non-root `USER node` is good. No insecure default. | Keep |
| Dockerfile.sandbox-browser exposed ports | `Dockerfile.sandbox-browser:26` `EXPOSE 9222 5900 6080` | Sandbox-browser image exposes Chromium CDP (9222), VNC (5900), and noVNC (6080). Per `docs/install/docker.md:251-253`, the default sandbox `network` is `none`, so ports are not published by default; still worth flagging as a sandbox-only image, not a v0 surface. | Investigate: confirm sandbox image is excluded from v0 pack (per W6 §1, `dist/` is in `files`; Dockerfile.sandbox-browser is not packed via npm) |
| docker-setup.sh CLI banner | `docker-setup.sh:191-194` prints onboarding hints for "WhatsApp (QR)", "Telegram (bot token)", "Discord (bot token)", and links to `https://docs.molt.bot/providers` | Banner advertises non-v0 channels (WhatsApp, Discord) and references an external docs URL. v0 is Telegram-only. | Rewrite to Telegram-only banner; verify `docs.molt.bot/providers` URL classification (see §6) |
| docker-setup.sh gateway bind default | `docker-setup.sh:31` defaults `CLAWDBOT_GATEWAY_BIND` to `lan` | Same `lan` default as docker-compose; reinforces the insecure-default concern. | Same as compose-file row above |
| docker-setup.sh .env write | `docker-setup.sh:120,156-166` writes operator config (incl. `CLAWDBOT_GATEWAY_TOKEN`) to `$ROOT_DIR/.env` | Setup writes a `.env` file containing a freshly generated gateway token. Repo `.env*` is hard-denied (W4); make sure `.env` is gitignored before public release. | Fix: confirm `.env` is in `.gitignore` and add explicit setup banner warning |
| scripts/e2e/Dockerfile branding | `scripts/e2e/Dockerfile:14` copies `extensions/memory-core` | E2E image hard-codes a single extension path; fine if memory-core is in v0, otherwise update when scope changes. | Investigate against W3 keep-vs-cut classification of extensions/memory-core |

## Section 5: Install/onboarding surfaces

Evidence sources: `README.md` quick-start blocks, `docs/install/index.md`, `docs/install/installer.md`, `docs/install/docker.md`, `docs/start/getting-started.md`, `docs/start/setup.md`, `docs/start/onboarding.md`.

External services / URLs assumed by install + onboarding (string-only inventory; URL classification details land in §6):

| Source | External service or URL referenced | Notes |
| --- | --- | --- |
| `README.md:24` | `https://molt.bot`, `https://docs.molt.bot`, `https://docs.molt.bot/start/getting-started`, `https://docs.molt.bot/install/updating`, `https://docs.molt.bot/start/showcase`, `https://docs.molt.bot/start/faq`, `https://docs.molt.bot/start/wizard`, `https://github.com/moltbot/nix-clawdbot`, `https://docs.molt.bot/install/docker`, `https://discord.gg/clawd` | Top-of-README link bar mixes current-project (`molt.bot`, `github.com/moltbot/*`) with old-product (`discord.gg/clawd`, `nix-clawdbot`). |
| `README.md:31-32` | `https://www.anthropic.com/`, `https://openai.com/` | Onboarding assumes external OAuth subscriptions (Anthropic Pro/Max, OpenAI/Codex). |
| `README.md:46-49` | `npm install -g moltbot@latest`, `pnpm add -g moltbot@latest`, `moltbot onboard --install-daemon` | Quick start assumes the npm registry hosts `moltbot@latest`; this is the public release target. |
| `README.md:89` | `https://github.com/moltbot/moltbot.git` | From-source clone target. Current-project. |
| `README.md:130` | `https://api.star-history.com/svg?repos=moltbot/moltbot&...` | External Star History badge service. |
| `README.md:4` | `https://raw.githubusercontent.com/moltbot/moltbot/main/docs/whatsapp-clawd.jpg` | Hero image hosted from `moltbot/moltbot`; filename and `alt="Clawdbot"` still carry old-product brand. |
| `docs/install/index.md:15,20,43,49,57,126,129` | `https://molt.bot/install.sh`, `https://molt.bot/install.ps1` | Curl/iwr install bootstrap assumes `molt.bot` hosts `install.sh`/`install.ps1`. CLAUDE.md notes these scripts live in sibling repo `../molt.bot`; downtime/404 blocks new installs. |
| `docs/install/installer.md:11-15` | `https://molt.bot/install.sh`, `https://molt.bot/install-cli.sh`, `https://molt.bot/install.ps1` | Three installer endpoints assumed live on `molt.bot`. |
| `docs/install/installer.md:31-44` | `https://bun.sh/install`, npm registry, NodeSource, Homebrew | Installer assumes external package-manager registries. |
| `docs/install/docker.md:35-67,193` | Docker Hub / Docker registry implied via `docker build`/`docker compose`; `docs.molt.bot/providers` | Docker quick-start assumes Docker daemon; provider docs URL. |
| `docs/install/docker.md:189` | `https://docs.molt.bot/providers` | Linked provider docs. |
| `docs/install/index.md:91,135` | `https://github.com/moltbot/moltbot.git` | From-source path. |
| `docs/start/getting-started.md:48` | `https://api.search.brave.com/` (implied) — Brave Search API key, configured via `moltbot configure --section web` | Recommends external Brave Search API key for web tools. |
| `docs/start/getting-started.md:50` | `https://semgrep.dev` | Recommends external Semgrep install for SAST. |
| `docs/start/getting-started.md:58,66,72,76` | `https://molt.bot/install.sh`, `https://molt.bot/install.ps1`, `npm install -g moltbot@latest`, `pnpm add -g moltbot@latest` | Same install bootstrap dependencies as README. |
| `docs/start/getting-started.md:88-92` | OAuth flows for OpenAI Codex and Anthropic API keys; mention of `claude setup-token` | Assumes external OAuth + Anthropic Console access. |
| `docs/start/getting-started.md:170` | `https://github.com/moltbot/moltbot.git` | From-source clone. |
| `docs/start/setup.md:13-15` | Implies `~/.clawdbot/moltbot.json` config path and `~/clawd` workspace path | Onboarding config paths still rooted at `.clawdbot` / `clawd` (old-product). Not an external service but a public-surface inconsistency. |
| `docs/start/onboarding.md:45,87-89,100-101` | `~/.clawdbot/credentials/oauth.json`, `moltbot webhooks gmail setup`, Gmail Pub/Sub setup | macOS app onboarding assumes Anthropic OAuth and (optionally) Gmail Pub/Sub — both non-v0 for a Telegram-only public v0. |
| `docs/start/onboarding.md:6-7,40-45` | "macOS app" — non-v0 surface | macOS-app first-run onboarding doc is the primary onboarding narrative; v0 is CLI/Telegram-only per scope assumption. |

Cross-cutting findings:

- README quick-start (`README.md:62-71`) advertises sending to `+1234567890` and mentions WhatsApp/Telegram/Slack/Discord/Google Chat/Signal/iMessage/BlueBubbles/Microsoft Teams/Matrix/Zalo/Zalo Personal/WebChat as deliverable channels. v0 is Telegram-only; the README quick-start materially overstates v0 capability.
- README highlights (`README.md:120,142`) enumerate every channel as a current feature; same issue.
- The whole install bootstrap chain (`molt.bot/install.sh` → `npm install -g moltbot@latest` → `moltbot onboard --install-daemon`) depends on three external services being live: `molt.bot` host, npmjs registry, and (for OAuth) Anthropic/OpenAI. Document the dependency chain or pin a fallback path.

