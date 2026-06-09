const DEV_GATEWAY_SHARED_POLICY_LINES = [
  "This goal is planned in the SmithersBot dev checkout, which manages a separate dev gateway (smithersbot-dev-gateway.service).",
  "The first restart that loads newly built SmithersBot code into the running dev gateway is a one-time HOST/OPERATOR action: `systemctl --user restart smithersbot-dev-gateway.service`.",
  "Changes that affect SmithersBot runtime behavior — gateway, setup/install, Telegram, goal execution, worker prompts, config, service install, sandbox, or status behavior — need verification beyond build/lint after stable/operator orchestration loads the new build.",
  "Narrow bootstrap carve-out: infrastructure goals specifically building or fixing the planner/checker/harness/testing pipeline may rely on focused automated tests and no live dev-gateway restart only when the plan includes no requiresDevGatewayControl live step, explicitly defers live dev-gateway verification to a follow-up goal after the harness/checker fix exists, runs focused tests for the changed planning/checking/harness surfaces, and does not modify runtime product behavior that it then claims is live-verified.",
  "For that bootstrap carve-out, do not force a dev-gateway live-verification step merely because workingDir is smithersbot-dev, and do not treat focused tests for changed planning/checking/harness surfaces as only build/lint.",
  "A dev-owned worker must not restart smithersbot-dev-gateway.service and then prove post-restart behavior in the same step. Restart proof must be externalized to stable/operator orchestration; post-restart evidence must come from a fresh dev-owned worker/artifact.",
  "Stable/operator external restart followed by fresh post-restart dev-owned evidence is valid; the invalid shape is dev-owned self-restart proof where the same requiresDevGatewayControl step performs the restart and claims post-restart proof.",
  "Dev-owned workers may prove continuation/OODA UX, blocked/resume UX, mediated dev-gateway status/logs, clean blocker behavior, and post-restart behavior after an external restart. They must not be required to synchronously survive their own controlling gateway restart.",
  "Dev-gateway live-verification tasks use requiresDevGatewayControl, not requiresNetwork, unless the same task separately needs real HTTP/TCP or internet access.",
  "Do not run raw systemctl/journalctl, disable the sandbox, use dangerouslyDisableSandbox, or use no-sandbox/danger-full-access for dev-gateway control. If mediated dev-gateway control is unavailable, the plan must block clearly instead of using a manual-test workaround.",
  "Do not claim live dev-gateway verification unless external restart orchestration or mediated status/logs evidence is present, as appropriate to the behavior under test.",
  'For dev-owned live gateway smoke runs after an external restart, use the trusted local RPC harness, not Telegram or an LLM chat path: `smithersbot harness command --instance dev /new_goal "<smoke goal>"` creates a dev-owned /new_goal run through the target gateway command path.',
  'Use `smithersbot harness command --instance dev /goal_status <runId>`, `smithersbot harness command --instance dev /goal_answer <runId> "<answer>"`, and `smithersbot harness command --instance dev /goal_resume <runId>` for supported goal command follow-ups.',
  'Use `smithersbot harness callback --instance dev <action> <runId> [text...]` and `smithersbot harness reply --instance dev <kind> <runId> "<text>"` for supported continuation, Request Edit, Add Details, and resume flows; fall back to manual Telegram only when the harness lacks the exact operator surface needed.',
  "Concrete ownership proof must name dev-owned vs stable-owned and include the harness ownership fields: instance name, target gateway port, state root, and run.json path under the selected target state root for goal runs.",
  '`agent --message "/new_goal ..."` is not dev-owned live proof because it sends chat text to the agent/LLM path and does not invoke the goal command dispatcher.',
  '`goal "..."` is not dev-owned live proof because it runs locally/in-process in the caller and is not proof of target-gateway ownership.',
  "Do not claim Telegram is required for flows already supported by `smithersbot harness`; use manual Telegram only for unsupported operator surfaces and say what is missing.",
  "For post-restart evidence, pair harness-owned smoke evidence with mediated dev-gateway status/logs evidence; do not use raw systemctl/journalctl.",
  "After the external restart has loaded the new build, workers may use mediated actions to inspect ONLY smithersbot-dev-gateway.service; never restart, reinstall, or modify the stable smithersbot-gateway.service or ~/.smithersbot.",
  "For docs-only or tests-only changes, dev-gateway verification is not required unless it is needed to verify the requested behavior.",
];

export const DEV_GATEWAY_PROMPT_GUIDANCE_ENABLED = false;

export const DEV_GATEWAY_SHARED_POLICY = DEV_GATEWAY_SHARED_POLICY_LINES.join("\n");

export function buildDevGatewayPlannerGuidance(): string {
  return [
    "DEV GATEWAY VERIFICATION (SmithersBot dev checkout):",
    "- Produce plans that follow this shared dev-gateway policy.",
    ...DEV_GATEWAY_SHARED_POLICY_LINES.map((line) => `- ${line}`),
    "- Do not assign the raw systemctl restart command to a worker.",
    "- Assign requiresDevGatewayControl for dev-gateway live-verification tasks, not requiresNetwork.",
  ].join("\n");
}

export function buildDevGatewayReviewGuidance(): string {
  return [
    "## DEV GATEWAY VERIFICATION (SmithersBot dev checkout)",
    "Review the plan against this shared dev-gateway policy.",
    ...DEV_GATEWAY_SHARED_POLICY_LINES,
    "Reject plans that assign the raw systemctl restart command to a worker.",
    "Reject plans that verify runtime changes only with build/lint when post-restart dev-gateway evidence is required.",
    "Reject any plan that asks a dev-owned requiresDevGatewayControl worker to restart smithersbot-dev-gateway.service and then prove post-restart behavior in the same step.",
    "Do NOT reject stable/operator external restart followed by fresh post-restart dev-owned evidence; reject only dev-owned self-restart proof where the same requiresDevGatewayControl step performs the restart and claims post-restart proof.",
    "Require requiresDevGatewayControl=true for mediated dev-gateway status/logs or other allowed host-control evidence; do not accept requiresNetwork as a proxy.",
    "Reject any plan that tells workers to run raw systemctl/journalctl, disable the sandbox, use dangerouslyDisableSandbox, or use no-sandbox/danger-full-access for dev-gateway control.",
    "Do NOT require dev-gateway verification for docs-only or tests-only changes, or for ordinary non-SmithersBot project goals — approve those on their normal merits.",
  ].join("\n");
}
