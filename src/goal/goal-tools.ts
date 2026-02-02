import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

/** Signal emitted by goal-specific tools during agent execution. */
export type GoalToolSignal =
  | { type: "task_complete"; summary: string }
  | { type: "user_input_needed"; question: string; context?: string };

/**
 * Create goal-specific custom tools for the PI agent session.
 *
 * Returns tool definitions plus a signal getter and reset function.
 * The executor checks `getSignal()` after each `session.prompt()` call
 * to determine whether the agent marked the task complete or needs user input.
 */
export function createGoalTools(): {
  tools: ToolDefinition[];
  getSignal: () => GoalToolSignal | null;
  reset: () => void;
} {
  // Track both signal types independently so request_user_input always wins
  // even if the model also calls mark_task_complete in the same prompt cycle.
  let blockedSignal: { question: string; context?: string } | null = null;
  let completeSignal: { summary: string } | null = null;

  const markTaskComplete: ToolDefinition = {
    name: "mark_task_complete",
    label: "Mark Task Complete",
    description:
      "Call this tool when you have finished the current task. " +
      "Provide a brief summary of what you did.",
    parameters: Type.Object({
      summary: Type.String({ description: "Brief summary of what was accomplished" }),
    }),
    async execute(_toolCallId: string, params: { summary: string }) {
      // If the task is already blocked on user input, this is a no-op.
      if (blockedSignal) {
        return {
          content: [
            {
              type: "text",
              text: "This task is paused waiting for user input. Do not call any more tools.",
            },
          ],
          details: {},
        };
      }
      completeSignal = { summary: params.summary };
      return {
        content: [
          {
            type: "text",
            text: "Task marked complete. Do not call any more tools for this task.",
          },
        ],
        details: {},
      };
    },
  };

  const requestUserInput: ToolDefinition = {
    name: "request_user_input",
    label: "Request User Input",
    description:
      "Call this tool ONLY when you genuinely cannot proceed without information " +
      "from the user. Try to solve problems yourself first. This will pause the " +
      "current task and notify the user.",
    parameters: Type.Object({
      question: Type.String({ description: "Clear question for the user" }),
      context: Type.Optional(
        Type.String({ description: "Additional context about why this is needed" }),
      ),
    }),
    async execute(_toolCallId: string, params: { question: string; context?: string }) {
      blockedSignal = { question: params.question, context: params.context };
      return {
        content: [
          {
            type: "text",
            text: "User has been notified. This task is paused. Do not continue working on it.",
          },
        ],
        details: {},
      };
    },
  };

  return {
    tools: [markTaskComplete, requestUserInput],
    // Blocked always takes precedence over complete.
    getSignal: () => {
      if (blockedSignal) {
        return {
          type: "user_input_needed",
          question: blockedSignal.question,
          context: blockedSignal.context,
        };
      }
      if (completeSignal) {
        return { type: "task_complete", summary: completeSignal.summary };
      }
      return null;
    },
    reset: () => {
      blockedSignal = null;
      completeSignal = null;
    },
  };
}
