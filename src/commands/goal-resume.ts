import { confirm, isCancel } from "@clack/prompts";
import { mkdirSync } from "node:fs";

import { JsonExitError } from "../cli/cli-utils.js";
import { createCliProgress } from "../cli/progress.js";
import { resolveEnvApiKey } from "../agents/model-auth.js";
import { executePlan } from "../goal/executor.js";
import { formatPlanOutput } from "../goal/format-output.js";
import { createGoalLlmClient } from "../goal/llm-client.js";
import {
  loadRun,
  saveRun,
  serializedToSession,
  sessionToSerialized,
  resolveRunId,
} from "../goal/run-store.js";
import type { GoalOutcome, OutputFormat } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";

export type GoalResumeOptions = {
  yes?: boolean;
  json?: boolean;
  output?: OutputFormat;
};

/** Resolve whether JSON mode is active: --output wins over --json. */
function resolveIsJson(opts: GoalResumeOptions): boolean {
  if (opts.output) return opts.output === "json";
  return Boolean(opts.json);
}

export async function goalResumeCommand(
  runId: string,
  opts: GoalResumeOptions,
  runtime: RuntimeEnv,
): Promise<GoalOutcome | undefined> {
  const isJson = resolveIsJson(opts);

  const resolvedId = resolveRunId(runId);
  if (!resolvedId) {
    if (isJson) {
      runtime.log(JSON.stringify({ error: `Run not found: ${runId}` }));
      throw new JsonExitError(1);
    }
    runtime.error(`Run not found: ${runId}`);
    return undefined;
  }

  const run = loadRun(resolvedId);
  if (!run) {
    if (isJson) {
      runtime.log(JSON.stringify({ error: `Run file missing: ${resolvedId}` }));
      throw new JsonExitError(1);
    }
    runtime.error(`Run file missing: ${resolvedId}`);
    return undefined;
  }

  // Terminal: done is not resumable
  if (run.state === "done") {
    if (isJson) {
      runtime.log(JSON.stringify({ error: "Run already completed." }));
      throw new JsonExitError(1);
    }
    runtime.error("Run already completed.");
    return undefined;
  }

  // Terminal: failed is not resumable
  if (run.state === "failed") {
    if (isJson) {
      runtime.log(JSON.stringify({ error: "Run failed.", lastError: run.lastError ?? null }));
      throw new JsonExitError(1);
    }
    runtime.error(`Run failed: ${run.lastError ?? "Unknown error"}`);
    return undefined;
  }

  // Blocked: print details and exit — user must provide answer first
  if (run.state === "blocked") {
    if (isJson) {
      runtime.log(
        JSON.stringify({
          status: "blocked",
          question: run.blocked?.prompt ?? null,
          requiredInputKey: run.blocked?.requiredInputKey ?? null,
        }),
      );
    } else {
      runtime.log(`Blocked: ${run.blocked?.prompt ?? "Unknown reason"}`);
      runtime.log(`Required input: ${run.blocked?.requiredInputKey ?? "unknown"}`);
      runtime.log(
        `Answer:  moltbot goal answer ${run.runId.slice(0, 8)} --key ${run.blocked?.requiredInputKey ?? "KEY"} --value <VALUE>`,
      );
    }
    return {
      status: "blocked",
      question: run.blocked?.prompt ?? "",
      requiredInputKey: run.blocked?.requiredInputKey ?? "unknown",
    };
  }

  // Stale/incomplete states
  if (run.state === "init" || run.state === "planning") {
    if (isJson) {
      runtime.log(JSON.stringify({ error: "Run is in an incomplete state." }));
      throw new JsonExitError(1);
    }
    runtime.error("Run is in an incomplete state.");
    return undefined;
  }

  // Resumable: awaiting_approval, rejected, cancelled, executing
  // (rejected and cancelled both return to the approval flow)

  // Resolve API key
  const authResult = resolveEnvApiKey("anthropic");
  if (!authResult) {
    throw new Error(
      "No Anthropic API key found. Set ANTHROPIC_API_KEY in your environment or .env file.",
    );
  }

  const client = createGoalLlmClient({
    apiKey: authResult.apiKey,
    modelOverride: run.model,
  });

  // Capture run fields for closure (TypeScript can't narrow across closures)
  const { runId: savedRunId, workingDir, model, dryRun, createdAt } = run;

  // Ensure workspace directory exists
  mkdirSync(workingDir, { recursive: true });

  // Reconstruct in-memory session
  const session = serializedToSession(run);

  // Helper to persist
  function persistRun(): void {
    saveRun(
      sessionToSerialized({
        session,
        runId: savedRunId,
        workingDir,
        model,
        dryRun,
        createdAt,
      }),
    );
  }

  // --- Approval flow: awaiting_approval, rejected, cancelled ---
  const needsApproval =
    run.state === "awaiting_approval" || run.state === "rejected" || run.state === "cancelled";

  if (needsApproval) {
    if (session.plan) {
      if (!isJson) {
        runtime.log(formatPlanOutput(session.plan, { diagram: "both", format: "md" }));
        runtime.log("");
      }
    }

    if (!opts.yes) {
      if (isJson) {
        runtime.log(
          JSON.stringify({ error: "--yes is required in JSON mode to approve the plan." }),
        );
        throw new JsonExitError(1);
      }
      let approved: boolean | symbol;
      try {
        approved = await confirm({
          message: `Execute this ${session.plan?.steps.length ?? 0}-step plan?`,
        });
      } catch {
        session.state = "cancelled";
        persistRun();
        runtime.log("Cancelled.");
        return { status: "rejected" };
      }
      if (isCancel(approved)) {
        session.state = "cancelled";
        persistRun();
        runtime.log("Cancelled.");
        return { status: "rejected" };
      }
      if (!approved) {
        session.state = "rejected";
        persistRun();
        runtime.log("Plan rejected.");
        return { status: "rejected" };
      }
    }
  }

  // --- Executing (interrupted): restore step statuses ---
  if (session.plan) {
    for (const step of session.plan.steps) {
      const result = session.stepResults.get(step.id);
      if (result) {
        step.status = result.success ? "done" : "failed";
      }
    }
  }

  const pendingSteps = session.plan?.steps.filter((s) => s.status === "pending") ?? [];
  if (pendingSteps.length === 0) {
    session.state = "done";
    persistRun();
    const outcome: GoalOutcome = {
      status: "done",
      summary: "All steps already completed.",
    };
    if (isJson) {
      runtime.log(JSON.stringify(outcome, null, 2));
    } else {
      runtime.log("All steps already completed.");
    }
    return outcome;
  }

  if (!isJson) {
    runtime.log(`Resuming: ${pendingSteps.length} pending step(s) remaining.`);
  }

  const execProgress = createCliProgress({
    label: "Executing plan...",
    total: pendingSteps.length,
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
      onStepComplete: persistRun,
    });

    persistRun();

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
