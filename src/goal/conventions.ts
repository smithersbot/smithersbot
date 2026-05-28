import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GLOBAL_CONVENTIONS = `# Global Workflow Conventions

- Verify before done: never mark a task complete without proving it works.
- Run relevant tests/checks, inspect logs/output, and confirm behavior end to end.
- For non-trivial changes, pause and ask whether there is a more elegant solution.
- Skip over-engineering for obvious or mechanical one-line fixes.
- When given a bug report, investigate runtime signals and fix it directly.
- Keep user context switching near zero by owning diagnosis and remediation.
- Prefer minimal, focused changes that solve the assigned task.
- Keep commits concise, scoped, and action-oriented.
- Avoid unrelated refactors in the same change.
- Never commit secrets, credentials, tokens, or private keys.
- If verification is blocked by environment limits, report the exact blocker clearly.
`;

function writeIfMissing(filePath: string, content: string): void {
  if (fs.existsSync(filePath)) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

export function ensureGlobalConventions(): void {
  const homeDir = os.homedir();

  writeIfMissing(path.join(homeDir, ".claude", "CLAUDE.md"), GLOBAL_CONVENTIONS);
  writeIfMissing(path.join(homeDir, ".codex", "AGENTS.md"), GLOBAL_CONVENTIONS);
}
