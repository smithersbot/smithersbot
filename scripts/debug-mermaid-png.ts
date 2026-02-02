import { writeFileSync } from "node:fs";
import type { ExecutionDisplayStatus } from "../src/goal/execution-status.js";
import { renderMermaid } from "../src/goal/mermaid-render.js";
import { renderMermaidToPng } from "../src/goal/mermaid-png.js";
import type { Plan, PlanStep } from "../src/goal/types.js";

function makePlan(steps: Plan["steps"]): Plan {
  return { goal: "Debug all 5 statuses", summary: "Debug DAG", steps };
}

function step(overrides: Partial<PlanStep> & { id: string }): PlanStep {
  return {
    description: `Step ${overrides.id}`,
    dependsOn: [],
    tool: { name: "mkdir", args: {} },
    status: "pending",
    ...overrides,
  };
}

const plan = makePlan([
  step({ id: "A", description: "Completed task" }),
  step({ id: "B", description: "Blocked task", dependsOn: ["A"] }),
  step({ id: "C", description: "Running task", dependsOn: ["A"] }),
  step({ id: "D", description: "Pending task", dependsOn: ["C"] }),
  step({ id: "E", description: "Waiting for input", dependsOn: ["B"] }),
]);

const statuses = new Map<string, ExecutionDisplayStatus>([
  ["A", "done"],
  ["B", "blocked"],
  ["C", "in_progress"],
  ["D", "pending"],
  ["E", "soft_blocked"],
]);

const mermaid = renderMermaid(plan, undefined, statuses);
console.log("--- Mermaid source ---");
console.log(mermaid);
console.log("--- Rendering PNG ---");

const png = renderMermaidToPng(mermaid);
if (png) {
  writeFileSync("/tmp/moltbot-mermaid-debug.png", png);
  console.log("Wrote /tmp/moltbot-mermaid-debug.png (%d bytes)", png.length);
} else {
  console.error("PNG render failed (is mmdc/puppeteer installed?)");
  process.exit(1);
}
