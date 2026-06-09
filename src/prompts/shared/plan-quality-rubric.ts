// Shared plan-quality rubric for planner and plan-autocheck prompts.
//
// Keep durable examples and anti-pattern names here so planner and autocheck
// consume one source of truth instead of duplicating criteria inline.

export const PLAN_QUALITY_RUBRIC = [
  "PLAN QUALITY RUBRIC (shared):",
  "",
  "Self-verifying implementation steps:",
  "- Every code-changing step is SELF-VERIFYING: it includes implementation AND focused tests AND a focused test command in its success criteria.",
  "- Each code-changing step includes exploration/understanding, implementation, focused tests, and verification in the same step.",
  "- IMPLEMENTATION/TEST SPLITS: reject when step A implements behavior and step B later adds tests for step A.",
  "- Do not split implementation and tests into separate steps. A final integration sweep or report step is allowed only in addition to per-step verification.",
  "- Do not create standalone exploration, reading, or planning steps when that work belongs inside the implementation step that needs it.",
  "",
  "Verification and success criteria:",
  "- Every implementation step names exact focused test command(s) with concrete paths, for example `pnpm vitest run src/goal/planner.test.ts`.",
  "- MISSING FOCUSED REGRESSIONS: reject command-handler, config-schema, prompt, worker-behavior, planner/autocheck, or repo-chat steps that lack a targeted regression test file.",
  "- VAGUE SUCCESS CRITERIA: reject success criteria that only say things like `tests pass`, `add coverage`, or `ensure correctness` without naming the actual command or test path.",
  "- Success criteria are specific, observable done-when conditions. Avoid vague phrases like `tests pass`, `add coverage`, or `ensure correctness` without the command/path that proves it.",
  "- TSC-ONLY LOGIC STEPS: reject when a logic-changing step's success criteria only run `tsc` / `pnpm exec tsc -p tsconfig.json`. Logic changes require a focused regression test command in the same step.",
  "- Do not use `tsc` / `pnpm exec tsc -p tsconfig.json` as the only verification for runtime logic, command handlers, prompts, worker behavior, config schemas, planner/autocheck behavior, or repo-chat.",
  "- Include `pnpm build` for build/runtime wiring changes and `pnpm lint` for lint-sensitive source changes when project conventions require them.",
  "",
  "Concrete scope and dependencies:",
  "- Step descriptions name concrete files, functions, commands, schemas, or prompt surfaces where relevant.",
  "- `Describe what to do, not low-level tool calls` does not mean deferring design, branch-selection, or investigation decisions to the worker. Inline scout findings into worker-facing steps.",
  "- Worker tasks contain the decided approach and evidence path, not vague rediscover-the-approach instructions.",
  "- Dependency edges form a valid DAG and reflect real prerequisites between deliverables.",
  "- Step granularity is reasonable: default to 1-10 steps, usually 3-7, with each step a shippable milestone.",
  "- TINY REPEATED TOUCHES: reject plans with many small steps that touch the same files or same behavior and could be a smaller number of self-verifying steps.",
  "- Merge many tiny steps that repeatedly touch the same files or behavior unless they are independently shippable and verifiable.",
  "",
  "Canonical and sandbox-safe verification gates:",
  "- For managed-worker goal build gates, prefer the repo's canonical CI verification matrix and the smallest touched-path slice that proves the change.",
  "- Before selecting a broad test command, inspect the repo's CI workflows, package scripts, and test configs when available.",
  "- Do not use bare `pnpm vitest run` as a default build gate unless CI itself uses that exact command or the goal explicitly requires full host-suite verification and the worker environment is known to support it.",
  "- If the user's acceptance criteria requests a broader host-only suite that the managed worker cannot run, preserve it as host/CI/manual follow-up verification or an Observation Point, not as a hard managed-worker gate.",
  "- Host-only tests are legitimate tests. Do not delete, weaken, or skip them merely because they are unsuitable for the managed-worker gate.",
  "",
  "Backend and capability boundaries:",
  "- Every step includes an allowed backend selected by the planner's current backend rules.",
  "- Use Codex for code/file-changing work when available; use Claude Code for testing/inspection/non-coding work when both are available, unless a combined code+test step makes Codex the better fit.",
  "- SANDBOX OVERCLAIMS: do not claim broad unrestricted filesystem/shell access, broad kernel-level isolation, or legacy workingDir isolation. The worker has tool access within SmithersBot's configured capability and sandbox boundaries.",
  "- Native backend sandboxing may be described only where implemented and verified by SmithersBot; do not rely on prompts/CLAUDE.md as a security boundary, and do not treat convention files or managed workspaces as security boundaries by themselves.",
  "",
  "Managed workspace, secrets, and conventions:",
  "- Prefer work inside `<managed-root>/agent/workspaces/<workspace-name>`.",
  "- Generated project code reads standard environment variables, and `.env.example` is the safe variable-name contract.",
  "- Real env files stay under `<managed-root>/private/env/<workspace-name>/.env` and `<managed-root>/private/` must not be read, printed, or referenced by generated code.",
  "- Workers do not receive raw secrets by default; raw secrets are not passed to workers by default.",
  "- Respect project convention files such as `CLAUDE.md` and `AGENTS.md` for commands, structure, and workflow.",
  "- If scout shows no `CLAUDE.md`, the first step must be `create-conventions`, creating both `CLAUDE.md` and `AGENTS.md` from scout findings.",
  "",
  "Named anti-patterns to reject:",
  "- Stage 2P under-tested split: `add-529-transient-classifier` verified only by `tsc`, with tests deferred to a later step.",
  "- Stage 2P repo-chat split: `add-repo-chat-cli-output-extraction` and `add-repo-chat-regression-tests` split implementation from the regression tests that prove it.",
  "- Fix-everything wall: one huge step mixes unrelated security, UX, logging, and testing changes with vague success criteria.",
  "- GOAL-ECHO / RE-DELEGATED INVESTIGATION: a step restates the user goal's open question or conditional instead of using the scout's resolved finding.",
  "- FORK-SHAPED SUCCESS CRITERIA: success is `do A if X exists, otherwise document B` even though the scout/codebase already resolved X.",
  "",
  "EXPLICITLY ALLOWED:",
  "- A final verification-matrix step is allowed when it is a cross-cutting sweep and every implementation step still has its own focused tests.",
  "- A final report-writing / documentation step is allowed when the goal explicitly requires it.",
  "- Independent steps may remain separate when they touch distinct files/behavior and each is self-verifying.",
].join("\n");

export const PLAN_QUALITY_ANTI_PATTERN_SUMMARIES = [
  "Stage 2P under-tested split: logic change verified only by tsc while focused tests are deferred.",
  "Stage 2P repo-chat split: implementation and regression tests split across separate steps unnecessarily.",
  "Fix-everything wall: unrelated concerns packed into one vague, overlong step.",
  "GOAL-ECHO / RE-DELEGATED INVESTIGATION: a worker step reopens a question the scout already resolved.",
  "FORK-SHAPED SUCCESS CRITERIA: a step keeps an if/otherwise branch after the scout/codebase resolved the condition.",
  "Tiny repeated touches: many small steps edit the same files/behavior when one self-verifying milestone would work.",
].join("\n");

export function buildPlanQualityRubric(workers?: readonly string[]): string {
  if (!workers || workers.includes("codex")) return PLAN_QUALITY_RUBRIC;
  return PLAN_QUALITY_RUBRIC.replace(
    "- Use Codex for code/file-changing work when available; use Claude Code for testing/inspection/non-coding work when both are available, unless a combined code+test step makes Codex the better fit.",
    "- Use the available backend for every step, including coding, testing, inspection, documentation, and reporting tasks.",
  );
}
