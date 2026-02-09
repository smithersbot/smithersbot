import type { BlockedDetail, PlanStep } from "./types.js";

export function aggregateBlockedDetails(steps: PlanStep[]): BlockedDetail | null {
  const blocked = steps.filter((s) => s.status === "blocked");
  if (blocked.length === 0) return null;

  if (blocked.length === 1) {
    const task = blocked[0]!;
    const prompt =
      task.blockedQuestion ?? `Task ${task.id} is blocked (${task.blockedReason ?? "unknown"}).`;
    return {
      blockedAt: "execution",
      prompt,
      requiredInputKey: `task:${task.id}:input`,
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
    requiredInputKey: `tasks:${blocked.map((t) => t.id).join(",")}:input`,
  };
}
