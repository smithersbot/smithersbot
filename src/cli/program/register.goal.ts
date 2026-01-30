import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
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
    .option("--json", "Output as JSON (shorthand for --output json)", false)
    .option("--dry-run", "Generate and display plan without executing", false)
    .option(
      "--diagram <mode>",
      "Diagram format: none, ascii, mermaid, both (default: both for md, none for json)",
    )
    .option("--output <format>", "Output format: md, json (default: md)")
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
          ["moltbot goal status <runId>", "Show run details"],
          ["moltbot goal resume <runId>", "Resume a blocked/interrupted run"],
        ])}`,
    )
    .action(async (goalText, opts) => {
      if (!goalText) {
        goal.outputHelp();
        return;
      }
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { goalCommand } = await import("../../commands/goal.js");
        await goalCommand(
          {
            goal: String(goalText),
            model: opts.model as string | undefined,
            workingDir: opts.workingDir as string | undefined,
            yes: Boolean(opts.yes),
            json: Boolean(opts.json),
            dryRun: Boolean(opts.dryRun),
            diagram: opts.diagram as DiagramMode | undefined,
            output: opts.output as OutputFormat | undefined,
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
    .description("Show details for a specific goal run")
    .option("--json", "Output as JSON (shorthand for --output json)", false)
    .option("--output <format>", "Output format: md, json (default: md)")
    .option("--diagram <mode>", "Diagram format: none, ascii, mermaid, both (default: both)")
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
    .action(async (runId, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { goalResumeCommand } = await import("../../commands/goal-resume.js");
        await goalResumeCommand(
          String(runId),
          {
            yes: Boolean(opts.yes),
            json: Boolean(opts.json),
            output: opts.output as OutputFormat | undefined,
          },
          defaultRuntime,
        );
      });
    });
}
