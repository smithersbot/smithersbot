import type { CpmResult } from "./cpm.js";
import type { ExecutionDisplayStatus } from "./execution-status.js";
import type { Plan, StepResult } from "./types.js";
import { computeCriticalPathScores, orderStepIdsCriticalPathFirst } from "./plan-order.js";

/** Init directive — must precede the graph declaration. */
const INIT_DIRECTIVE = [
  `%%{init: {`,
  `  "theme": "base",`,
  `  "themeVariables": {`,
  `    "fontFamily": "Times New Roman, Times, serif",`,
  `    "fontSize": "18px",`,
  `    "primaryColor": "#fff",`,
  `    "primaryTextColor": "#fff",`,
  `    "lineColor": "#A1A1AA"`,
  `  }`,
  `}}%%`,
].join("\n");

/** Class definitions for each execution status. */
const CLASS_DEFS = [
  `classDef pending fill:#2D3748,stroke:#718096,stroke-width:2px,color:#CBD5E0,stroke-dasharray: 5 5,rx:4,ry:4;`,
  `classDef waiting fill:#4C1D95,stroke:#FCD34D,stroke-width:3px,color:#FFF,rx:4,ry:4;`,
  `classDef done fill:#3F4F3A,stroke:#84CC16,stroke-width:3px,color:#ECFCCB,rx:4,ry:4;`,
  `classDef blocked fill:#450a0a,stroke:#EF4444,stroke-width:4px,color:#FECACA,stroke-dasharray: 8 4,rx:4,ry:4;`,
  `classDef inprog fill:#1F2937,stroke:#A855F7,color:#E9D5FF,stroke-width:2px,rx:4,ry:4;`,
].join("\n");

/** Default link style applied to all edges. */
const LINK_STYLE_DEFAULT = `linkStyle default stroke:#718096,stroke-width:2px,fill:none;`;

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

function formatActualDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0s";
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0) return `${minutes} min`;
  return `${minutes}m ${seconds}s`;
}

function nodeDurationLabel(
  stepId: string,
  status: ExecutionDisplayStatus,
  cpm?: CpmResult,
  stepResults?: ReadonlyMap<string, StepResult>,
): string {
  if (status === "done") {
    const result = stepResults?.get(stepId);
    if (result && Number.isFinite(result.durationMs)) {
      return `<br/>${formatActualDuration(result.durationMs)}`;
    }
  }
  if (cpm) {
    return `<br/>~${cpm.steps[stepId].durationMinutesEffective} min`;
  }
  return "";
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

  // "Ask user yes/no question about X" → "Ask: X?"
  s = s.replace(
    /^Ask(?:\s+(?:the\s+)?user)?\s+(?:a\s+)?(?:yes\/no\s+)?question\s+about\s+(.+)/i,
    (_m, topic) => {
      let t = topic.trim();
      t = t.replace(/^creating\b/i, "create");
      return `Ask: ${t}${t.endsWith("?") ? "" : "?"}`;
    },
  );

  // "Write file X containing Y" → "Write X"
  s = s.replace(/^Write file\s+(\S+)\s+containing\b.*/i, "Write $1");

  // Generic "containing ..." suffix strip
  s = s.replace(/\s+containing\b.*$/i, "");

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
 * Renders a plan as a Mermaid flowchart DAG.
 *
 * When `cpm` is provided, node labels include duration and critical-path
 * edges are styled with a thicker `linkStyle`.
 *
 * When `displayStatuses` is provided, nodes are coloured by execution status
 * with emoji prefixes.
 *
 * When `stepResults` is provided, `done` steps use actual elapsed duration.
 */
export function renderMermaid(
  plan: Plan,
  cpm?: CpmResult,
  displayStatuses?: Map<string, ExecutionDisplayStatus>,
  stepResults?: ReadonlyMap<string, StepResult>,
): string {
  const lines: string[] = [INIT_DIRECTIVE, "", "flowchart TD"];

  // Compute critical-path-first numeric labels: stepId → 1-based number
  const scores = computeCriticalPathScores(plan.steps);
  const order = orderStepIdsCriticalPathFirst(plan.steps, scores);
  const orderNum = new Map<string, number>();
  for (let i = 0; i < order.length; i++) {
    orderNum.set(order[i], i + 1);
  }

  // Node declarations
  for (const step of plan.steps) {
    const status = displayStatuses?.get(step.id) ?? "pending";
    const emoji = displayStatuses ? STATUS_EMOJI[status] : "";
    const prefix = emoji ? `${emoji} ` : "";
    const num = orderNum.get(step.id) ?? 0;
    const shortDesc = normalizeLabel(step.description);
    const dur = nodeDurationLabel(step.id, status, cpm, stepResults);
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

  // classDefs + linkStyle default
  lines.push(CLASS_DEFS);
  lines.push(LINK_STYLE_DEFAULT);

  // Per-node status class assignment (always applied; defaults to pending)
  for (const step of plan.steps) {
    const status = displayStatuses?.get(step.id) ?? "pending";
    lines.push(`  class ${step.id} ${STATUS_CLASS[status]};`);
  }

  // Critical-path linkStyle overrides (same stroke color, thicker width)
  for (const idx of criticalEdgeIndices) {
    lines.push(`  linkStyle ${idx} stroke:#718096,stroke-width:4px;`);
  }

  return lines.join("\n");
}
