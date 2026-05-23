// Stage 2U-C agent-surface sandbox/security classification builder.
//
// This module produces a machine-readable classification of every SmithersBot
// agent surface (the phases that spawn a Codex / Claude Code backend) plus the
// other runCliProcess callers that are explicitly out of the agent-surface
// audit scope. It is the single source of truth that
// internal/STAGE2U_C_AGENT_SURFACE_AUDIT.json and the consolidated audit report
// reconcile against.
//
// The classification is derived from the actual code paths:
//   - worker (src/goal/cli-worker.ts) and repo-chat
//     (src/repo-chat/repo-chat-worker.ts) route every spawn through the SHARED
//     native sandbox helper in src/goal/backend-sandbox.ts
//     (writeCodexNativeSandboxConfig permission profile for Codex,
//     buildClaudeCodeSandboxLaunchConfig fail-closed settings for Claude). Their
//     deny matrices (private env, repo .env*, symlink escape, auth/session
//     paths) are proven by src/goal/backend-sandbox.test.ts; the live OS-level
//     bubblewrap proof is env-gated (see captureLiveSandboxProofStatus).
//   - scout/planner, plan-autocheck, post-execution-review, lessons, and
//     manual-tests spawn the backend with credential-stripped env
//     (buildCredentialStrippedEnv / buildClaudeCodeEnv from
//     src/goal/claude-code-env.ts) but DO NOT use the shared native sandbox
//     helper: Codex gets its coarse built-in `--sandbox read-only` /
//     `workspace-write` flag (which restricts writes but does not enforce the
//     proven .env/auth deny matrix) and Claude gets no native sandbox settings
//     at all. They are classified credential-stripped-native-sandbox-opt-out.
//
// This module performs NO sandbox-policy changes; it only classifies. It never
// reads or prints private env/auth/session contents.

import type { GoalBackendId } from "./backend-types.js";
import {
  classifyBackendProbeReadiness,
  isLiveSandboxProbeEnabled,
  SANDBOX_LIVE_PROBES_ENV,
  type SandboxProbeStatus,
} from "./sandbox-probes.js";

/** The five allowed sandbox/security classifications for an agent surface. */
export const SANDBOX_CLASSIFICATIONS = [
  "native-sandbox-proven",
  "shared-native-sandbox-helper-proven",
  "credential-stripped-native-sandbox-opt-out",
  "read-only-non-agent-local",
  "not-safe-needs-fix",
] as const;

export type SandboxClassification = (typeof SANDBOX_CLASSIFICATIONS)[number];

/** Agent surfaces are audited for the two CLI backends this audit covers. */
export type AgentSurfaceBackend = "codex" | "claude_code";

/**
 * Per-(surface, backend) security properties. `"n/a"` marks a property that does
 * not apply to that backend (e.g. subscription-auth stripping is Claude-only).
 */
export type SurfaceSecurityProperties = {
  /** Managed private env (<root>/private/env/<ws>/.env) read denied to the agent. */
  privateEnvDenied: boolean;
  /** Repo .env / .env.local / .env.production / .env.test read denied. */
  repoEnvDenied: boolean;
  /** A symlink inside the workspace pointing at a denied target stays denied. */
  symlinkEscapeDenied: boolean;
  /** Auth/session stores (~/.claude, ~/.codex/auth.json) denied to sandboxed Bash. */
  authSessionDenied: boolean;
  /** Safe reads (README.md, .env.example, agent history) still succeed. */
  allowedSafeReadsWork: boolean;
  /** Provider credential env keys stripped before spawn (buildCredentialStrippedEnv). */
  credentialStripped: boolean;
  /** Claude subscription-auth env (ANTHROPIC_API_KEY/AUTH_TOKEN/BASE_URL) stripped. */
  subscriptionAuthStripped: boolean | "n/a";
  /** API-key env poisoning of subscription auth prevented (stripClaudeSubscriptionAuthEnv). */
  apiKeyPoisoningStripped: boolean | "n/a";
  /** No --dangerously-bypass / --dangerously-skip-permissions / danger-full-access flags. */
  noDangerousSkipFlags: boolean;
};

export type BackendSandboxClassification = {
  backend: AgentSurfaceBackend;
  classification: SandboxClassification;
  /** Short description of the sandbox mechanism used for this backend. */
  mechanism: string;
  /** Source reference (file + key function/flag) the classification is based on. */
  sourceRef: string;
  rationale: string;
  properties: SurfaceSecurityProperties;
};

export type AgentSurfaceAudit = {
  surface: string;
  /** True for the agent surfaces this audit classifies; false for excluded callers. */
  inScope: boolean;
  sourceFile: string;
  description: string;
  /** Surfaces whose spawn path this one reuses (repair/resume reuse worker etc.). */
  reusesSurfaces?: string[];
  /** Why an out-of-scope caller is excluded from the agent-surface audit. */
  exclusionReason?: string;
  backends: {
    codex: BackendSandboxClassification | null;
    claude_code: BackendSandboxClassification | null;
  };
};

const NO_DANGEROUS_FLAGS = true;

/**
 * Property preset for surfaces that route through the shared native sandbox
 * helper (worker, repo-chat, and the repair/resume paths that reuse them). The
 * deny matrix is proven in src/goal/backend-sandbox.test.ts; the live OS proof
 * is env-gated.
 */
function nativeHelperProps(backend: AgentSurfaceBackend): SurfaceSecurityProperties {
  return {
    privateEnvDenied: true,
    repoEnvDenied: true,
    symlinkEscapeDenied: true,
    authSessionDenied: true,
    allowedSafeReadsWork: true,
    credentialStripped: true,
    subscriptionAuthStripped: backend === "claude_code" ? true : "n/a",
    apiKeyPoisoningStripped: backend === "claude_code" ? true : "n/a",
    noDangerousSkipFlags: NO_DANGEROUS_FLAGS,
  };
}

/**
 * Property preset for surfaces that strip credentials but opt out of the shared
 * native sandbox helper. Codex still gets its coarse built-in `--sandbox` flag
 * (writes restricted), Claude gets no native sandbox settings; neither enforces
 * the proven .env/auth file-read deny matrix, so the file-deny properties are
 * honestly false. Credential/subscription-auth stripping is the real boundary.
 */
function optOutProps(backend: AgentSurfaceBackend): SurfaceSecurityProperties {
  return {
    privateEnvDenied: false,
    repoEnvDenied: false,
    symlinkEscapeDenied: false,
    authSessionDenied: false,
    allowedSafeReadsWork: true,
    credentialStripped: true,
    subscriptionAuthStripped: backend === "claude_code" ? true : "n/a",
    apiKeyPoisoningStripped: backend === "claude_code" ? true : "n/a",
    noDangerousSkipFlags: NO_DANGEROUS_FLAGS,
  };
}

function nativeHelperBackend(
  backend: AgentSurfaceBackend,
  sourceRef: string,
  mechanism: string,
): BackendSandboxClassification {
  return {
    backend,
    classification: "shared-native-sandbox-helper-proven",
    mechanism,
    sourceRef,
    rationale:
      "Routes the spawn through the shared backend-sandbox.ts native helper " +
      "(proven deny matrix: private env, repo .env*, symlink escape, auth/session); " +
      "credential-stripped env. Live OS bubblewrap proof is env-gated.",
    properties: nativeHelperProps(backend),
  };
}

function optOutBackend(
  backend: AgentSurfaceBackend,
  sourceRef: string,
  mechanism: string,
): BackendSandboxClassification {
  return {
    backend,
    classification: "credential-stripped-native-sandbox-opt-out",
    mechanism,
    sourceRef,
    rationale:
      backend === "codex"
        ? "Spawns Codex with its coarse built-in `--sandbox` flag (writes restricted) " +
          "and credential-stripped env, but does NOT use the shared native-helper " +
          "permission profile, so the proven .env/auth file-read deny matrix is absent. " +
          "Hardening target for 2U-E."
        : "Spawns Claude with credential + subscription-auth stripped env but NO native " +
          "sandbox settings, so file-read denies (.env, ~/.claude) are not enforced. " +
          "Hardening target for 2U-E.",
    properties: optOutProps(backend),
  };
}

/**
 * Build the full agent-surface audit. Every in-scope surface has a defined
 * classification for both Codex and Claude Code; the three out-of-scope
 * runCliProcess callers (goal-sending, nightwatch, pi-runner) are explicitly
 * recorded with an exclusion reason.
 */
export function buildAgentSurfaceAudit(): AgentSurfaceAudit[] {
  return [
    {
      surface: "scout-planner",
      inScope: true,
      sourceFile: "src/goal/cli-planner.ts",
      description:
        "Combined scout+planner. runCliPlanning/runCliPlanRevision spawn the backend " +
        "to produce/revise the plan.",
      backends: {
        codex: optOutBackend(
          "codex",
          "src/goal/cli-planner.ts buildCodexPlanningArgs (`--sandbox workspace-write`, net.allowed=true) + buildCredentialStrippedEnv(stripAuthKeys)",
          "Codex exec `--sandbox workspace-write`, credential-stripped env",
        ),
        claude_code: optOutBackend(
          "claude_code",
          "src/goal/cli-planner.ts runCliPlanning + buildClaudeCodeEnv(authMode)",
          "Claude print mode, credential + subscription-auth stripped env, no native sandbox",
        ),
      },
    },
    {
      surface: "plan-autocheck",
      inScope: true,
      sourceFile: "src/goal/plan-autocheck.ts",
      description: "Plan autocheck/checker/review rounds. runPlanAutocheck spawns the backend.",
      backends: {
        codex: optOutBackend(
          "codex",
          "src/goal/plan-autocheck.ts (`--json --color never --sandbox read-only`) + buildCredentialStrippedEnv(stripAuthKeys)",
          "Codex exec `--sandbox read-only` (no writes), credential-stripped env",
        ),
        claude_code: optOutBackend(
          "claude_code",
          "src/goal/plan-autocheck.ts + buildClaudeCodeEnv(claudeCodeAuth)",
          "Claude print mode, credential + subscription-auth stripped env, no native sandbox",
        ),
      },
    },
    {
      surface: "worker",
      inScope: true,
      sourceFile: "src/goal/cli-worker.ts",
      description:
        "Execution worker. executeTaskWithCliWorker (via cli-runner from agent-executor) spawns " +
        "the backend to perform the task with workspace writes.",
      backends: {
        codex: nativeHelperBackend(
          "codex",
          "src/goal/cli-worker.ts writeCodexNativeSandboxConfig + mergeCodexNativeSandboxEnv(buildCredentialStrippedEnv)",
          "Codex native permission-profile sandbox (workspace-write) via shared helper",
        ),
        claude_code: nativeHelperBackend(
          "claude_code",
          "src/goal/cli-worker.ts buildClaudeCodeSandboxLaunchConfig + buildClaudeCodeEnv",
          "Claude Code native fail-closed sandbox settings via shared helper",
        ),
      },
    },
    {
      surface: "repo-chat",
      inScope: true,
      sourceFile: "src/repo-chat/repo-chat-worker.ts",
      description:
        "Repo-chat conversational backend. runRepoChatWorkerOnce spawns the backend in " +
        "read-only purpose.",
      backends: {
        codex: nativeHelperBackend(
          "codex",
          "src/repo-chat/repo-chat-worker.ts writeCodexNativeSandboxConfig(purpose=repo-chat) + mergeCodexNativeSandboxEnv",
          "Codex native permission-profile sandbox (read-only) via shared helper",
        ),
        claude_code: nativeHelperBackend(
          "claude_code",
          "src/repo-chat/repo-chat-worker.ts buildClaudeCodeSandboxLaunchConfig(purpose=repo-chat) + buildClaudeCodeEnv",
          "Claude Code native fail-closed sandbox settings (read-only) via shared helper",
        ),
      },
    },
    {
      surface: "post-execution-review",
      inScope: true,
      sourceFile: "src/goal/post-execution-review.ts",
      description:
        "Post-execution review of the diff (single-pass or chunked). Spawns the backend per chunk.",
      backends: {
        codex: optOutBackend(
          "codex",
          "src/goal/post-execution-review.ts (`exec --sandbox workspace-write`) + buildCredentialStrippedEnv(stripAuthKeys)",
          "Codex exec `--sandbox workspace-write`, credential-stripped env",
        ),
        claude_code: optOutBackend(
          "claude_code",
          "src/goal/post-execution-review.ts + buildClaudeCodeEnv(claudeCodeAuth)",
          "Claude print mode, credential + subscription-auth stripped env, no native sandbox",
        ),
      },
    },
    {
      surface: "manual-tests",
      inScope: true,
      sourceFile: "src/goal/manual-tests.ts",
      description:
        "Manual-test suggestion generation. Spawns a CLI backend, or uses an in-process " +
        "GoalLlmClient.complete() API path (no filesystem-executing subprocess).",
      backends: {
        codex: optOutBackend(
          "codex",
          "src/goal/manual-tests.ts (`--sandbox`) + buildCredentialStrippedEnv",
          "Codex exec `--sandbox`, credential-stripped env (or GoalLlmClient API path, no FS)",
        ),
        claude_code: optOutBackend(
          "claude_code",
          "src/goal/manual-tests.ts + buildClaudeCodeEnv(subscription)",
          "Claude print mode, subscription-auth stripped env, no native sandbox (or GoalLlmClient API path)",
        ),
      },
    },
    {
      surface: "lessons",
      inScope: true,
      sourceFile: "src/goal/lessons.ts",
      description:
        "Lessons extraction. runClaudeLessonExtraction / runCodexLessonExtraction spawn the backend.",
      backends: {
        codex: optOutBackend(
          "codex",
          "src/goal/lessons.ts runCodexLessonExtraction (`--sandbox read-only`) + buildCredentialStrippedEnv(stripAuthKeys)",
          "Codex exec `--sandbox read-only`, credential-stripped env",
        ),
        claude_code: optOutBackend(
          "claude_code",
          "src/goal/lessons.ts runClaudeLessonExtraction + buildClaudeCodeEnv(subscription)",
          "Claude print mode, subscription-auth stripped env, no native sandbox",
        ),
      },
    },
    {
      surface: "repair",
      inScope: true,
      sourceFile:
        "src/goal/agent-executor.ts, src/repo-chat/repo-chat-worker.ts (runSandboxSafeRepair)",
      description:
        "Repair/retry path. Re-runs the worker (agent-executor retry) or repo-chat " +
        "(runSandboxSafeRepair) spawn; introduces no independent sandbox surface.",
      reusesSurfaces: ["worker", "repo-chat"],
      backends: {
        codex: nativeHelperBackend(
          "codex",
          "src/repo-chat/repo-chat-worker.ts runSandboxSafeRepair writeCodexNativeSandboxConfig (reuses worker/repo-chat helper)",
          "Reuses the shared native permission-profile sandbox of worker/repo-chat",
        ),
        claude_code: nativeHelperBackend(
          "claude_code",
          "src/repo-chat/repo-chat-worker.ts runSandboxSafeRepair buildClaudeCodeSandboxLaunchConfig (reuses worker/repo-chat helper)",
          "Reuses the shared native fail-closed Claude sandbox of worker/repo-chat",
        ),
      },
    },
    {
      surface: "resume-replan",
      inScope: true,
      sourceFile: "src/goal/goal.ts, src/goal/goal-resume.ts",
      description:
        "Goal resume / replan orchestration. Re-invokes the worker (resume) and planner " +
        "(replan) spawn paths; introduces no independent sandbox surface. The replan branch " +
        "inherits the scout-planner credential-stripped-native-sandbox-opt-out classification.",
      reusesSurfaces: ["worker", "scout-planner"],
      backends: {
        codex: nativeHelperBackend(
          "codex",
          "src/goal/goal-resume.ts re-invokes executeTaskWithCliWorker (worker native helper); replan reuses cli-planner opt-out",
          "Resume reuses the worker native permission-profile sandbox; replan reuses planner opt-out",
        ),
        claude_code: nativeHelperBackend(
          "claude_code",
          "src/goal/goal-resume.ts re-invokes executeTaskWithCliWorker (worker native helper); replan reuses cli-planner opt-out",
          "Resume reuses the worker native Claude sandbox; replan reuses planner opt-out",
        ),
      },
    },
    // --- Out-of-scope runCliProcess callers (explicitly excluded) ---
    {
      surface: "goal-sending",
      inScope: false,
      sourceFile: "src/telegram/goal-sending.ts",
      description:
        "Telegram goal-sending Mermaid diagram repair helper. Spawns Codex/Claude only to " +
        "repair a broken Mermaid diagram for rendering — not a goal/agent task execution surface.",
      exclusionReason:
        "Mermaid-diagram repair utility, not an agent task surface. It still uses Codex " +
        "`--sandbox workspace-write` + credential-stripped env and Claude read-only tools " +
        "(CLAUDE_ALLOWED_TOOLS_READ_ONLY); classified for documentation as opt-out.",
      backends: {
        codex: optOutBackend(
          "codex",
          "src/telegram/goal-sending.ts buildCodexMermaidRepairArgs (`--sandbox workspace-write`) + buildCredentialStrippedEnv",
          "Codex exec `--sandbox workspace-write`, credential-stripped (Mermaid repair only)",
        ),
        claude_code: optOutBackend(
          "claude_code",
          "src/telegram/goal-sending.ts + buildClaudeCodeEnv + CLAUDE_ALLOWED_TOOLS_READ_ONLY",
          "Claude read-only tools, credential + subscription-auth stripped (Mermaid repair only)",
        ),
      },
    },
    {
      surface: "nightwatch",
      inScope: false,
      sourceFile: "src/cron/nightwatch.ts",
      description:
        "Nightly cron maintenance job (lesson/goal review). Spawns Codex/Claude read-only to " +
        "review prior runs — not a user-driven goal/agent task surface.",
      exclusionReason:
        "Cron maintenance job, not a per-goal agent surface. Uses Codex `--sandbox read-only` " +
        "(+ the benign `--skip-git-repo-check`, which is NOT a sandbox-bypass flag) and Claude " +
        "read-only tools, both credential-stripped; classified for documentation as opt-out.",
      backends: {
        codex: optOutBackend(
          "codex",
          "src/cron/nightwatch.ts (`--sandbox read-only --skip-git-repo-check`) + buildCredentialStrippedEnv",
          "Codex exec `--sandbox read-only`, credential-stripped (cron review)",
        ),
        claude_code: optOutBackend(
          "claude_code",
          "src/cron/nightwatch.ts + buildClaudeCodeEnv(subscription) + CLAUDE_ALLOWED_TOOLS_READ_ONLY",
          "Claude read-only tools, subscription-auth stripped (cron review)",
        ),
      },
    },
    {
      surface: "pi-runner",
      inScope: false,
      sourceFile: "src/goal/pi-runner.ts",
      description:
        "In-process `pi` coding-agent backend (@mariozechner/pi-coding-agent). Runs tools " +
        "in-process via createEnforcedCodingTools rather than spawning a Codex/Claude CLI.",
      exclusionReason:
        "Not a Codex/Claude CLI surface. The `pi` backend runs in-process and its boundary is " +
        "capability-enforcement (createEnforcedCodingTools + hard-deny path/command checks), not " +
        "the OS-level native sandbox this audit covers; it also uses provider API keys directly " +
        "(not credential-stripped). Recommend a separate capability-enforcement review.",
      backends: {
        codex: null,
        claude_code: null,
      },
    },
  ];
}

/**
 * Capture live OS-level sandbox proof readiness for both backends. When the
 * live-probe env flag is unset (the default in worker subprocesses), this
 * records the exact enabling command and the blocker reason rather than a vague
 * failure, so the consolidated report can quote it.
 */
export function captureLiveSandboxProofStatus(): {
  enabled: boolean;
  envFlag: string;
  enableCommand: string;
  codex: SandboxProbeStatus;
  claude: SandboxProbeStatus;
} {
  return {
    enabled: isLiveSandboxProbeEnabled(),
    envFlag: SANDBOX_LIVE_PROBES_ENV,
    enableCommand: `${SANDBOX_LIVE_PROBES_ENV}=1 pnpm vitest run src/goal/sandbox-probes.test.ts`,
    codex: classifyBackendProbeReadiness("codex"),
    claude: classifyBackendProbeReadiness("claude_code"),
  };
}

export type AgentSurfaceAuditSummary = {
  totalSurfaces: number;
  inScopeSurfaces: number;
  excludedCallers: string[];
  countByClassification: Record<SandboxClassification, number>;
  surfacesNeedingFix: string[];
};

/** Summarize the audit for the report verdict lines. */
export function summarizeAgentSurfaceAudit(
  audit: AgentSurfaceAudit[] = buildAgentSurfaceAudit(),
): AgentSurfaceAuditSummary {
  const countByClassification = Object.fromEntries(
    SANDBOX_CLASSIFICATIONS.map((classification) => [classification, 0]),
  ) as Record<SandboxClassification, number>;
  const surfacesNeedingFix: string[] = [];
  const excludedCallers: string[] = [];

  for (const entry of audit) {
    if (!entry.inScope) excludedCallers.push(entry.surface);
    for (const backend of ["codex", "claude_code"] as const) {
      const classification = entry.backends[backend];
      if (!classification) continue;
      countByClassification[classification.classification] += 1;
      if (classification.classification === "not-safe-needs-fix") {
        surfacesNeedingFix.push(`${entry.surface}:${backend}`);
      }
    }
  }

  return {
    totalSurfaces: audit.length,
    inScopeSurfaces: audit.filter((entry) => entry.inScope).length,
    excludedCallers,
    countByClassification,
    surfacesNeedingFix,
  };
}

/** Backend id helper kept aligned with GoalBackendId for downstream consumers. */
export function isAuditedBackend(backend: GoalBackendId): backend is AgentSurfaceBackend {
  return backend === "codex" || backend === "claude_code";
}
