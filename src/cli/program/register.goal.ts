import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import type { GoalBackendId } from "../../goal/backend-types.js";
import type { ClaudeCodeAuthMode } from "../../config/types.goal.js";
import type { DiagramMode, OutputFormat } from "../../goal/types.js";
import { theme } from "../../terminal/theme.js";
import { formatHelpExamples } from "../help-format.js";
import { runCommandWithRuntime } from "../cli-utils.js";

export function registerGoalCommand(program: Command) {
  const goal = program
    .command("goal [goal]")
    .description("Plan and execute a high-level goal autonomously")
    .option("--model <id>", "Model id (default: claude-sonnet-4-20250514)")
    .option(
      "--working-dir <dir>",
      "Working directory for file operations (default: .moltbot-goal-workspace)",
    )
    .option("--yes", "Auto-approve plan without prompting", false)
    .option("--no-git-checkpoints", "Disable git checkpoints during execution")
    .option("--json", "Output as JSON (shorthand for --output json)", false)
    .option("--dry-run", "Generate and display plan without executing", false)
    .option("--plan-only", "Generate and persist a plan, then stop before execution", false)
    .option("--scout-timeout <minutes>", "Scout timeout in minutes (default: 20)")
    .option(
      "--diagram <mode>",
      "Diagram format: none, ascii, mermaid, both (default: both for md, none for json)",
    )
    .option("--output <format>", "Output format: md, json (default: md)")
    .option(
      "--backend <backend>",
      "Execution backend: pi, codex, claude_code (default: claude_code)",
    )
    .option(
      "--claude-code-auth <mode>",
      "Claude Code auth: subscription, api_key (default: subscription)",
    )
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ['moltbot goal "Create a REST API with Express"', "Plan and build a project"],
          ['moltbot goal "Add a README to the current repo" --yes', "Auto-approve plan"],
          ['moltbot goal "Refactor auth module" --dry-run', "Preview plan only"],
          ['moltbot goal "Build landing page" --dry-run --diagram mermaid', "Mermaid diagram only"],
          ['moltbot goal "Build landing page" --dry-run --output json', "JSON output"],
          ["moltbot goal list", "List all goal runs"],
          ["moltbot goal status <runId>", "Show concise status: state, progress, blocker, retries"],
          ["moltbot goal resume <runId>", "Resume a blocked/interrupted run"],
          ["moltbot goal stop <runId>", "Stop a running goal"],
          [
            "moltbot goal answer <runId> --key <KEY> --value <VALUE>",
            "Answer a blocked run's question",
          ],
        ])}`,
    )
    .action(async (goalText, opts) => {
      if (!goalText) {
        goal.outputHelp();
        return;
      }
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { goalCommand } = await import("../../commands/goal.js");
        const scoutTimeoutMinutes = opts.scoutTimeout
          ? Number.parseFloat(String(opts.scoutTimeout))
          : undefined;
        const scoutTimeoutMs =
          scoutTimeoutMinutes && Number.isFinite(scoutTimeoutMinutes)
            ? scoutTimeoutMinutes * 60_000
            : undefined;

        await goalCommand(
          {
            goal: String(goalText),
            model: opts.model as string | undefined,
            workingDir: opts.workingDir as string | undefined,
            yes: Boolean(opts.yes),
            noGitCheckpoints: opts.gitCheckpoints === false,
            json: Boolean(opts.json),
            dryRun: Boolean(opts.dryRun),
            planOnly: Boolean(opts.planOnly),
            scoutTimeoutMs,
            diagram: opts.diagram as DiagramMode | undefined,
            output: opts.output as OutputFormat | undefined,
            backend: opts.backend as GoalBackendId | undefined,
            claudeCodeAuth: opts.claudeCodeAuth as ClaudeCodeAuthMode | undefined,
          },
          defaultRuntime,
        );
      });
    });

  // Subcommand: list
  goal
    .command("list")
    .description("List all goal runs")
    .option("--json", "Output as JSON (shorthand for --output json)", false)
    .option("--output <format>", "Output format: md, json (default: md)")
    .option("--limit <n>", "Max runs to show (default: 20)", "20")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { goalListCommand } = await import("../../commands/goal-list.js");
        await goalListCommand(
          {
            json: Boolean(opts.json),
            output: opts.output as OutputFormat | undefined,
            limit: Number.parseInt(String(opts.limit), 10) || 20,
          },
          defaultRuntime,
        );
      });
    });

  // Subcommand: status
  goal
    .command("status <runId>")
    .description("Show concise goal status (state, progress, blocker, retries)")
    .option("--json", "Output as JSON (shorthand for --output json)", false)
    .option("--output <format>", "Output format: md, json (default: md)")
    .option("--diagram <mode>", "Diagram format: none, ascii, mermaid, both (default: none)")
    .addHelpText(
      "after",
      () =>
        "\nConcise layout order: headline, progress, blocker (if any), retries.\n" +
        "Telegram status replies are capped to a readable line budget (~15 lines).\n",
    )
    .action(async (runId, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { goalStatusCommand } = await import("../../commands/goal-status.js");
        await goalStatusCommand(
          String(runId),
          {
            json: Boolean(opts.json),
            output: opts.output as OutputFormat | undefined,
            diagram: opts.diagram as DiagramMode | undefined,
          },
          defaultRuntime,
        );
      });
    });

  // Subcommand: resume
  goal
    .command("resume <runId>")
    .description("Resume a blocked or interrupted goal run")
    .option("--yes", "Auto-approve without prompting", false)
    .option("--json", "Output as JSON (shorthand for --output json)", false)
    .option("--output <format>", "Output format: md, json (default: md)")
    .option("--replan", "Retry planning phase for incomplete runs", false)
    .action(async (runId, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { goalResumeCommand } = await import("../../commands/goal-resume.js");
        await goalResumeCommand(
          String(runId),
          {
            yes: Boolean(opts.yes),
            json: Boolean(opts.json),
            output: opts.output as OutputFormat | undefined,
            replan: Boolean(opts.replan),
          },
          defaultRuntime,
        );
      });
    });

  // Subcommand: answer
  goal
    .command("answer <runId>")
    .description("Provide input to unblock a goal run")
    .requiredOption("--key <key>", "The required input key (shown in status/blocked output)")
    .requiredOption("--value <value>", "The value to provide")
    .option("--json", "Output as JSON (shorthand for --output json)", false)
    .option("--output <format>", "Output format: md, json (default: md)")
    .action(async (runId, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { goalAnswerCommand } = await import("../../commands/goal-answer.js");
        await goalAnswerCommand(
          String(runId),
          {
            key: String(opts.key),
            value: String(opts.value),
            json: Boolean(opts.json),
            output: opts.output as OutputFormat | undefined,
          },
          defaultRuntime,
        );
      });
    });

  // Subcommand: stop
  goal
    .command("stop <runId>")
    .description("Stop a running goal execution")
    .option("--json", "Output as JSON (shorthand for --output json)", false)
    .option("--force", "Force stop even if not in executing state", false)
    .action(async (runId, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { goalStopCommand } = await import("../../commands/goal-stop.js");
        await goalStopCommand(
          String(runId),
          {
            json: Boolean(opts.json),
            force: Boolean(opts.force),
          },
          defaultRuntime,
        );
      });
    });
}
