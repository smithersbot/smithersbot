import { appendFileSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { resolveWorkingFile } from "./run-store.js";

/**
 * Resolves a relative path against the working directory and ensures
 * the result stays inside the sandbox. Throws on path traversal.
 */
export function resolveSafePath(relativePath: string, workingDir: string): string {
  if (!relativePath) throw new Error("Path is required");
  const resolved = path.resolve(workingDir, relativePath);
  // Trailing separator ensures /foo doesn't match /foobar
  if (!resolved.startsWith(workingDir + path.sep) && resolved !== workingDir) {
    throw new Error(`Path escapes working directory: ${relativePath}`);
  }
  return resolved;
}

/** Signal emitted by goal-specific tools during agent execution. */
export type GoalToolSignal =
  | { type: "task_complete"; summary: string }
  | { type: "user_input_needed"; question: string; context?: string }
  | {
      type: "task_failed";
      reason: string;
      whatTried: string;
      errorType: string;
      suggestedNext: string;
      needsRevert: boolean;
    };

/**
 * Create goal-specific custom tools for the PI agent session.
 *
 * Returns tool definitions plus a signal getter and reset function.
 * The executor checks `getSignal()` after each `session.prompt()` call
 * to determine whether the agent marked the task complete or needs user input.
 *
 * When `workingDir` is provided, includes the `delete_path` tool for safe
 * filesystem deletion within the workspace.
 */
export function createGoalTools(
  workingDir?: string,
  runId?: string,
): {
  tools: ToolDefinition[];
  getSignal: () => GoalToolSignal | null;
  reset: () => void;
  setActiveTask: (taskId: string) => void;
} {
  let activeTaskId: string | null = null;

  // Track all signal types independently. Precedence: blocked > failed > complete.
  let blockedSignal: { question: string; context?: string } | null = null;
  let failedSignal: {
    reason: string;
    whatTried: string;
    errorType: string;
    suggestedNext: string;
    needsRevert: boolean;
  } | null = null;
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

  const markTaskFailed: ToolDefinition = {
    name: "mark_task_failed",
    label: "Mark Task Failed",
    description:
      "Call this tool when you have genuinely tried and cannot complete the current task. " +
      "Provide structured details about what you tried and what went wrong.",
    parameters: Type.Object({
      reason: Type.String({ description: "Why the task cannot be completed" }),
      whatTried: Type.String({ description: "What approaches were attempted" }),
      errorType: Type.String({
        description:
          'Category: "build_failure", "test_failure", "missing_dependency", "design_unclear", or "other"',
      }),
      suggestedNext: Type.String({ description: "What should be tried differently next time" }),
      needsRevert: Type.Boolean({ description: "Whether changes made should be reverted" }),
    }),
    async execute(
      _toolCallId: string,
      params: {
        reason: string;
        whatTried: string;
        errorType: string;
        suggestedNext: string;
        needsRevert: boolean;
      },
    ) {
      // If already blocked on user input, this is a no-op.
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
      failedSignal = {
        reason: params.reason,
        whatTried: params.whatTried,
        errorType: params.errorType,
        suggestedNext: params.suggestedNext,
        needsRevert: params.needsRevert,
      };
      return {
        content: [
          {
            type: "text",
            text: "Task marked as failed. Do not call any more tools for this task.",
          },
        ],
        details: {},
      };
    },
  };

  const updateWorkingNotes: ToolDefinition = {
    name: "update_working_notes",
    label: "Update Working Notes",
    description:
      "Record what you've tried and learned for this task. " +
      "Notes persist across retries so future attempts can avoid repeating failures. " +
      "On difficulty: capture what failed, key hypotheses tried, and the next step. " +
      "On completion: write a brief note (3–6 bullets) covering what changed and what verification ran.",
    parameters: Type.Object({
      notes: Type.String({ description: "Markdown content to append to the working notes" }),
    }),
    async execute(_toolCallId: string, params: { notes: string }) {
      if (!runId || !activeTaskId) {
        return {
          content: [{ type: "text", text: "Error: no active task context for working notes." }],
          details: {},
        };
      }
      try {
        const filePath = resolveWorkingFile(runId, activeTaskId);
        const dir = path.dirname(filePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const header = `\n## Attempt at ${new Date().toISOString()}\n\n`;
        appendFileSync(filePath, header + params.notes + "\n", "utf8");
        return {
          content: [{ type: "text", text: "Working notes updated." }],
          details: {},
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error writing working notes: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: {},
        };
      }
    },
  };

  const tools: ToolDefinition[] = [
    markTaskComplete,
    requestUserInput,
    markTaskFailed,
    updateWorkingNotes,
  ];

  // delete_path: safe filesystem deletion within the workspace
  if (workingDir) {
    const deletePath: ToolDefinition = {
      name: "delete_path",
      label: "Delete Path",
      description:
        "Delete a file or directory within the workspace. " +
        "Use recursive: true for directories. Symlinks are refused for safety.",
      parameters: Type.Object({
        path: Type.String({ description: "Relative path within the workspace to delete" }),
        recursive: Type.Optional(
          Type.Boolean({ description: "Set true to delete directories recursively" }),
        ),
      }),
      async execute(_toolCallId: string, params: { path: string; recursive?: boolean }) {
        try {
          const resolved = resolveSafePath(params.path, workingDir);

          // Refuse workspace root
          if (resolved === workingDir) {
            return {
              content: [{ type: "text", text: "Error: cannot delete the workspace root." }],
              details: {},
            };
          }

          // Refuse symlinks
          let stat;
          try {
            stat = lstatSync(resolved);
          } catch {
            return {
              content: [{ type: "text", text: `Error: path does not exist: ${params.path}` }],
              details: {},
            };
          }
          if (stat.isSymbolicLink()) {
            return {
              content: [{ type: "text", text: "Error: refusing to delete symlink for safety." }],
              details: {},
            };
          }

          rmSync(resolved, { recursive: Boolean(params.recursive), force: true });
          return {
            content: [{ type: "text", text: `Deleted: ${params.path}` }],
            details: {},
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            details: {},
          };
        }
      },
    };
    tools.push(deletePath);
  }

  return {
    tools,
    // Precedence: blocked > failed > complete.
    getSignal: () => {
      if (blockedSignal) {
        return {
          type: "user_input_needed",
          question: blockedSignal.question,
          context: blockedSignal.context,
        };
      }
      if (failedSignal) {
        return {
          type: "task_failed",
          reason: failedSignal.reason,
          whatTried: failedSignal.whatTried,
          errorType: failedSignal.errorType,
          suggestedNext: failedSignal.suggestedNext,
          needsRevert: failedSignal.needsRevert,
        };
      }
      if (completeSignal) {
        return { type: "task_complete", summary: completeSignal.summary };
      }
      return null;
    },
    reset: () => {
      blockedSignal = null;
      failedSignal = null;
      completeSignal = null;
    },
    setActiveTask: (taskId: string) => {
      activeTaskId = taskId;
    },
  };
}
