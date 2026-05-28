import { completeSimple, getModel, type Api, type Model } from "@mariozechner/pi-ai";
import type { GoalLlmClient, GoalLlmResponse } from "./types.js";

const DEFAULT_MODEL_ID = "claude-sonnet-4-20250514";
const DEFAULT_PROVIDER = "anthropic";

function isTextBlock(block: { type: string }): block is { type: "text"; text: string } {
  return block.type === "text";
}

export function createGoalLlmClient(params: {
  apiKey: string;
  modelOverride?: string;
}): GoalLlmClient {
  // getModel's second arg is typed to known model IDs; cast for user-provided overrides.
  const modelId = params.modelOverride ?? DEFAULT_MODEL_ID;
  const model = getModel(DEFAULT_PROVIDER, modelId as typeof DEFAULT_MODEL_ID) as Model<Api>;

  return {
    async complete({ systemPrompt, userMessage, maxTokens }): Promise<GoalLlmResponse> {
      const res = await completeSimple(
        model,
        {
          systemPrompt,
          messages: [
            {
              role: "user",
              content: userMessage,
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: params.apiKey,
          maxTokens: maxTokens ?? 4096,
          temperature: 0.2,
        },
      );

      const text = res.content
        .filter(isTextBlock)
        .map((block) => block.text)
        .join("");

      if (res.errorMessage || res.stopReason === "error") {
        throw new Error(res.errorMessage || "LLM request failed (no error details)");
      }

      if (!text) {
        const blockTypes = res.content.map((b) => b.type).join(", ") || "none";
        console.error(
          `[goal] LLM returned no text. blocks=[${blockTypes}] stopReason=${res.stopReason}`,
        );
      }

      return {
        text,
        usage: res.usage
          ? { inputTokens: res.usage.input, outputTokens: res.usage.output }
          : undefined,
      };
    },
  };
}
