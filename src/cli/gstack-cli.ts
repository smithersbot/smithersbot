import { Option, type Command } from "commander";
import type { ClaudeCodeAuthMode } from "../config/types.goal.js";
import { runGstack } from "../commands/gstack-runner.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { formatHelpExamples } from "./help-format.js";

const GSTACK_AUTH_CHOICES = ["subscription", "api_key"] as const satisfies ClaudeCodeAuthMode[];

export function registerGstackCli(program: Command) {
  program
    .command("gstack")
    .description("Launch Claude Code with the goal permission stack")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument("[args...]", "Additional args to pass through to Claude Code")
    .addOption(
      new Option(
        "--claude-code-auth <mode>",
        "Claude Code auth: subscription, api_key (default: subscription)",
      )
        .choices([...GSTACK_AUTH_CHOICES])
        .default("subscription"),
    )
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["moltbot gstack", "Launch an interactive Claude Code session"],
          ["moltbot gstack --claude-code-auth api_key", "Use API key auth passthrough"],
          ["moltbot gstack -- --resume", "Pass additional flags directly to Claude Code"],
        ])}\n`,
    )
    .action(async (args: string[], opts: { claudeCodeAuth: ClaudeCodeAuthMode }) => {
      try {
        const result = await runGstack({
          claudeCodeAuth: opts.claudeCodeAuth,
          args,
        });
        process.exit(result.exitCode ?? 1);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}
