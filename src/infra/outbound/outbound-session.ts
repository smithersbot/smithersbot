import type { MsgContext } from "../../auto-reply/templating.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import type { MoltbotConfig } from "../../config/config.js";
import { recordSessionMetaFromInbound, resolveStorePath } from "../../config/sessions.js";
import {
  buildAgentSessionKey,
  type RoutePeer,
  type RoutePeerKind,
} from "../../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../../routing/session-key.js";
import { buildTelegramGroupPeerId } from "../../telegram/bot/helpers.js";
import { resolveTelegramTargetChatType } from "../../telegram/inline-buttons.js";
import { parseTelegramTarget } from "../../telegram/targets.js";
import type { ResolvedMessagingTarget } from "./target-resolver.js";

export type OutboundSessionRoute = {
  sessionKey: string;
  baseSessionKey: string;
  peer: RoutePeer;
  chatType: "direct" | "group" | "channel";
  from: string;
  to: string;
  threadId?: string | number;
};

export type ResolveOutboundSessionRouteParams = {
  cfg: MoltbotConfig;
  channel: ChannelId;
  agentId: string;
  accountId?: string | null;
  target: string;
  resolvedTarget?: ResolvedMessagingTarget;
  replyToId?: string | null;
  threadId?: string | number | null;
};

function normalizeThreadId(value?: string | number | null): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return String(Math.trunc(value));
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function stripProviderPrefix(raw: string, channel: string): string {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  const prefix = `${channel.toLowerCase()}:`;
  if (lower.startsWith(prefix)) return trimmed.slice(prefix.length).trim();
  return trimmed;
}

function stripKindPrefix(raw: string): string {
  return raw.replace(/^(user|channel|group|conversation|room|dm):/i, "").trim();
}

function inferPeerKind(params: {
  channel: ChannelId;
  resolvedTarget?: ResolvedMessagingTarget;
}): RoutePeerKind {
  const resolvedKind = params.resolvedTarget?.kind;
  if (resolvedKind === "user") return "dm";
  if (resolvedKind === "channel") return "channel";
  if (resolvedKind === "group") {
    const plugin = getChannelPlugin(params.channel);
    const chatTypes = plugin?.capabilities?.chatTypes ?? [];
    const supportsChannel = chatTypes.includes("channel");
    const supportsGroup = chatTypes.includes("group");
    if (supportsChannel && !supportsGroup) return "channel";
    return "group";
  }
  return "dm";
}

function buildBaseSessionKey(params: {
  cfg: MoltbotConfig;
  agentId: string;
  channel: ChannelId;
  accountId?: string | null;
  peer: RoutePeer;
}): string {
  return buildAgentSessionKey({
    agentId: params.agentId,
    channel: params.channel,
    accountId: params.accountId,
    peer: params.peer,
    dmScope: params.cfg.session?.dmScope ?? "main",
    identityLinks: params.cfg.session?.identityLinks,
  });
}

function resolveTelegramSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const parsed = parseTelegramTarget(params.target);
  const chatId = parsed.chatId.trim();
  if (!chatId) return null;
  const parsedThreadId = parsed.messageThreadId;
  const fallbackThreadId = normalizeThreadId(params.threadId);
  const resolvedThreadId =
    parsedThreadId ?? (fallbackThreadId ? Number.parseInt(fallbackThreadId, 10) : undefined);
  // Telegram topics are encoded in the peer id (chatId:topic:<id>).
  const chatType = resolveTelegramTargetChatType(params.target);
  // If the target is a username and we lack a resolvedTarget, default to DM to avoid group keys.
  const isGroup =
    chatType === "group" ||
    (chatType === "unknown" &&
      params.resolvedTarget?.kind &&
      params.resolvedTarget.kind !== "user");
  const peerId = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : chatId;
  const peer: RoutePeer = {
    kind: isGroup ? "group" : "dm",
    id: peerId,
  };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "telegram",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `telegram:group:${peerId}` : `telegram:${chatId}`,
    to: `telegram:${chatId}`,
    threadId: resolvedThreadId,
  };
}

function resolveMSTeamsSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  let trimmed = params.target.trim();
  if (!trimmed) return null;
  trimmed = trimmed.replace(/^(msteams|teams):/i, "").trim();

  const lower = trimmed.toLowerCase();
  const isUser = lower.startsWith("user:");
  const rawId = stripKindPrefix(trimmed);
  if (!rawId) return null;
  const conversationId = rawId.split(";")[0] ?? rawId;
  const isChannel = !isUser && /@thread\.tacv2/i.test(conversationId);
  const peer: RoutePeer = {
    kind: isUser ? "dm" : isChannel ? "channel" : "group",
    id: conversationId,
  };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "msteams",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: isUser ? "direct" : isChannel ? "channel" : "group",
    from: isUser
      ? `msteams:${conversationId}`
      : isChannel
        ? `msteams:channel:${conversationId}`
        : `msteams:group:${conversationId}`,
    to: isUser ? `user:${conversationId}` : `conversation:${conversationId}`,
  };
}

function resolveMattermostSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  let trimmed = params.target.trim();
  if (!trimmed) return null;
  trimmed = trimmed.replace(/^mattermost:/i, "").trim();
  const lower = trimmed.toLowerCase();
  const isUser = lower.startsWith("user:") || trimmed.startsWith("@");
  if (trimmed.startsWith("@")) {
    trimmed = trimmed.slice(1).trim();
  }
  const rawId = stripKindPrefix(trimmed);
  if (!rawId) return null;
  const peer: RoutePeer = { kind: isUser ? "dm" : "channel", id: rawId };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "mattermost",
    accountId: params.accountId,
    peer,
  });
  const threadId = normalizeThreadId(params.replyToId ?? params.threadId);
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey,
    threadId,
  });
  return {
    sessionKey: threadKeys.sessionKey,
    baseSessionKey,
    peer,
    chatType: isUser ? "direct" : "channel",
    from: isUser ? `mattermost:${rawId}` : `mattermost:channel:${rawId}`,
    to: isUser ? `user:${rawId}` : `channel:${rawId}`,
    threadId,
  };
}

function resolveBlueBubblesSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const stripped = stripProviderPrefix(params.target, "bluebubbles");
  const lower = stripped.toLowerCase();
  const isGroup =
    lower.startsWith("chat_id:") ||
    lower.startsWith("chat_guid:") ||
    lower.startsWith("chat_identifier:") ||
    lower.startsWith("group:");
  const rawPeerId = isGroup
    ? stripKindPrefix(stripped)
    : stripped.replace(/^(imessage|sms|auto):/i, "");
  // BlueBubbles inbound group ids omit chat_* prefixes; strip them to align sessions.
  const peerId = isGroup
    ? rawPeerId.replace(/^(chat_id|chat_guid|chat_identifier):/i, "")
    : rawPeerId;
  if (!peerId) return null;
  const peer: RoutePeer = {
    kind: isGroup ? "group" : "dm",
    id: peerId,
  };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "bluebubbles",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `group:${peerId}` : `bluebubbles:${peerId}`,
    to: `bluebubbles:${stripped}`,
  };
}

function resolveZaloSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const trimmed = stripProviderPrefix(params.target, "zalo")
    .replace(/^(zl):/i, "")
    .trim();
  if (!trimmed) return null;
  const isGroup = trimmed.toLowerCase().startsWith("group:");
  const peerId = stripKindPrefix(trimmed);
  const peer: RoutePeer = { kind: isGroup ? "group" : "dm", id: peerId };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "zalo",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `zalo:group:${peerId}` : `zalo:${peerId}`,
    to: `zalo:${peerId}`,
  };
}

function resolveFallbackSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const trimmed = stripProviderPrefix(params.target, params.channel).trim();
  if (!trimmed) return null;
  const peerKind = inferPeerKind({
    channel: params.channel,
    resolvedTarget: params.resolvedTarget,
  });
  const peerId = stripKindPrefix(trimmed);
  if (!peerId) return null;
  const peer: RoutePeer = { kind: peerKind, id: peerId };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: params.channel,
    peer,
  });
  const chatType = peerKind === "dm" ? "direct" : peerKind === "channel" ? "channel" : "group";
  const from =
    peerKind === "dm" ? `${params.channel}:${peerId}` : `${params.channel}:${peerKind}:${peerId}`;
  const toPrefix = peerKind === "dm" ? "user" : "channel";
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType,
    from,
    to: `${toPrefix}:${peerId}`,
  };
}

export async function resolveOutboundSessionRoute(
  params: ResolveOutboundSessionRouteParams,
): Promise<OutboundSessionRoute | null> {
  const target = params.target.trim();
  if (!target) return null;
  switch (params.channel) {
    case "telegram":
      return resolveTelegramSession({ ...params, target });
    case "msteams":
      return resolveMSTeamsSession({ ...params, target });
    case "mattermost":
      return resolveMattermostSession({ ...params, target });
    case "bluebubbles":
      return resolveBlueBubblesSession({ ...params, target });
    case "zalo":
      return resolveZaloSession({ ...params, target });
    default:
      return resolveFallbackSession({ ...params, target });
  }
}

export async function ensureOutboundSessionEntry(params: {
  cfg: MoltbotConfig;
  agentId: string;
  channel: ChannelId;
  accountId?: string | null;
  route: OutboundSessionRoute;
}): Promise<void> {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const ctx: MsgContext = {
    From: params.route.from,
    To: params.route.to,
    SessionKey: params.route.sessionKey,
    AccountId: params.accountId ?? undefined,
    ChatType: params.route.chatType,
    Provider: params.channel,
    Surface: params.channel,
    MessageThreadId: params.route.threadId,
    OriginatingChannel: params.channel,
    OriginatingTo: params.route.to,
  };
  try {
    await recordSessionMetaFromInbound({
      storePath,
      sessionKey: params.route.sessionKey,
      ctx,
    });
  } catch {
    // Do not block outbound sends on session meta writes.
  }
}
