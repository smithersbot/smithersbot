import type { MoltbotConfig } from "../config/types.js";
import { resolveEnabledWorkers } from "../goal/backend-types.js";
import {
  createContinuationCliClient,
  type ContinuationCliClientParams,
} from "../goal/continuation-cli-client.js";
import { createGoalLlmClient } from "../goal/llm-client.js";
import type { GoalLlmClient } from "../goal/types.js";

const CONTINUATION_BACKEND_PREFERENCE = ["claude_code", "codex"] as const;

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function resolveAnthropicProviderApiKey(cfg?: MoltbotConfig): string | undefined {
  const providers = cfg?.models?.providers;
  if (!providers) return undefined;
  return firstNonEmpty(providers.anthropic?.apiKey);
}

function orderContinuationBackends(backends: ReturnType<typeof resolveEnabledWorkers>) {
  return CONTINUATION_BACKEND_PREFERENCE.filter((backend) => backends.includes(backend));
}

export type ResolveContinuationClientDeps = {
  createRawClient?: typeof createGoalLlmClient;
  createCliClient?: (params: ContinuationCliClientParams) => GoalLlmClient | undefined;
  env?: NodeJS.ProcessEnv;
  cwd?: () => string;
};

export function resolveContinuationClient(
  cfg?: MoltbotConfig,
  deps: ResolveContinuationClientDeps = {},
): GoalLlmClient | undefined {
  const cliClient = (deps.createCliClient ?? createContinuationCliClient)({
    backends: orderContinuationBackends(resolveEnabledWorkers(cfg?.goal)),
    workingDir: cfg?.goal?.defaultWorkingDir ?? deps.cwd?.() ?? process.cwd(),
    claudeCodeAuth: cfg?.goal?.claudeCodeAuth ?? "subscription",
    readOnlyRoots: cfg?.goal?.readOnlyRoots,
  });
  if (cliClient) return cliClient;

  const apiKey = resolveAnthropicProviderApiKey(cfg);
  if (apiKey) return (deps.createRawClient ?? createGoalLlmClient)({ apiKey });
  return undefined;
}
