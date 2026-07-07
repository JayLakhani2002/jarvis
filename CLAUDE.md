# Jarvis — Claude Context File

This repo is the **infrastructure code** for Jay's Jarvis: the AI-company automation that runs his life OS. You are working on Jarvis itself here.

## Read first, in order
1. `README.md` — what exists and runs today (7 launchd jobs, pocket Telegram bot, night-shift company)
2. `ROADMAP.md` — what we're building next, in priority order
3. **Ground truth for WHO Jay is and WHY**: the vault at `~/Documents/J's AI Brain` — its `CLAUDE.md` (identity, rules), `GOALS.md` (the €1M plan), `operating-core.md` (behavior loop — run every response through it), and `06 Company/(C) Company OS.md` (the 13-agent org this code serves)

## Rules for working in this repo
- The vault is the brain; this repo is the hands. Product decisions live there, code lives here.
- Draft-only boundary is sacred: nothing here may ever auto-send, auto-deploy, auto-spend, or push without Jay's ratification. Unattended jobs write into the vault only.
- Every schedule change goes in `launchd/*.plist` sources + `./install.sh` — never edit `~/Library/LaunchAgents` directly.
- New job checklist: script in `bin/` + plist in `launchd/` + register in `bin/watchdog.sh` AND `bin/telegram_jarvis.py` (/status list) + README table row.
- `config/` is gitignored (bot token) — never commit secrets, never print the token.
- Test before claiming done: run the script, check `logs/`, verify with `launchctl list | grep jaysbrain`.
- The one-track priority (Thesis → BSS Sept 13 → Agora Oct beta) outranks Jarvis features. If Jay asks for a feature mid-thesis-crunch, flag the trade-off once, then build what he decides.

## Current state (2026-07-07)
v1 shipped and verified: telegrambot (24/7), nightshift 02:00, watchdog 06:55, briefingpush 07:00, vaultsnapshot hourly, dailysync 21:00, weeklysync Sun 18:05. Remote: github.com/JayLakhani2002/jarvis (private).
