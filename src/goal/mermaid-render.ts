import type { CpmResult } from "./cpm.js";
import type { Plan } from "./types.js";

/** Escape characters that break Mermaid node labels inside double quotes. */
function escapeLabel(text: string): string {
  return text.replace(/"/g, "&quot;");
}

/**
 * Renders a plan as a Mermaid flowchart DAG.
 *
 * When `cpm` is provided, node labels include duration and critical nodes
 * are styled with a `critical` class.
 *
 * Example:
 *   graph TD
 *     1["1. Create directory (mkdir) [1m]"]
 *     2["2. Write index.html (file_write) [1m]"]
 *     1 --> 2
 *     classDef critical stroke-width:3px;
 *     class 1 critical;
 *     class 2 critical;
 */
export function renderMermaid(plan: Plan, cpm?: CpmResult): string {
  const lines: string[] = ["graph TD"];

  // Node declarations
  for (const step of plan.steps) {
    const durSuffix = cpm ? ` [${cpm.steps[step.id].durationMinutesEffective}m]` : "";
    const label = escapeLabel(`${step.id}. ${step.description} (${step.tool.name})${durSuffix}`);
    lines.push(`  ${step.id}["${label}"]`);
  }

  // Edge declarations (dependency → step)
  for (const step of plan.steps) {
    for (const dep of step.dependsOn) {
      lines.push(`  ${dep} --> ${step.id}`);
    }
  }

  // Critical path styling
  if (cpm) {
    const criticalIds = Object.entries(cpm.steps)
      .filter(([, timing]) => timing.isCritical)
      .map(([id]) => id);
    if (criticalIds.length > 0) {
      lines.push("  classDef critical stroke-width:3px;");
      for (const id of criticalIds) {
        lines.push(`  class ${id} critical;`);
      }
    }
  }

  return lines.join("\n");
}
