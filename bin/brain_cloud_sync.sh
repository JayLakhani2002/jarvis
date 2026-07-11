#!/bin/bash
VAULT="$HOME/Documents/J's AI Brain"
REPO="$HOME/.jarvis-brain-sync"

# iCloud can hold a vault file locked mid-sync (EDEADLK) — cp then silently fails and the
# push ships a STALE copy (bit us 2026-07-11: two files pushed 2 days old). Retry each copy
# with a materialize nudge; a file that still fails marks the run failed (exit 1) so the
# watchdog's non-zero-exit check surfaces it, but the other files still sync.
FAILED=0
copy() {
  for _ in 1 2 3 4 5; do
    cp "$1" "$2" 2>/dev/null && return 0
    brctl download "$1" 2>/dev/null
    sleep 2
  done
  echo "sync: FAILED to copy $(basename "$1") after 5 tries" >&2
  FAILED=1
}

copy "$VAULT/CLAUDE.md" "$REPO/CLAUDE.md"
copy "$VAULT/GOALS.md" "$REPO/GOALS.md"
copy "$VAULT/operating-core.md" "$REPO/operating-core.md"
copy "$VAULT/00 Notes/(C) Claude Toolbox.md" "$REPO/Claude-Toolbox.md"
copy "$VAULT/06 Company/(C) Company OS.md" "$REPO/Company-OS.md"
copy "$VAULT/06 Company/(C) Morning Briefing.md" "$REPO/Morning-Briefing.md"
copy "$VAULT/06 Company/(C) Decision Inbox.md" "$REPO/Decision-Inbox.md"

cd "$REPO"
git add CLAUDE.md GOALS.md operating-core.md Claude-Toolbox.md Company-OS.md Morning-Briefing.md Decision-Inbox.md
if ! git diff --cached --quiet; then
  git commit -q -m "Daily sync $(date +%Y-%m-%d)"
  git push -q origin main
fi
exit $FAILED
