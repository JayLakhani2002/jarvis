#!/bin/bash
# Pushes the Morning Briefing to the operator's phone at 07:00.
# Channel priority: Telegram (if configured) -> iMessage to self -> macOS notification.
VAULT="$HOME/Documents/J's AI Brain"
BRIEFING="$VAULT/06 Company/(C) Morning Briefing.md"
TG_CONF="$HOME/Documents/Projects/Jarvis/config/telegram.conf"   # format: TOKEN=xxx\nCHAT_ID=yyy (created when bot goes live)
IM_CONF="$HOME/Documents/Projects/Jarvis/config/imessage.conf"  # optional, format: SELF=you@example.com
[ -f "$IM_CONF" ] && source "$IM_CONF"
BUILD_LOG="$HOME/Library/Logs/Jarvis/briefing_build.log"   # v1.5 rule: app logs live outside ~/Documents

# v1.8: assemble the ratified "commander brief" deterministically (also inserts the section
# at the top of the note for /brief). Builder prints the brief on stdout. If it succeeds
# (exit 0) AND is non-empty, send that; otherwise FALL BACK to the raw note content below,
# so the 07:00 push never silently misses even if a source or the builder itself breaks.
MSG=$(/opt/homebrew/bin/python3 /Users/jay/Documents/Projects/Jarvis/bin/briefing_build.py 2>>"$BUILD_LOG")
if [ $? -ne 0 ] || [ -z "$MSG" ]; then
  # FALLBACK — strip frontmatter + footer links for a clean message
  BODY=$(sed '/^---$/,/^---$/d' "$BRIEFING" 2>/dev/null | sed '/Part of \[\[/d' | head -40)
  [ -z "$BODY" ] && BODY="(Morning Briefing is empty — check night shift log)"
  MSG="🧠 JARVIS — Morning Briefing
$BODY"
fi

if [ -f "$TG_CONF" ]; then
  source "$TG_CONF"
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    -d chat_id="${CHAT_ID}" --data-urlencode text="$MSG" >/dev/null && exit 0
fi

# iMessage to self (iPhone + Watch) — skipped unless config/imessage.conf sets SELF
if [ -n "$SELF" ]; then
osascript <<APPLESCRIPT 2>/dev/null && exit 0
tell application "Messages"
  set svc to 1st account whose service type = iMessage
  send "$(echo "$MSG" | sed 's/"/\\"/g')" to participant "$SELF" of svc
end tell
APPLESCRIPT
fi

# last resort: local notification
osascript -e 'display notification "Morning Briefing ready in Obsidian" with title "🧠 Jarvis"'
