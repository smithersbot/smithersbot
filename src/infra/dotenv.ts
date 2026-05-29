import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";

import { resolveGatewayInstanceFromEnv } from "../config/gateway-instance.js";
import { resolveManagedRoot } from "../config/managed-paths.js";
import { resolveConfigDir } from "../utils.js";

export function loadDotEnv(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;

  // Load from process CWD first (dotenv default).
  dotenv.config({ quiet });

  // Then load global fallback: ~/.smithersbot/.env (or $*_STATE_DIR/.env),
  // without overriding any env vars already present.
  const instance = resolveGatewayInstanceFromEnv(process.env);
  const globalEnvPaths = [path.join(resolveConfigDir(process.env), ".env")];
  if (!instance.legacyStateFallbacks) {
    globalEnvPaths.push(path.join(resolveManagedRoot(process.env), ".env"));
  }

  for (const globalEnvPath of new Set(globalEnvPaths)) {
    if (!fs.existsSync(globalEnvPath)) continue;
    dotenv.config({ quiet, path: globalEnvPath, override: false });
  }
}
