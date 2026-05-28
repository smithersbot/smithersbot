import { type RunOptions, run } from "@grammyjs/runner";
import type { MoltbotConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { resolveAgentMaxConcurrent } from "../config/agent-limits.js";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatDurationMs } from "../infra/format-duration.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveTelegramAccount } from "./accounts.js";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { createTelegramBot } from "./bot.js";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";
import { makeProxyFetch } from "./proxy.js";
import { readTelegramUpdateOffset, writeTelegramUpdateOffset } from "./update-offset-store.js";
import { startTelegramWebhook } from "./webhook.js";

export type MonitorTelegramOpts = {
  token?: string;
  accountId?: string;
  config?: MoltbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  useWebhook?: boolean;
  webhookPath?: string;
  webhookPort?: number;
  webhookSecret?: string;
  proxyFetch?: typeof fetch;
  webhookUrl?: string;
};

export function createTelegramRunnerOptions(cfg: MoltbotConfig): RunOptions<unknown> {
  return {
    sink: {
      concurrency: resolveAgentMaxConcurrent(cfg),
    },
    runner: {
      fetch: {
        // Match grammY defaults
        timeout: 30,
        // Request reactions without dropping default update types.
        allowed_updates: resolveTelegramAllowedUpdates(),
      },
      // Suppress grammY getUpdates stack traces; we log concise errors ourselves.
      silent: true,
      // Retry transient failures for a limited window before surfacing errors.
      maxRetryTime: 5 * 60 * 1000,
      retryInterval: "exponential",
    },
  };
}

const TELEGRAM_POLL_RESTART_POLICY = {
  initialMs: 2000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
};

const isGetUpdatesConflict = (err: unknown) => {
  if (!err || typeof err !== "object") return false;
  const typed = err as {
    error_code?: number;
    errorCode?: number;
    description?: string;
    method?: string;
    message?: string;
  };
  const errorCode = typed.error_code ?? typed.errorCode;
  if (errorCode !== 409) return false;
  const haystack = [typed.method, typed.description, typed.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return haystack.includes("getupdates");
};

const NETWORK_ERROR_SNIPPETS = [
  "fetch failed",
  "network",
  "timeout",
  "timed out",
  "request to '",
  "socket",
  "econnreset",
  "econnrefused",
  "undici",
];

const isNetworkRelatedError = (err: unknown) => {
  if (!err) return false;
  const message = formatErrorMessage(err).toLowerCase();
  if (!message) return false;
  return NETWORK_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
};

type PollerErrorClassification = {
  recoverable: boolean;
  reason: string;
};

function classifyPollingError(err: unknown): PollerErrorClassification {
  if (isGetUpdatesConflict(err)) {
    return { recoverable: true, reason: "getUpdates conflict" };
  }
  if (isRecoverableTelegramNetworkError(err, { context: "polling" })) {
    return { recoverable: true, reason: "recoverable network error" };
  }
  if (isNetworkRelatedError(err)) {
    return { recoverable: true, reason: "network error" };
  }
  return { recoverable: false, reason: "fatal" };
}

async function stopRunnerForRestart(params: {
  runner: ReturnType<typeof run>;
  accountId: string;
  runtime?: RuntimeEnv;
  reason: string;
}) {
  (params.runtime?.log ?? console.log)(
    `telegram duplicate-poller-prevention account=${params.accountId} action=await-previous-stop reason=${params.reason}`,
  );
  await params.runner.stop();
}

export async function monitorTelegramProvider(opts: MonitorTelegramOpts = {}) {
  const cfg = opts.config ?? loadConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = opts.token?.trim() || account.token;
  if (!token) {
    throw new Error(
      `Telegram bot token missing for account "${account.accountId}" (set channels.telegram.accounts.${account.accountId}.botToken/tokenFile or TELEGRAM_BOT_TOKEN for default).`,
    );
  }

  const proxyFetch =
    opts.proxyFetch ??
    (account.config.proxy ? makeProxyFetch(account.config.proxy as string) : undefined);

  let lastUpdateId = await readTelegramUpdateOffset({
    accountId: account.accountId,
  });
  const persistUpdateId = async (updateId: number) => {
    if (lastUpdateId !== null && updateId <= lastUpdateId) return;
    lastUpdateId = updateId;
    try {
      await writeTelegramUpdateOffset({
        accountId: account.accountId,
        updateId,
      });
    } catch (err) {
      (opts.runtime?.error ?? console.error)(
        `telegram: failed to persist update offset: ${String(err)}`,
      );
    }
  };

  const bot = createTelegramBot({
    token,
    runtime: opts.runtime,
    proxyFetch,
    config: cfg,
    accountId: account.accountId,
    updateOffset: {
      lastUpdateId,
      onUpdateId: persistUpdateId,
    },
  });

  if (opts.useWebhook) {
    await startTelegramWebhook({
      token,
      accountId: account.accountId,
      config: cfg,
      path: opts.webhookPath,
      port: opts.webhookPort,
      secret: opts.webhookSecret,
      runtime: opts.runtime as RuntimeEnv,
      fetch: proxyFetch,
      abortSignal: opts.abortSignal,
      publicUrl: opts.webhookUrl,
    });
    return;
  }

  // Use grammyjs/runner for concurrent update processing
  let restartAttempts = 0;
  let activeRunner: ReturnType<typeof run> | null = null;

  while (!opts.abortSignal?.aborted) {
    if (activeRunner) {
      await stopRunnerForRestart({
        runner: activeRunner,
        accountId: account.accountId,
        runtime: opts.runtime,
        reason: "pre-start",
      });
      activeRunner = null;
    }
    const runner = run(bot, createTelegramRunnerOptions(cfg));
    activeRunner = runner;
    (opts.runtime?.log ?? console.log)(
      `telegram poller-started account=${account.accountId} restartAttempt=${restartAttempts}`,
    );
    if (restartAttempts > 0) {
      (opts.runtime?.log ?? console.log)(
        `telegram provider restart-success account=${account.accountId} attempt=${restartAttempts}`,
      );
    }
    const stopOnAbort = () => {
      if (opts.abortSignal?.aborted) {
        void runner.stop();
      }
    };
    opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
    let shouldRestart = false;
    let restartReason = "";
    let restartDelayMs = 0;
    try {
      // runner.task() returns a promise that resolves when the runner stops
      await runner.task();
      (opts.runtime?.log ?? console.log)(
        `telegram poller-exited account=${account.accountId} classification=stopped reason=task-resolved`,
      );
      return;
    } catch (err) {
      if (opts.abortSignal?.aborted) {
        (opts.runtime?.log ?? console.log)(
          `telegram poller-exited account=${account.accountId} classification=controlled-abort error=${formatErrorMessage(err)}`,
        );
        return;
      }
      const classification = classifyPollingError(err);
      if (!classification.recoverable) {
        (opts.runtime?.error ?? console.error)(
          `telegram poller-exited account=${account.accountId} classification=fatal error=${formatErrorMessage(err)}`,
        );
        throw err;
      }
      (opts.runtime?.error ?? console.error)(
        `telegram poller-exited account=${account.accountId} classification=recoverable reason=${classification.reason} error=${formatErrorMessage(err)}`,
      );
      restartAttempts += 1;
      restartDelayMs = computeBackoff(TELEGRAM_POLL_RESTART_POLICY, restartAttempts);
      const errMsg = formatErrorMessage(err);
      (opts.runtime?.error ?? console.error)(
        `telegram provider restart-attempt account=${account.accountId} attempt=${restartAttempts} backoffMs=${restartDelayMs} reason=${classification.reason} error=${errMsg}; retrying in ${formatDurationMs(restartDelayMs)}.`,
      );
      shouldRestart = true;
      restartReason = classification.reason;
    } finally {
      opts.abortSignal?.removeEventListener("abort", stopOnAbort);
      if (activeRunner === runner) {
        if (shouldRestart) {
          await stopRunnerForRestart({
            runner,
            accountId: account.accountId,
            runtime: opts.runtime,
            reason: restartReason,
          });
        }
        activeRunner = null;
      }
    }

    if (shouldRestart) {
      try {
        await sleepWithAbort(restartDelayMs, opts.abortSignal);
      } catch (sleepErr) {
        if (opts.abortSignal?.aborted) return;
        throw sleepErr;
      }
    }
  }
}
