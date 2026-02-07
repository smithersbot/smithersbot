import os from "node:os";
import { computeCpm } from "./cpm.js";
import type { DiagramMode, OutputFormat, Plan } from "./types.js";
import { renderAsciiDependencies } from "./dag-render.js";
import { renderMermaid } from "./mermaid-render.js";

/** Replace leading $HOME with ~ for display only. */
function tildeShorten(p: string): string {
  const home = os.homedir();
  if (p === home) return "~";
  if (p.startsWith(`${home}/`)) return `~${p.slice(home.length)}`;
  return p;
}

/**
 * Format a plan for display, respecting diagram mode and output format.
 *
 * - `md`: Markdown with summary, step list, CPM schedule, and diagram section(s).
 * - `json`: Strict JSON with plan data, CPM schedule, and optional diagram strings.
 */
export function formatPlanOutput(
  plan: Plan,
  opts: { diagram: DiagramMode; format: OutputFormat; workingDir?: string },
): string {
  if (opts.format === "json") {
    return formatJson(plan, opts.diagram, opts.workingDir);
  }
  return formatMarkdown(plan, opts.diagram, opts.workingDir);
}

function wantAscii(mode: DiagramMode): boolean {
  return mode === "ascii" || mode === "both";
}

function wantMermaid(mode: DiagramMode): boolean {
  return mode === "mermaid" || mode === "both";
}

function formatMarkdown(plan: Plan, diagram: DiagramMode, workingDir?: string): string {
  const cpm = computeCpm(plan);
  const lines: string[] = [];

  lines.push(`## Plan: ${plan.summary}`);
  if (workingDir) {
    lines.push(`**Working dir:** ${tildeShorten(workingDir)}`);
  }
  lines.push("");
  lines.push("### Steps");

  for (const step of plan.steps) {
    const deps = step.dependsOn.length > 0 ? step.dependsOn.join(", ") : "none";
    const dur = cpm.steps[step.id].durationMinutesEffective;
    lines.push(`${step.id}. **${step.description}** (depends on: ${deps}) [${dur}m]`);
  }

  // CPM schedule section
  lines.push("");
  lines.push("### Schedule (CPM)");
  lines.push("");
  lines.push(`**Total duration:** ${cpm.totalDurationMinutes}m`);
  lines.push(`**Critical path:** ${cpm.criticalPathStepIds.join(" \u2192 ")}`);

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
    lines.push(renderMermaid(plan, cpm));
    lines.push("```");
  }

  return lines.join("\n");
}

function formatJson(plan: Plan, diagram: DiagramMode, workingDir?: string): string {
  const cpm = computeCpm(plan);
  const diagrams: Record<string, string> = {};
  if (wantAscii(diagram)) diagrams.ascii = renderAsciiDependencies(plan);
  if (wantMermaid(diagram)) diagrams.mermaid = renderMermaid(plan, cpm);

  const output: Record<string, unknown> = {
    goal: plan.goal,
    summary: plan.summary,
    ...(workingDir ? { workingDir } : {}),
    steps: plan.steps.map((s) => ({
      id: s.id,
      description: s.description,
      dependsOn: s.dependsOn,
      durationMinutes: s.durationMinutes,
      durationMinutesEffective: cpm.steps[s.id].durationMinutesEffective,
    })),
    schedule: {
      totalDurationMinutes: cpm.totalDurationMinutes,
      criticalPathStepIds: cpm.criticalPathStepIds,
      steps: cpm.steps,
    },
    diagrams,
  };

  return JSON.stringify(output, null, 2);
}
