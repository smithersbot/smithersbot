import { getFileMtimeMs, isCacheEnabled, resolveCacheTtlMs } from "./cache-utils.js";
import type { MoltbotConfig } from "./types.js";

const DEFAULT_CONFIG_CACHE_MS = 200;

type ConfigCacheEntry = {
  configPath: string;
  expiresAt: number;
  mtimeMs?: number;
  config: MoltbotConfig;
};

export function resolveConfigCacheMs(env: NodeJS.ProcessEnv): number {
  const raw = env.CLAWDBOT_CONFIG_CACHE_MS?.trim();
  if (raw === "") return 0;

  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed < 0) {
      return 0;
    }
  }

  return resolveCacheTtlMs({
    envValue: raw,
    defaultTtlMs: DEFAULT_CONFIG_CACHE_MS,
  });
}

export function shouldUseConfigCache(env: NodeJS.ProcessEnv): boolean {
  if (env.CLAWDBOT_DISABLE_CONFIG_CACHE?.trim()) return false;
  return isCacheEnabled(resolveConfigCacheMs(env));
}

export class ConfigCache {
  private entry: ConfigCacheEntry | null = null;

  get(params: { configPath: string; env: NodeJS.ProcessEnv }): MoltbotConfig | null {
    const { configPath, env } = params;
    if (!shouldUseConfigCache(env)) return null;

    const cached = this.entry;
    if (!cached) return null;
    if (cached.configPath !== configPath) return null;
    if (cached.expiresAt <= Date.now()) return null;
    const currentMtimeMs = getFileMtimeMs(configPath);
    if (currentMtimeMs !== cached.mtimeMs) {
      this.clear();
      return null;
    }

    // Return a clone so caller mutations never leak back into the cache.
    return structuredClone(cached.config);
  }

  set(params: { configPath: string; config: MoltbotConfig; env: NodeJS.ProcessEnv }): void {
    const { configPath, config, env } = params;
    if (!shouldUseConfigCache(env)) return;

    const cacheMs = resolveConfigCacheMs(env);
    if (!isCacheEnabled(cacheMs)) return;

    this.entry = {
      configPath,
      expiresAt: Date.now() + cacheMs,
      mtimeMs: getFileMtimeMs(configPath),
      config: structuredClone(config),
    };
  }

  clear(): void {
    this.entry = null;
  }
}

const configCache = new ConfigCache();

export function getCachedConfig(params: {
  configPath: string;
  env: NodeJS.ProcessEnv;
}): MoltbotConfig | null {
  return configCache.get(params);
}

export function setCachedConfig(params: {
  configPath: string;
  config: MoltbotConfig;
  env: NodeJS.ProcessEnv;
}): void {
  configCache.set(params);
}

export function clearConfigCache(): void {
  configCache.clear();
}
