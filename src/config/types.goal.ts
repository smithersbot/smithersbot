export type GoalConfig = {
  /** Default working directory when --working-dir is not specified. */
  defaultWorkingDir?: string;
  /** Extra directories the agent can read (read-only). Hard denies still apply. */
  readOnlyRoots?: string[];
};
