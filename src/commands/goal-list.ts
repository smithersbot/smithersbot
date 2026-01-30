import { listRuns } from "../goal/run-store.js";
import type { OutputFormat } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";

export type GoalListOptions = {
  json?: boolean;
  output?: OutputFormat;
  limit?: number;
};

const DEFAULT_LIMIT = 20;

/** Resolve whether JSON mode is active: --output wins over --json. */
function resolveIsJson(opts: GoalListOptions): boolean {
  if (opts.output) return opts.output === "json";
  return Boolean(opts.json);
}

export async function goalListCommand(opts: GoalListOptions, runtime: RuntimeEnv): Promise<void> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const runs = listRuns().slice(0, limit);
  const isJson = resolveIsJson(opts);

  if (isJson) {
    runtime.log(JSON.stringify(runs, null, 2));
    return;
  }

  if (runs.length === 0) {
    runtime.log("No goal runs found.");
    return;
  }

  runtime.log("Goal runs:\n");
  for (const run of runs) {
    const progress = run.stepCount > 0 ? `${run.completedSteps}/${run.stepCount} steps` : "no plan";
    const truncatedGoal = run.goal.length > 60 ? `${run.goal.slice(0, 57)}...` : run.goal;
    const dryTag = run.dryRun ? " [dry]" : "";
    runtime.log(
      `  ${run.runId.slice(0, 8)}  ${(run.state + dryTag).padEnd(20)}  ${progress.padEnd(14)}  ${truncatedGoal}`,
    );
  }
  runtime.log(`\n${runs.length} run(s). Use "moltbot goal status <runId>" for details.`);
}
