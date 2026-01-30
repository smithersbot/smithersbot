import { confirm, isCancel } from "@clack/prompts";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { createCliProgress } from "../cli/progress.js";
import { resolveEnvApiKey } from "../agents/model-auth.js";
import { executePlan } from "../goal/executor.js";
import { formatPlanOutput } from "../goal/format-output.js";
import { createGoalLlmClient } from "../goal/llm-client.js";
import { generatePlan } from "../goal/planner.js";
import type { DiagramMode, GoalOutcome, GoalSession, OutputFormat } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";

const DEFAULT_WORKSPACE_DIR = ".moltbot-goal-workspace";

export type GoalCommandOptions = {
  goal: string;
  model?: string;
  workingDir?: string;
  yes?: boolean;
  json?: boolean;
  dryRun?: boolean;
  diagram?: DiagramMode;
  output?: OutputFormat;
};

/** Resolve effective output format: --output wins over --json. */
function resolveOutputFormat(opts: GoalCommandOptions): OutputFormat {
  if (opts.output) return opts.output;
  if (opts.json) return "json";
  return "md";
}

/** Resolve effective diagram mode. Default depends on output format. */
function resolveDiagramMode(opts: GoalCommandOptions, outputFormat: OutputFormat): DiagramMode {
  if (opts.diagram) return opts.diagram;
  return outputFormat === "json" ? "none" : "both";
}

export async function goalCommand(
  opts: GoalCommandOptions,
  runtime: RuntimeEnv,
): Promise<GoalOutcome> {
  const goal = opts.goal.trim();
  if (!goal) throw new Error("Goal text is required");

  const outputFormat = resolveOutputFormat(opts);
  const diagramMode = resolveDiagramMode(opts, outputFormat);
  const isJson = outputFormat === "json";

  // Default to a sandboxed workspace subfolder
  const workingDir = opts.workingDir
    ? path.resolve(opts.workingDir)
    : path.resolve(process.cwd(), DEFAULT_WORKSPACE_DIR);

  mkdirSync(workingDir, { recursive: true });

  if (!isJson) {
    runtime.log(`Workspace: ${workingDir}`);
  }

  // Resolve API key
  const authResult = resolveEnvApiKey("anthropic");
  if (!authResult) {
    throw new Error(
      "No Anthropic API key found. Set ANTHROPIC_API_KEY in your environment or .env file.",
    );
  }

  const client = createGoalLlmClient({
    apiKey: authResult.apiKey,
    modelOverride: opts.model,
  });

  // In-memory session state
  const session: GoalSession = {
    goal,
    state: "init",
    plan: null,
    stepResults: new Map(),
    blockReason: null,
  };

  // Phase 1: Planning
  session.state = "planning";
  let planResult;
  {
    const progress = createCliProgress({
      label: "Generating plan...",
      indeterminate: true,
      enabled: !isJson,
    });
    try {
      planResult = await generatePlan(client, goal);
    } finally {
      progress.done();
    }
  }

  // Handle blocked-at-planning
  if ("blocked" in planResult) {
    session.state = "blocked";
    session.blockReason = planResult.question;
    const outcome: GoalOutcome = { status: "blocked", question: planResult.question };
    if (isJson) {
      runtime.log(JSON.stringify(outcome, null, 2));
    } else {
      runtime.log(`\nBLOCKED: ${planResult.question}`);
    }
    return outcome;
  }

  // After the blocked check, planResult is narrowed to Plan
  session.plan = planResult;

  // Display plan
  runtime.log(isJson ? "" : "\n");
  runtime.log(formatPlanOutput(planResult, { diagram: diagramMode, format: outputFormat }));
  if (!isJson) runtime.log("");

  if (opts.dryRun) {
    const outcome: GoalOutcome = {
      status: "done",
      summary: "Dry run complete (plan generated, no execution)",
    };
    if (isJson) {
      runtime.log(JSON.stringify(outcome, null, 2));
    }
    return outcome;
  }

  // Phase 2: Approval gate
  session.state = "awaiting_approval";
  if (!opts.yes) {
    // JSON mode requires --yes because interactive prompts break strict JSON output
    if (isJson) {
      throw new Error(
        "--output json requires --yes to skip interactive approval. Add --yes to auto-approve.",
      );
    }
    const approved = await confirm({
      message: `Execute this ${planResult.steps.length}-step plan?`,
    });
    if (isCancel(approved) || !approved) {
      session.state = "rejected";
      runtime.log("Plan rejected.");
      return { status: "rejected" };
    }
  }

  // Phase 3: Execution
  const execProgress = createCliProgress({
    label: "Executing plan...",
    total: planResult.steps.length,
    enabled: !isJson,
  });
  try {
    if (!isJson) runtime.log("");
    const outcome = await executePlan({
      session,
      client,
      workingDir,
      runtime,
      progress: execProgress,
    });

    // Final result
    if (!isJson) runtime.log("");
    if (isJson) {
      runtime.log(JSON.stringify(outcome, null, 2));
    } else if (outcome.status === "done") {
      runtime.log(`DONE: ${outcome.summary}`);
    } else if (outcome.status === "blocked") {
      runtime.log(`BLOCKED: ${outcome.question}`);
    }

    return outcome;
  } finally {
    execProgress.done();
  }
}
