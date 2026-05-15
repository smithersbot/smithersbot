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

SmithersBot requires **Node.js 22.12.0 or later** (LTS). This version includes important security patches:

- CVE-2025-59466: async_hooks DoS vulnerability
- CVE-2026-21636: Permission model bypass vulnerability

Verify your Node.js version:

```bash
node --version  # Should be v22.12.0 or later
```

### Docker Security

When running SmithersBot in Docker:

1. The official image runs as a non-root user (`node`) for reduced attack surface
2. Use `--read-only` flag when possible for additional filesystem protection
3. Limit container capabilities with `--cap-drop=ALL`

Example secure Docker run:

```bash
docker run --read-only --cap-drop=ALL \
  -v smithersbot-data:/app/data \
  smithersbot:latest
```

## Security Scanning

This project uses `detect-secrets` for automated secret detection in CI/CD.
See `.detect-secrets.cfg` for configuration and `.secrets.baseline` for the baseline.

Run locally:

```bash
pip install detect-secrets==1.5.0
detect-secrets scan --baseline .secrets.baseline
```
