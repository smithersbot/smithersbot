#!/usr/bin/env -S node --import tsx

import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";

type PackFile = { path: string };
type PackResult = { files?: PackFile[] };

const requiredPaths = ["dist/hooks/gmail.js"];
const forbiddenPrefixes: string[] = [];

type PackageJson = {
  name?: string;
  version?: string;
};

function runPackDry(): PackResult[] {
  const tmpParent = resolve(".tmp");
  mkdirSync(tmpParent, { recursive: true });

  const tmpDir = mkdtempSync(join(tmpParent, "release-check-"));
  const stdoutPath = join(tmpDir, "npm-pack.json");
  const stderrPath = join(tmpDir, "npm-pack.stderr");

  const stdoutFd = openSync(stdoutPath, "w");
  const stderrFd = openSync(stderrPath, "w");
  let stdoutOpen = true;
  let stderrOpen = true;

  const closeOutputFiles = () => {
    if (stdoutOpen) {
      closeSync(stdoutFd);
      stdoutOpen = false;
    }
    if (stderrOpen) {
      closeSync(stderrFd);
      stderrOpen = false;
    }
  };

  try {
    const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      env: {
        ...process.env,
        npm_config_cache: process.env.npm_config_cache ?? join(tmpDir, "npm-cache"),
      },
      stdio: ["ignore", stdoutFd, stderrFd],
    });
    closeOutputFiles();

    const raw = readFileSync(stdoutPath, "utf8");
    const stderr = readFileSync(stderrPath, "utf8").trim();

    if (result.error || result.status !== 0) {
      const detail = stderr || raw.trim() || result.error?.message || "unknown error";
      console.error("release-check: npm pack failed.");
      console.error(detail);
      process.exit(1);
    }

    return JSON.parse(raw) as PackResult[];
  } finally {
    closeOutputFiles();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function checkPluginVersions() {
  const rootPackagePath = resolve("package.json");
  const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8")) as PackageJson;
  const targetVersion = rootPackage.version;

  if (!targetVersion) {
    console.error("release-check: root package.json missing version.");
    process.exit(1);
  }

  const extensionsDir = resolve("extensions");
  const entries = readdirSync(extensionsDir, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );

  const mismatches: string[] = [];

  for (const entry of entries) {
    const packagePath = join(extensionsDir, entry.name, "package.json");
    let pkg: PackageJson;
    try {
      pkg = JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;
    } catch {
      continue;
    }

    if (!pkg.name || !pkg.version) {
      continue;
    }

    if (pkg.version !== targetVersion) {
      mismatches.push(`${pkg.name} (${pkg.version})`);
    }
  }

  if (mismatches.length > 0) {
    console.error(`release-check: plugin versions must match ${targetVersion}:`);
    for (const item of mismatches) {
      console.error(`  - ${item}`);
    }
    console.error("release-check: run `pnpm plugins:sync` to align plugin versions.");
    process.exit(1);
  }
}

function main() {
  checkPluginVersions();

  const results = runPackDry();
  const files = results.flatMap((entry) => entry.files ?? []);
  const paths = new Set(files.map((file) => file.path));

  const missing = requiredPaths.filter((path) => !paths.has(path));
  const forbidden = [...paths].filter((path) =>
    forbiddenPrefixes.some((prefix) => path.startsWith(prefix)),
  );

  if (missing.length > 0 || forbidden.length > 0) {
    if (missing.length > 0) {
      console.error("release-check: missing files in npm pack:");
      for (const path of missing) {
        console.error(`  - ${path}`);
      }
    }
    if (forbidden.length > 0) {
      console.error("release-check: forbidden files in npm pack:");
      for (const path of forbidden) {
        console.error(`  - ${path}`);
      }
    }
    process.exit(1);
  }

  console.log("release-check: npm pack contents look OK.");
}

main();
