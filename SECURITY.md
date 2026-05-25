# Security Policy

If you believe you've found a security issue in SmithersBot, please report it privately.

## Reporting

- Email: `contact@smithersbot.com`
- What to include: reproduction steps, impact assessment, and (if possible) a minimal PoC.

Please do **not** open a public GitHub issue for suspected vulnerabilities. Use the private email channel above for initial disclosure. Once a fix is available, a public advisory may be published.

## Disclosure

SmithersBot is licensed under the MIT License (see `LICENSE`). Reported issues will be triaged on a best-effort basis; there is no SLA. Coordinated disclosure is appreciated — please allow a reasonable window for a fix before publishing details.

### Web Interface Safety

SmithersBot's web interface is intended for local use only. Do **not** bind it to the public internet; it is not hardened for public exposure.

## Runtime Requirements

### Node.js Version

SmithersBot requires **Node.js 22.12.0 or later**.
For security, use the latest available Node 22 LTS patch release rather than an older 22.x build.

Verify your Node.js version:

```bash
node --version  # Should be v22.12.0 or later
```

## Operational Safety

Run SmithersBot in an isolated environment, such as a VM, VPS, dedicated machine, or isolated development machine.
Anything agents should read or edit must live inside a managed workspace repo: `~/smithersbot-goals/agent/workspaces/<workspace-name>/repo`.
Private env, config, auth, and session files must stay outside the workspace and are not agent-visible.

## Security Scanning

This project uses `detect-secrets` for automated secret detection in CI/CD.
See `.detect-secrets.cfg` for configuration and `.secrets.baseline` for the baseline.

Run locally:

```bash
pip install detect-secrets==1.5.0
detect-secrets scan --baseline .secrets.baseline
```
