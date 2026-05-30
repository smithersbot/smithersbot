import os from "node:os";

/**
 * `os.networkInterfaces()` can throw under sandbox network isolation — observed
 * as `uv_interface_addresses returned Unknown system error 1` when the bubblewrap
 * sandbox denies the netlink socket. Module-init callers (system presence,
 * tailnet discovery) must not crash on import in that environment, so this
 * wrapper degrades to an empty interface map instead of throwing.
 */
export function safeNetworkInterfaces(): ReturnType<typeof os.networkInterfaces> {
  try {
    return os.networkInterfaces();
  } catch {
    return {};
  }
}
