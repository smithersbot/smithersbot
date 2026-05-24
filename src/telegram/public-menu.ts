export type TelegramPublicMenuCommand = {
  command: string;
  label: TelegramPublicMenuLabel;
  publicDescription: string;
};

export type TelegramPublicMenuLabel =
  | "Core workflow"
  | "Repo chat"
  | "Goal diagnostics & tuning"
  | "Advanced & admin"
  | "Help";

export const PUBLIC_TELEGRAM_MENU_LABEL_ORDER: TelegramPublicMenuLabel[] = [
  "Core workflow",
  "Repo chat",
  "Goal diagnostics & tuning",
  "Advanced & admin",
  "Help",
];

export const PUBLIC_TELEGRAM_MENU: TelegramPublicMenuCommand[] = [
  {
    command: "new_goal",
    label: "Core workflow",
    publicDescription: "Create a new goal and receive a plan for approval.",
  },
  {
    command: "goal_status",
    label: "Core workflow",
    publicDescription: "Show status for a goal run.",
  },
  {
    command: "goal_list",
    label: "Core workflow",
    publicDescription: "List recent goal runs.",
  },
  {
    command: "goal_resume",
    label: "Core workflow",
    publicDescription: "Resume an interrupted goal run.",
  },
  {
    command: "goal_stop",
    label: "Core workflow",
    publicDescription: "Stop a running goal.",
  },
  {
    command: "repo_chat",
    label: "Repo chat",
    publicDescription: "Ask a read-only question about this repository.",
  },
  {
    command: "chat_backend",
    label: "Repo chat",
    publicDescription: "Set the repo chat backend.",
  },
  {
    command: "goal_lessons",
    label: "Goal diagnostics & tuning",
    publicDescription: "Show or manage goal lessons.",
  },
  {
    command: "goal_plan_autocheck",
    label: "Goal diagnostics & tuning",
    publicDescription: "Toggle automatic plan checks.",
  },
  {
    command: "goal_semgrep",
    label: "Goal diagnostics & tuning",
    publicDescription: "Configure Semgrep checks for goals.",
  },
  {
    command: "goal_workers",
    label: "Goal diagnostics & tuning",
    publicDescription: "Configure goal worker concurrency.",
  },
  {
    command: "goal_github_push",
    label: "Goal diagnostics & tuning",
    publicDescription: "Dangerous/admin: toggle automatic GitHub push and PR creation.",
  },
  {
    command: "nightwatch",
    label: "Advanced & admin",
    publicDescription: "Configure scheduled code review.",
  },
  {
    command: "gateway_status",
    label: "Advanced & admin",
    publicDescription: "Show gateway process and service status.",
  },
  {
    command: "usage_status",
    label: "Advanced & admin",
    publicDescription: "Show Claude Code and Codex usage quota.",
  },
  {
    command: "gateway_restart",
    label: "Advanced & admin",
    publicDescription: "Dangerous/admin: restart the gateway service.",
  },
  {
    command: "help",
    label: "Help",
    publicDescription: "Show SmithersBot operator help.",
  },
  {
    command: "commands",
    label: "Help",
    publicDescription: "List the public SmithersBot command surface.",
  },
];

export function buildPublicTelegramMenu(
  commandSpecs: Array<{ command: string; description: string }>,
): Array<{ command: string; description: string }> {
  const specsByName = new Map(commandSpecs.map((spec) => [spec.command.toLowerCase(), spec]));
  return PUBLIC_TELEGRAM_MENU.flatMap(({ command }) => {
    const spec = specsByName.get(command);
    return spec ? [spec] : [];
  });
}
