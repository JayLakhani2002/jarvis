#!/bin/bash
# Deploys all Jarvis launchd jobs from launchd/ to ~/Library/LaunchAgents and (re)loads them.
# Run after ANY change to a plist or after moving the project. Idempotent.
set -e
P="$HOME/Documents/Projects/Jarvis"
LA="$HOME/Library/LaunchAgents"
# Logs MUST live outside ~/Documents: on reboot launchd's posix_spawn cannot open
# stdout/err files under the TCC-protected, iCloud-synced ~/Documents (stale com.apple.macl
# xattr) → every job crash-loops with EX_CONFIG (78). Create the dir before bootstrapping.
mkdir -p "$HOME/Library/Logs/Jarvis"
# jobs paused by the operator live in launchd/disabled/ — unload if present, never install
for off in "$P"/launchd/disabled/*.plist; do
  [ -e "$off" ] || continue
  name=$(basename "$off")
  launchctl unload "$LA/$name" 2>/dev/null || true
  rm -f "$LA/$name"
  echo "disabled (skipped): $name"
done
for src in "$P"/launchd/*.plist; do
  name=$(basename "$src")
  launchctl unload "$LA/$name" 2>/dev/null || true
  cp "$src" "$LA/$name"
  launchctl load "$LA/$name"
  echo "installed + loaded: $name"
done
echo; launchctl list | grep jaysbrain
