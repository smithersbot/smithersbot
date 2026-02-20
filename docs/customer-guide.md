Her---
summary: "Simple guide for customers using SmithersBot in Telegram"
---

# Customer Guide

This guide shows you how to use SmithersBot in Telegram.

## What You Need

- Your Telegram app on your phone or computer
- Your bot name (shared during setup)
- Your Claude subscription (Pro or Max) and/or OpenAI subscription.

## How To Message Your Bot

1. Open Telegram.
2. Tap search.
3. Search for your bot name.
4. Open the bot chat.
5. Tap **Start**.
6. Send a normal message like `hello`.

If the bot is set up correctly, you should get a reply.

## How To Give It A Task

Use the `/new_goal` command in your chat with the bot.

Format:

```
/new_goal <what you want done>
```

Examples:

```text
/new_goal Research competitors in my area and give me a short summary.
```

```text
/new_goal Draft a follow up email sequence to leads who have not responded.
```

```text
/new_goal Summarize this week customer inquiries and group them by topic.
```

Tip: write tasks in plain language. The more specific you are, the better the output.

## How it works
After you give your bot a `/new_goal` command it will create a plan for you to approve.
You can approve, reject or request edits to the goal plan.
Once the goal plan is approved, it executes its tasks in its optimal time saving order.
If a task gets blocked, it will send you a message and continue to try and complete other tasks that aren't dependant on blocked tasks. See the Blocked Task Section below.
Once a goal completes, it will tell you it's completed.

## Blocked Tasks
Sometimes the agent really can't continue on a task without your input. In this case it will set the task to blocked and won't continue executing that task or any tasks dependant on it until you give the input it requires.

**Examples of reasons a task would block:** 
- It takes longer than 2x its expected time to complete. 
- You run out of Claude or OpenAI usage. 
- There are edits to its code that broke something.

**How to Unblock Tasks:**
If it's a simple fix you need to make such as waiting until your OpenAI usage resets, just click "▶️ Resume Task" when you want it to resume.
If you need to provide input (i.e. it's trying to do something out of scope such as running a massive set of tests that's taking too long), reply to the "BLOCKED TASK" message and tell it what to do differently and it will take your feedback and resume.

**Note:** If you're unsure how to unblock a task, use Repo Chat for clarity on why the task is blocked and what you should do. (See section below "Repo Chat" for more).

## How To Check On A Task

To check the status of all goals, simply send `/goal_list` in the same chat.

To check the status of a single goal, send `/goal_status <Goal ID>` in the same chat.
**Note:** you can get your Goal ID from the `/goal_list` or from messages the bot sends after you call `/new_goal`


Examples:

```text
/goal_list 
```

```text
/goal_status c8ee4cdc
```

## Repo Chat
If you have a question you'd like to ask but you don't want to change anything use repo chat. 
**How to use repo chat:**
Send a message that isn't responding to any other messages and doesn't have any slash commands (i.e. `/new_goal` or `/goal_list`).
**Note:** It's important you don't send slash commands by accident or repo chat won't work. If you need to reference a slash command, send it in quotes (i.e. "/new_goal")
You will get a response from the bot asking any question you have about previous goal runs, or any work you've produced in the past.
You can also reply to messages the bot sends to keep the conversation going and it will remember what was said earlier on this reply chain.

For example, if a goal has recently completed and its instructions on how to test are unclear to you, simply send a message like this that's not responding to any messages:
```text
The goal c8ee4cdc was recently completed but its instructions for Test 1 are unclear to me. Can you please break that down step by step so someone who isn't a professional developer can execute them? 
```

Also if you want to do something with SmithersBot and aren't sure how, it has access to all the code so it knows how SmithersBot works and can tell you how to achieve what you want. I.e.:
```text
My goal c8ee4cdc completed and when I tried testing it the test failed:
<insert output of test that failed>
What do I do now, how do I fix this?
```
**Note:** The answer to this question is to click the "🔄 Incorporate Feedback" button on the done task telling it about the failed test and it will update the plan and fix the bug.

```text
My goal c8ee4cdc blocked and I don't understand how to unblock it. Please check and see what went wrong and how I can unblock it.
```

It's also a great soundboard for planning goals. If you have an idea for something that you want but can't quite articulate it clearly enough for a `/new_goal` command, you can ask it to write a `/new_goal` command based on a loose description of what you want and you can iterate with it until the command looks ready to send as a `/new_goal` command. I.e.:
```text
I want to build something that sends me a report every week about developments in the robotics advanced manufacturing industry. Give me a "/new_goal" command to achieve this.
```

Here's a real example:
```text
I’ve never seen this issue:
Failed to parse the planner response. Debug: cat $STATE_DIR/goals/l63b40a3-71a3-4059-97d8-d8f2d01f0737/plan-raw.txt

It just happened
(State dir is .clawdbot-dev)

Please tell me what went wrong and write a “/new_goals” command to fix it
```

## What To Do If It Stops Responding

1. Planning and execution can take time, 10-30 minutes of planning isn't abnormal. The vision for SmithersBot is a bot that keeps working in the background and only messages you when it truly needs input or to let you know it's finsihed its task.
2. If you want to know the status of a goal, look at the section "How To Check On A Task" above.
3. If you want even more detail (i.e. if a task is taking 2x longer than its estimated time in its flow chart), you can use repo chat to ask what the bot is currently doing and if it's hung.

For example, send this message that's not responding to any other message:
```text
The goal c8ee4cdc is currently executing but it's taking way longer than its time estimate. Please check what it's doing now and whether it's hung and report back to me with why it's taking so long and if I should stop it.
```

## Your Bot Limits

- Your bot uses your Claude subscription usage limits.
- It can draft content, summarize information, build automations and help with research.
- It can make mistakes, so review important outputs before using them.
- It does not automatically access your private systems unless you explicitly set that up.
- Large or complex tasks may take longer.

## Helpful Links

- Setup checklist for your operator: [Setup Call Checklist](/setup-call-checklist)
- Telegram channel reference: [Telegram](/channels/telegram)
