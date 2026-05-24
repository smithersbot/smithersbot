import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildAgentSurfaceAudit,
  captureLiveSandboxProofStatus,
  isAuditedBackend,
  SANDBOX_CLASSIFICATIONS,
  summarizeAgentSurfaceAudit,
  type AgentSurfaceBackend,
  type SandboxClassification,
} from "./agent-surface-audit.js";
import {
  appendAgentHistoryEvent,
  resolveAgentHistoryEventsPath,
  writeAgentPromptArtifact,
  writeCriticalAgentLaunchEvent,
  type AgentHistoryScope,
} from "./agent-history-events.js";
import { isLiveSandboxProbeEnabled, SANDBOX_LIVE_PROBES_ENV } from "./sandbox-probes.js";

const CLASSIFICATION_SET = new Set<SandboxClassification>(SANDBOX_CLASSIFICATIONS);

/** Every agent surface this audit must classify (in scope). */
const EXPECTED_IN_SCOPE = [
  "scout-planner",
  "plan-autocheck",
  "worker",
  "repo-chat",
  "manual-tests",
  "lessons",
  "repair",
  "resume-replan",
];

/** Out-of-scope runCliProcess callers that must be explicitly classified/excluded. */
const EXPECTED_EXCLUDED = ["goal-sending", "nightwatch", "pi-runner"];

describe("agent surface sandbox/security classification builder", () => {
  it("classifies every known agent surface for both Codex and Claude Code", () => {
    const audit = buildAgentSurfaceAudit();
    const inScope = audit.filter((entry) => entry.inScope).map((entry) => entry.surface);
    expect(inScope.sort()).toEqual([...EXPECTED_IN_SCOPE].sort());

    for (const entry of audit.filter((e) => e.inScope)) {
      for (const backend of ["codex", "claude_code"] as const) {
        const classification = entry.backends[backend];
        // No undefined/null entry for any in-scope surface+backend.
        expect(classification, `${entry.surface}:${backend} must be defined`).toBeTruthy();
        expect(CLASSIFICATION_SET.has(classification!.classification)).toBe(true);
        expect(classification!.backend).toBe(backend);
        expect(classification!.mechanism.length).toBeGreaterThan(0);
        expect(classification!.sourceRef.length).toBeGreaterThan(0);
        expect(classification!.rationale.length).toBeGreaterThan(0);
        // Dangerous skip flags must never be used by any in-scope surface.
        expect(classification!.properties.noDangerousSkipFlags).toBe(true);
      }
    }
  });

  it("never leaves an undefined classification value anywhere in the audit", () => {
    const audit = buildAgentSurfaceAudit();
    for (const entry of audit) {
      for (const backend of ["codex", "claude_code"] as const) {
        const classification = entry.backends[backend];
        if (classification === null) continue;
        expect(classification.classification).toBeDefined();
        expect(CLASSIFICATION_SET.has(classification.classification)).toBe(true);
      }
    }
  });

  it("explicitly excludes goal-sending, nightwatch, and pi-runner with reasons", () => {
    const audit = buildAgentSurfaceAudit();
    const excluded = audit.filter((entry) => !entry.inScope).map((entry) => entry.surface);
    expect(excluded.sort()).toEqual([...EXPECTED_EXCLUDED].sort());

    for (const entry of audit.filter((e) => !e.inScope)) {
      expect(entry.exclusionReason && entry.exclusionReason.length).toBeGreaterThan(0);
      expect(entry.sourceFile.length).toBeGreaterThan(0);
    }

    // pi-runner is not a Codex/Claude CLI surface at all -> no backend classification.
    const piRunner = audit.find((entry) => entry.surface === "pi-runner");
    expect(piRunner?.backends.codex).toBeNull();
    expect(piRunner?.backends.claude_code).toBeNull();
    expect(piRunner?.exclusionReason).toContain("capability-enforcement");
  });

  it("marks hardened in-scope CLI surfaces as shared-native-sandbox-helper-proven", () => {
    const audit = buildAgentSurfaceAudit();
    for (const surface of [
      "scout-planner",
      "plan-autocheck",
      "worker",
      "repo-chat",
      "manual-tests",
      "lessons",
      "repair",
      "resume-replan",
    ]) {
      const entry = audit.find((e) => e.surface === surface)!;
      for (const backend of ["codex", "claude_code"] as const) {
        const classification = entry.backends[backend]!;
        expect(classification.classification).toBe("shared-native-sandbox-helper-proven");
        expect(classification.properties.privateEnvDenied).toBe(true);
        expect(classification.properties.repoEnvDenied).toBe(true);
        expect(classification.properties.symlinkEscapeDenied).toBe(true);
        expect(classification.properties.authSessionDenied).toBe(true);
        expect(classification.properties.allowedSafeReadsWork).toBe(true);
        expect(classification.properties.credentialStripped).toBe(true);
      }
      // Claude-specific subscription-auth + API-key-poisoning protections present.
      expect(entry.backends.claude_code!.properties.subscriptionAuthStripped).toBe(true);
      expect(entry.backends.claude_code!.properties.apiKeyPoisoningStripped).toBe(true);
    }
  });

  it("leaves only excluded Codex/Claude utility callers as credential-stripped opt-out", () => {
    const audit = buildAgentSurfaceAudit();
    for (const surface of ["goal-sending", "nightwatch"]) {
      const entry = audit.find((e) => e.surface === surface)!;
      expect(entry.inScope).toBe(false);
      for (const backend of ["codex", "claude_code"] as const) {
        const classification = entry.backends[backend]!;
        expect(classification.classification).toBe("credential-stripped-native-sandbox-opt-out");
        // The honest finding: these opt out of the proven file-read deny matrix.
        expect(classification.properties.privateEnvDenied).toBe(false);
        expect(classification.properties.repoEnvDenied).toBe(false);
        // The real boundary is credential stripping.
        expect(classification.properties.credentialStripped).toBe(true);
      }
    }
  });

  it("summarizes the audit with no surface needing a fix and the three excluded callers", () => {
    const summary = summarizeAgentSurfaceAudit();
    expect(summary.surfacesNeedingFix).toEqual([]);
    expect(summary.countByClassification["not-safe-needs-fix"]).toBe(0);
    expect(summary.inScopeSurfaces).toBe(EXPECTED_IN_SCOPE.length);
    expect(summary.excludedCallers.sort()).toEqual([...EXPECTED_EXCLUDED].sort());
    expect(summary.countByClassification["shared-native-sandbox-helper-proven"]).toBe(16);
    expect(summary.countByClassification["credential-stripped-native-sandbox-opt-out"]).toBe(4);
  });

  it("classifies audited backends via the GoalBackendId helper", () => {
    const backends: AgentSurfaceBackend[] = ["codex", "claude_code"];
    for (const backend of backends) {
      expect(isAuditedBackend(backend)).toBe(true);
    }
    expect(isAuditedBackend("pi")).toBe(false);
  });

  it("records the exact live-proof command + blocker when OS-level probes are env-gated", () => {
    const status = captureLiveSandboxProofStatus();
    expect(status.envFlag).toBe(SANDBOX_LIVE_PROBES_ENV);
    expect(status.enableCommand).toContain(SANDBOX_LIVE_PROBES_ENV);
    expect(status.enableCommand).toContain("pnpm vitest run");
    expect(status.enabled).toBe(isLiveSandboxProbeEnabled());
    if (!status.enabled) {
      // No vague failure: record the exact enabling env flag as the blocker.
      expect(status.codex.status).toBe("not-run");
      expect(status.claude.status).toBe("not-run");
      expect("reason" in status.codex && status.codex.reason).toContain(SANDBOX_LIVE_PROBES_ENV);
      expect("reason" in status.claude && status.claude.reason).toContain(SANDBOX_LIVE_PROBES_ENV);
    } else {
      expect(["proven", "unproven"]).toContain(status.codex.status);
      expect(["proven", "unproven"]).toContain(status.claude.status);
    }
  });
});

describe("agent-visible history is secret-free through the primitive writers", () => {
  let managedRoot: string;
  let previousRoot: string | undefined;
  const plantedTokenEnvKey = "STAGE2UC_AUDIT_PLANTED_TOKEN";
  let previousPlantedToken: string | undefined;

  const PLANTED = {
    apiKey: "sk-PLANTEDAUDITKEY1234567890",
    ghToken: "ghp_PLANTEDAUDITGHTOKEN1234",
    awsKey: "AKIAABCDEFGHIJKLMNOP",
    slackToken: "xoxb-PLANTED-AUDIT-1234567890",
    jwt: "eyJhbGciOiJIUzI1.eyJzdWIiOjEyMzQ1.PLANTEDsignature12",
    envSecret: "planted-env-secret-value-9911",
  };

  const scope: AgentHistoryScope = {
    kind: "goal",
    workspaceName: "audit-ws",
    goalId: "run-secret-free",
  };

  beforeEach(() => {
    managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-surface-audit-"));
    previousRoot = process.env.SMITHERSBOT_GOALS_ROOT;
    process.env.SMITHERSBOT_GOALS_ROOT = managedRoot;
    previousPlantedToken = process.env[plantedTokenEnvKey];
    process.env[plantedTokenEnvKey] = PLANTED.envSecret;
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
    else process.env.SMITHERSBOT_GOALS_ROOT = previousRoot;
    if (previousPlantedToken === undefined) delete process.env[plantedTokenEnvKey];
    else process.env[plantedTokenEnvKey] = previousPlantedToken;
    fs.rmSync(managedRoot, { recursive: true, force: true });
  });

  function assertNoSecrets(text: string): void {
    for (const secret of Object.values(PLANTED)) {
      expect(text).not.toContain(secret);
    }
  }

  it("redacts planted secrets from the critical launch prompt artifact and launch event", () => {
    const prompt = [
      "Run the task.",
      `API key: ${PLANTED.apiKey}`,
      `GitHub token: ${PLANTED.ghToken}`,
      `AWS key: ${PLANTED.awsKey}`,
      `Slack token: ${PLANTED.slackToken}`,
      `JWT: ${PLANTED.jwt}`,
      `Env secret: ${PLANTED.envSecret}`,
    ].join("\n");

    const { promptArtifactPath, eventPath } = writeCriticalAgentLaunchEvent({
      scope,
      phase: "worker",
      backend: "codex",
      prompt,
      argv: ["codex", "exec", `--token=${PLANTED.ghToken}`, "<prompt>"],
      event: { runId: "run-secret-free", stepId: "step-1" },
    });

    const promptText = fs.readFileSync(promptArtifactPath, "utf8");
    assertNoSecrets(promptText);
    expect(promptText).toContain("[REDACTED]");

    const eventText = fs.readFileSync(eventPath, "utf8");
    assertNoSecrets(eventText);
    // argv secret redacted but the launch event itself is recorded.
    expect(eventText).toContain('"event":"launch"');
    expect(eventText).toContain("[REDACTED]");
  });

  it("redacts planted secrets from incremental JSONL events (summary + error class)", () => {
    appendAgentHistoryEvent(scope, {
      event: "result",
      phase: "worker",
      backend: "claude_code",
      status: "failed",
      outputSummary: `failure leaked ${PLANTED.apiKey} and ${PLANTED.envSecret}`,
      errorClass: `error: ${PLANTED.jwt}`,
    });

    const eventsPath = resolveAgentHistoryEventsPath(scope);
    const text = fs.readFileSync(eventsPath, "utf8");
    assertNoSecrets(text);
    expect(text).toContain("[REDACTED]");
    expect(text).toContain('"event":"result"');
  });

  it("redacts planted secrets written directly via the prompt artifact writer", () => {
    const promptPath = writeAgentPromptArtifact({
      scope: { kind: "repo-chat", workspaceName: "audit-ws", sessionId: "sess-1" },
      phase: "repo-chat",
      backend: "claude_code",
      prompt: `Secrets: ${PLANTED.apiKey} ${PLANTED.slackToken} ${PLANTED.awsKey}`,
    });
    const text = fs.readFileSync(promptPath, "utf8");
    assertNoSecrets(text);
    expect(text).toContain("[REDACTED]");
  });
});
