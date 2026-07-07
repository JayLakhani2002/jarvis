#!/bin/bash
VAULT="$HOME/Documents/J's AI Brain"
REPO="$HOME/.jarvis-brain-sync"

cp "$VAULT/CLAUDE.md" "$REPO/CLAUDE.md"
cp "$VAULT/GOALS.md" "$REPO/GOALS.md"
cp "$VAULT/operating-core.md" "$REPO/operating-core.md"
cp "$VAULT/00 Notes/(C) Claude Toolbox.md" "$REPO/Claude-Toolbox.md"
cp "$VAULT/06 Company/(C) Company OS.md" "$REPO/Company-OS.md"
cp "$VAULT/06 Company/(C) Morning Briefing.md" "$REPO/Morning-Briefing.md"
cp "$VAULT/06 Company/(C) Decision Inbox.md" "$REPO/Decision-Inbox.md"

cd "$REPO"
git add CLAUDE.md GOALS.md operating-core.md Claude-Toolbox.md Company-OS.md Morning-Briefing.md Decision-Inbox.md
if ! git diff --cached --quiet; then
  git commit -q -m "Daily sync $(date +%Y-%m-%d)"
  git push -q origin main
fi
