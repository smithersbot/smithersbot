#!/usr/bin/env tsx
/**
 * Copy the scout prompt template from src/prompts/scout to dist/prompts/scout
 * so the compiled runtime can resolve it from the same relative location.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const TEMPLATE_FILE = "scout_prompt_template.md";

const srcTemplate = path.join(projectRoot, "src", "prompts", "scout", TEMPLATE_FILE);
const distTemplate = path.join(projectRoot, "dist", "prompts", "scout", TEMPLATE_FILE);

if (!fs.existsSync(srcTemplate)) {
  console.warn("[copy-scout-template] Source template not found:", srcTemplate);
  process.exitCode = 1;
} else {
  fs.mkdirSync(path.dirname(distTemplate), { recursive: true });
  fs.copyFileSync(srcTemplate, distTemplate);
  console.log("[copy-scout-template] Copied scout_prompt_template.md");
}
