import type { SerializedRun } from "./types.js";

export function hasCurrentDeliveredSurface(run: SerializedRun): boolean {
  const proposalId = run.pendingContinuation?.proposalId;
  const delivery = run.continuationDelivery;
  return Boolean(
    proposalId &&
    delivery &&
    delivery.proposalId === proposalId &&
    !delivery.failed &&
    typeof delivery.messageId === "number" &&
    typeof delivery.deliveredAt === "string",
  );
}
