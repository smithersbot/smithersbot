# Telegram routing

## Message flow

Telegram messages are received by the bot handler, filtered by allowlist and policy, and then routed
through the goal router. The router decides whether a message should update an existing goal run,
answer a blocked step, approve or reject a plan, or create a new plan-only goal. Chat help is handled
as a read-only response with no tool execution.

## Routing decisions

| Decision | Trigger | Effect |
| --- | --- | --- |
| GOAL_EDIT | Reply to latest plan message | Treat as a goal edit |
| GOAL_ANSWER | Exactly one blocked run awaits input | Treat as a goal answer |
| GOAL_APPROVE | Exactly one awaiting approval run and approval intent | Approve plan |
| GOAL_REJECT | Exactly one awaiting approval run and rejection intent | Reject plan |
| GOAL_CREATE | Default for plain text | Create plan only goal |
| CHAT_HELP | Meta or help intent | Send help text only |

## Why chat is constrained

Telegram feels conversational, but generic chat is intentionally read-only. The system only plans or
executes through explicit goal routing so that tools are gated, auditable, and scoped to a run.

## Vision alignment

This keeps SmithersBot in the always on technical cofounder role without surprise side effects.
Every action is attached to a goal run, with clear approvals and a traceable history.
