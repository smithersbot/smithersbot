# Stage 2D — Secret + PII Sweep

**HEAD at task start:** `ef5d55373493a442056e311c43baa2cd80958182`

**Scope:** read-only repo-wide secret and PII audit using local tools only
(Grep / Glob / Read / `git check-ignore`). No external scanners. No values are
printed below — only `file:line:type:severity`.

## .env gitignore confirmation

| File | `git check-ignore` exit | Status |
|---|---|---|
| `.env` | 0 | ignored (not in working tree, ignored by `.gitignore` line 3) |
| `.env.example` | 1 | tracked template (expected; placeholder content only) |

No other tracked `.env*` files were found.

```
git ls-files | grep -E '(^|/)\.env($|\.)'
-> .env.example
```

## Severity summary

| Severity | Hit count |
|---|---|
| critical | 0 |
| high | 0 |
| medium | 13 |
| low | ~30 |

No real production credentials, private keys, JWTs, AWS access keys, Google
API keys, Anthropic OAT/API keys, Slack tokens, GitHub PATs, or database
credentials were found. All `sk-…`, `sk-ant-…`, `Bearer …`,
`AKIA…`, `AIza…`, `eyJ…`, `xoxb-…` / `xoxp-…`, `ghp_…`, `github_pat_…`,
`postgres://`/`mysql://`/`mongodb://`/`redis://` matches are obvious
placeholder/test fixtures (`-ACCESS-TOKEN-`, `-REFRESH-TOKEN-`, `1234567890`,
`user:pass@db.local`, `should-be-stripped`, `gateway-test-key`,
`test-elevenlabs-key`, `shared-gateway-token-1234567890`, etc.).

No critical findings ⇒ `stage2d_secrets_pii_critical.md` is **not** created.

## Findings

### MEDIUM — accidentally-committed personal artifacts under `/home/matt/...`

These directories appear in `git ls-files` and are **not** in `.gitignore`.
They were never intended to be public. Contents include `/home/matt/moltbot`
absolute paths and dev-state planning artifacts.

| File | Line(s) | Type | Severity |
|---|---|---|---|
| `.clawdbot-dev/goals/942c5427-58b0-4f4b-9f37-4507e8c5d29c/scout/execution_plan.json` | tracked-file | accidental-commit / personal-path | medium |
| `.clawdbot-dev/goals/942c5427-58b0-4f4b-9f37-4507e8c5d29c/scout/plan_draft.md` | tracked-file | accidental-commit / personal-path | medium |
| `.clawdbot-dev/goals/942c5427-58b0-4f4b-9f37-4507e8c5d29c/scout/scout_report.json` | tracked-file | accidental-commit / personal-path | medium |
| `.clawdbot-dev/goals/942c5427-58b0-4f4b-9f37-4507e8c5d29c/scout/node_specs/add-goal-status-view-model.md` | tracked-file | accidental-commit / personal-path | medium |
| `.clawdbot-dev/goals/942c5427-58b0-4f4b-9f37-4507e8c5d29c/scout/node_specs/implement-compact-goal-status-output.md` | tracked-file | accidental-commit / personal-path | medium |
| `.clawdbot-dev/goals/942c5427-58b0-4f4b-9f37-4507e8c5d29c/scout/node_specs/shorten-goal-completion-summaries.md` | tracked-file | accidental-commit / personal-path | medium |
| `.clawdbot-dev/goals/942c5427-58b0-4f4b-9f37-4507e8c5d29c/scout/node_specs/update-telegram-goal-status-messages.md` | tracked-file | accidental-commit / personal-path | medium |
| `~/.npm/_logs/2026-03-01T02_00_28_279Z-debug-0.log` | tracked-file | accidental-commit / personal-path | medium |

These should be `git rm`'d and added to `.gitignore` (`/.clawdbot-dev/` and
`/~/`) during the final git-hygiene pass — out of scope for this read-only
sweep.

### MEDIUM — real private Tailscale hostname in code/skills

Real-looking private Tailscale machine name visible in repo (not a generic
placeholder). Previously documented in `RELEASE_AUDIT/secrets-and-pii.md` for
two other test files; the entries below are still present after 2B/2C and
still reference the same hostname.

| File | Line(s) | Type | Severity |
|---|---|---|---|
| `skills/canvas/SKILL.md` | 133 | private-hostname (.ts.net Tailscale) | medium |
| `src/infra/bonjour-discovery.test.ts` | 233, 262 | private-hostname (.ts.net Tailscale) | medium |
| `src/infra/widearea-dns.test.ts` | 36, 41 | private-hostname (.ts.net Tailscale) | medium |

### LOW — real first-name `/Users/<name>` paths in tests and docs

| File | Line(s) | Type | Severity |
|---|---|---|---|
| `src/agents/tools/image-tool.test.ts` | 205 | personal-path (`/Users/<firstname>`) | low |
| `src/agents/pi-embedded-runner/run/images.test.ts` | 109, 113, 118, 128, 129 | personal-path (`/Users/<firstname>`) | low |
| `docs/broadcast-groups.md` | 182, 190 | personal-path (`/Users/<firstname>`) | low |

### LOW — upstream attribution / personal handles in public-facing files

Allowed by Stage 2A policy for historical attribution, recorded here for
visibility.

| File | Line(s) | Type | Severity |
|---|---|---|---|
| `docs/index.md` | 225 | upstream-handle (creator credit) | low |
| `docs/index.md` | 231 | upstream-handle (GitHub noreply email) | low |
| `appcast.xml` | multiple | upstream-handle (Mac-app changelog `Thanks @…`) | low |
| `docs/platforms/mac/logging.md` | 23 | upstream-handle (personal blog link) | low |
| `docs/tools/browser-login.md` | 37 | upstream-handle (third-party repo) | low |
| `docs/platforms/gcp.md` | 313, 317, 321 | upstream-owned (third-party releases) | low |
| `docs/platforms/hetzner.md` | 225, 229, 233 | upstream-owned (third-party releases) | low |

### LOW — third-party tooling skills (`steipete/…` brew taps and Go modules)

These are public skill manifests pointing at public upstream tools. Not
secrets; included for completeness only.

| File | Line(s) | Type | Severity |
|---|---|---|---|
| `skills/wacli/SKILL.md` | 5 | upstream-owned (brew tap / go module) | low |
| `skills/apple-reminders/SKILL.md` | 4 | upstream-owned (homepage) | low |
| `skills/blucli/SKILL.md` | 5 | upstream-owned (go module) | low |
| `skills/eightctl/SKILL.md` | 5 | upstream-owned (go module) | low |
| `skills/gifgrep/SKILL.md` | 5 | upstream-owned (brew tap / go module) | low |
| `skills/oracle/SKILL.md` | 5, 31 | upstream-owned (npm package) | low |
| `skills/songsee/SKILL.md` | 4 | upstream-owned (homepage) | low |
| `skills/food-order/SKILL.md` | 5 | upstream-owned (go module) | low |
| `skills/bird/SKILL.md` | 5, 16 | upstream-owned (brew tap / npm package) | low |

### LOW — illustrative `op://` vault paths in 1Password skill

Already documented in `RELEASE_AUDIT/secrets-and-pii.md`. These are
example/illustrative paths under `op://app-prod/...`, not real vault paths.

| File | Line(s) | Type | Severity |
|---|---|---|---|
| `skills/1password/references/cli-examples.md` | 10, 11, 12, 13, 17, 23 | illustrative-vault-path | low |

### LOW — public-facing legacy contact / phone / non-product-domain

| File | Line(s) | Type | Severity |
|---|---|---|---|
| `docs/gateway/security/index.md` | 752 | legacy-domain (`security@clawd.bot`) | low |
| `.env.example` | 5 | real-looking US phone (`+17343367101` — non-555 area code) | low |

## Not findings (verified placeholder / test-fixture only)

These regex hits were inspected and confirmed to be obvious placeholders or
test fixtures — listed here so future audits know they were considered.

- `sk-ant-oat01-ACCESS-TOKEN-1234567890`, `sk-ant-ort01-REFRESH-TOKEN-…`,
  `sk-ant-api-0123456789abcdefghijklmnopqrstuvwxyz` (test fixtures)
- `sk-abcdefghijklmnopqrstuvwxyz123456` (test fixture)
- `sk-openai-0123456789abcdefghijklmnopqrstuvwxyz` (test fixture)
- `sk-openrouter-test`, `sk-synthetic-test` (test fixtures)
- `GOCSPX-FakeSecretValue123` (test fixture, explicit `FAKE_*` name)
- `Bearer abcdef1234567890ghij` (redact-tests fixture)
- `shared-gateway-token-1234567890`, `test-gateway-token-1234567890`,
  `env-token-1234567890`, `gateway-test-key`, `synthetic-test-key`,
  `keychain-refresh`, `gh-profile-token`, `anthropic-test-key`,
  `gateway-password`, `slack-signing-secret`, `test-elevenlabs-key`,
  `local-token-abc123`, `remote-token-xyz789`, `fallback-local-token`,
  `default-local-token`, `should-be-stripped` (all test fixtures)
- `BRAVE_API_KEY_HERE`, `FIRECRAWL_API_KEY_HERE`, `YOUR_GEMINI_API_KEY`,
  `YOUR_OPENAI_COMPAT_API_KEY`, `YOUR_REMOTE_API_KEY`, `YOUR_TELEGRAM_BOT_TOKEN`,
  `YOUR_DISCORD_BOT_TOKEN`, `CLAWDBOT_HOOK_TOKEN`, `your-long-random-token`,
  `your-secret-8-plus-chars`, `your-signing-secret`, `example-password`,
  `elevenlabs_api_key`, `shared-push-token`, `vapi_xxxxxxxxxxxx`,
  `ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`, `your_auth_token_here`,
  `BEGIN PRIVATE KEY` in `src/logging/redact.test.ts`,
  `src/gateway/client.test.ts`, `.detect-secrets.cfg`, `.secrets.baseline`,
  `.pre-commit-config.yaml` (all redaction/baseline/test fixtures)
- `postgres://user:pass@db.local:5432/app` (test fixture)
- `+1555…` phone numbers (E.164 555-prefixed fictional placeholders)
- `*@g.us`, `*@s.whatsapp.net`, `*@thread.tacv`, `*@group.imessage`
  (WhatsApp / Teams / iMessage identifier formats — not personal emails)
- `*@example.com`, `*@example.[a-z]+`, `*@gmail.com`, `*@icloud.com`,
  `noreply@…`, `attacker@evil.com`, `*@walletofsatoshi.com`, `*@getalby.com`,
  `*@gserviceaccount.com` (placeholders or third-party service identifiers)
- `/Users/test`, `/Users/me`, `/Users/example`, `/Users/user`, `/Users/service`,
  `/Users/config`, `/Users/testuser`, `/Users/you` (generic placeholders)
- `*.tailnet-1234.ts.net`, `your-tailnet`, `your-vps.tailnet-xxxx.ts.net`,
  `mac-mini.tailnet-1234.ts.net`, `gateway.tailnet:18789` (placeholder
  hostnames; `moltbot.internal.` is a documented service-discovery name, not
  a private hostname)
- `.secrets.baseline` `hashed_secret` entries (these are hashes by design,
  not secrets; the file is the detect-secrets baseline)

## Commands run

```
git rev-parse HEAD
git check-ignore .env
git check-ignore .env.example
git check-ignore .clawdbot-dev .clawdbot-dev/goals
git ls-files | grep -E '(^|/)\.env($|\.)'
git ls-files | grep -Ei '\.(pem|key|p12|pfx|cer|crt|jks|pkcs12|asc)$'
git ls-files '.clawdbot-dev/' '~/'

# Key-shape regexes (Grep)
(sk-[a-zA-Z0-9]{20,}|sk_live_[a-zA-Z0-9]{20,}|xoxb-[a-zA-Z0-9-]{20,}|xoxp-[a-zA-Z0-9-]{20,}|ghp_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{30,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16})
BEGIN (RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY
sk-ant-[a-zA-Z0-9_-]{20,}
AIza[A-Za-z0-9_-]{30,}
eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}
[Bb]earer\s+[A-Za-z0-9_-]{20,}
(password|api[_-]?key|secret|token)\s*[:=]\s*["'][A-Za-z0-9_.\-+/=]{16,}["']   # case-insensitive
(postgres|mysql|mongodb|redis)://[^"\s]+:[^@\s]+@[^/\s]+

# PII regexes (Grep)
[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}                                  # emails (filtered for non-placeholder)
(\+[1-9][0-9]{0,2}[\s\-]?)?\(?[2-9][0-9]{2}\)?[\s\-]?[0-9]{3}[\s\-]?[0-9]{4}     # NANP phones (filtered for non-555)
(\.local|\.lan|\.internal|\.tailnet|\.ts\.net)\b                                 # private hostnames
ssh\s+[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+                                             # ssh user@host
/home/matt                                                                        # personal absolute path
/Users/(steipete|tyleryust|pete|pascal|peter|sebslight)                          # real first-name macOS paths
op://|1Password|1password                                                         # 1Password vault refs
peters-mac-studio|sheep-coho|flawd-bot|exe\.dev                                  # known private ops markers
```

## Notes

- All `exe.dev` references are now in `docs/platforms/exe-dev.md` and related
  hub pages — they describe a public third-party VPS provider, not a private
  operator target. The Stage 2A scrub removed the private `exe.dev` /
  `flawd-bot` / `op://Private/...` mentions from `AGENTS.md` and
  `CLAUDE.md`; verified zero hits in both files.
- The `.env.example` value `+17343367101` (area code 734) is the existing
  upstream Twilio WhatsApp number example. Recommend replacing with a
  555-prefixed placeholder during the final docs/env-example polish (out of
  scope for this read-only audit).
