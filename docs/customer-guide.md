---
summary: "Simple guide for customers using SmithersBot in Telegram"
---

# Customer Guide

This guide shows you how to use SmithersBot in Telegram.

## What You Need

- Your Telegram app on your phone or computer
- Your bot name (shared during setup)
- Your Claude subscription (Pro or Max)

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

```text
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
Once the goal plan is approved, it executes its tasks in its optimal order.
If a task gets blocked (i.e. 

## How To Check On A Task

To check the status of all goals, simply send `/goal_list` in the same chat.

To check the status of a single goal, send `/goal_status <Goal ID>` in the same chat.
Note: you can get your Goal ID from the `/goal_list` or from messages the bot sends after you call `/new_goal`


Examples:

```
/goal_list 
```


```
/goal_status c8ee4cdc
```

## Repo Chat
If you have a question you'd like to ask but you don't want to change anything use repo chat. 
**How to use repo chat:**
Send a message that isn't responding to any other messages and doesn't have any slash commands (i.e. `/new_goal` or `/goal_list`).
You will get a response from the bot asking any question you have about previous goal runs, or any work you've produced in the past.
You can also reply to messages the bot sends to keep the conversation going and it will remember what was said earlier on this reply chain.

For example, if a goal has recently completed and its instructions on how to test are unclear to you, simply send a message like this that's not responding to any messages:
```
The goal c8ee4cdc was recently completed but its instructions for Test 1 are unclear to me. Can you please break that down step by step so someone who isn't a professional developer can execute them? 
```

Also if you want to do something with SmithersBot and aren't sure how, it has access to all the code so it knows how SmithersBot works and can tell you how to achieve what you want. I.e.:
```
My goal completed and when I tried testing it the test failed:
<insert output of test that failed>
What do I do now, how do I fix this?
```
**Note:** The answer to this question is to click the "🔄 Incorporate Feedback" button on the done task telling it about the failed test and it will update the plan and fix the bug.


It's also a great soundboard. If you have an idea for something that you want but can't quite articulate it clearly enough for a `/new_goal` command, you can ask it to write a `/new_goal` command based on a loose description of what you want and you can iterate with it until the command looks ready to send as a `/new_goal` command.

## What To Do If It Stops Responding

1. Planning and execution can take time, 10-30 minutes of planning isn't abnormal. The vision for SmithersBot is a bot that keeps working in the background and only messages you when it truly needs input or to let you know it's finsihed its task.
2. If you want to know the status of a goal, look at the section "How To Check On A Task" above.
3. If you want even more detail (i.e. if a task is taking 2x longer than its estimated time in its flow chart), you can use repo chat to ask what the bot is currently doing and if it's hung.

For example, send this message that's not responding to any other message:

```
The goal c8ee4cdc is currently executing but it's taking way longer than its time estimate. Please check what it's doing now and whether it's hung and report back to me with why it's taking so long and if I should stop it.
``` 


4. If you do not manage the server directly, contact your support provider.

Support contact placeholder:
- Name: `[YOUR SUPPORT CONTACT]`
- Email: `[SUPPORT EMAIL]`
- Phone or WhatsApp: `[SUPPORT NUMBER]`

## Your Bot Limits

- Your bot uses your Claude subscription usage limits.
- It can draft content, summarize information, and help with research.
- It can make mistakes, so review important outputs before using them.
- It does not automatically access your private systems unless you explicitly set that up.
- Large or complex tasks may take longer.

## Helpful Links

- Setup checklist for your operator: [Setup Call Checklist](/setup-call-checklist)
- Telegram channel reference: [Telegram](/channels/telegram)
