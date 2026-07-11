#!/bin/bash
# Jarvis monitors Jarvis: verifies every automation actually ran; reports into the Morning Briefing.
VAULT="$HOME/Documents/J's AI Brain"
BRIEFING="$VAULT/06 Company/(C) Morning Briefing.md"
TODAY=$(date +%Y-%m-%d)
ISSUES=""

# night shift: skip all checks while Jay has it paused (plist in launchd/disabled/)
NS_DISABLED=""
[ -f "$HOME/Documents/Jarvis/launchd/disabled/com.jaysbrain.nightshift.plist" ] && NS_DISABLED=1
# night shift: did today's shift report or log entry appear?
if [ -z "$NS_DISABLED" ] && ! ls "$VAULT/06 Company/Shift Reports/"*"$TODAY"* >/dev/null 2>&1; then
  if grep -q "start: $(date '+%a %b')" "$HOME/Library/Logs/Jarvis/night_shift.log" 2>/dev/null && grep "start:" "$HOME/Library/Logs/Jarvis/night_shift.log" | tail -1 | grep -q "$(date '+%b %e')"; then
    ISSUES="$ISSUES\n- ⚠️ Night shift ran but produced no Shift Report (check ~/Library/Logs/Jarvis/night_shift.log)"
  else
    ISSUES="$ISSUES\n- ⚠️ No night shift output for $TODAY (Mac asleep at 02:00? run: sudo pmset repeat wakeorpoweron MTWRFSU 01:55:00)"
  fi
fi
# github brain sync: committed within last 36h?
LAST_SYNC=$(cd "$HOME/.jarvis-brain-sync" && git log -1 --format=%ct 2>/dev/null || echo 0)
AGE=$(( ($(date +%s) - LAST_SYNC) / 3600 ))
[ "$AGE" -gt 36 ] && ISSUES="$ISSUES\n- ⚠️ GitHub brain sync stale: last commit ${AGE}h ago"
# vault snapshots: any commit in last 3h?
LAST_SNAP=$(git --git-dir="$HOME/.jarvis-vault-backup.git" log -1 --format=%ct 2>/dev/null || echo 0)
SAGE=$(( ($(date +%s) - LAST_SNAP) / 3600 ))
[ "$SAGE" -gt 3 ] && ISSUES="$ISSUES\n- ⚠️ Vault snapshots stale: last ${SAGE}h ago"
# market radar: note updated within last 26h?
RADAR="$VAULT/06 Company/(C) Market Radar.md"
if [ -f "$RADAR" ]; then
  RAGE=$(( ($(date +%s) - $(stat -f %m "$RADAR")) / 3600 ))
  [ "$RAGE" -gt 26 ] && ISSUES="$ISSUES\n- ⚠️ Market Radar stale: last update ${RAGE}h ago"
else
  ISSUES="$ISSUES\n- ⚠️ Market Radar note missing (marketradar job never ran?)"
fi
# launchd jobs: loaded AND actually healthy — not just label-present.
# A crash-looping job still shows its label in `launchctl list` with PID "-" and its
# last exit status, so the old label-only check silently missed two multi-day outages.
# `launchctl list` columns are: PID <TAB> last-exit-status <TAB> label.
JOBS="telegrambot dailysync weeklysync vaultsnapshot briefingpush watchdog marketradar ragindex voiceserver dashboard"
[ -z "$NS_DISABLED" ] && JOBS="nightshift $JOBS"
DAEMONS=" telegrambot voiceserver "   # KeepAlive jobs that must always be RUNNING (live PID)
CRIT=""                               # ⛔ findings — also pushed straight to Telegram below
for job in $JOBS; do
  line=$(launchctl list 2>/dev/null | awk -v l="com.jaysbrain.$job" '$3==l {print; exit}')
  if [ -z "$line" ]; then
    ISSUES="$ISSUES\n- ⚠️ launchd job NOT loaded: $job"
    continue
  fi
  pid=$(echo "$line" | awk '{print $1}')
  status=$(echo "$line" | awk '{print $2}')
  # daemon down: loaded but no live process
  case "$DAEMONS" in
    *" $job "*)
      if [ "$pid" = "-" ]; then
        L="- ⛔ $job loaded but NOT RUNNING"
        CRIT="$CRIT\n$L"; ISSUES="$ISSUES\n$L"
      fi ;;
  esac
  # last exit status: 78 = EX_CONFIG — posix_spawn couldn't open the stdout/err file (the
  # reboot outage class). Negative = killed by signal (e.g. -15 SIGTERM on reload) = normal.
  # 0 or "-" = healthy. Anything else persistent = a real non-zero exit worth flagging.
  case "$status" in
    0|-) ;;
    78) L="- ⛔ $job spawn-failing (EX_CONFIG — likely unopenable log file; see README gotchas)"
        CRIT="$CRIT\n$L"; ISSUES="$ISSUES\n$L" ;;
    -*) ;;
    *)  ISSUES="$ISSUES\n- ⚠️ $job last exit non-zero (status $status)" ;;
  esac
done

# Direct Telegram alert for ⛔ CRITICAL findings only. Both prior multi-day outages were
# invisible because the alert path (briefing → the briefingpush launchd job) was itself
# down; a direct Bot-API push from here is the one channel that survives when the jobs are
# broken. Works even if the telegrambot polling daemon is dead — sendMessage doesn't need it.
# Parse KEY=VALUE from the same conf the bot uses; never print the token; skip if conf absent.
TG_CONF="$HOME/Documents/Jarvis/config/telegram.conf"
if [ -n "$CRIT" ] && [ -f "$TG_CONF" ]; then
  TOKEN=$(grep '^TOKEN=' "$TG_CONF" | head -1 | cut -d= -f2-)
  CHAT_ID=$(grep '^CHAT_ID=' "$TG_CONF" | head -1 | cut -d= -f2-)
  if [ -n "$TOKEN" ] && [ -n "$CHAT_ID" ]; then
    MSG=$(printf '🩺 Jarvis Watchdog — CRITICAL (%s)%b' "$TODAY" "$CRIT")
    curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
      -d chat_id="${CHAT_ID}" --data-urlencode text="$MSG" >/dev/null 2>&1 || true
  fi
fi

if [ -n "$ISSUES" ]; then
  ENTRY=$(printf '\n## 🩺 Watchdog (%s)%b\n' "$TODAY" "$ISSUES")
else
  ENTRY=$(printf '\n## 🩺 Watchdog (%s)\n- ✅ All systems ran: syncs, snapshots, market radar, RAG index, all jobs loaded (night shift %s)\n' "$TODAY" "$([ -n "$NS_DISABLED" ] && echo 'paused by Jay' || echo 'ok')")
fi

# Briefing is normally reset nightly by the 02:00 shift; while night shift is paused
# nothing resets it, so prune our own prior section(s) before appending — otherwise
# this grows one watchdog block per run forever. iCloud can also hold the file locked
# mid-sync (EDEADLK) — retry the whole read-prune-write cycle with a materialize nudge.
n=0
until ENTRY_TEXT="$ENTRY" BRIEFING_PATH="$BRIEFING" /opt/homebrew/bin/python3 - 2>/tmp/jarvis-watchdog-write.err <<'PYEOF'
import os, re
path = os.environ["BRIEFING_PATH"]
entry = os.environ["ENTRY_TEXT"]
text = open(path).read()
text = re.sub(r"\n## 🩺 Watchdog \(.*?\)\n(?:(?!\n## ).)*", "", text, flags=re.S)
open(path, "w").write(text.rstrip("\n") + "\n" + entry + "\n")
PYEOF
do
  n=$((n + 1))
  [ "$n" -ge 5 ] && { echo "watchdog: gave up writing briefing after 5 tries: $(cat /tmp/jarvis-watchdog-write.err)" >&2; break; }
  brctl download "$BRIEFING" 2>/dev/null
  sleep 2
done
[ -n "$ISSUES" ] && osascript -e 'display notification "Automation issues found — see Morning Briefing" with title "🩺 Jarvis Watchdog"' 2>/dev/null
