// Scout prompt template loader.
//
// The scout prompt template ships as a runtime .md file because it contains
// {{PLACEHOLDER}} tokens rendered at goal-planning time. The build copy step
// (scripts/copy-scout-template.ts) mirrors this file into dist/prompts/scout/
// so the compiled runtime can read it from the same relative location.

import path from "node:path";

export const SCOUT_PROMPT_TEMPLATE_FILE = "scout_prompt_template.md";

/**
 * Resolve the absolute filesystem path of the scout prompt template, relative
 * to whichever copy of this module is currently being executed (source or dist).
 */
export function resolveScoutTemplatePath(): string {
  const moduleDir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
  return path.join(moduleDir, SCOUT_PROMPT_TEMPLATE_FILE);
}
