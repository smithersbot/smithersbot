import { confirm, isCancel } from "@clack/prompts";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { createCliProgress } from "../cli/progress.js";
import { resolveEnvApiKey } from "../agents/model-auth.js";
import { renderDag } from "../goal/dag-render.js";
import { executePlan } from "../goal/executor.js";
import { createGoalLlmClient } from "../goal/llm-client.js";
import { generatePlan } from "../goal/planner.js";
import type { GoalOutcome, GoalSession } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";

const DEFAULT_WORKSPACE_DIR = ".moltbot-goal-workspace";

export type GoalCommandOptions = {
  goal: string;
  model?: string;
  workingDir?: string;
  yes?: boolean;
  json?: boolean;
  dryRun?: boolean;
};

export async function goalCommand(
  opts: GoalCommandOptions,
  runtime: RuntimeEnv,
): Promise<GoalOutcome> {
  const goal = opts.goal.trim();
  if (!goal) throw new Error("Goal text is required");

  // Default to a sandboxed workspace subfolder
  const workingDir = opts.workingDir
    ? path.resolve(opts.workingDir)
    : path.resolve(process.cwd(), DEFAULT_WORKSPACE_DIR);

  mkdirSync(workingDir, { recursive: true });

  if (!opts.json) {
    runtime.log(`Workspace: ${workingDir}`);
  }

  // Resolve API key
  const authResult = resolveEnvApiKey("anthropic");
  if (!authResult) {
    throw new Error("No Anthropic API key found. Set ANTHROPIC_API_KEY in your environment.");
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
      enabled: !opts.json,
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
    if (opts.json) {
      runtime.log(JSON.stringify(outcome, null, 2));
    } else {
      runtime.log(`\nBLOCKED: ${planResult.question}`);
    }
    return outcome;
  }

  // After the blocked check, planResult is narrowed to Plan
  session.plan = planResult;

  // Display plan
  if (opts.json) {
    runtime.log(JSON.stringify(planResult, null, 2));
  } else {
    runtime.log("");
    runtime.log(renderDag(planResult));
    runtime.log("");
  }

  if (opts.dryRun) {
    const outcome: GoalOutcome = {
      status: "done",
      summary: "Dry run complete (plan generated, no execution)",
    };
    if (opts.json) {
      runtime.log(JSON.stringify(outcome, null, 2));
    }
    return outcome;
  }

  // Phase 2: Approval gate
  session.state = "awaiting_approval";
  if (!opts.yes) {
    const approved = await confirm({
      message: `Execute this ${planResult.steps.length}-step plan?`,
    });
    if (isCancel(approved) || !approved) {
      session.state = "rejected";
      if (!opts.json) {
        runtime.log("Plan rejected.");
      }
      return { status: "rejected" };
    }
  }

  // Phase 3: Execution
  const execProgress = createCliProgress({
    label: "Executing plan...",
    total: planResult.steps.length,
    enabled: !opts.json,
  });
  try {
    runtime.log("");
    const outcome = await executePlan({
      session,
      client,
      workingDir,
      runtime,
      progress: execProgress,
    });

    // Final result
    runtime.log("");
    if (opts.json) {
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
