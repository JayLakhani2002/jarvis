#!/bin/bash
# Hourly snapshot of vault CONTENT into a local bare repo outside iCloud. Local-only by design.
# Excludes live in $GIT_DIR/info/exclude (.obsidian/.claude/.claudian/node_modules at any depth).
VAULT="$HOME/Documents/J's AI Brain"
export GIT_DIR="$HOME/.jarvis-vault-backup.git"
export GIT_WORK_TREE="$VAULT"
cd "$VAULT" || exit 1
if ! git add -A . 2>/tmp/jarvis-snapshot-add.err; then
  brctl download "$VAULT" 2>/dev/null   # materialize iCloud-evicted files; retry next hour
  exit 0
fi
if ! git diff --cached --quiet 2>/dev/null; then
  git commit -q -m "snapshot $(date '+%Y-%m-%d %H:%M')"
fi
