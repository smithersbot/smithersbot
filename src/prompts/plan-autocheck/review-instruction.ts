// Plan-autocheck reviewer instruction prompt.
//
// Canonical text used by `src/goal/plan-autocheck.ts` to instruct the plan
// reviewer (Claude Code or Codex) on what to verify and how to respond.

import { PLAN_QUALITY_RUBRIC } from "../shared/plan-quality-rubric.js";
import { PLAN_QUALITY_PRINCIPLES } from "../shared/plan-quality-principles.js";
import { buildDevGatewayReviewGuidance } from "../shared/dev-gateway-guidance.js";

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
  "Terms (Task, successCriteria, Key Decision, Observation Point, Decision(s) Needed, verification): use them as defined in GLOSSARY.md; do not import software-engineering jargon the glossary does not define. Link GLOSSARY.md rather than restating its definitions.",
  "",
  "## 2. SHARED PLAN-QUALITY RUBRIC",
  PLAN_QUALITY_RUBRIC,
  "",
  "## PLAN-QUALITY REVIEW LENS",
  PLAN_QUALITY_PRINCIPLES,
  "- Review whether Tasks are thin, end-to-end, and independently verifiable; whether any Task adds indirection that earns nothing; and whether verification is behavior-based.",
  "- When reviewing whether a Plan's verification is adequate, see docs/goal-engine-guides/testing-guidance.md",
  "- For Plans fixing hard/intermittent bugs, see docs/goal-engine-guides/diagnosis-guide.md",
  "",
  "## NETWORK-ENABLED TASK REVIEW",
  NETWORK_TASK_SHAPE_REVIEW_GUIDANCE,
  "",
  "## 3. REVIEW METHOD",
  "Inspect relevant source files in the current working directory when needed to validate paths, APIs, dependencies, conventions, and test commands.",
  "Reject plans whose buildGate or final verification Task uses a broad command such as bare `pnpm vitest run` when the repo's CI matrix does not use that command or when the managed-worker environment cannot run the host-only suites it includes. This is not a minor verification detail.",
  "When scout_report, plan_draft, or node_specs artifacts exist, cross-check worker-facing steps against them. If the scout resolved an unknown or conditional, reject steps that leave the value open instead of inlining the resolved branch, approach, and evidence path.",
  "Reject worker-facing steps that reopen decisions or keep conditional success branches when the scout or codebase already resolved them. Verification, restart, cleanup, or report leniency must not excuse punts or branched criteria.",
  "Leniency for verification/report steps does not apply to impossible, non-canonical, host-only, or sandbox-incompatible verification gates.",
  "Reject only when the plan is fundamentally incorrect, unexecutable, under-tested, or violates the shared rubric.",
  "Do not make this rubric so rigid that it rejects normal, well-scoped plans.",
  "",
  "## 4. APPROVAL CRITERIA (when to approve)",
  "Do NOT reject for minor issues in verification, cleanup, or restart steps that the",
  "executing agent can reasonably adapt to at runtime (for example environment path",
  "assumptions or fixture creation details), since the executing agent can inspect and adapt within configured boundaries.",
  "This leniency applies only to minor execution details; it does not apply when a step reopens a resolved scout decision, delegates design/investigation back to the worker, uses fork-shaped success criteria after the condition is resolved, or overclaims restart/live verification evidence.",
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
export const DEV_GATEWAY_REVIEW_GUIDANCE = buildDevGatewayReviewGuidance();
