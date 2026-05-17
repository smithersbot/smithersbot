import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import { jsonResult } from "./common.js";

// WhatsApp source channel removed from v0; the action handler reports the
// removal instead of dispatching reactions through Baileys.
export async function handleWhatsAppAction(
  _toolCallId: string,
  _params: unknown,
): Promise<AgentToolResult<unknown>> {
  return jsonResult({ ok: false, error: "WhatsApp actions are not available in this build." });
}
