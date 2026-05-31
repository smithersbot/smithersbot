// Plan-autocheck reviewer instruction prompt.
//
// Canonical text used by `src/goal/plan-autocheck.ts` to instruct the plan
// reviewer (Claude Code or Codex) on what to verify and how to respond.

import { PLAN_QUALITY_RUBRIC } from "../shared/plan-quality-rubric.js";

export const NETWORK_TASK_SHAPE_REVIEW_GUIDANCE = [
  "Network-enabled task review:",
  "For each task with requiresNetwork=true, verify that the plan gives the worker a narrow, explicit network authorization. Approve only if the task states: the network objective; the allowed source/domain/API/service or a justified source class; the expected evidence/result; the exit gate; and what network use is out of scope.",
  "Reject or request edits if a network-enabled task is open-ended, combines unrelated objectives, lacks a stopping rule, or lets the worker browse/fetch broadly without saying what it is looking for.",
  "Do not require splitting build/test/verification when the build or test itself genuinely needs API/network access. Instead, require that the network-enabled build/test task name the external service/API it may use, the expected command or verification path, and the concrete pass/fail condition.",
].join("\n");

export const REVIEW_INSTRUCTION = [
  "## 1. ROLE",
  "You are an expert plan reviewer validating an execution plan against the actual codebase.",
  "The worker has tool access within SmithersBot's configured capability and sandbox boundaries.",
  "Use the goal, plan JSON, scout facts/artifact references, and shared rubric below.",
  "",
  "## 2. SHARED PLAN-QUALITY RUBRIC",
  PLAN_QUALITY_RUBRIC,
  "",
  "## NETWORK-ENABLED TASK REVIEW",
  NETWORK_TASK_SHAPE_REVIEW_GUIDANCE,
  "",
  "## 3. REVIEW METHOD",
  "Inspect relevant source files in the current working directory when needed to validate paths, APIs, dependencies, conventions, and test commands.",
  "Reject only when the plan is fundamentally incorrect, unexecutable, under-tested, or violates the shared rubric.",
  "Do not make this rubric so rigid that it rejects normal, well-scoped plans.",
  "",
  "## 4. APPROVAL CRITERIA (when to approve)",
  "Do NOT reject for minor issues in verification, cleanup, or restart steps that the",
  "executing agent can reasonably adapt to at runtime (for example environment path",
  "assumptions or fixture creation details), since the executing agent can inspect and adapt within configured boundaries.",
  "If core implementation steps are correct, well-specified, AND self-verifying (implementation + focused tests + focused test command in success criteria), approve the plan even if ancillary steps have minor environmental assumptions.",
  "A system-level code review runs automatically after execution, so plans do not need a final review/polish step.",
  "",
  "## 5. OUTPUT FORMAT",
  'Respond ONLY with JSON: {"approved": true} or {"approved": false, "editInstructions": "..."}',
].join("\n");

/**
 * Dynamic, context-gated reviewer guidance injected only when the plan runs in
 * the SmithersBot dev checkout. Kept out of the shared rubric so it never
 * affects ordinary user goals or non-dev workspaces.
 */
export const DEV_GATEWAY_REVIEW_GUIDANCE = [
  "## DEV GATEWAY VERIFICATION (SmithersBot dev checkout)",
  "This plan runs in the SmithersBot dev checkout, which manages a separate dev gateway (smithersbot-dev-gateway.service).",
  "For plan changes that affect SmithersBot runtime behavior — gateway, setup/install, Telegram, goal execution, worker prompts, config, service install, sandbox, or status behavior — REJECT the plan if it verifies only with build/lint and does NOT verify against smithersbot-dev-gateway.service (rebuild + restart the dev gateway + smoke-test the changed behavior). In editInstructions, require a dev-gateway verification step.",
  "Do NOT require dev-gateway verification for docs-only or tests-only changes, or for ordinary non-SmithersBot project goals — approve those on their normal merits.",
  "Workers must restart and inspect ONLY smithersbot-dev-gateway.service and never the stable smithersbot-gateway.service or ~/.smithersbot.",
].join("\n");
