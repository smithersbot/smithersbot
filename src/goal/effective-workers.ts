import type { CliWorkerId, GoalConfig } from "../config/types.goal.js";
import { detectBackendAvailability } from "./backend-availability.js";
import type { BackendAvailability } from "./backend-types.js";
import { resolveEnabledWorkers } from "./backend-types.js";

export const NO_WORKER_BACKEND_ERROR =
  "No worker backend available. Install Codex or Claude Code and rerun.";

const PLANNER_WORKER_ORDER: CliWorkerId[] = ["claude_code", "codex"];

export function resolveEffectiveEnabledWorkers(params?: {
  config?: GoalConfig;
  availability?: BackendAvailability[];
}): CliWorkerId[] {
  const configuredWorkers = resolveEnabledWorkers(params?.config);
  const availability = params?.availability ?? detectBackendAvailability();
  const isAvailable = (backend: CliWorkerId) =>
    availability.find((entry) => entry.id === backend)?.available === true;

  return PLANNER_WORKER_ORDER.filter(
    (worker) => configuredWorkers.includes(worker) && isAvailable(worker),
  );
}

export function requireEffectiveEnabledWorkers(params?: {
  config?: GoalConfig;
  availability?: BackendAvailability[];
}): CliWorkerId[] {
  const workers = resolveEffectiveEnabledWorkers(params);
  if (workers.length === 0) {
    throw new Error(NO_WORKER_BACKEND_ERROR);
  }
  return workers;
}
