#!/bin/bash
# Hourly snapshot of vault CONTENT into a local bare repo outside iCloud. Local-only by design.
# Excludes live in $GIT_DIR/info/exclude (.obsidian/.claude/.claudian/node_modules at any depth).
VAULT="$HOME/Documents/J's AI Brain"
export GIT_DIR="$HOME/.jarvis-vault-backup.git"
export GIT_WORK_TREE="$VAULT"
cd "$VAULT" || exit 1

# a prior run's git add can be killed by a timeout (below) and orphan this lock —
# always clear it first or every future snapshot silently no-ops forever.
[ -f "$GIT_DIR/index.lock" ] && rm -f "$GIT_DIR/index.lock"

# iCloud can hold files "dataless" (evicted to save disk) — first touch materializes
# them at ~2-10s each, so a full `git add -A` can legitimately take minutes, not hang
# forever. Cap it well under the 3600s cadence instead of blocking the next run.
git add -A . 2>/tmp/jarvis-snapshot-add.err &
ADD_PID=$!
n=0
while kill -0 "$ADD_PID" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -ge 240 ]; then
    kill "$ADD_PID" 2>/dev/null
    wait "$ADD_PID" 2>/dev/null
    rm -f "$GIT_DIR/index.lock"
    brctl download "$VAULT" 2>/dev/null &  # pre-warm materialization for next hour, non-blocking
    exit 0
  fi
  sleep 1
done
wait "$ADD_PID"; ADD_STATUS=$?
if [ "$ADD_STATUS" -ne 0 ]; then
  rm -f "$GIT_DIR/index.lock"
  brctl download "$VAULT" 2>/dev/null &
  exit 0
fi
if ! git diff --cached --quiet 2>/dev/null; then
  git commit -q -m "snapshot $(date '+%Y-%m-%d %H:%M')"
fi
