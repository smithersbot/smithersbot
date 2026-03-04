import { describe, expect, it } from "vitest";

import { formatPermissionRemediation, type PermissionCheck } from "./audit-fs.js";

const POSIX_PERMS: PermissionCheck = {
  ok: true,
  isSymlink: false,
  isDir: false,
  mode: 0o644,
  bits: 0o644,
  source: "posix",
  worldWritable: false,
  groupWritable: false,
  worldReadable: true,
  groupReadable: true,
};

const WINDOWS_PERMS: PermissionCheck = {
  ...POSIX_PERMS,
  source: "windows-acl",
  worldReadable: false,
  groupReadable: false,
};

describe("formatPermissionRemediation", () => {
  it("single-quotes and escapes chmod paths with shell metacharacters", () => {
    const targetPath = "/tmp/with space/quo'te`$;name.txt";
    const remediation = formatPermissionRemediation({
      targetPath,
      perms: POSIX_PERMS,
      isDir: false,
      posixMode: 0o600,
    });

    expect(remediation).toBe("chmod 600 '/tmp/with space/quo'\\''te`$;name.txt'");
  });

  it("single-quotes and escapes icacls paths with shell metacharacters", () => {
    const targetPath = "C:\\Temp\\with space\\quo'te`$;name.txt";
    const remediation = formatPermissionRemediation({
      targetPath,
      perms: WINDOWS_PERMS,
      isDir: false,
      posixMode: 0o600,
      env: { USERDOMAIN: "DEV", USERNAME: "Alice" },
    });

    expect(remediation).toBe(
      `icacls 'C:\\Temp\\with space\\quo'\\''te\`$;name.txt' /inheritance:r /grant:r "DEV\\Alice:F" /grant:r "SYSTEM:F"`,
    );
  });
});
