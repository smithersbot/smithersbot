# Stage 2U-F — Telegram Long-Message Continuation (Multi-Message Buffer) Fix Report

- **Date/time (UTC):** 2026-05-24T20:52:02Z
- **Repo HEAD at time of writing:** `b62b7b262`
- **Implementing commits:**
  - `0f706930a` — `repair-telegram-continuation-new-goal-feedback`
  - `b62b7b262` — `extend-telegram-continuation-remaining-routes`
- **This report:** markdown only; no source changes were made in this step.

This report documents the repair of the shared Telegram long-message
continuation/buffering system that regressed for long-form (long-freeform)
routes. The live trigger was a long `/new_goal` paste that Telegram split into
two inbound messages: the second chunk (`G9: canvas-host fs.watch reload
timeout`) produced an interactive prompt
("This looks like more text for /new_goal. What should I do with it?")
instead of being auto-appended, and planning started from only the first chunk.

---

## 1. Root cause of the `/new_goal` regression

When Telegram client-side auto-splits a long paste, the parts arrive back-to-back
through the Bot API as separate inbound messages (typically <500 ms apart). The
`/new_goal` command handler buffers the first chunk through the shared
`CommandFragmentBuffer` and, on **flush**, does two things in its flush callback
(`src/telegram/goal-commands.ts`, `bot.command(["new_goal","goal"])`, flush
callback near lines 2141–2153):

1. starts planning by calling `runGoal(combinedText)`, **and**
2. installs a **command anchor** via `commandFragmentBuffer.setAnchor(...)` (a
   short-TTL marker that a follow-up chunk may belong to the just-dispatched
   command).

The regression: when a nearby continuation chunk arrived **after the gap flush
had already fired**, the buffer no longer had a pending entry to append to, but
the live anchor was still present. The inbound text path then resolved that live
anchor (`resolveLiveCommandAnchor` →
`src/telegram/bot-handlers.ts` `routeTelegramTextMessage`) and called
`promptForCommandAnchorFollowUp(...)`, which sends the interactive
"This looks like more text for /new_goal. What should I do with it?" message
(with append / start-new / ignore buttons) instead of silently auto-appending.
Because the flush had already dispatched, planning had already begun from only
the first chunk, and `"Right away, sir."` (the planning preface) had already
been emitted for the partial text.

In short: the **flush-then-anchor** timing left a window in which the second
chunk of an obviously-split paste fell through to the interactive anchor
follow-up prompt rather than being treated as a continuation.

## 2. Was the existing `/new_goal` continuation pattern regressed, or bypassed?

**Bypassed (for the post-flush window), not removed.** The `/new_goal` path was
already wired to the shared `CommandFragmentBuffer` — chunks that arrived *before*
the buffer flushed were still combined correctly. The defect was that the
post-flush continuation path (the live command anchor → interactive follow-up
prompt) intercepted a nearby continuation chunk and bypassed auto-append. The
practical contributing factor was that the buffer key and the inbound append
routing did not reliably steer an obvious nearby continuation back into the
shared collector before the anchor follow-up path ran, so the shared
continuation behavior was effectively skipped in that window.

The fix keeps the shared collector as the single continuation mechanism: nearby
continuation chunks are appended into the **still-pending** buffer entry (each
append reschedules the flush timer), so dispatch runs **once** with the combined
text and the interactive prompt is not shown for an obvious nearby continuation.

## 3. Shared helper / pattern reused

The repair reuses the **one** shared collector — no per-surface one-off buffers
were added:

- `CommandFragmentBuffer` in `src/telegram/command-fragments.ts`
  - `bufferCommand(key, entry)` — start/replace a pending buffer for a key.
  - `tryAppend(key, messageId, text, receivedAtMs)` — append a nearby chunk to an
    existing pending entry (enforces id-gap, time-gap, max-parts, max-chars,
    and rejects slash-prefixed text).
  - `tryAppendMatching({...normalized, commandNames}, messageId, text, nowMs)` —
    append to any pending entry whose key matches the chat/thread/sender/surface
    prefix for one of the allowed command names (used by the inbound text path so
    a continuation chunk is captured before any anchor follow-up logic runs).
  - `flush` / `cancelAndFlush` — emit the combined text via the entry's
    `flushCallback` exactly once.
  - `setAnchor` / `getAnchor` / `clearAnchor` — TTL-bounded command anchor
    (existing semantics retained; anchor cleared when a different canonical
    command is buffered on the same key).
- `buildCommandFragmentKey(params)` and `normalizeCommandFragmentParams(msg,
  accountId)` in the same module produce the deterministic key (see §5).

Key wiring points:
- `/new_goal` flush callback installs the anchor and runs the planner exactly
  once (`src/telegram/goal-commands.ts` ~2119–2155).
- Inbound text handler attempts `tryAppendMatching` over the long-freeform
  command names **before** the anchor follow-up path
  (`src/telegram/bot-handlers.ts` ~1556–1568).
- `routeTelegramTextMessage` buffers long-freeform reply/free-text routes via a
  shared `bufferLongFreeformRoute` helper that funnels through the same
  `CommandFragmentBuffer` (`src/telegram/bot-handlers.ts` ~671–716).

## 4. Routes audited and routes fixed

Long-freeform routes audited (every route where a single logical user payload can
be Telegram-split into multiple inbound messages):

| Route | Audited | Fixed / wired through shared collector |
| --- | --- | --- |
| `/new_goal` (and `/goal`) | yes | yes — buffer + flush-once + anchor append; continuation no longer triggers the follow-up prompt |
| Incorporate Feedback / goal-feedback / plan-revision (reply-based + `/goal_feedback`) | yes | yes — buffers before acquiring the feedback lock so split replies combine into one plan-revision and chunk 2 does not get an "already being processed" response |
| `/repo_chat` (command + free-text path + replies to known repo-chat sessions) | yes | yes — split chunks combine into one repo-chat turn |
| Add Details / `gAD:<runId>` (blocked-details reply) | yes | yes — split Add Details replies combine and the resumed goal receives the full text |
| `/goal_answer` (command + reply-based answer routing) | yes | yes — split answer chunks combine before answering the blocked step |
| `/goal_resume` with trailing text | yes | yes — buffers the trailing text and does not resume from the first chunk alone |

The first two rows were repaired in `0f706930a`
(`repair-telegram-continuation-new-goal-feedback`); the remaining rows were wired
through the same collector in `b62b7b262`
(`extend-telegram-continuation-remaining-routes`).

Notes / scope honesty:
- All fixed routes share the single `CommandFragmentBuffer`; no per-route buffer
  was introduced.
- The pre-existing near-limit `text:` fragment buffer in
  `src/telegram/bot-handlers.ts` (for very large generic pastes) remains; the
  command-fragment collector is consulted first for the long-freeform command
  surfaces above so those payloads combine with the correct command/surface
  context.

## 5. Final buffer key composition

`buildCommandFragmentKey` (`src/telegram/command-fragments.ts`) composes a
colon-joined key so unrelated messages never merge across users, chats, topics,
goals, or reply contexts, and so a new slash command is never swallowed as a
continuation of a different surface:

```
cmd : <accountId> : <chatId> : <resolvedThreadId|"main"> : <senderId>
    : <commandName> : run:<runId|"none"> : reply:<replyToMessageId|"none">
```

- **accountId** — Telegram bot account binding.
- **chatId** — chat the message belongs to.
- **resolvedThreadId** — forum/topic thread id (or `main` for non-forum / general),
  resolved via `resolveTelegramForumThreadId`.
- **senderId** — message sender (`msg.from.id`).
- **commandName** — canonical surface: `new_goal` | `repo_chat` | `goal_feedback`
  | `goal_answer` | `goal_resume`.
- **run:<runId>** — goal/run id when the surface is tied to a specific run
  (e.g. feedback / answer / resume / Add Details); `none` otherwise.
- **reply:<replyToMessageId>** — the `reply_to_message` id for reply-based
  surfaces; `none` otherwise.

`normalizeCommandFragmentParams` derives accountId / chatId / resolvedThreadId /
senderId from the inbound message so every call site keys identically.
`tryAppendMatching` matches on the chat/thread/sender/surface prefix
(`cmd:<account>:<chat>:<thread>:<sender>:<command>:`) so a nearby continuation is
appended to the right pending entry regardless of the run/reply suffix.

## 6. Continuation-window behavior (time-gap close + new-command guard)

Defined in `src/telegram/command-fragments.ts`:

- **Time-gap close:** a continuation chunk is appended only if it arrives within
  `COMMAND_FRAGMENT_MAX_GAP_MS` (default **2000 ms**, clamped to
  `[COMMAND_FRAGMENT_MIN_GAP_MS=500, COMMAND_FRAGMENT_MAX_CONFIGURED_GAP_MS=60000]`)
  of the previous chunk. Each successful append reschedules the flush timer, so a
  steady stream of split parts keeps accumulating; once the gap elapses the
  buffer flushes and dispatch runs **once** with the combined text. A chunk
  arriving after the window closed starts a fresh logical payload.
- **Message-id gap guard:** appends require `0 < idGap <=
  COMMAND_FRAGMENT_MAX_ID_GAP` (**5**) so up to a few intervening bot/service
  messages are tolerated, but distant messages are not stitched in.
- **Size guards:** `COMMAND_FRAGMENT_MAX_PARTS` (**12**) and
  `COMMAND_FRAGMENT_MAX_TOTAL_CHARS` (**50,000**) cap a combined payload.
- **Anchor TTL:** the post-flush command anchor honors
  `COMMAND_ANCHOR_TTL_MS` (default **60,000 ms**, clamped to
  `[10,000, 60,000]`); an anchor for a different canonical command on the same
  key is cleared when a new command is buffered.
- Buffering is scoped to the long-freeform command surfaces only — ordinary
  messages are not globally delayed.

Ordering and line breaks are preserved: appended parts are stored in arrival
order in `textParts` and joined on flush (`textParts.join("")`), so the combined
payload reproduces the original split text exactly.

## 7. How new slash commands are protected from accidental swallowing

- `tryAppend` rejects any continuation whose text (after trimming leading
  whitespace) starts with `/` — a new slash command is never appended to a
  pending buffer (`src/telegram/command-fragments.ts` ~240–247).
- The inbound text handler only attempts `tryAppendMatching` when the message is
  **not** command-like (`isCommandLike` is false) and is not itself a reply that
  belongs elsewhere (`src/telegram/bot-handlers.ts` ~1552, ~1556).
- `bufferLongFreeformRoute` likewise refuses to start a new buffer for
  slash-prefixed text (`src/telegram/bot-handlers.ts` ~699), and flushes any
  existing pending entry on a key collision before re-buffering.
- The strengthened key includes the canonical `commandName`/surface, so a chunk
  for one surface cannot be appended to a pending entry for a different surface,
  and a different user/chat/thread/goal/reply context yields a different key.

## 8. Tests added / strengthened (exact paths)

- `src/telegram/command-fragments.test.ts`
  - helpers: deterministic keys; distinct keys for DM vs forum; **separates
    surfaces, goals, reply prompts, accounts, and senders**.
  - `CommandFragmentBuffer`: anchor set/retrieve within TTL; expired anchor
    returns undefined; clears anchor when buffering a different canonical
    command; retains anchor when rebuffering the same command; buffer/append/
    flush combined text; pending canonical command lookup; auto-flush after
    timeout; id-gap allow (gap 3) / reject (gap > 5); time-gap reject; append
    within default 2 s window; merges 1500 ms fragments but rejects 2500 ms
    apart; per-instance gap override; **rejects slash-prefixed continuation
    text**; flushes existing entry on collision via `cancelAndFlush`; enforces
    max-parts and max-total-chars.
  - end-to-end `createTelegramBot` split flow: combines split `/new_goal` into one
    planner request; **"combines the live /new_goal G9 continuation regression
    without prompting"** (asserts no `"Right away, sir."` for the partial and no
    "This looks like more text for /new_goal" prompt); combines split
    `/repo_chat` into one request; combines split `/repo_chat` with a short first
    chunk; combines adjacent repeated `/repo_chat` chunks without duplicate/
    dropped text; keeps later repeated `/repo_chat` outside the window as separate
    sessions.
- `src/telegram/bot-handlers.goal-routing.test.ts`
  - **"buffers split feedback replies before acquiring the feedback lock"**.
- `src/telegram/bot-handlers.repo-chat-routing.test.ts`
  - `shouldRouteTelegramTextToRepoChat` does not route non-reply text to repo
    chat when a live command anchor exists; combines split free-text repo chat
    into one inbound dispatch; combines split replies to known repo-chat sessions
    before dispatch; **"buffers split Add Details replies and answers with the
    combined text once"**; routes replies to known repo-chat sessions before
    pending command-fragment append; appends/starts-new from command-anchor
    pending text and clears the pending callback.
- `src/telegram/goal-commands.test.ts`
  - "sets a new_goal anchor after a buffered command flush"; "routes appended
    anchor text through the same planner dispatch helper"; **"combines split
    /goal_answer text before answering the blocked step"**; **"buffers
    /goal_resume with trailing text and does not resume from the first chunk"**;
    `/goal_feedback` and `/goal_answer` lock/threading behaviors retained.
- `src/telegram/repo-chat-commands.test.ts`
  - repo-chat anchor command-name assertions for the shared buffer.

## 9. Verification results (observed at HEAD `b62b7b262`)

All commands below were run from the repo root for this report and observed to
pass:

- `pnpm vitest run src/telegram/command-fragments.test.ts src/telegram/bot-handlers.goal-routing.test.ts src/telegram/bot-handlers.repo-chat-routing.test.ts src/telegram/repo-chat-commands.test.ts`
  → **4 files passed, 77 tests passed**.
- `pnpm vitest run src/telegram/goal-commands.test.ts`
  → **1 file passed, 218 tests passed**.
- `pnpm exec tsc -p tsconfig.json` → **exit 0** (clean type-check).
- `pnpm build` → **exit 0** (tsc + copy/codegen scripts completed).
- `pnpm lint` (`oxlint --type-aware src test`) → **0 warnings, 0 errors** across
  2346 files.

The implementing tasks (`0f706930a`, `b62b7b262`) reported the same focused
vitest + tsc + build + lint commands passing; the results above are an
independent re-run at the current HEAD and match.

## 10. Manual verification steps (after the next gateway restart)

> Requires a gateway restart, which is not permitted during goal execution.
> Run these manually after an operator restart.

1. **Restart the gateway** (operator action).
2. **`/new_goal` split into two chunks:** paste a long `/new_goal` that Telegram
   splits into two messages. Confirm:
   - no "This looks like more text for /new_goal. What should I do with it?"
     prompt appears for the second chunk;
   - the resulting plan includes content from the **second** chunk (e.g. the
     trailing item), i.e. planning did not start from only the first chunk;
   - only one `"Right away, sir."` planning preface is emitted, after the buffer
     flushes.
3. **Incorporate Feedback reply split into two chunks:** on a done/awaiting run,
   send a long "Incorporate Feedback" reply split into two messages. Confirm:
   - chunk two does **not** get an "already being processed" response;
   - the plan-revision prompt/result reflects **both** chunks (one revision runs).
4. **`/repo_chat` split into two chunks:** send a long `/repo_chat` split into two
   messages and confirm a **single** repo-chat turn runs with the combined text
   (not two separate turns).
5. **Add Details split into two chunks:** on a blocked run, use Add Details and
   send the details split into two messages; confirm the **resumed goal receives
   both chunks** as one combined add-details payload.

(Optionally also exercise `/goal_answer` and `/goal_resume`-with-text split into
two chunks and confirm a single combined answer/resume.)

---

### Safety note

No secret values, environment values, tokens, API keys, raw auth/session/config
contents, raw statusline JSON, or sensitive absolute paths are included in this
report. Source-file references are repo-relative; no source code was modified in
this step (report/markdown only).
