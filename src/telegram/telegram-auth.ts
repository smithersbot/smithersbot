import type { Bot } from "grammy";

import { resolveCommandAuthorizedFromAuthorizers } from "../channels/command-gating.js";
import type { ChannelGroupPolicy } from "../config/group-policy.js";
import type {
  TelegramAccountConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "../config/types.js";
import type { MoltbotConfig } from "../config/config.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { resolveTelegramForumThreadId } from "./bot/helpers.js";
import { firstDefined, isSenderAllowed, normalizeAllowFromWithStore } from "./bot-access.js";
import { readTelegramAllowFromStore } from "./pairing-store.js";

export type TelegramCommandAuthResult = {
  chatId: number;
  isGroup: boolean;
  isForum: boolean;
  resolvedThreadId?: number;
  senderId: string;
  senderUsername: string;
  groupConfig?: TelegramGroupConfig;
  topicConfig?: TelegramTopicConfig;
  commandAuthorized: boolean;
};

type TelegramCommandAuthMessage = {
  chat: { id: number; type: string; is_forum?: boolean; title?: string };
  from?: { id?: number; username?: string };
  message_thread_id?: number;
};

export async function resolveTelegramCommandAuth(params: {
  msg: TelegramCommandAuthMessage;
  bot: Bot;
  cfg: MoltbotConfig;
  telegramCfg: TelegramAccountConfig;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  useAccessGroups: boolean;
  resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId?: number,
  ) => { groupConfig?: TelegramGroupConfig; topicConfig?: TelegramTopicConfig };
  requireAuth: boolean;
}): Promise<TelegramCommandAuthResult | null> {
  const {
    msg,
    bot,
    cfg,
    telegramCfg,
    allowFrom,
    groupAllowFrom,
    useAccessGroups,
    resolveGroupPolicy,
    resolveTelegramGroupConfig,
    requireAuth,
  } = params;
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
  const isForum = (msg.chat as { is_forum?: boolean }).is_forum === true;
  const resolvedThreadId = resolveTelegramForumThreadId({
    isForum,
    messageThreadId,
  });
  const storeAllowFrom = await readTelegramAllowFromStore().catch(() => []);
  const { groupConfig, topicConfig } = resolveTelegramGroupConfig(chatId, resolvedThreadId);
  const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
  const effectiveGroupAllow = normalizeAllowFromWithStore({
    allowFrom: groupAllowOverride ?? groupAllowFrom,
    storeAllowFrom,
  });
  const hasGroupAllowOverride = typeof groupAllowOverride !== "undefined";
  const senderIdRaw = msg.from?.id;
  const senderId = senderIdRaw ? String(senderIdRaw) : "";
  const senderUsername = msg.from?.username ?? "";

  if (isGroup && groupConfig?.enabled === false) {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      fn: () => bot.api.sendMessage(chatId, "This group is disabled."),
    });
    return null;
  }
  if (isGroup && topicConfig?.enabled === false) {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      fn: () => bot.api.sendMessage(chatId, "This topic is disabled."),
    });
    return null;
  }
  if (requireAuth && isGroup && hasGroupAllowOverride) {
    if (
      senderIdRaw == null ||
      !isSenderAllowed({
        allow: effectiveGroupAllow,
        senderId: String(senderIdRaw),
        senderUsername,
      })
    ) {
      await withTelegramApiErrorLogging({
        operation: "sendMessage",
        fn: () => bot.api.sendMessage(chatId, "You are not authorized to use this command."),
      });
      return null;
    }
  }

  if (isGroup && useAccessGroups) {
    const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
    const groupPolicy = telegramCfg.groupPolicy ?? defaultGroupPolicy ?? "open";
    if (groupPolicy === "disabled") {
      await withTelegramApiErrorLogging({
        operation: "sendMessage",
        fn: () => bot.api.sendMessage(chatId, "Telegram group commands are disabled."),
      });
      return null;
    }
    if (groupPolicy === "allowlist" && requireAuth) {
      if (
        senderIdRaw == null ||
        !isSenderAllowed({
          allow: effectiveGroupAllow,
          senderId: String(senderIdRaw),
          senderUsername,
        })
      ) {
        await withTelegramApiErrorLogging({
          operation: "sendMessage",
          fn: () => bot.api.sendMessage(chatId, "You are not authorized to use this command."),
        });
        return null;
      }
    }
    const groupAllowlist = resolveGroupPolicy(chatId);
    if (groupAllowlist.allowlistEnabled && !groupAllowlist.allowed) {
      await withTelegramApiErrorLogging({
        operation: "sendMessage",
        fn: () => bot.api.sendMessage(chatId, "This group is not allowed."),
      });
      return null;
    }
  }

  const dmAllow = normalizeAllowFromWithStore({
    allowFrom: allowFrom,
    storeAllowFrom,
  });
  const senderAllowed = isSenderAllowed({
    allow: dmAllow,
    senderId,
    senderUsername,
  });
  const commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
    useAccessGroups,
    authorizers: [{ configured: dmAllow.hasEntries, allowed: senderAllowed }],
    modeWhenAccessGroupsOff: "configured",
  });
  if (requireAuth && !commandAuthorized) {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      fn: () => bot.api.sendMessage(chatId, "You are not authorized to use this command."),
    });
    return null;
  }

  return {
    chatId,
    isGroup,
    isForum,
    resolvedThreadId,
    senderId,
    senderUsername,
    groupConfig,
    topicConfig,
    commandAuthorized,
  };
}
