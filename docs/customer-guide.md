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
/new_goal Draft a follow up email to leads who have not responded in 7 days.
```

```text
/new_goal Summarize this week customer inquiries and group them by topic.
```

Tip: write tasks in plain language. The more specific you are, the better the output.

## How To Check On A Task

Use `/goal_status` in the same chat.

Example:

```text
/goal_status
```

The bot will show progress or the latest result.

## What To Do If It Stops Responding

1. Wait 30 to 60 seconds and try again.
2. Send a simple message: `ping`.
3. If there is still no reply, run your restart command if you have server access:

```bash
systemctl --user restart moltbot-gateway.service
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
