import { sendMessageIMessage } from "../imessage/send.js";
import type { OutboundSendDeps } from "../infra/outbound/deliver.js";
import { sendMessageSignal } from "../signal/send.js";
import { sendMessageSlack } from "../slack/send.js";
import { sendMessageTelegram } from "../telegram/send.js";

export type CliDeps = {
  sendMessageTelegram: typeof sendMessageTelegram;
  sendMessageSlack: typeof sendMessageSlack;
  sendMessageSignal: typeof sendMessageSignal;
  sendMessageIMessage: typeof sendMessageIMessage;
};

export function createDefaultDeps(): CliDeps {
  return {
    sendMessageTelegram,
    sendMessageSlack,
    sendMessageSignal,
    sendMessageIMessage,
  };
}

// Provider docking: extend this mapping when adding new outbound send deps.
export function createOutboundSendDeps(deps: CliDeps): OutboundSendDeps {
  return {
    sendTelegram: deps.sendMessageTelegram,
    sendSlack: deps.sendMessageSlack,
    sendSignal: deps.sendMessageSignal,
    sendIMessage: deps.sendMessageIMessage,
  };
}
