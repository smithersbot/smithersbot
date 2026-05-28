import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { type ChannelId, getChannelPlugin, listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.js";
import type { MoltbotConfig } from "../config/config.js";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resetDirectoryCache } from "../infra/outbound/target-resolver.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { isRecoverableTelegramNetworkError } from "../telegram/network-errors.js";

export type ChannelRuntimeSnapshot = {
  channels: Partial<Record<ChannelId, ChannelAccountSnapshot>>;
  channelAccounts: Partial<Record<ChannelId, Record<string, ChannelAccountSnapshot>>>;
};

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

type ChannelRuntimeStore = {
  aborts: Map<string, AbortController>;
  tasks: Map<string, Promise<unknown>>;
  runtimes: Map<string, ChannelAccountSnapshot>;
};

const CHANNEL_RESTART_POLICY = {
  initialMs: 1000,
  maxMs: 15_000,
  factor: 1.8,
  jitter: 0.25,
};

const MAX_CHANNEL_RESTART_ATTEMPTS = 5;

function createRuntimeStore(): ChannelRuntimeStore {
  return {
    aborts: new Map(),
    tasks: new Map(),
    runtimes: new Map(),
  };
}

function isAccountEnabled(account: unknown): boolean {
  if (!account || typeof account !== "object") return true;
  const enabled = (account as { enabled?: boolean }).enabled;
  return enabled !== false;
}

function resolveDefaultRuntime(channelId: ChannelId): ChannelAccountSnapshot {
  const plugin = getChannelPlugin(channelId);
  return plugin?.status?.defaultRuntime ?? { accountId: DEFAULT_ACCOUNT_ID };
}

function cloneDefaultRuntime(channelId: ChannelId, accountId: string): ChannelAccountSnapshot {
  return { ...resolveDefaultRuntime(channelId), accountId };
}

function isRecoverableChannelExit(channelId: ChannelId, err: unknown): boolean {
  if (channelId === "telegram") {
    return isRecoverableTelegramNetworkError(err, { context: "polling" });
  }
  return isRecoverableTelegramNetworkError(err, { context: "unknown" });
}

type ChannelManagerOptions = {
  loadConfig: () => MoltbotConfig;
  channelLogs: Record<ChannelId, SubsystemLogger>;
  channelRuntimeEnvs: Record<ChannelId, RuntimeEnv>;
};

export type ChannelManager = {
  getRuntimeSnapshot: () => ChannelRuntimeSnapshot;
  startChannels: () => Promise<void>;
  startChannel: (channel: ChannelId, accountId?: string) => Promise<void>;
  stopChannel: (channel: ChannelId, accountId?: string) => Promise<void>;
  markChannelLoggedOut: (channelId: ChannelId, cleared: boolean, accountId?: string) => void;
};

// Channel docking: lifecycle hooks (`plugin.gateway`) flow through this manager.
export function createChannelManager(opts: ChannelManagerOptions): ChannelManager {
  const { loadConfig, channelLogs, channelRuntimeEnvs } = opts;

  const channelStores = new Map<ChannelId, ChannelRuntimeStore>();

  const getStore = (channelId: ChannelId): ChannelRuntimeStore => {
    const existing = channelStores.get(channelId);
    if (existing) return existing;
    const next = createRuntimeStore();
    channelStores.set(channelId, next);
    return next;
  };

  const getRuntime = (channelId: ChannelId, accountId: string): ChannelAccountSnapshot => {
    const store = getStore(channelId);
    return store.runtimes.get(accountId) ?? cloneDefaultRuntime(channelId, accountId);
  };

  const setRuntime = (
    channelId: ChannelId,
    accountId: string,
    patch: ChannelAccountSnapshot,
  ): ChannelAccountSnapshot => {
    const store = getStore(channelId);
    const current = getRuntime(channelId, accountId);
    const next = { ...current, ...patch, accountId };
    store.runtimes.set(accountId, next);
    return next;
  };

  const launchAccount = async (
    channelId: ChannelId,
    id: string,
    restartAttempt = 0,
  ): Promise<void> => {
    const plugin = getChannelPlugin(channelId);
    const startAccount = plugin?.gateway?.startAccount;
    if (!plugin || !startAccount) return;
    const cfg = loadConfig();
    resetDirectoryCache({ channel: channelId, accountId: id });
    const store = getStore(channelId);
    const log = channelLogs[channelId];

    if (store.tasks.has(id)) {
      log.info?.(`[${id}] duplicate-poller-prevention action=skip-start existingTask=true`);
      return;
    }

    const account = plugin.config.resolveAccount(cfg, id);
    const enabled = plugin.config.isEnabled
      ? plugin.config.isEnabled(account, cfg)
      : isAccountEnabled(account);
    if (!enabled) {
      setRuntime(channelId, id, {
        accountId: id,
        running: false,
        lastError: plugin.config.disabledReason?.(account, cfg) ?? "disabled",
      });
      return;
    }

    let configured = true;
    if (plugin.config.isConfigured) {
      configured = await plugin.config.isConfigured(account, cfg);
    }
    if (!configured) {
      setRuntime(channelId, id, {
        accountId: id,
        running: false,
        lastError: plugin.config.unconfiguredReason?.(account, cfg) ?? "not configured",
      });
      return;
    }

    const abort = new AbortController();
    store.aborts.set(id, abort);
    setRuntime(channelId, id, {
      accountId: id,
      running: true,
      lastStartAt: Date.now(),
      lastError: null,
    });

    const task = startAccount({
      cfg,
      accountId: id,
      account,
      runtime: channelRuntimeEnvs[channelId],
      abortSignal: abort.signal,
      log,
      getStatus: () => getRuntime(channelId, id),
      setStatus: (next) => setRuntime(channelId, id, next),
    });
    if (restartAttempt > 0) {
      log.info?.(`[${id}] provider restart-success attempt=${restartAttempt}`);
    }

    let restartPlan: { attempt: number; delayMs: number; reason: string } | null = null;
    const tracked = Promise.resolve(task)
      .catch((err) => {
        const message = formatErrorMessage(err);
        const controlledAbort = abort.signal.aborted;
        const recoverable = !controlledAbort && isRecoverableChannelExit(channelId, err);
        const nextAttempt = restartAttempt + 1;
        const withinRestartLimit = nextAttempt <= MAX_CHANNEL_RESTART_ATTEMPTS;
        const classification = recoverable && withinRestartLimit ? "recoverable" : "fatal";
        setRuntime(channelId, id, { accountId: id, lastError: message });
        log.error?.(
          `[${id}] channel exited: ${message} classification=${classification} recoverable=${recoverable} aborted=${controlledAbort}`,
        );
        if (recoverable && withinRestartLimit) {
          const delayMs = computeBackoff(CHANNEL_RESTART_POLICY, nextAttempt);
          restartPlan = { attempt: nextAttempt, delayMs, reason: "recoverable-channel-exit" };
          log.error?.(
            `[${id}] provider restart-attempt attempt=${nextAttempt} backoffMs=${delayMs} reason=${restartPlan.reason}`,
          );
        } else if (recoverable) {
          log.error?.(
            `[${id}] provider restart-skipped reason=max-restart-attempts-exceeded attempts=${restartAttempt}`,
          );
        }
      })
      .finally(async () => {
        if (restartPlan) {
          try {
            await sleepWithAbort(restartPlan.delayMs, abort.signal);
          } catch (err) {
            if (abort.signal.aborted) {
              log.info?.(`[${id}] provider restart-skipped reason=aborted`);
              restartPlan = null;
            } else {
              throw err;
            }
          }
        }

        store.aborts.delete(id);
        store.tasks.delete(id);
        setRuntime(channelId, id, {
          accountId: id,
          running: false,
          lastStopAt: Date.now(),
        });

        if (!restartPlan || abort.signal.aborted) return;
        await launchAccount(channelId, id, restartPlan.attempt);
      });
    store.tasks.set(id, tracked);
  };

  const startChannel = async (channelId: ChannelId, accountId?: string) => {
    const plugin = getChannelPlugin(channelId);
    const startAccount = plugin?.gateway?.startAccount;
    if (!startAccount) return;
    const cfg = loadConfig();
    resetDirectoryCache({ channel: channelId, accountId });
    const accountIds = accountId ? [accountId] : plugin.config.listAccountIds(cfg);
    if (accountIds.length === 0) return;

    await Promise.all(
      accountIds.map(async (id) => {
        await launchAccount(channelId, id);
      }),
    );
  };

  const stopChannel = async (channelId: ChannelId, accountId?: string) => {
    const plugin = getChannelPlugin(channelId);
    const cfg = loadConfig();
    const store = getStore(channelId);
    const knownIds = new Set<string>([
      ...store.aborts.keys(),
      ...store.tasks.keys(),
      ...(plugin ? plugin.config.listAccountIds(cfg) : []),
    ]);
    if (accountId) {
      knownIds.clear();
      knownIds.add(accountId);
    }

    await Promise.all(
      Array.from(knownIds.values()).map(async (id) => {
        const abort = store.aborts.get(id);
        const task = store.tasks.get(id);
        if (!abort && !task && !plugin?.gateway?.stopAccount) return;
        abort?.abort();
        if (plugin?.gateway?.stopAccount) {
          const account = plugin.config.resolveAccount(cfg, id);
          await plugin.gateway.stopAccount({
            cfg,
            accountId: id,
            account,
            runtime: channelRuntimeEnvs[channelId],
            abortSignal: abort?.signal ?? new AbortController().signal,
            log: channelLogs[channelId],
            getStatus: () => getRuntime(channelId, id),
            setStatus: (next) => setRuntime(channelId, id, next),
          });
        }
        try {
          await task;
        } catch {
          // ignore
        }
        store.aborts.delete(id);
        store.tasks.delete(id);
        setRuntime(channelId, id, {
          accountId: id,
          running: false,
          lastStopAt: Date.now(),
        });
      }),
    );
  };

  const startChannels = async () => {
    for (const plugin of listChannelPlugins()) {
      await startChannel(plugin.id);
    }
  };

  const markChannelLoggedOut = (channelId: ChannelId, cleared: boolean, accountId?: string) => {
    const plugin = getChannelPlugin(channelId);
    if (!plugin) return;
    const cfg = loadConfig();
    const resolvedId =
      accountId ??
      resolveChannelDefaultAccountId({
        plugin,
        cfg,
      });
    const current = getRuntime(channelId, resolvedId);
    const next: ChannelAccountSnapshot = {
      accountId: resolvedId,
      running: false,
      lastError: cleared ? "logged out" : current.lastError,
    };
    if (typeof current.connected === "boolean") {
      next.connected = false;
    }
    setRuntime(channelId, resolvedId, next);
  };

  const getRuntimeSnapshot = (): ChannelRuntimeSnapshot => {
    const cfg = loadConfig();
    const channels: ChannelRuntimeSnapshot["channels"] = {};
    const channelAccounts: ChannelRuntimeSnapshot["channelAccounts"] = {};
    for (const plugin of listChannelPlugins()) {
      const store = getStore(plugin.id);
      const accountIds = plugin.config.listAccountIds(cfg);
      const defaultAccountId = resolveChannelDefaultAccountId({
        plugin,
        cfg,
        accountIds,
      });
      const accounts: Record<string, ChannelAccountSnapshot> = {};
      for (const id of accountIds) {
        const account = plugin.config.resolveAccount(cfg, id);
        const enabled = plugin.config.isEnabled
          ? plugin.config.isEnabled(account, cfg)
          : isAccountEnabled(account);
        const described = plugin.config.describeAccount?.(account, cfg);
        const configured = described?.configured;
        const current = store.runtimes.get(id) ?? cloneDefaultRuntime(plugin.id, id);
        const next = { ...current, accountId: id };
        if (!next.running) {
          if (!enabled) {
            next.lastError ??= plugin.config.disabledReason?.(account, cfg) ?? "disabled";
          } else if (configured === false) {
            next.lastError ??= plugin.config.unconfiguredReason?.(account, cfg) ?? "not configured";
          }
        }
        accounts[id] = next;
      }
      const defaultAccount =
        accounts[defaultAccountId] ?? cloneDefaultRuntime(plugin.id, defaultAccountId);
      channels[plugin.id] = defaultAccount;
      channelAccounts[plugin.id] = accounts;
    }
    return { channels, channelAccounts };
  };

  return {
    getRuntimeSnapshot,
    startChannels,
    startChannel,
    stopChannel,
    markChannelLoggedOut,
  };
}
