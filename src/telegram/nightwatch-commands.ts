import type { Bot, Context } from "grammy";

import { resolveChannelConfigWrites } from "../channels/plugins/config-writes.js";
import type { MoltbotConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import type { ChannelGroupPolicy } from "../config/group-policy.js";
import { writeConfigFile } from "../config/io.js";
import type { NightwatchConfig } from "../config/types.cron.js";
import type {
  TelegramAccountConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "../config/types.js";
import { NIGHTWATCH_DEFAULTS } from "../cron/nightwatch.js";
import { resolveTelegramCommandAuth } from "./telegram-auth.js";

export const NIGHTWATCH_COMMAND_SPECS: Array<{ command: string; description: string }> = [
  {
    command: "nightwatch",
    description: "Configure nightwatch daily code review schedule",
  },
];

const NIGHTWATCH_USAGE = [
  "Usage:",
  "/nightwatch",
  "/nightwatch on",
  "/nightwatch off",
  "/nightwatch time HH:MM",
  "/nightwatch tz Area/City",
  "/nightwatch chat",
].join("\n");

type TelegramNightwatchCommandContext = Context & { match?: string };

type RegisterTelegramNightwatchCommandParams = {
  bot: Bot;
  cfg: MoltbotConfig;
  accountId: string;
  telegramCfg: TelegramAccountConfig;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  useAccessGroups: boolean;
  resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId?: number,
  ) => { groupConfig?: TelegramGroupConfig; topicConfig?: TelegramTopicConfig };
  shouldSkipUpdate: (ctx: unknown) => boolean;
};

function parseTimeInput(raw: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const hour = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function toDailyCronExpr(time: { hour: number; minute: number }): string {
  return `${time.minute} ${time.hour} * * *`;
}

function parseDailyCronExpr(cronExpr: string): { hour: number; minute: number } | null {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minuteRaw, hourRaw, dayRaw, monthRaw, weekdayRaw] = parts;
  if (dayRaw !== "*" || monthRaw !== "*" || weekdayRaw !== "*") return null;
  const minute = Number.parseInt(minuteRaw ?? "", 10);
  const hour = Number.parseInt(hourRaw ?? "", 10);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function formatHourMinute(hour: number, minute: number): string {
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function formatCronTime(cronExpr: string): string {
  const parsed = parseDailyCronExpr(cronExpr);
  if (!parsed) return cronExpr;
  return formatHourMinute(parsed.hour, parsed.minute);
}

function formatNightwatchStatus(nightwatchCfg: NightwatchConfig | undefined): string {
  const enabled = nightwatchCfg?.enabled === true;
  const cronExpr = nightwatchCfg?.cronExpr ?? NIGHTWATCH_DEFAULTS.cronExpr;
  const timezone = nightwatchCfg?.timezone ?? NIGHTWATCH_DEFAULTS.timezone;
  const repoPath = nightwatchCfg?.repoPath ?? NIGHTWATCH_DEFAULTS.repoPath;
  const chatId =
    nightwatchCfg?.telegramChatId == null || String(nightwatchCfg.telegramChatId).trim() === ""
      ? "(not set)"
      : String(nightwatchCfg.telegramChatId);

  return [
    `Nightwatch: ${enabled ? "enabled" : "disabled"}`,
    `Schedule: ${formatCronTime(cronExpr)} (${cronExpr})`,
    `Timezone: ${timezone}`,
    `Repo path: ${repoPath}`,
    `Telegram chat: ${chatId}`,
  ].join("\n");
}

function patchNightwatchConfig(
  nextConfig: MoltbotConfig,
  patch: Partial<NightwatchConfig>,
): NightwatchConfig {
  nextConfig.cron ??= {};
  const nextNightwatch = {
    ...nextConfig.cron.nightwatch,
    ...patch,
  };
  nextConfig.cron.nightwatch = nextNightwatch;
  return nextNightwatch;
}

export function registerTelegramNightwatchCommand({
  bot,
  cfg,
  accountId,
  telegramCfg,
  allowFrom,
  groupAllowFrom,
  useAccessGroups,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
}: RegisterTelegramNightwatchCommandParams): void {
  async function sendReply(
    chatId: number,
    text: string,
    threadId?: number,
    replyToMessageId?: number,
  ): Promise<void> {
    const threadParams = threadId != null ? { message_thread_id: threadId } : {};
    const replyParams =
      replyToMessageId != null ? { reply_parameters: { message_id: replyToMessageId } } : {};
    await bot.api.sendMessage(chatId, text, { ...threadParams, ...replyParams });
  }

  async function authAndResolve(ctx: TelegramNightwatchCommandContext) {
    const msg = ctx.message;
    if (!msg) return null;
    if (shouldSkipUpdate(ctx)) return null;
    const auth = await resolveTelegramCommandAuth({
      msg,
      bot,
      cfg,
      telegramCfg,
      allowFrom,
      groupAllowFrom,
      useAccessGroups,
      resolveGroupPolicy,
      resolveTelegramGroupConfig,
      requireAuth: true,
    });
    if (!auth) return null;
    const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
    const threadIdForSend = auth.isGroup ? auth.resolvedThreadId : messageThreadId;
    const replyToMessageId = typeof msg.message_id === "number" ? msg.message_id : undefined;
    return {
      chatId: auth.chatId,
      threadIdForSend,
      messageThreadId,
      commandChatId: msg.chat.id,
      replyToMessageId,
    };
  }

  async function canWriteConfig(
    chatId: number,
    threadId?: number,
    replyToMessageId?: number,
  ): Promise<boolean> {
    if (resolveChannelConfigWrites({ cfg, channelId: "telegram", accountId })) {
      return true;
    }
    await sendReply(
      chatId,
      "Config writes are disabled for this Telegram account.",
      threadId,
      replyToMessageId,
    );
    return false;
  }

  async function writeNightwatchPatch(patch: Partial<NightwatchConfig>): Promise<NightwatchConfig> {
    const nextConfig = loadConfig();
    const nextNightwatch = patchNightwatchConfig(nextConfig, patch);
    await writeConfigFile(nextConfig);

    patchNightwatchConfig(cfg, patch);
    return nextNightwatch;
  }

  bot.command("nightwatch", async (ctx: TelegramNightwatchCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;

    const raw = ctx.match?.trim() ?? "";
    if (!raw) {
      const nightwatchCfg = loadConfig().cron?.nightwatch;
      await sendReply(
        resolved.chatId,
        formatNightwatchStatus(nightwatchCfg),
        resolved.threadIdForSend,
        resolved.replyToMessageId,
      );
      return;
    }

    const [subcommandRaw, ...rest] = raw.split(/\s+/);
    const subcommand = (subcommandRaw ?? "").toLowerCase();

    if (subcommand === "on") {
      if (
        !(await canWriteConfig(
          resolved.chatId,
          resolved.threadIdForSend,
          resolved.replyToMessageId,
        ))
      )
        return;
      const nextNightwatch = await writeNightwatchPatch({ enabled: true });
      await sendReply(
        resolved.chatId,
        `Nightwatch enabled.\n\n${formatNightwatchStatus(nextNightwatch)}`,
        resolved.threadIdForSend,
        resolved.replyToMessageId,
      );
      return;
    }

    if (subcommand === "off") {
      if (
        !(await canWriteConfig(
          resolved.chatId,
          resolved.threadIdForSend,
          resolved.replyToMessageId,
        ))
      )
        return;
      const nextNightwatch = await writeNightwatchPatch({ enabled: false });
      await sendReply(
        resolved.chatId,
        `Nightwatch disabled.\n\n${formatNightwatchStatus(nextNightwatch)}`,
        resolved.threadIdForSend,
        resolved.replyToMessageId,
      );
      return;
    }

    if (subcommand === "time") {
      const timeRaw = rest.join(" ").trim();
      const parsed = parseTimeInput(timeRaw);
      if (!parsed) {
        await sendReply(
          resolved.chatId,
          `Invalid time: "${timeRaw}". Use HH:MM in 24-hour format.\n${NIGHTWATCH_USAGE}`,
          resolved.threadIdForSend,
          resolved.replyToMessageId,
        );
        return;
      }
      if (
        !(await canWriteConfig(
          resolved.chatId,
          resolved.threadIdForSend,
          resolved.replyToMessageId,
        ))
      )
        return;
      const nextNightwatch = await writeNightwatchPatch({
        cronExpr: toDailyCronExpr(parsed),
      });
      await sendReply(
        resolved.chatId,
        `Nightwatch schedule updated.\n\n${formatNightwatchStatus(nextNightwatch)}`,
        resolved.threadIdForSend,
        resolved.replyToMessageId,
      );
      return;
    }

    if (subcommand === "tz") {
      const timezone = rest.join(" ").trim();
      if (!timezone) {
        await sendReply(
          resolved.chatId,
          `Timezone is required.\n${NIGHTWATCH_USAGE}`,
          resolved.threadIdForSend,
          resolved.replyToMessageId,
        );
        return;
      }
      try {
        new Intl.DateTimeFormat("en", { timeZone: timezone });
      } catch {
        await sendReply(
          resolved.chatId,
          `Invalid timezone: "${timezone}".`,
          resolved.threadIdForSend,
          resolved.replyToMessageId,
        );
        return;
      }
      if (
        !(await canWriteConfig(
          resolved.chatId,
          resolved.threadIdForSend,
          resolved.replyToMessageId,
        ))
      )
        return;
      const nextNightwatch = await writeNightwatchPatch({ timezone });
      await sendReply(
        resolved.chatId,
        `Nightwatch timezone updated.\n\n${formatNightwatchStatus(nextNightwatch)}`,
        resolved.threadIdForSend,
        resolved.replyToMessageId,
      );
      return;
    }

    if (subcommand === "chat") {
      if (
        !(await canWriteConfig(
          resolved.chatId,
          resolved.threadIdForSend,
          resolved.replyToMessageId,
        ))
      )
        return;
      const patch: Partial<NightwatchConfig> = {
        telegramChatId: String(resolved.commandChatId),
        telegramAccountId: accountId,
      };
      if (resolved.messageThreadId != null) {
        patch.telegramThreadId = resolved.messageThreadId;
      }
      const nextNightwatch = await writeNightwatchPatch(patch);
      await sendReply(
        resolved.chatId,
        `Nightwatch plans will be sent to this chat.\n\n${formatNightwatchStatus(nextNightwatch)}`,
        resolved.threadIdForSend,
        resolved.replyToMessageId,
      );
      return;
    }

    await sendReply(
      resolved.chatId,
      NIGHTWATCH_USAGE,
      resolved.threadIdForSend,
      resolved.replyToMessageId,
    );
  });
}
