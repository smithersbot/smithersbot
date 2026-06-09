#!/usr/bin/env tsx
/**
 * Copy the shared worker contract into its source mirrors and dist so the
 * compiled runtime (src/prompts/worker/worker-context.ts) can resolve them at
 * the same relative location it uses in source.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const SHARED_FILE = "shared-worker-contract.md";
const MIRROR_FILES = ["AGENTS.md", "CLAUDE.md"];
const FILES = [SHARED_FILE, ...MIRROR_FILES];

const srcDir = path.join(projectRoot, "src", "goal", "worker-context");
const distDir = path.join(projectRoot, "dist", "goal", "worker-context");

function main(): void {
  fs.mkdirSync(distDir, { recursive: true });

  const sharedPath = path.join(srcDir, SHARED_FILE);
  if (!fs.existsSync(sharedPath)) {
    console.warn("[copy-worker-contract] Source file not found:", sharedPath);
    process.exitCode = 1;
    return;
  }
  const sharedBody = fs.readFileSync(sharedPath);

  for (const file of MIRROR_FILES) {
    fs.writeFileSync(path.join(srcDir, file), sharedBody);
  }

  for (const file of FILES) {
    const srcPath = path.join(srcDir, file);
    if (!fs.existsSync(srcPath)) {
      console.warn("[copy-worker-contract] Source file not found:", srcPath);
      process.exitCode = 1;
      return;
    }
    const buf = fs.readFileSync(srcPath);
    fs.writeFileSync(path.join(distDir, file), buf);
  }

  console.log("[copy-worker-contract] Synced worker contract mirrors and copied them to dist/goal/worker-context/");
}

main();
