import { sendMessageIMessage } from "../imessage/send.js";
import type { OutboundSendDeps } from "../infra/outbound/deliver.js";
import { sendMessageTelegram } from "../telegram/send.js";

export type CliDeps = {
  sendMessageTelegram: typeof sendMessageTelegram;
  sendMessageIMessage: typeof sendMessageIMessage;
};

export function createDefaultDeps(): CliDeps {
  return {
    sendMessageTelegram,
    sendMessageIMessage,
  };
}

// Provider docking: extend this mapping when adding new outbound send deps.
export function createOutboundSendDeps(deps: CliDeps): OutboundSendDeps {
  return {
    sendTelegram: deps.sendMessageTelegram,
    sendIMessage: deps.sendMessageIMessage,
  };
}
