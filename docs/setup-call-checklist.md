---
summary: "Operator checklist for a 30 minute customer setup call"
---

# Setup Call Checklist

Use this checklist to run a 30 minute onboarding call for a non technical customer.

## Pre Call Message To Customer

Send this before the call:

- Sign up for Claude Pro or Max at `https://claude.ai`.
- Pricing reference: Pro is usually about $20 per month and Max is usually about $100 per month.
- Download Telegram on your phone.
- VPS note: if you are hosting on a VPS, your operator will handle server setup.
- Have 30 minutes available with a laptop and phone.

## On Call Steps

1. SSH into the customer VPS. Estimated time: 1 minute.
2. Run the bootstrap script. Estimated time: 3 minutes.

```bash
bash scripts/customer-setup.sh
```

3. Run Claude login and complete browser auth with the customer. Estimated time: 3 minutes.

```bash
claude login
```

4. Create or get Telegram bot token using `@BotFather`. Estimated time: 3 minutes.
5. Run non interactive onboarding with Telegram token. Estimated time: 2 minutes.

```bash
moltbot onboard --non-interactive --accept-risk --auth-choice skip --install-daemon --skip-skills --flow quickstart --telegram-token "<TELEGRAM_BOT_TOKEN>"
```

6. Run setup verification. Estimated time: 2 minutes.

```bash
moltbot doctor --customer-check
```

7. Ask customer to send `hello` to their bot in Telegram. Estimated time: 2 minutes.
8. Walk through the customer guide. Estimated time: 5 minutes.

Customer guide:
- [Customer Guide](/customer-guide)

9. Confirm support contact details are saved by the customer. Estimated time: 1 minute.

Support contact placeholder:
- Name: `[YOUR SUPPORT CONTACT]`
- Email: `[SUPPORT EMAIL]`
- Phone or WhatsApp: `[SUPPORT NUMBER]`

## Time Plan

- Active steps total: 22 minutes
- Buffer for delays and questions: 8 minutes
- Total call target: 30 minutes

## Final Confirmation

Before ending the call, confirm all items:

- `moltbot doctor --customer-check` passes critical checks
- Customer received a reply from the bot in Telegram
- Customer knows `/new_goal` and `/goal_status`
- Customer has support contact details
