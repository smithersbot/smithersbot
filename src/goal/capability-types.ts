// Hard deny types for goal enforcement

export type HardDeny = {
  pattern: string;
  reason: string;
  type: "path" | "command";
};
