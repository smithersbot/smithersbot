type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord =>
  value && typeof value === "object" ? (value as UnknownRecord) : {};

export const withTelegramGoalRouterDisabled = (config: UnknownRecord = {}): UnknownRecord => {
  const channels = asRecord(config.channels);
  const telegram = asRecord(channels.telegram);

  return {
    ...config,
    channels: {
      ...channels,
      telegram: {
        goalRouter: false,
        ...telegram,
      },
    },
  };
};
