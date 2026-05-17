export type TelegramPublicMenuCommand = {
  command: string;
};

export const PUBLIC_TELEGRAM_MENU: TelegramPublicMenuCommand[] = [
  { command: "new_goal" },
  { command: "goal_status" },
  { command: "goal_list" },
  { command: "goal_resume" },
  { command: "goal_stop" },
  { command: "repo_chat" },
  { command: "chat_backend" },
  { command: "nightwatch" },
  { command: "goal_lessons" },
  { command: "goal_plan_autocheck" },
  { command: "goal_semgrep" },
  { command: "goal_workers" },
  { command: "goal_github_push" },
  { command: "gateway_restart" },
  { command: "help" },
  { command: "commands" },
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
