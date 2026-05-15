#!/usr/bin/env node
// Safe denial probe for SmithersBot hard-deny guardrails.
//
// This script imports the PURE deny-check functions exported from
// src/goal/hard-deny.ts via tsx (TypeScript on-the-fly loader) and calls them
// on a few harmless fake forbidden strings. It NEVER executes the strings as
// shell commands or filesystem operations — they are passed as plain JS
// strings to pure functions that return a HardDeny match descriptor (or null).
//
// Run with:
//   node --import tsx RELEASE_AUDIT/README_VERIFY/artifacts/claim-16-denial-probe.mjs
//
// Exit code 0 means every fake forbidden input was correctly denied AND every
// safe baseline input was correctly allowed. Non-zero indicates a guardrail
// miss.

import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const hardDenyPath = path.join(repoRoot, "src", "goal", "hard-deny.ts");

const mod = await import(hardDenyPath);
const { checkCommandDeny, checkPathDeny, HARD_DENIES } = mod;

if (typeof checkCommandDeny !== "function" || typeof checkPathDeny !== "function") {
  console.error("FAIL: expected checkCommandDeny / checkPathDeny exports");
  process.exit(2);
}

const commandCases = [
  { input: "rm -rf /", shouldDeny: true, label: "rm-rf-root" },
  { input: "sudo cat /etc/shadow", shouldDeny: true, label: "sudo-prefix" },
  { input: "npm publish", shouldDeny: true, label: "npm-publish" },
  { input: "kubectl apply -f manifest.yaml", shouldDeny: true, label: "kubectl-apply" },
  { input: "echo hello world", shouldDeny: false, label: "harmless-echo" },
];

const pathCases = [
  { input: ".env", shouldDeny: true, label: "env-file" },
  { input: "/home/user/.ssh/id_rsa", shouldDeny: true, label: "ssh-private-key" },
  { input: "credentials.json", shouldDeny: true, label: "credentials-json" },
  { input: "README.md", shouldDeny: false, label: "harmless-readme" },
];

let failures = 0;

console.log(`HARD_DENIES total entries: ${HARD_DENIES.length}`);
console.log("");
console.log("=== command deny probe ===");
for (const c of commandCases) {
  const result = checkCommandDeny(c.input);
  const denied = result !== null;
  const ok = denied === c.shouldDeny;
  if (!ok) failures += 1;
  console.log(
    `[${ok ? "PASS" : "FAIL"}] ${c.label.padEnd(20)} input=${JSON.stringify(c.input).padEnd(40)} shouldDeny=${c.shouldDeny} got=${denied ? `DENY(${result.pattern}: ${result.reason})` : "ALLOW"}`,
  );
}

console.log("");
console.log("=== path deny probe ===");
for (const c of pathCases) {
  const result = checkPathDeny(c.input);
  const denied = result !== null;
  const ok = denied === c.shouldDeny;
  if (!ok) failures += 1;
  console.log(
    `[${ok ? "PASS" : "FAIL"}] ${c.label.padEnd(20)} input=${JSON.stringify(c.input).padEnd(40)} shouldDeny=${c.shouldDeny} got=${denied ? `DENY(${result.pattern}: ${result.reason})` : "ALLOW"}`,
  );
}

console.log("");
console.log(`failures: ${failures}`);
process.exit(failures > 0 ? 1 : 0);
