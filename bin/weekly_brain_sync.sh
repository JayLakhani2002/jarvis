#!/bin/bash
VAULT="$HOME/Documents/J's AI Brain"
MONTH_DIR="$VAULT/01 Journals/2026 Journals/$(date +%m\ %B | sed 's/^0//')"
mkdir -p "$MONTH_DIR"
CAPTURE="$MONTH_DIR/Quick Capture.md"
DATE=$(date +%Y-%m-%d)

echo "" >> "$CAPTURE"
echo "## Auto Brain Sync — $DATE" >> "$CAPTURE"
# graph hygiene: ensure every month's Quick Capture is born linked into the brain
if ! grep -q '\[\[🧠 HOME\]\]' "$CAPTURE"; then
  echo "*Inbox of [[🧠 HOME]] · reviewed against [[GOALS]]*" >> "$CAPTURE"
fi

# --- Git activity across tracked repos (last 7 days) ---
for repo in "Agora Jobs" "LifePilot" "DeutschMate-main" "Nilimpa Startup /Bakery Expense APK"; do
  REPO_PATH="$HOME/Documents/Projects/$repo"
  [ -d "$REPO_PATH/.git" ] || REPO_PATH="$HOME/Documents/$repo"
  if [ -d "$REPO_PATH/.git" ]; then
    COMMITS=$(cd "$REPO_PATH" && git log --since="7 days ago" --oneline 2>/dev/null)
    if [ -n "$COMMITS" ]; then
      echo "### $repo (git activity, last 7 days)" >> "$CAPTURE"
      echo '```' >> "$CAPTURE"
      echo "$COMMITS" >> "$CAPTURE"
      echo '```' >> "$CAPTURE"
    fi
  fi
done

# --- Health summary from the "Log Health" Shortcut lines (last 7 entries) ---
# The Shortcut appends lines like:
#   - 2026-07-07 Health — Sleep: 7.2 | Steps: 8400 | Energy: 450kcal | RHR: 58 | HRV: 45 | Workouts: 1
# Pull the most recent 7 from this month AND last month's capture (covers month rollover).
PREV_MONTH_DIR="$VAULT/01 Journals/2026 Journals/$(date -v-1m +%m\ %B 2>/dev/null | sed 's/^0//')"
HEALTH_LINES=$(cat "$PREV_MONTH_DIR/Quick Capture.md" "$CAPTURE" 2>/dev/null | grep "Health —" | tail -7)

if [ -n "$HEALTH_LINES" ]; then
  echo "### Health Summary (last 7 logged days, from Watch/Health)" >> "$CAPTURE"
  echo "$HEALTH_LINES" | awk '
    { n++
      if (match($0,/Sleep: [0-9.]+/))    { v=substr($0,RSTART,RLENGTH); gsub(/[^0-9.]/,"",v); sleep+=v; sc++ }
      if (match($0,/Steps: [0-9.]+/))    { v=substr($0,RSTART,RLENGTH); gsub(/[^0-9.]/,"",v); steps+=v; stc++ }
      if (match($0,/Energy: [0-9.]+/))   { v=substr($0,RSTART,RLENGTH); gsub(/[^0-9.]/,"",v); energy+=v; ec++ }
      if (match($0,/RHR: [0-9.]+/))      { v=substr($0,RSTART,RLENGTH); gsub(/[^0-9.]/,"",v); rhr+=v; rc++ }
      if (match($0,/HRV: [0-9.]+/))      { v=substr($0,RSTART,RLENGTH); gsub(/[^0-9.]/,"",v); hrv+=v; hc++ }
      if (match($0,/Workouts: [0-9.]+/)) { v=substr($0,RSTART,RLENGTH); gsub(/[^0-9.]/,"",v); wk+=v }
    }
    END {
      printf "- Days logged: %d\n", n
      if (sc>0)  printf "- Avg sleep: %.1f h  (keystone #1 — 7-day trend)\n", sleep/sc
      if (stc>0) printf "- Avg steps: %d/day\n", steps/stc
      if (ec>0)  printf "- Avg active energy: %d kcal/day\n", energy/ec
      if (rc>0)  printf "- Avg resting HR: %d bpm\n", rhr/rc
      if (hc>0)  printf "- Avg HRV: %d ms\n", hrv/hc
      printf "- Workouts this week: %d  (gym target: 3)\n", wk
    }
  ' >> "$CAPTURE"
else
  echo "### Health Summary" >> "$CAPTURE"
  echo "- No Health/Watch data logged this week — check the \"Log Health\" iOS automation is running." >> "$CAPTURE"
fi

echo "- [ ] Reminder: fold this into the weekly review + confirm the 4 habit numbers (sleep / clean days / gym / thesis hours)" >> "$CAPTURE"

# --- Weekly review DRAFT (agent-written, Jay edits ~5 min instead of writing 30) ---
DRAFTS="$VAULT/06 Company/Drafts"
mkdir -p "$DRAFTS"
DRAFT_FILE="$DRAFTS/Weekly Review Draft $DATE.md"
CLAUDE_BIN="$(command -v claude || echo "$HOME/.local/bin/claude")"
LOG="$HOME/Library/Logs/Jarvis/weekly_review_draft.log"  # outside ~/Documents: TCC/iCloud can poison log files (see README EX_CONFIG gotcha)
if [ -x "$CLAUDE_BIN" ]; then
  (cd "$VAULT" && "$CLAUDE_BIN" -p "Draft Jay's weekly review for the week ending $DATE into the file '$DRAFT_FILE'. DRAFT ONLY — Jay ratifies; never send or delete anything. Sources: this week's section of '$CAPTURE' (git activity + health summary just appended), '01 Journals' entries from the last 7 days, 'GOALS.md', and '06 Company/(C) Morning Briefing.md'. The draft must contain: (1) the 4 habit numbers — avg sleep, clean days, gym sessions, thesis hours — with a one-line verdict each vs target; (2) git/shipping activity per project; (3) calendar/plan adherence: what was planned vs what actually happened, and the biggest drift; (4) one-track check: did the week serve Thesis → BSS Sept 13 → Agora Oct beta; (5) 3 proposed priorities for next week. Start the file with '*DRAFT by Jarvis — edit then move into your weekly review. Part of [[🧠 HOME]]*'. Where a number is unknown, write '?? (fill in)' rather than guessing." \
    --permission-mode acceptEdits --max-turns 30) >> "$LOG" 2>&1
  [ -f "$DRAFT_FILE" ] && echo "- [ ] Weekly review DRAFT ready: [[Weekly Review Draft $DATE]] — edit + ratify" >> "$CAPTURE"
else
  echo "- ⚠️ weekly review draft skipped: claude CLI not found" >> "$CAPTURE"
fi
