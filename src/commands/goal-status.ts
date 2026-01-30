import { loadRun, resolveRunId } from "../goal/run-store.js";
import { formatPlanOutput } from "../goal/format-output.js";
import type { DiagramMode, OutputFormat } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";

export type GoalStatusOptions = {
  json?: boolean;
  output?: OutputFormat;
  diagram?: DiagramMode;
};

/** Resolve whether JSON mode is active: --output wins over --json. */
function resolveIsJson(opts: GoalStatusOptions): boolean {
  if (opts.output) return opts.output === "json";
  return Boolean(opts.json);
}

export async function goalStatusCommand(
  runId: string,
  opts: GoalStatusOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const isJson = resolveIsJson(opts);
  const resolvedId = resolveRunId(runId);

  if (!resolvedId) {
    if (isJson) {
      runtime.log(JSON.stringify({ error: `Run not found: ${runId}` }));
    } else {
      runtime.error(`Run not found: ${runId}`);
    }
    return;
  }

  const run = loadRun(resolvedId);
  if (!run) {
    if (isJson) {
      runtime.log(JSON.stringify({ error: `Run file missing: ${resolvedId}` }));
    } else {
      runtime.error(`Run file missing: ${resolvedId}`);
    }
    return;
  }

  if (isJson) {
    runtime.log(JSON.stringify(run, null, 2));
    return;
  }

  const diagramMode = opts.diagram ?? "both";

  runtime.log(`Run:       ${run.runId}`);
  runtime.log(`Goal:      ${run.goal}`);
  runtime.log(`State:     ${run.state}`);
  runtime.log(`Model:     ${run.model ?? "default"}`);
  runtime.log(`Workspace: ${run.workingDir}`);
  runtime.log(`Created:   ${run.createdAt}`);
  runtime.log(`Updated:   ${run.updatedAt}`);
  if (run.dryRun) {
    runtime.log("Dry run:   yes");
  }

  if (run.blockReason) {
    runtime.log(`\nBlocked: ${run.blockReason}`);
  }

  if (run.plan) {
    runtime.log("");
    runtime.log(
      formatPlanOutput(run.plan, {
        diagram: diagramMode,
        format: "md",
      }),
    );

    // Show step results
    const results = Object.values(run.stepResults);
    if (results.length > 0) {
      runtime.log("\n### Step Results\n");
      for (const result of results) {
        const icon = result.success ? "x" : "!";
        runtime.log(
          `[${icon}] ${result.stepId} (${result.durationMs}ms)${result.error ? ` -- ${result.error}` : ""}`,
        );
      }
    }
  }

  if (run.state === "awaiting_approval" || run.state === "executing") {
    runtime.log(`\nResume: moltbot goal resume ${run.runId.slice(0, 8)}`);
  }
}
