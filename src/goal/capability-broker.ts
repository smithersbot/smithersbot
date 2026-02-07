// Pure, deterministic broker that merges baseline + validated step expansions into effective capabilities.

import path from "node:path";
import type {
  CapabilityGrant,
  CapabilityPolicy,
  EffectiveCapabilities,
} from "./capability-types.js";
import { isCommandDenied } from "./capability-policy.js";
import type { PlanStep } from "./types.js";

const MAX_PATH_GLOBS = 20;
const MAX_COMMAND_PATTERNS = 20;
const MAX_DOMAINS = 10;

// Overly broad patterns that should be rejected for write_config
const OVERLY_BROAD_PATTERNS = ["**/*", "*"];

/**
 * Compute effective capabilities for a task step.
 *
 * Pure, deterministic: same inputs always produce same output. No side effects.
 * This is critical for resume — the persisted policy + step data must produce
 * identical effective capabilities.
 */
export function computeEffectiveCapabilities(
  policy: CapabilityPolicy,
  step: PlanStep,
  workingDir: string,
  attempt?: number,
): EffectiveCapabilities {
  const grants: CapabilityGrant[] = [...policy.baseline];
  const nodeGrants: CapabilityGrant[] = [];

  const requested = step.requestedCapabilities ?? [];
  for (const entry of requested) {
    // TTL check: attempt-scoped grants are excluded on retry
    if (entry.ttl === "attempt" && attempt != null && attempt > 1) {
      continue;
    }

    // Reject if ID is not in expandableIds
    if (!policy.expandableIds.includes(entry.id)) {
      continue;
    }

    // Validate pathGlobs: must resolve within workingDir
    if (entry.pathGlobs) {
      const validGlobs = entry.pathGlobs.slice(0, MAX_PATH_GLOBS);
      const allWithin = validGlobs.every((glob) => {
        // A glob starting with the workingDir is fine
        const resolved = glob.startsWith("/") ? glob : path.resolve(workingDir, glob);
        return resolved.startsWith(workingDir);
      });
      if (!allWithin) continue;

      // Reject overly broad patterns for fs.write_config
      if (entry.id === "fs.write_config") {
        const hasBroad = validGlobs.some((g) => OVERLY_BROAD_PATTERNS.includes(g.trim()));
        if (hasBroad) continue;
      }
    }

    // Validate commandPatterns: none should match a hard deny
    if (entry.commandPatterns) {
      const validPatterns = entry.commandPatterns.slice(0, MAX_COMMAND_PATTERNS);
      const hasConflict = validPatterns.some(
        (pattern) => isCommandDenied(pattern, policy.hardDenies) != null,
      );
      if (hasConflict) continue;
    }

    // Cap domain allowlist
    const cappedEntry: CapabilityGrant = { ...entry };
    if (cappedEntry.pathGlobs) {
      cappedEntry.pathGlobs = cappedEntry.pathGlobs.slice(0, MAX_PATH_GLOBS);
    }
    if (cappedEntry.commandPatterns) {
      cappedEntry.commandPatterns = cappedEntry.commandPatterns.slice(0, MAX_COMMAND_PATTERNS);
    }
    if (cappedEntry.domainAllowlist) {
      cappedEntry.domainAllowlist = cappedEntry.domainAllowlist.slice(0, MAX_DOMAINS);
    }

    grants.push(cappedEntry);
    nodeGrants.push(cappedEntry);
  }

  return {
    grants,
    denies: policy.hardDenies,
    nodeGrants,
  };
}
