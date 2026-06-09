import path from "node:path";

import { loadConfig } from "../../config/config.js";
import { resolveGatewayInstanceFromEnv } from "../../config/gateway-instance.js";
import { resolveRunDir } from "../../goal/run-store.js";
import type { RestartAttempt } from "../../infra/restart.js";
import { triggerMoltbotRestart } from "../../infra/restart.js";
import { resolveContinuationClient } from "../../telegram/continuation-client.js";
import {
  applyContinuationEditReply,
  applyResumeDetailsReply,
  handleContinuationProposalAction,
  openAddDetailsReply,
  type ContinuationProposalAction,
} from "../../telegram/continuation-core.js";
import { buildGatewayStatusMessage } from "../../telegram/gateway-status.js";
import {
  handleGoal,
  handleGoalAnswer,
  handleGoalApprove,
  handleGoalStatus,
  type GoalPlanResult,
} from "../../telegram/goal-commands.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";

export type HarnessOwnership = {
  instance: "stable" | "dev";
  port: number;
  stateRoot: string;
  serviceUnit: string;
  runId?: string;
  runJsonPath?: string;
};

export type HarnessMessage = {
  text: string;
  replyMarkup?: unknown;
};

export type HarnessResult = {
  ok: boolean;
  messages: HarnessMessage[];
  ownership: HarnessOwnership;
  state?: string;
  restart?: RestartAttempt & { unit: string };
};

export type HarnessDeps = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  restart?: (unit: string) => RestartAttempt;
};

const COMMANDS = new Set([
  "new_goal",
  "goal",
  "goal_status",
  "goal_answer",
  "goal_resume",
  "gateway_status",
]);

const CALLBACK_ACTIONS: Record<string, ContinuationProposalAction | "add_details" | "resume"> = {
  approve_prompt: "approve_prompt",
  more_details: "more_details",
  request_edit: "request_edit",
  no_further_plan: "no_further_plan",
  make_another_plan: "make_another_plan",
  add_details: "add_details",
  resume: "resume",
};

function textParam(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalTextParam(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function ownership(params: { runId?: string; deps?: HarnessDeps }): HarnessOwnership {
  const env = params.deps?.env ?? process.env;
  const instance = resolveGatewayInstanceFromEnv(env, params.deps?.homedir);
  const goalsDir = path.join(instance.stateDir, "goals");
  return {
    instance: instance.name,
    port: instance.defaultPort,
    stateRoot: instance.stateDir,
    serviceUnit: instance.serviceUnit,
    ...(params.runId
      ? {
          runId: params.runId,
          runJsonPath: path.join(resolveRunDir(params.runId, goalsDir), "run.json"),
        }
      : {}),
  };
}

function messagesFromGoalResult(result: string | GoalPlanResult | undefined): HarnessMessage[] {
  if (result == null) return [];
  if (typeof result === "string") return [{ text: result }];
  return [{ text: result.text }];
}

function resultRunId(result: string | GoalPlanResult | undefined): string | undefined {
  return typeof result === "object" && result != null ? result.runId : undefined;
}

function send(opts: {
  ok: boolean;
  messages: HarnessMessage[];
  runId?: string;
  state?: string;
  restart?: RestartAttempt & { unit: string };
  deps?: HarnessDeps;
}): HarnessResult {
  return {
    ok: opts.ok,
    messages: opts.messages,
    ownership: ownership({ runId: opts.runId, deps: opts.deps }),
    ...(opts.state ? { state: opts.state } : {}),
    ...(opts.restart ? { restart: opts.restart } : {}),
  };
}

function createCommandHandler(deps?: HarnessDeps): GatewayRequestHandler {
  return async ({ params, respond }) => {
    const command = textParam(params.command).replace(/^\//, "");
    if (!COMMANDS.has(command)) {
      respond(
        true,
        send({ ok: false, messages: [{ text: `Unsupported harness command: ${command}` }], deps }),
      );
      return;
    }

    if (command === "new_goal" || command === "goal") {
      const goalText = textParam(params.text || params.goal || params.args);
      const result = await handleGoal(goalText);
      const runId = resultRunId(result);
      respond(true, send({ ok: true, messages: messagesFromGoalResult(result), runId, deps }));
      return;
    }

    if (command === "goal_status") {
      const runId = textParam(params.runId || params.id || params.args);
      const result = await handleGoalStatus(runId);
      respond(
        true,
        send({
          ok: true,
          messages: [{ text: result }],
          runId: resultRunId({ text: "", runId }),
          deps,
        }),
      );
      return;
    }

    if (command === "goal_answer") {
      const runId = textParam(params.runId || params.id);
      const answer = textParam(params.text || params.answer || params.value);
      const result = await handleGoalAnswer(runId, answer);
      respond(true, send({ ok: true, messages: messagesFromGoalResult(result), runId, deps }));
      return;
    }

    if (command === "goal_resume") {
      const runId = textParam(params.runId || params.id || params.args);
      const result = await handleGoalApprove(runId);
      respond(true, send({ ok: true, messages: messagesFromGoalResult(result), runId, deps }));
      return;
    }

    const text = buildGatewayStatusMessage({ env: deps?.env ?? process.env });
    respond(true, send({ ok: true, messages: [{ text }], deps }));
  };
}

function createCallbackHandler(deps?: HarnessDeps): GatewayRequestHandler {
  return async ({ params, respond }) => {
    const actionName = textParam(params.action);
    const action = CALLBACK_ACTIONS[actionName];
    if (!action) {
      respond(
        true,
        send({
          ok: false,
          messages: [{ text: `Unsupported harness callback: ${actionName}` }],
          deps,
        }),
      );
      return;
    }
    const runId = textParam(params.runId || params.id);
    const text = optionalTextParam(params.text);

    if (action === "add_details") {
      const opened = openAddDetailsReply({ runId });
      if (text?.trim()) {
        const applied = applyResumeDetailsReply({ runId, text, source: "add_details" });
        respond(
          true,
          send({
            ok: true,
            messages: [...opened.messages, ...applied.messages],
            runId: applied.runId ?? opened.runId ?? runId,
            state: applied.state,
            deps,
          }),
        );
        return;
      }
      respond(
        true,
        send({
          ok: true,
          messages: opened.messages,
          runId: opened.runId ?? runId,
          state: opened.state,
          deps,
        }),
      );
      return;
    }

    if (action === "resume") {
      const result = applyResumeDetailsReply({ runId, source: "resume" });
      respond(
        true,
        send({
          ok: true,
          messages: result.messages,
          runId: result.runId ?? runId,
          state: result.state,
          deps,
        }),
      );
      return;
    }

    const proposalIdPrefix = textParam(params.proposalIdPrefix || params.proposalId);
    const result = await handleContinuationProposalAction({
      action,
      runId,
      proposalIdPrefix,
    });
    if (action === "request_edit" && text?.trim()) {
      // Parity with the Telegram Request Edit path (goal-commands.ts): resolve a
      // real continuation revision backend so the harness can drive a successful
      // edit instead of always reporting "no continuation backend available".
      const client = resolveContinuationClient(loadConfig());
      const applied = await applyContinuationEditReply({
        runId: result.runId ?? runId,
        text,
        client,
      });
      respond(
        true,
        send({
          ok: true,
          messages: [...result.messages, ...applied.messages],
          runId: applied.runId ?? result.runId ?? runId,
          state: applied.state,
          deps,
        }),
      );
      return;
    }
    respond(
      true,
      send({
        ok: true,
        messages: result.messages,
        runId: result.runId ?? runId,
        state: result.state,
        deps,
      }),
    );
  };
}

function createReplyHandler(deps?: HarnessDeps): GatewayRequestHandler {
  return async ({ params, respond }) => {
    const kind = textParam(params.kind || params.pendingAction);
    const runId = textParam(params.runId || params.id);
    const text = textParam(params.text);
    if (kind === "continuation_edit") {
      const client = resolveContinuationClient(loadConfig());
      const result = await applyContinuationEditReply({ runId, text, client });
      respond(
        true,
        send({
          ok: true,
          messages: result.messages,
          runId: result.runId ?? runId,
          state: result.state,
          deps,
        }),
      );
      return;
    }
    if (kind === "add_details") {
      const result = applyResumeDetailsReply({ runId, text, source: "add_details" });
      respond(
        true,
        send({
          ok: true,
          messages: result.messages,
          runId: result.runId ?? runId,
          state: result.state,
          deps,
        }),
      );
      return;
    }
    respond(
      true,
      send({ ok: false, messages: [{ text: `Unsupported harness reply kind: ${kind}` }], deps }),
    );
  };
}

function createGatewayRestartHandler(deps?: HarnessDeps): GatewayRequestHandler {
  return ({ params, respond }) => {
    if ("unit" in params || "serviceUnit" in params || "systemdUnit" in params) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "harness.gateway_restart does not accept arbitrary systemd unit names",
        ),
      );
      return;
    }
    const own = ownership({ deps });
    const restart = deps?.restart ?? (() => triggerMoltbotRestart());
    const attempt = restart(own.serviceUnit);
    respond(
      true,
      send({
        ok: attempt.ok,
        messages: [
          {
            text: attempt.ok
              ? `gateway_restart accepted for ${own.serviceUnit}.`
              : `gateway_restart failed for ${own.serviceUnit}: ${attempt.detail ?? "unknown error"}`,
          },
        ],
        restart: { ...attempt, unit: own.serviceUnit },
        deps,
      }),
    );
  };
}

export function createHarnessHandlers(deps?: HarnessDeps): GatewayRequestHandlers {
  return {
    "harness.command": createCommandHandler(deps),
    "harness.callback": createCallbackHandler(deps),
    "harness.reply": createReplyHandler(deps),
    "harness.gateway_restart": createGatewayRestartHandler(deps),
  };
}

export const harnessHandlers = createHarnessHandlers();
