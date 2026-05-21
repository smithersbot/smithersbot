#!/usr/bin/env tsx
/**
 * Copy the shared worker contract and its backend mirrors from
 * src/goal/worker-context/ into dist/goal/worker-context/ so the compiled
 * runtime (src/prompts/worker/worker-context.ts) can resolve them at the same
 * relative location it uses in source.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const FILES = ["shared-worker-contract.md", "AGENTS.md", "CLAUDE.md"];

const srcDir = path.join(projectRoot, "src", "goal", "worker-context");
const distDir = path.join(projectRoot, "dist", "goal", "worker-context");

function main(): void {
  fs.mkdirSync(distDir, { recursive: true });

  let firstBody: string | undefined;
  let mismatch = false;

  for (const file of FILES) {
    const srcPath = path.join(srcDir, file);
    if (!fs.existsSync(srcPath)) {
      console.warn("[copy-worker-contract] Source file not found:", srcPath);
      process.exitCode = 1;
      return;
    }
    const buf = fs.readFileSync(srcPath);
    const body = buf.toString("utf8");
    if (firstBody === undefined) firstBody = body;
    else if (body !== firstBody) mismatch = true;
    fs.writeFileSync(path.join(distDir, file), buf);
  }

  if (mismatch) {
    console.error(
      "[copy-worker-contract] FATAL: shared-worker-contract.md, AGENTS.md, and CLAUDE.md must be byte-identical.",
    );
    process.exitCode = 1;
  } else {
    console.log("[copy-worker-contract] Copied worker contract files to dist/goal/worker-context/");
  }
}

main();
