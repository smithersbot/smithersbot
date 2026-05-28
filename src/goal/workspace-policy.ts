import {
  isPathInsideAgentRoot,
  isPathInsidePrivateRoot,
  resolveAgentRoot,
} from "../config/managed-paths.js";
import type { GoalConfig } from "../config/types.goal.js";

export const LEGACY_WORKING_DIR_WARNING =
  "[goal] Workspace is outside the SmithersBot managed agent root; allowing legacy workingDir for Stage 2S compatibility.";

export function isLegacyWorkingDirAllowed(config: GoalConfig | undefined): boolean {
  return config?.allowLegacyWorkingDir !== false;
}

export function assertGoalWorkerWorkspace(params: {
  workingDir: string;
  config?: GoalConfig;
  onWarning?: (message: string) => void;
}): void {
  if (isPathInsidePrivateRoot(params.workingDir)) {
    throw new Error("Goal worker workspace cannot be inside SmithersBot private paths.");
  }

  if (isPathInsideAgentRoot(params.workingDir)) return;

  if (!isLegacyWorkingDirAllowed(params.config)) {
    throw new Error(
      `Goal worker workspace must be inside the managed agent root (${resolveAgentRoot()}); got ${params.workingDir}`,
    );
  }

  params.onWarning?.(`${LEGACY_WORKING_DIR_WARNING} Workspace: ${params.workingDir}`);
}
