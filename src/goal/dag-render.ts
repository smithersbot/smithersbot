import type { Plan, PlanStep } from "./types.js";

function statusChar(status: PlanStep["status"]): string {
  switch (status) {
    case "done":
      return "x";
    case "blocked":
      return "!";
    case "in_progress":
      return ">";
    default:
      return " ";
  }
}

/**
 * Renders a plan as an ASCII dependency graph with status indicators.
 * Used during execution runtime to show live progress.
 *
 * Example output:
 *   Plan: Create a landing page
 *   ==========================
 *
 *   [ ] 1. Create directory (mkdir)
 *    |
 *   [ ] 2. Write index.html (file_write)
 *    |
 *   [ ] 3. Stage files (git_add)
 *
 *   Legend: [ ] pending  [x] done  [!] blocked  [>] in_progress
 */
export function renderDag(plan: Plan): string {
  const lines: string[] = [];
  const title = `Plan: ${plan.summary}`;
  lines.push(title);
  lines.push("=".repeat(Math.min(title.length, 60)));
  lines.push("");

  // Build child adjacency for rendering connectors
  const stepMap = new Map(plan.steps.map((s) => [s.id, s]));
  const childrenOf = new Map<string, string[]>();
  for (const step of plan.steps) {
    for (const dep of step.dependsOn) {
      const list = childrenOf.get(dep) ?? [];
      list.push(step.id);
      childrenOf.set(dep, list);
    }
  }

  // Render in topological order via BFS
  const rendered = new Set<string>();
  const roots = plan.steps.filter((s) => s.dependsOn.length === 0);
  const queue = [...roots];

  while (queue.length > 0) {
    const step = queue.shift()!;
    if (rendered.has(step.id)) continue;

    // Check all deps are rendered before we render this step
    const allDepsRendered = step.dependsOn.every((d) => rendered.has(d));
    if (!allDepsRendered) {
      queue.push(step);
      continue;
    }

    rendered.add(step.id);

    const icon = statusChar(step.status);
    lines.push(`[${icon}] ${step.id}. ${step.description}`);

    const children = childrenOf.get(step.id) ?? [];
    if (children.length > 0) {
      if (children.length === 1) {
        lines.push(" |");
      } else {
        lines.push(" " + children.map(() => "|").join(" "));
      }
    }

    for (const childId of children) {
      const child = stepMap.get(childId);
      if (child && !rendered.has(childId)) {
        queue.push(child);
      }
    }
  }

  lines.push("");
  lines.push("Legend: [ ] pending  [x] done  [!] blocked  [>] in_progress");

  return lines.join("\n");
}

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
