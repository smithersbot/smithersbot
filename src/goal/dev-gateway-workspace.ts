// Dynamic dev-gateway worker guidance detection.
//
// Unlike runtime instance config (which MUST be selected explicitly — see
// src/config/gateway-instance.ts), this module's checkout/working-directory
// detection is used ONLY to scope worker GUIDANCE and hard-deny policy. It never
// flips the running gateway's runtime config. A worker editing the dev checkout
// is told it is in the dev workspace and is allowed to manage only the dev
// gateway service; it does not change which instance the gateway process is.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveGatewayInstanceIdentity } from "../config/gateway-instance.js";

/** The managed-workspace name of the SmithersBot dev checkout. */
export const DEV_GATEWAY_WORKSPACE_NAME = "smithersbot-dev";

export type DevGatewayWorkerContext = {
  /** The working dir/checkout is the SmithersBot dev workspace. */
  isDevWorkspace: boolean;
  /** The dev gateway service is installed or active. */
  servicePresent: boolean;
  /** Both conditions hold: inject dev guidance and dev-only restart policy. */
  active: boolean;
};

/**
 * Path-based detection that a worker's checkout/cwd is the SmithersBot dev
 * workspace. Guidance only — never used to resolve runtime config.
 */
export function isSmithersbotDevWorkspace(workingDir: string): boolean {
  const resolved = path.resolve(workingDir);
  const segments = resolved.split(path.sep).filter(Boolean);
  return segments.includes(DEV_GATEWAY_WORKSPACE_NAME);
}

/**
 * Best-effort detection that the dev gateway service is installed/present. The
 * dev unit file is written under the user systemd dir by the dev install flow,
 * so its presence is a deterministic "exists" signal that avoids spawning
 * processes during goal execution. Probes are injectable for tests.
 */
export function devGatewayServicePresent(opts?: {
  homedir?: () => string;
  fileExists?: (filePath: string) => boolean;
}): boolean {
  const homedir = opts?.homedir ?? os.homedir;
  const fileExists = opts?.fileExists ?? ((filePath: string) => fs.existsSync(filePath));
  const unit = resolveGatewayInstanceIdentity("dev", homedir).serviceUnit;
  const unitFile = path.join(homedir(), ".config", "systemd", "user", unit);
  return fileExists(unitFile);
}

/**
 * Resolve whether dev-gateway worker guidance + dev-only restart policy apply.
 * `servicePresent` may be supplied explicitly (tests/callers); otherwise it is
 * probed only when the working dir is the dev workspace.
 */
export function resolveDevGatewayWorkerContext(params: {
  workingDir: string;
  servicePresent?: boolean;
  homedir?: () => string;
  fileExists?: (filePath: string) => boolean;
}): DevGatewayWorkerContext {
  const isDevWorkspace = isSmithersbotDevWorkspace(params.workingDir);
  const servicePresent = !isDevWorkspace
    ? false
    : (params.servicePresent ??
      devGatewayServicePresent({ homedir: params.homedir, fileExists: params.fileExists }));
  return { isDevWorkspace, servicePresent, active: isDevWorkspace && servicePresent };
}
