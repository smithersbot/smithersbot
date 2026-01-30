import type { DiagramMode, OutputFormat, Plan } from "./types.js";
import { renderAsciiDependencies } from "./dag-render.js";
import { renderMermaid } from "./mermaid-render.js";

/**
 * Format a plan for display, respecting diagram mode and output format.
 *
 * - `md`: Markdown with summary, step list, and diagram section(s).
 * - `json`: Strict JSON with plan data and optional diagram strings.
 */
export function formatPlanOutput(
  plan: Plan,
  opts: { diagram: DiagramMode; format: OutputFormat },
): string {
  if (opts.format === "json") {
    return formatJson(plan, opts.diagram);
  }
  return formatMarkdown(plan, opts.diagram);
}

function wantAscii(mode: DiagramMode): boolean {
  return mode === "ascii" || mode === "both";
}

function wantMermaid(mode: DiagramMode): boolean {
  return mode === "mermaid" || mode === "both";
}

function formatMarkdown(plan: Plan, diagram: DiagramMode): string {
  const lines: string[] = [];

  lines.push(`## Plan: ${plan.summary}`);
  lines.push("");
  lines.push("### Steps");

  for (const step of plan.steps) {
    const deps = step.dependsOn.length > 0 ? step.dependsOn.join(", ") : "none";
    lines.push(
      `${step.id}. **${step.description}** -- \`${step.tool.name}\` (depends on: ${deps})`,
    );
  }

  if (wantAscii(diagram)) {
    lines.push("");
    lines.push("### Dependencies (ASCII)");
    lines.push("");
    lines.push(renderAsciiDependencies(plan));
  }

  if (wantMermaid(diagram)) {
    lines.push("");
    lines.push("### Dependency Graph (Mermaid)");
    lines.push("");
    lines.push("```mermaid");
    lines.push(renderMermaid(plan));
    lines.push("```");
  }

  return lines.join("\n");
}

function formatJson(plan: Plan, diagram: DiagramMode): string {
  const diagrams: Record<string, string> = {};
  if (wantAscii(diagram)) diagrams.ascii = renderAsciiDependencies(plan);
  if (wantMermaid(diagram)) diagrams.mermaid = renderMermaid(plan);

  const output = {
    goal: plan.goal,
    summary: plan.summary,
    steps: plan.steps.map((s) => ({
      id: s.id,
      description: s.description,
      dependsOn: s.dependsOn,
      tool: s.tool,
    })),
    diagrams,
  };

  return JSON.stringify(output, null, 2);
}
