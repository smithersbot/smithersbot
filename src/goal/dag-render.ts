import type { Plan } from "./types.js";

/**
 * Renders a per-step dependency listing for static plan display.
 * No pipe connectors, no runtime status legend.
 *
 * Example output:
 *   [ ] 1 (mkdir)
 *       deps: none
 *
 *   [ ] 2 (file_write)
 *       deps: 1
 *
 *   [ ] 3 (git_add)
 *       deps: 2
 */
export function renderAsciiDependencies(plan: Plan): string {
  const blocks: string[] = [];

  for (const step of plan.steps) {
    const deps = step.dependsOn.length > 0 ? step.dependsOn.join(", ") : "none";
    blocks.push(`[ ] ${step.id}\n    deps: ${deps}`);
  }

  return blocks.join("\n\n");
}
