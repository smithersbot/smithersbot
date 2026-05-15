#!/data/data/com.termux/files/usr/bin/bash
# Moltbot OAuth Sync Widget
# Syncs Claude Code tokens to Moltbot on a gateway host
# Place in ~/.shortcuts/ on phone for Termux:Widget

termux-toast "Syncing Moltbot auth..."

# Run sync on the gateway host
RESULT=$(ssh user@gateway-host '~/moltbot/scripts/sync-claude-code-auth.sh' 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    # Extract expiry time from output
    EXPIRY=$(echo "$RESULT" | grep "Token expires:" | cut -d: -f2-)

    termux-vibrate -d 100
    termux-toast "Moltbot synced! Expires:${EXPIRY}"

    # Optional: restart moltbot service
    ssh user@gateway-host 'systemctl --user restart moltbot' 2>/dev/null
else
    termux-vibrate -d 300
    termux-toast "Sync failed: ${RESULT}"
fi
