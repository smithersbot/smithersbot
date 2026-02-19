export interface NightwatchConfig {
  enabled?: boolean;
  cronExpr?: string;
  repoPath?: string;
  timezone?: string;
  telegramChatId?: string | number;
  telegramAccountId?: string;
  telegramThreadId?: number;
}

export interface CronConfig {
  enabled?: boolean;
  store?: string;
  maxConcurrentRuns?: number;
  nightwatch?: NightwatchConfig;
}
