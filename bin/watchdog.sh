#!/bin/bash
# Jarvis monitors Jarvis: verifies every automation actually ran; reports into the Morning Briefing.
VAULT="$HOME/Documents/J's AI Brain"
BRIEFING="$VAULT/06 Company/(C) Morning Briefing.md"
TODAY=$(date +%Y-%m-%d)
ISSUES=""

# night shift: did today's shift report or log entry appear?
if ! ls "$VAULT/06 Company/Shift Reports/"*"$TODAY"* >/dev/null 2>&1; then
  if grep -q "start: $(date '+%a %b')" "$HOME/Documents/Jarvis/logs/night_shift.log" 2>/dev/null && grep "start:" "$HOME/Documents/Jarvis/logs/night_shift.log" | tail -1 | grep -q "$(date '+%b %e')"; then
    ISSUES="$ISSUES\n- ⚠️ Night shift ran but produced no Shift Report (check .scripts/night_shift.log)"
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
# launchd jobs loaded?
for job in nightshift dailysync weeklysync vaultsnapshot briefingpush watchdog marketradar; do
  launchctl list 2>/dev/null | grep -q "com.jaysbrain.$job" || ISSUES="$ISSUES\n- ⚠️ launchd job NOT loaded: $job"
done

if [ -n "$ISSUES" ]; then
  printf '\n## 🩺 Watchdog (%s)%b\n' "$TODAY" "$ISSUES" >> "$BRIEFING"
  osascript -e 'display notification "Automation issues found — see Morning Briefing" with title "🩺 Jarvis Watchdog"' 2>/dev/null
else
  printf '\n## 🩺 Watchdog (%s)\n- ✅ All systems ran: night shift, syncs, snapshots, market radar, 7/7 jobs loaded\n' "$TODAY" >> "$BRIEFING"
fi
