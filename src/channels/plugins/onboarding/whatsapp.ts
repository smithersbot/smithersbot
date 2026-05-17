import type { ChannelOnboardingAdapter } from "../onboarding-types.js";

const channel = "whatsapp" as const;

// WhatsApp source channel removed from v0; this stub keeps the plugin contract
// surface compilable while the extension is retired in a later cut.
export const whatsappOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async () => ({
    channel,
    configured: false,
    statusLines: ["WhatsApp: not available in this build"],
    selectionHint: "unavailable",
    quickstartScore: 0,
  }),
  configure: async ({ cfg, accountOverrides }) => ({
    cfg,
    accountId: accountOverrides.whatsapp?.trim() ?? "default",
  }),
};
