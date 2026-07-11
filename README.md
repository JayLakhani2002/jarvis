# 🧠 Jarvis

The infrastructure that runs Jay's AI company — the code side of the brain at `~/Documents/J's AI Brain` (Obsidian vault, iCloud-synced).

## What runs, when

| Job (launchd) | Schedule | Script | What it does |
|---|---|---|---|
| `telegrambot` | always on (KeepAlive) | `bin/telegram_jarvis.py` | Pocket Jarvis: @Jarvis_for_Jay_bot answers from the vault; `/task` `/brief` `/status` |
| `nightshift` | **PAUSED by Jay** (plist in `launchd/disabled/`) | `bin/night_shift.sh` | Headless chief-of-staff works ≤3 Backlog items (draft-only) → Shift Report + Decision Inbox + Morning Briefing. Re-enable: `git mv launchd/disabled/com.jaysbrain.nightshift.plist launchd/ && ./install.sh` |
| `watchdog` | 06:55 daily | `bin/watchdog.sh` | Verifies every job ran; appends 🩺 status to the briefing |
| `briefingpush` | 07:00 daily | `bin/briefing_push.sh` | Sends Morning Briefing to Telegram (iMessage fallback) |
| `vaultsnapshot` | hourly | `bin/vault_snapshot.sh` | Commits vault content to local backup repo `~/.jarvis-vault-backup.git` (never leaves the machine) |
| `dailysync` | 21:00 daily | `bin/brain_cloud_sync.sh` | Pushes core brain files → private GitHub `jarvis-brain-sync` → claude.ai Project |
| `weeklysync` | Sun 18:05 | `bin/weekly_brain_sync.sh` | Git activity + 7-day health digest → vault Quick Capture, then drafts the weekly review into `06 Company/Drafts/` (Jay edits + ratifies) |
| `marketradar` | 01:30 daily | `bin/market_radar.py` | Scans arbeitnow.com for Berlin werkstudent postings → stats + trend table in `06 Company/(C) Market Radar.md` (fresh before the 02:00 shift) |
| `voiceserver` | always on (KeepAlive) | `bin/voice_server.py` | LAN HTTP :8765 for Siri Shortcuts: `/ask` (RAG + claude, spoken-length answer), `/brief`, `/health`. Key auth from `config/voice.conf` (gitignored). Read-only by design |
| `dashboard` | every 30 min + at load | `bin/dashboard.py` | One-screen JARVIS-HUD dashboard (habits, deadlines countdown, Decision Inbox, Agora market, job health) → `dashboard/index.html` (gitignored). View: open the file, or phone via `voiceserver` `/dash?key=…` |
| `ragindex` | 20:45 daily | `bin/vault_rag.py index` | Vault RAG: embeds every note (nomic-embed-text via local Ollama) → `~/.jarvis-rag/` (local-only). Query: `vault_rag.py search/ask` or Telegram `/search` |
| `emailtriage` | 06:40 daily | `bin/email_triage.py` | Reads Gmail inbox **read-only** over IMAP (BODY.PEEK), claude classifies needs-reply/FYI/noise → `## 📧 Inbox` section in the briefing + reply drafts in `06 Company/Drafts/` for ratification. **Dormant until `config/email.conf` exists** (setup recipe in vault Drafts). Never sends/marks-read/moves mail |

## Layout

```
bin/        all executable scripts + night_shift_prompt.md (the shift's orders)
launchd/    plist SOURCES (versioned) — edit here, never in ~/Library directly
config/     telegram.conf (bot token + chat id) — gitignored, never committed
logs/       archived pre-v1.5 job logs (gitignored); live stdout/err + app logs now write to ~/Library/Logs/Jarvis (outside TCC/iCloud — see gotcha 7)
install.sh  deploys launchd/*.plist → ~/Library/LaunchAgents and reloads them
```

## How to change things

1. Edit a script in `bin/` → change is live immediately (jobs call scripts by path).
2. Edit a schedule → change the plist in `launchd/`, then run `./install.sh`.
3. New job → add plist to `launchd/` + script to `bin/`, run `./install.sh`, and add it to the job list in `bin/watchdog.sh` and `bin/telegram_jarvis.py` (/status).
4. Check health → Telegram: `/status`, or `launchctl list | grep jaysbrain` (exit code 0 = healthy).
5. **New bash-script job? Route it through `bin/run_sh.py`, never call `/bin/bash script.sh` directly in a plist.** launchd-spawned `/bin/bash` gets silently denied ("Operation not permitted") reading `.sh` files under `~/Documents/*` — no TCC prompt is possible for a headless agent, so it just fails. Pattern (see any current plist for the exact form): `["/bin/bash", "-c", "exec /opt/homebrew/bin/python3 /Users/jay/Documents/Jarvis/bin/run_sh.py /Users/jay/Documents/Jarvis/bin/yourscript.sh"]`. Pure-python jobs don't need this — `bash -c "exec /opt/homebrew/bin/python3 script.py"` already works because bash never opens the script file itself.
6. **Vault file I/O can hit a transient `OSError: [Errno 11] Resource deadlock avoided`** — iCloud/Obsidian briefly locks a note mid-sync. Read with retries (`read_resilient()` in `voice_server.py`, `read_lines_resilient()` in `dashboard.py`); on write, retry with a `brctl download` nudge between attempts (see `watchdog.sh`). Don't let one crash a whole job — vault I/O is never guaranteed instant.
7. **launchd log paths MUST stay outside `~/Documents`.** On reboot, launchd's `posix_spawn` opens each job's `StandardOut/ErrPath` *before* exec; if that file sits under the TCC-protected, iCloud-synced `~/Documents` and carries a stale `com.apple.macl` xattr, the open is denied and the job crash-loops. **Symptom: label still listed in `launchctl list`, but PID `-` and last exit status `78` (`EX_CONFIG`).** This poisoned all 10 jobs for ~2 days after the Jul 9 reboot (fresh files worked, which is why it looked intermittent). Fix (v1.5): every plist + app-level log path now points at `~/Library/Logs/Jarvis/` and `install.sh` creates it — never point a launchd log path back under `~/Documents`. The watchdog now catches this class directly (PID + exit-78 checks, plus a direct Telegram push that survives even when the briefing-push job is down).

## Related pieces outside this repo

- **The brain:** `~/Documents/J's AI Brain` (Obsidian vault; agents' ground truth; company docs in `06 Company/`)
- **Agent charters:** `~/.claude/agents/*.md` (13 roles — chief-of-staff, ceo, cto, cmo, cfo, coo, architects, pm, dev, tester, deployer, analyst)
- **Sync repo (working dir):** `~/.jarvis-brain-sync` → github.com/JayLakhani2002/jarvis-brain-sync (private)
- **Vault backup repo:** `~/.jarvis-vault-backup.git` (bare, local-only by design — journals/health never leave the machine)

## Recovery

Mac reformatted / new machine: clone this repo to `~/Documents/Jarvis`, restore `config/telegram.conf` (token from BotFather, chat id via getUpdates), run `./install.sh`. Vault comes back via iCloud; agents via `~/.claude/agents` (re-create from Company OS charters if lost).

## Hard rules baked into everything

- Unattended = **draft-only**: agents write inside the vault only — no sends, no pushes, no deploys, no spend.
- Decisions land in the vault's Decision Inbox; **Jay ratifies**, machines never decide.
- The one track outranks all features: Thesis → BSS (Sept 13) → Agora Oct beta.
