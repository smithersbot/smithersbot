import type { CpmResult } from "./cpm.js";
import type { ExecutionDisplayStatus } from "./execution-status.js";
import type { Plan, PlanStep } from "./types.js";

/** Init directive — must precede the graph declaration. */
const INIT_DIRECTIVE = [
  `%%{init:{`,
  `  "theme":"dark",`,
  `  "flowchart":{"curve":"basis","nodeSpacing":28,"rankSpacing":44},`,
  `  "themeVariables":{`,
  `    "fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Noto Sans, DejaVu Sans, Liberation Sans, Arial, sans-serif",`,
  `    "fontSize":"16px",`,
  `    "lineColor":"#334155",`,
  `    "primaryTextColor":"#E5E7EB",`,
  `    "primaryBorderColor":"#334155"`,
  `  }`,
  `}}%%`,
].join("\n");

/** Graph-level style definitions — must follow `graph TD`. */
const GRAPH_STYLES = [
  `  classDef pending fill:#0F172A,stroke:#334155,color:#E5E7EB,stroke-width:2px,rx:14,ry:14;`,
  `  classDef done fill:#052E1B,stroke:#22C55E,color:#BBF7D0,stroke-width:2px,rx:14,ry:14;`,
  `  classDef blocked fill:#3F0B15,stroke:#EF4444,color:#FECDD3,stroke-width:2px,rx:14,ry:14;`,
  `  classDef waiting fill:#111827,stroke:#475569,color:#CBD5E1,stroke-width:2px,rx:14,ry:14;`,
  `  classDef inprog fill:#1F2937,stroke:#A855F7,color:#E9D5FF,stroke-width:2px,rx:14,ry:14;`,
  `  linkStyle default stroke:#334155,stroke-width:2px;`,
].join("\n");

const STATUS_CLASS: Record<ExecutionDisplayStatus, string> = {
  done: "done",
  blocked: "blocked",
  in_progress: "inprog",
  soft_blocked: "waiting",
  pending: "pending",
};

const STATUS_EMOJI: Record<ExecutionDisplayStatus, string> = {
  done: "✅",
  blocked: "⛔",
  in_progress: "🏃",
  soft_blocked: "⏳",
  pending: "",
};

/** Escape characters that break Mermaid node labels inside double quotes. */
function escapeLabel(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Strip LLM-generated noise from step descriptions to produce short labels.
 *
 * Strips: leading prefixes (A./B./1./write-a-txt./A)/A-), trailing filler
 * words (step/steps), "in parallel", "if user answered yes", verbose patterns.
 * Preserves `?` for question steps.
 */
export function normalizeLabel(raw: string): string {
  let s = raw.trim();

  // Strip leading prefixes like "A.", "B)", "1.", "1)", "A-", "write-a-txt."
  s = s.replace(/^[A-Za-z0-9][\w-]*[.)]\s*/, "");
  // Also strip "A-" style prefix (single letter/digit dash)
  s = s.replace(/^[A-Za-z0-9]-\s*/, "");

  // Strip verbose filler phrases (case-insensitive)
  s = s.replace(/\s+in parallel\b/gi, "");
  s = s.replace(/\s+if user answered yes\b/gi, "");
  s = s.replace(/\s+if (?:the )?user (?:says?|agrees?|confirms?|approves?)\b[^?]*/gi, "");

  // Strip trailing "step" / "steps"
  s = s.replace(/\s+steps?\s*$/i, "");

  // Capitalize first letter
  if (s.length > 0) {
    s = s[0].toUpperCase() + s.slice(1);
  }

  return s.trim();
}

/**
 * Kahn's algorithm topological sort. Returns step IDs in dependency order.
 * Falls back to input order if the graph has cycles.
 */
export function topologicalSort(steps: PlanStep[]): string[] {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const step of steps) {
    inDegree.set(step.id, 0);
    adj.set(step.id, []);
  }
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (adj.has(dep)) {
        adj.get(dep)!.push(step.id);
        inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
      }
    }
  }

  // Seed queue with roots, sorted by original position for stability
  const idxMap = new Map(steps.map((s, i) => [s.id, i]));
  const queue: string[] = steps.filter((s) => (inDegree.get(s.id) ?? 0) === 0).map((s) => s.id);

  const result: string[] = [];
  while (queue.length > 0) {
    // Sort queue by original position for deterministic output
    queue.sort((a, b) => (idxMap.get(a) ?? 0) - (idxMap.get(b) ?? 0));
    const id = queue.shift()!;
    result.push(id);
    for (const next of adj.get(id) ?? []) {
      const deg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }

  // Cycle fallback: return input order
  if (result.length !== steps.length) {
    return steps.map((s) => s.id);
  }
  return result;
}

/**
 * Renders a plan as a Mermaid flowchart DAG.
 *
 * When `cpm` is provided, node labels include duration and critical-path
 * edges are styled with a thicker `linkStyle`.
 *
 * When `displayStatuses` is provided, nodes are coloured by execution status
 * with emoji prefixes.
 */
export function renderMermaid(
  plan: Plan,
  cpm?: CpmResult,
  displayStatuses?: Map<string, ExecutionDisplayStatus>,
): string {
  const lines: string[] = [INIT_DIRECTIVE, "", "graph TD", GRAPH_STYLES];

  // Compute topo-sorted numeric labels: stepId → 1-based number
  const topoOrder = topologicalSort(plan.steps);
  const topoNum = new Map<string, number>();
  for (let i = 0; i < topoOrder.length; i++) {
    topoNum.set(topoOrder[i], i + 1);
  }

  // Node declarations
  for (const step of plan.steps) {
    const status = displayStatuses?.get(step.id) ?? "pending";
    const emoji = displayStatuses ? STATUS_EMOJI[status] : "";
    const prefix = emoji ? `${emoji} ` : "";
    const num = topoNum.get(step.id) ?? 0;
    const shortDesc = normalizeLabel(step.description);
    const dur = cpm ? `<br/>~${cpm.steps[step.id].durationMinutesEffective} min` : "";
    const label = escapeLabel(`${prefix}${num}. ${shortDesc}`) + dur;
    lines.push(`  ${step.id}["${label}"]`);
  }

  // Edge declarations (dependency → step) with critical-path index tracking
  let edgeIndex = 0;
  const criticalEdgeIndices: number[] = [];
  for (const step of plan.steps) {
    for (const dep of step.dependsOn) {
      lines.push(`  ${dep} --> ${step.id}`);
      if (cpm?.steps[dep]?.isCritical && cpm?.steps[step.id]?.isCritical) {
        criticalEdgeIndices.push(edgeIndex);
      }
      edgeIndex++;
    }
  }

  // Critical path edge styling
  for (const idx of criticalEdgeIndices) {
    lines.push(`  linkStyle ${idx} stroke:#334155,stroke-width:4px;`);
  }

  // Per-node status class assignment (always applied; defaults to pending)
  for (const step of plan.steps) {
    const status = displayStatuses?.get(step.id) ?? "pending";
    lines.push(`  class ${step.id} ${STATUS_CLASS[status]};`);
  }

  return lines.join("\n");
}
