# Project Reference

## Coding Standards

- Use strict typing where possible; avoid `any` unless unavoidable and documented.
- Keep files focused and reasonably concise; extract helpers instead of duplicating logic.
- Add brief comments only when behavior is non-obvious.

## Verification

- Run the target project's build, test, and lint commands before reporting completion.
- If behavior is incorrect, inspect output, fix the implementation, and re-run verification.
- Do not mark the task complete until the modified behavior has been exercised.
- **Do NOT restart the gateway service during goal execution.** If verification requires a restart, mark the task blocked and ask the operator to restart.

## Git

- Make small, scoped commits with clear action-oriented messages.
- Stage and commit only files related to your task.
- Avoid destructive history rewrites unless explicitly requested.

## Security

- Never commit secrets, credentials, tokens, private keys, or live configuration values.
- Use fake placeholders in tests and examples.
- Do not edit sensitive files such as `.env*`, `*.pem`, `*.key`, `credentials*`, `.aws/**`, or `.ssh/**`.

## File Operations

- Prefer editing existing files over creating new ones.
- Do not edit `node_modules/`.

## Dependencies

- Do not add, remove, or upgrade dependencies unless the task explicitly requires it.
