// @ts-nocheck
import { buildTelegramMessageContext } from "./bot-message-context.js";
import { dispatchTelegramMessage } from "./bot-message-dispatch.js";
import { startTypingLoop } from "./typing-loop.js";
import { beginProofOfLife, startProofOfLifePulse } from "./proof-of-life.js";

export const createTelegramMessageProcessor = (deps) => {
  const {
    bot,
    cfg,
    account,
    telegramCfg,
    historyLimit,
    groupHistories,
    dmPolicy,
    allowFrom,
    groupAllowFrom,
    ackReactionScope,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveTelegramGroupConfig,
    runtime,
    replyToMode,
    streamMode,
    textLimit,
    opts,
    resolveBotTopicsEnabled,
  } = deps;

  return async (primaryCtx, allMedia, storeAllowFrom, options) => {
    const context = await buildTelegramMessageContext({
      primaryCtx,
      allMedia,
      storeAllowFrom,
      options,
      bot,
      cfg,
      account,
      historyLimit,
      groupHistories,
      dmPolicy,
      allowFrom,
      groupAllowFrom,
      ackReactionScope,
      logger,
      resolveGroupActivation,
      resolveGroupRequireMention,
      resolveTelegramGroupConfig,
    });
    if (!context) return;
    const proof = beginProofOfLife({
      bot,
      chatId: context.chatId,
      threadId: context.resolvedThreadId,
      label: "chat",
    });
    const proofPulse = startProofOfLifePulse(proof);
    const typingLoop = startTypingLoop({
      bot,
      chatId: context.chatId,
      threadId: context.resolvedThreadId,
      label: "chat",
    });
    try {
      await dispatchTelegramMessage({
        context,
        bot,
        cfg,
        runtime,
        replyToMode,
        streamMode,
        textLimit,
        telegramCfg,
        opts,
        resolveBotTopicsEnabled,
        proofOfLife: proof,
      });
    } finally {
      typingLoop.stop();
      proofPulse.stop();
      proof.stop();
    }
  };
};
