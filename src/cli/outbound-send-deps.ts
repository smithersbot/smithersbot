import type { OutboundSendDeps } from "../infra/outbound/deliver.js";

export type CliDeps = {
  sendMessageTelegram: NonNullable<OutboundSendDeps["sendTelegram"]>;
  sendMessageDiscord: NonNullable<OutboundSendDeps["sendDiscord"]>;
  sendMessageSlack: NonNullable<OutboundSendDeps["sendSlack"]>;
  sendMessageSignal: NonNullable<OutboundSendDeps["sendSignal"]>;
  sendMessageIMessage: NonNullable<OutboundSendDeps["sendIMessage"]>;
};

// Provider docking: extend this mapping when adding new outbound send deps.
export function createOutboundSendDeps(deps: CliDeps): OutboundSendDeps {
  return {
    sendTelegram: deps.sendMessageTelegram,
    sendDiscord: deps.sendMessageDiscord,
    sendSlack: deps.sendMessageSlack,
    sendSignal: deps.sendMessageSignal,
    sendIMessage: deps.sendMessageIMessage,
  };
}
