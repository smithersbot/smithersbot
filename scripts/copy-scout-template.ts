#!/usr/bin/env tsx
/**
 * Copy the scout prompt template from src/goal/templates to dist/goal/templates.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const srcTemplate = path.join(
  projectRoot,
  "src",
  "goal",
  "templates",
  "scout_prompt_template.md",
);
const distTemplate = path.join(
  projectRoot,
  "dist",
  "goal",
  "templates",
  "scout_prompt_template.md",
);

if (!fs.existsSync(srcTemplate)) {
  console.warn("[copy-scout-template] Source template not found:", srcTemplate);
  process.exitCode = 1;
} else {
  fs.mkdirSync(path.dirname(distTemplate), { recursive: true });
  fs.copyFileSync(srcTemplate, distTemplate);
  console.log("[copy-scout-template] Copied scout_prompt_template.md");
}
