import { Type } from "@sinclair/typebox";
import type { ChannelAgentTool } from "../types.js";

// WhatsApp source channel removed from v0; the login tool now reports the
// removal instead of opening a Baileys session.
export function createWhatsAppLoginTool(): ChannelAgentTool {
  return {
    label: "WhatsApp Login",
    name: "whatsapp_login",
    description: "WhatsApp login is not available in this build.",
    parameters: Type.Object({
      action: Type.Optional(Type.String()),
    }),
    execute: async () => ({
      content: [{ type: "text", text: "WhatsApp login is not available in this build." }],
      details: { available: false },
    }),
  };
}
