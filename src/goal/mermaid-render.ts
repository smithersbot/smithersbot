import type { Plan } from "./types.js";

/** Escape characters that break Mermaid node labels inside double quotes. */
function escapeLabel(text: string): string {
  return text.replace(/"/g, "&quot;");
}

/**
 * Renders a plan as a Mermaid flowchart DAG.
 *
 * Example:
 *   graph TD
 *     1["1. Create directory (mkdir)"]
 *     2["2. Write index.html (file_write)"]
 *     1 --> 2
 */
export function renderMermaid(plan: Plan): string {
  const lines: string[] = ["graph TD"];

  // Node declarations
  for (const step of plan.steps) {
    const label = escapeLabel(`${step.id}. ${step.description} (${step.tool.name})`);
    lines.push(`  ${step.id}["${label}"]`);
  }

  // Edge declarations (dependency → step)
  for (const step of plan.steps) {
    for (const dep of step.dependsOn) {
      lines.push(`  ${dep} --> ${step.id}`);
    }
  }

  return lines.join("\n");
}
