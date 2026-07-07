#!/bin/bash
# Pushes the Morning Briefing to Jay's phone at 07:00.
# Channel priority: Telegram (if configured) -> iMessage to self -> macOS notification.
VAULT="$HOME/Documents/J's AI Brain"
BRIEFING="$VAULT/06 Company/(C) Morning Briefing.md"
TG_CONF="$HOME/Documents/Jarvis/config/telegram.conf"   # format: TOKEN=xxx\nCHAT_ID=yyy (created when bot goes live)
SELF="lakhanijay20@gmail.com"

# strip frontmatter + footer links for a clean message
BODY=$(sed '/^---$/,/^---$/d' "$BRIEFING" 2>/dev/null | sed '/Part of \[\[/d' | head -40)
[ -z "$BODY" ] && BODY="(Morning Briefing is empty — check night shift log)"
MSG="🧠 JARVIS — Morning Briefing
$BODY"

if [ -f "$TG_CONF" ]; then
  source "$TG_CONF"
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    -d chat_id="${CHAT_ID}" --data-urlencode text="$MSG" >/dev/null && exit 0
fi

# iMessage to self (iPhone + Watch)
osascript <<APPLESCRIPT 2>/dev/null && exit 0
tell application "Messages"
  set svc to 1st account whose service type = iMessage
  send "$(echo "$MSG" | sed 's/"/\\"/g')" to participant "$SELF" of svc
end tell
APPLESCRIPT

# last resort: local notification
osascript -e 'display notification "Morning Briefing ready in Obsidian" with title "🧠 Jarvis"'
