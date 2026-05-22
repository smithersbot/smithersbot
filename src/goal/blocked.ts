import type { BlockedDetail, PlanStep } from "./types.js";

function buildStuckPrompt(step: PlanStep): string {
  return `Step ${step.id} stuck at in_progress — needs re-execution`;
}

function isUserInputBlocked(step: PlanStep): boolean {
  return step.blockedReason === "user_input" || step.blockedReason == null;
}

export function aggregateBlockedDetails(steps: PlanStep[]): BlockedDetail | null {
  const blocked = steps.filter((s) => s.status === "blocked");
  const stuckInProgress = steps.filter((s) => s.status === "in_progress");
  if (blocked.length === 0 && stuckInProgress.length === 0) return null;

  // Keep the legacy blocked-only contract untouched for existing callers.
  if (stuckInProgress.length === 0) {
    if (blocked.length === 1) {
      const task = blocked[0]!;
      const prompt =
        task.blockedQuestion ?? `Task ${task.id} is blocked (${task.blockedReason ?? "unknown"}).`;
      const requiredInputKey = isUserInputBlocked(task)
        ? `task:${task.id}:input`
        : "resume_execution";
      return {
        blockedAt: "execution",
        prompt,
        requiredInputKey,
        stepId: task.id,
      };
    }

    const lines = blocked.map((task) => {
      const reason = task.blockedQuestion ?? task.blockedReason ?? "unknown";
      return `- Task ${task.id} (${task.description}): ${reason}`;
    });
    return {
      blockedAt: "execution",
      prompt: `Multiple tasks need attention:\n${lines.join("\n")}`,
      requiredInputKey: blocked.every(isUserInputBlocked)
        ? `tasks:${blocked.map((t) => t.id).join(",")}:input`
        : "resume_execution",
    };
  }

  if (blocked.length === 0 && stuckInProgress.length === 1) {
    return {
      blockedAt: "execution",
      prompt: buildStuckPrompt(stuckInProgress[0]!),
      requiredInputKey: "resume_execution",
    };
  }

  const blockedLines = blocked.map((task) => {
    const reason = task.blockedQuestion ?? task.blockedReason ?? "unknown";
    return `- Task ${task.id} (${task.description}): ${reason}`;
  });
  const stuckLines = stuckInProgress.map(
    (step) => `- Step ${step.id} (${step.description}): ${buildStuckPrompt(step)}`,
  );
  const lines = [...blockedLines, ...stuckLines];
  return {
    blockedAt: "execution",
    prompt: `Multiple tasks need attention:\n${lines.join("\n")}`,
    requiredInputKey: "resume_execution",
  };
}
