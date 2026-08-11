#!/bin/bash
# Night shift — runs the company's 02:00 unattended session (draft-only).
VAULT="$HOME/Documents/J's AI Brain"
LOG="$HOME/Library/Logs/Jarvis/night_shift.log"  # outside ~/Documents: TCC/iCloud can poison log files (see README EX_CONFIG gotcha)
CLAUDE_BIN="$(command -v claude || echo "$HOME/.local/bin/claude")"

cd "$VAULT" || exit 1
{
  echo ""
  echo "===== Night shift start: $(date) ====="
  "$CLAUDE_BIN" -p "$(cat "$HOME/Documents/Projects/Jarvis/bin/night_shift_prompt.md")" \
    --permission-mode acceptEdits \
    --max-turns 50
  echo "===== Night shift end: $(date) (exit $?) ====="
} >> "$LOG" 2>&1
