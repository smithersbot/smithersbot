import { Button, type ButtonInteraction, type ComponentData } from "@buape/carbon";
import { ButtonStyle, Routes } from "discord-api-types/v10";

import {
  handleGoalAnswer,
  handleGoalApprove,
  handleGoalReject,
  handleGoalStop,
  type GoalPlanResult,
} from "../../telegram/goal-commands.js";
import type { GoalStatusChangeEvent } from "../../goal/agent-executor.js";
import { loadRun, resolveRunId } from "../../goal/run-store.js";
import { logDebug, logError } from "../../logger.js";
import type { MoltbotConfig } from "../../config/config.js";
import { createDiscordClient } from "../send.shared.js";

// ---------------------------------------------------------------------------
// Custom ID key
// ---------------------------------------------------------------------------

const GOAL_BUTTON_KEY = "goalaction";

// ---------------------------------------------------------------------------
// Custom ID encoding / decoding
// ---------------------------------------------------------------------------

function encodeValue(value: string): string {
  return encodeURIComponent(value);
}

function decodeValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export type GoalButtonAction = "resume" | "stop" | "approve" | "reject" | "edit";

export function buildGoalButtonCustomId(runIdPrefix: string, action: GoalButtonAction): string {
  return [`${GOAL_BUTTON_KEY}:run=${encodeValue(runIdPrefix)}`, `action=${action}`].join(";");
}

export function parseGoalButtonData(
  data: ComponentData,
): { runIdPrefix: string; action: GoalButtonAction } | null {
  if (!data || typeof data !== "object") return null;
  const coerce = (value: unknown) =>
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  const rawRun = coerce(data.run);
  const rawAction = coerce(data.action);
  if (!rawRun || !rawAction) return null;
  const validActions: GoalButtonAction[] = ["resume", "stop", "approve", "reject", "edit"];
  if (!validActions.includes(rawAction as GoalButtonAction)) return null;
  return {
    runIdPrefix: decodeValue(rawRun),
    action: rawAction as GoalButtonAction,
  };
}

// ---------------------------------------------------------------------------
// Button component builders (raw Discord API structures for REST sends)
// ---------------------------------------------------------------------------

/** Build Resume + Stop action row for goal status messages (blocked, running). */
export function buildGoalActionComponents(runIdPrefix: string) {
  return [
    {
      type: 1 as const, // ACTION_ROW
      components: [
        {
          type: 2 as const, // BUTTON
          style: ButtonStyle.Success,
          label: "\u25B6\uFE0F Resume Goal",
          custom_id: buildGoalButtonCustomId(runIdPrefix, "resume"),
        },
        {
          type: 2 as const, // BUTTON
          style: ButtonStyle.Danger,
          label: "\u23F9\uFE0F Stop Goal",
          custom_id: buildGoalButtonCustomId(runIdPrefix, "stop"),
        },
      ],
    },
  ];
}

/** Build Approve + Reject + Edit action row for plan approval messages. */
export function buildGoalPlanComponents(runIdPrefix: string) {
  return [
    {
      type: 1 as const, // ACTION_ROW
      components: [
        {
          type: 2 as const, // BUTTON
          style: ButtonStyle.Success,
          label: "\u2705 Approve",
          custom_id: buildGoalButtonCustomId(runIdPrefix, "approve"),
        },
        {
          type: 2 as const, // BUTTON
          style: ButtonStyle.Danger,
          label: "\u274C Reject",
          custom_id: buildGoalButtonCustomId(runIdPrefix, "reject"),
        },
        {
          type: 2 as const, // BUTTON
          style: ButtonStyle.Secondary,
          label: "\u270F\uFE0F Edit",
          custom_id: buildGoalButtonCustomId(runIdPrefix, "edit"),
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Emoji mapping for button actions
// ---------------------------------------------------------------------------

const ACTION_EMOJIS: Record<GoalButtonAction, string> = {
  resume: "\u25B6\uFE0F", // ▶️
  stop: "\u23F9\uFE0F", // ⏹️
  approve: "\u2705", // ✅
  reject: "\u274C", // ❌
  edit: "\u270F\uFE0F", // ✏️
};

// ---------------------------------------------------------------------------
// Button handler context
// ---------------------------------------------------------------------------

export type GoalButtonContext = {
  token: string;
  accountId: string;
  cfg: MoltbotConfig;
};

// ---------------------------------------------------------------------------
// Carbon Button class for interaction handling
// ---------------------------------------------------------------------------

export class GoalActionButton extends Button {
  label = "goalaction";
  customId = `${GOAL_BUTTON_KEY}:seed=1`;
  style = ButtonStyle.Primary;
  private ctx: GoalButtonContext;

  constructor(ctx: GoalButtonContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: ButtonInteraction, data: ComponentData): Promise<void> {
    const parsed = parseGoalButtonData(data);
    if (!parsed) {
      try {
        await interaction.update({
          content: "This action is no longer valid.",
          components: [],
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    const { runIdPrefix, action } = parsed;
    const resolvedId = resolveRunId(runIdPrefix);
    if (!resolvedId) {
      try {
        await interaction.reply({
          content: `Goal not found: ${runIdPrefix}`,
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    // React with emoji on the original message
    const messageId = interaction.message?.id;
    const channelId = interaction.message?.channelId;
    if (messageId && channelId) {
      const emoji = ACTION_EMOJIS[action];
      if (emoji) {
        void this.reactWithEmoji(channelId, messageId, emoji);
      }
    }

    logDebug(`discord goal buttons: ${action} for run ${runIdPrefix}`);

    switch (action) {
      case "resume":
        await this.handleResume(interaction, resolvedId, channelId);
        break;
      case "stop":
        await this.handleStop(interaction, resolvedId);
        break;
      case "approve":
        await this.handleApprove(interaction, resolvedId, channelId);
        break;
      case "reject":
        await this.handleReject(interaction, resolvedId);
        break;
      case "edit":
        await this.handleEdit(interaction);
        break;
    }
  }

  private async reactWithEmoji(channelId: string, messageId: string, emoji: string): Promise<void> {
    try {
      const { rest, request } = createDiscordClient(
        { token: this.ctx.token, accountId: this.ctx.accountId },
        this.ctx.cfg,
      );
      const encoded = encodeURIComponent(emoji.replace(/[\uFE0E\uFE0F]/g, ""));
      await request(
        () => rest.put(Routes.channelMessageOwnReaction(channelId, messageId, encoded)),
        "goal-react",
      );
    } catch (err) {
      logError(`discord goal buttons: failed to react with emoji: ${String(err)}`);
    }
  }

  private async handleResume(
    interaction: ButtonInteraction,
    resolvedId: string,
    channelId?: string,
  ): Promise<void> {
    const prefix = resolvedId.slice(0, 8);
    try {
      await interaction.update({
        content: `\u25B6\uFE0F Resuming goal ${prefix}...`,
        components: [],
      });
    } catch {
      // Interaction may have expired
    }

    const statusCb = channelId
      ? buildDiscordOnStatusChange({
          token: this.ctx.token,
          accountId: this.ctx.accountId,
          cfg: this.ctx.cfg,
          channelId,
          runId: resolvedId,
        })
      : undefined;

    try {
      const result = await handleGoalAnswer(prefix, "resume", statusCb);
      if (result != null) {
        await this.sendResultFollowUp(interaction, result, prefix, channelId);
      }
    } catch (err) {
      logError(`discord goal buttons: resume failed: ${String(err)}`);
      try {
        await interaction.followUp({
          content: `Failed to resume goal: ${String(err)}`,
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
    }
  }

  private async handleStop(interaction: ButtonInteraction, resolvedId: string): Promise<void> {
    const prefix = resolvedId.slice(0, 8);
    try {
      await interaction.update({
        content: `\u23F9\uFE0F Stopping goal ${prefix}...`,
        components: [],
      });
    } catch {
      // Interaction may have expired
    }

    try {
      const result = await handleGoalStop(prefix);
      try {
        await interaction.followUp({ content: result });
      } catch {
        // Interaction may have expired
      }
    } catch (err) {
      logError(`discord goal buttons: stop failed: ${String(err)}`);
      try {
        await interaction.followUp({
          content: `Failed to stop goal: ${String(err)}`,
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
    }
  }

  private async handleApprove(
    interaction: ButtonInteraction,
    resolvedId: string,
    channelId?: string,
  ): Promise<void> {
    const prefix = resolvedId.slice(0, 8);
    try {
      await interaction.update({
        content: `\u2705 Approving goal ${prefix}...`,
        components: [],
      });
    } catch {
      // Interaction may have expired
    }

    const statusCb = channelId
      ? buildDiscordOnStatusChange({
          token: this.ctx.token,
          accountId: this.ctx.accountId,
          cfg: this.ctx.cfg,
          channelId,
          runId: resolvedId,
        })
      : undefined;

    try {
      const result = await handleGoalApprove(prefix, statusCb);
      if (result != null) {
        await this.sendResultFollowUp(interaction, result, prefix, channelId);
      }
    } catch (err) {
      logError(`discord goal buttons: approve failed: ${String(err)}`);
      try {
        await interaction.followUp({
          content: `Failed to approve goal: ${String(err)}`,
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
    }
  }

  private async handleReject(interaction: ButtonInteraction, resolvedId: string): Promise<void> {
    const prefix = resolvedId.slice(0, 8);
    try {
      await interaction.update({
        content: `\u274C Rejecting goal ${prefix}...`,
        components: [],
      });
    } catch {
      // Interaction may have expired
    }

    try {
      const result = await handleGoalReject(prefix);
      try {
        await interaction.followUp({ content: result });
      } catch {
        // Interaction may have expired
      }
    } catch (err) {
      logError(`discord goal buttons: reject failed: ${String(err)}`);
      try {
        await interaction.followUp({
          content: `Failed to reject goal: ${String(err)}`,
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
    }
  }

  private async handleEdit(interaction: ButtonInteraction): Promise<void> {
    try {
      await interaction.reply({
        content:
          "Reply to the goal message with your edit instructions, prefixed with `/goal_edit`.",
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
  }

  /**
   * Send a goal result as a follow-up. Uses REST API when components (buttons)
   * are needed (since Carbon's followUp doesn't accept raw component structures),
   * falls back to interaction.followUp for plain text.
   */
  private async sendResultFollowUp(
    interaction: ButtonInteraction,
    result: string | GoalPlanResult,
    runIdPrefix: string,
    channelId?: string,
  ): Promise<void> {
    const { text, components } = resolveResultPayload(result, runIdPrefix);
    if (components && channelId) {
      // Send via REST API to include raw component structures
      try {
        const { rest, request } = createDiscordClient(
          { token: this.ctx.token, accountId: this.ctx.accountId },
          this.ctx.cfg,
        );
        await request(
          () =>
            rest.post(Routes.channelMessages(channelId), {
              body: { content: text.slice(0, 2000), components },
            }),
          "goal-result-with-buttons",
        );
      } catch (err) {
        logError(`discord goal buttons: REST follow-up failed: ${String(err)}`);
        // Fall back to plain text follow-up
        try {
          await interaction.followUp({ content: text });
        } catch {
          // Interaction may have expired
        }
      }
    } else {
      try {
        await interaction.followUp({ content: text });
      } catch {
        // Interaction may have expired
      }
    }
  }
}

export function createGoalActionButton(ctx: GoalButtonContext): Button {
  return new GoalActionButton(ctx);
}

// ---------------------------------------------------------------------------
// Follow-up payload builder for goal results
// ---------------------------------------------------------------------------

/**
 * Extract text and determine which button components (if any) to attach to a goal result.
 * Returns raw Discord API component structures suitable for REST API calls.
 */
function resolveResultPayload(
  result: string | GoalPlanResult,
  runIdPrefix: string,
): { text: string; components?: ReturnType<typeof buildGoalPlanComponents> } {
  if (typeof result === "string") {
    return { text: result };
  }
  const text = result.text;
  // Plan result with revision → show approve/reject/edit buttons
  if (result.runId && result.revision) {
    return { text, components: buildGoalPlanComponents(runIdPrefix) };
  }
  // Blocked result → show resume/stop buttons
  if (result.runId && result.blocked) {
    return { text, components: buildGoalActionComponents(runIdPrefix) };
  }
  return { text };
}

// ---------------------------------------------------------------------------
// Discord onStatusChange callback builder
// ---------------------------------------------------------------------------

/**
 * Build an onStatusChange callback that sends Discord messages with goal action buttons.
 * Analogous to the Telegram buildOnStatusChange in telegram/goal-commands.ts.
 */
export function buildDiscordOnStatusChange(params: {
  token: string;
  accountId: string;
  cfg: MoltbotConfig;
  channelId: string;
  runId: string;
}): (event: GoalStatusChangeEvent) => Promise<void> {
  const { token, accountId, cfg, channelId, runId } = params;
  const prefix = runId.slice(0, 8);

  return async (event: GoalStatusChangeEvent) => {
    const { rest, request } = createDiscordClient({ token, accountId }, cfg);

    if (event.type === "plan_ready") {
      const stepCount = event.plan.steps.length;
      const text = [
        `**PLAN READY (${prefix}):** ${event.summary}`,
        "",
        `${stepCount} step${stepCount === 1 ? "" : "s"} planned. Approve, reject, or request edits below.`,
      ].join("\n");

      const components = buildGoalPlanComponents(prefix);

      try {
        await request(
          () =>
            rest.post(Routes.channelMessages(channelId), {
              body: { content: text.slice(0, 2000), components },
            }),
          "goal-plan-ready",
        );
      } catch (err) {
        logError(`discord goal status: failed to send plan_ready: ${String(err)}`);
      }
      return;
    }

    const run = loadRun(runId);
    if (!run?.plan) return;

    if (event.type === "step_blocked") {
      const text = [
        `**TASK BLOCKED (${prefix}):** Step \`${event.stepId}\` needs input`,
        "",
        event.question,
        "",
        `Use \`/goal_answer ${prefix} <your answer>\` or press a button below.`,
      ].join("\n");

      const components = buildGoalActionComponents(prefix);

      try {
        await request(
          () =>
            rest.post(Routes.channelMessages(channelId), {
              body: { content: text.slice(0, 2000), components },
            }),
          "goal-blocked",
        );
      } catch (err) {
        logError(`discord goal status: failed to send step_blocked: ${String(err)}`);
      }
    } else if (event.type === "fully_blocked") {
      const blocked = event.steps.filter((s) => s.status === "blocked");
      const lines: string[] = [
        `**GOAL BLOCKED (${prefix}):** no runnable steps \u2014 waiting for answers.`,
      ];
      if (blocked.length > 0) {
        lines.push("");
        for (const s of blocked.slice(0, 3)) {
          lines.push(
            `\u2022 Step \`${s.id}\`: ${s.blockedQuestion ?? s.blockedReason ?? "needs input"}`,
          );
        }
        if (blocked.length > 3) lines.push(`  \u2026and ${blocked.length - 3} more`);
      }
      lines.push("");
      lines.push(`Reply with your answer or use \`/goal_answer ${prefix} <answer>\``);

      const components = buildGoalActionComponents(prefix);

      try {
        await request(
          () =>
            rest.post(Routes.channelMessages(channelId), {
              body: { content: lines.join("\n").slice(0, 2000), components },
            }),
          "goal-fully-blocked",
        );
      } catch (err) {
        logError(`discord goal status: failed to send fully_blocked: ${String(err)}`);
      }
    } else if (event.type === "all_done") {
      const text = `**DONE (${prefix}):** ${event.summary}`;
      try {
        await request(
          () =>
            rest.post(Routes.channelMessages(channelId), {
              body: { content: text.slice(0, 2000) },
            }),
          "goal-done",
        );
      } catch (err) {
        logError(`discord goal status: failed to send all_done: ${String(err)}`);
      }
    }
  };
}
