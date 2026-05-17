import type { OutboundSendDeps } from "../infra/outbound/deliver.js";

export type CliDeps = {
  sendMessageTelegram: NonNullable<OutboundSendDeps["sendTelegram"]>;
  sendMessageIMessage: NonNullable<OutboundSendDeps["sendIMessage"]>;
};

// Provider docking: extend this mapping when adding new outbound send deps.
export function createOutboundSendDeps(deps: CliDeps): OutboundSendDeps {
  return {
    sendTelegram: deps.sendMessageTelegram,
    sendIMessage: deps.sendMessageIMessage,
  };
}
