#!/bin/bash
# Deploys all Jarvis launchd jobs from launchd/ to ~/Library/LaunchAgents and (re)loads them.
# Run after ANY change to a plist or after moving the project. Idempotent.
set -e
P="$HOME/Documents/Jarvis"
LA="$HOME/Library/LaunchAgents"
for src in "$P"/launchd/*.plist; do
  name=$(basename "$src")
  launchctl unload "$LA/$name" 2>/dev/null || true
  cp "$src" "$LA/$name"
  launchctl load "$LA/$name"
  echo "installed + loaded: $name"
done
echo; launchctl list | grep jaysbrain
