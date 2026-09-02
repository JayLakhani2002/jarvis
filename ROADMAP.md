# Jarvis Roadmap

What's next, in order. Operational task queue = the vault's `06 Company/(C) Backlog.md` (night shift eats from there); this file is the feature-level plan. Founder (the operator) ratifies scope changes.

## ✅ v1.9 — repo-move restore + external dead-man switch, shipped 2026-08-12
The repo moved from `~/Documents/Jarvis` → `~/Documents/Projects/Jarvis` on Aug 2; every job hardcoded the old path, so all 12 died instantly and silently — nothing alerted for ~10 days, because the watchdog's own alert path lives inside the same broken stack. Third multi-day silent outage of this project (after Jul 7 bash-denial and Jul 9 EX_CONFIG). Fixed: all 32 hardcoded path references across 13 plists, 8 scripts, `install.sh`, and `app/main.js`/`app/voice.js`; `weekly_brain_sync.sh`'s sibling-repo scan now checks `~/Documents/Projects/` first. Hardened: `watchdog.sh` now pings an external healthchecks.io dead-man switch whenever it runs clean (`config/heartbeat.conf`, dormant until configured) — the alarm now lives outside this Mac, so it can't die with the stack it's watching; also added a whole-stack staleness check (dashboard.py not regenerating in >90min → CRITICAL) independent of any single job's exit code. `market_radar.py` and `vault_rag.py` gained the `read_resilient()` iCloud-lock retry pattern dashboard.py/voice_server.py already had. v2 Phase 2's TTS privacy-taint race fixed (a concurrent turn could clear a prior turn's taint before it finished speaking). Discovered, not yet fixed: `vaultsnapshot` has silently produced zero backup commits for ~4 weeks despite exit 0 every hour (its `git add -A` timeout path exits clean without committing) — needs its own investigation.

## ✅ v1.8.1 — overnight-cycle fixes + doc audit, shipped 2026-07-12
First unattended cycle of v1.5–v1.8 surfaced one real bug, fixed same night: `dailysync` cp could hit iCloud EDEADLK and silently push 2-day-old copies (happened Jul 11 21:00) — now retries with a materialize nudge and exits 1 on any stale file so watchdog flags it. Full context7 doc audit of the three external interfaces (Telegram Bot API, python imaplib, Claude Code CLI): all usage current; email triage's claude call additionally locked down to zero tools (`--tools "" --strict-mcp-config`).

## ✅ v1.8 — briefing content spec, shipped 2026-07-11
- **Commander brief** — the 07:00 push is now assembled **deterministically** by `bin/briefing_build.py` (stdlib, no Claude call → no hallucinated numbers, testable, free) into the operator's ratified format: ≤15 lines, numbers-first, imperative. Content order: header · 🎯 Track A/B/C countdowns · deadline-weighted top-3 from the Backlog `## Now (one-track)` items (keyword→track, nearest deadline first, unmatched last) · 📬 Decision Inbox pending · 💪 habits+streak · 📈 market-radar delta · 📧 email headline · 📅 icalBuddy calendar · ○ personal daily-note todos · 🩺 one-line system health. Every empty/unavailable source **omits its line** (never a placeholder); hard cap 15 lines drops todos→calendar→radar. Reuses dashboard.py's exact source files/parsing (one convention). Writes a self-pruning `## ⚡ 07:00 Brief` section at the **top** of the Morning Briefing note (inserted under the H1) so `/brief` leads with it. `briefing_push.sh` sends the builder's output, or falls back to the raw note if the builder fails/empties — the push never silently misses. Calendar needs a one-time Calendar TCC grant (setup recipe in vault `06 Company/Drafts/Jarvis Briefing v1.8 — Notes.md`); habits + email lines self-activate when their sources exist.

## ✅ v1.7 — CFO net-worth tracker, shipped 2026-07-11
- **Net-worth tracker** — `networth` job, 08:05 daily: the operator drops bank CSV exports into `finance/inbox/`; the job parses each with a per-bank column mapping (`config/banks.json`), computes each account's balance in **balance mode** (newest-dated row's balance) or **sum mode** (`starting_balance` + Σ amounts), handles German (`1.234,56`) vs US (`1,234.56`) decimals + currency symbols + UTF-8 BOM, keeps a per-account + monthly-history `finance/state.json`, and maintains a marker-delimited `## 📊 Net worth (Jarvis-tracked)` block in the vault's `GOALS.md` (per-account bullets + monthly Δ table). Stdlib-only (csv/json/datetime). Processed files → `finance/processed/`, unreadable → `finance/failed/`. **Dormant (exit 0) until a CSV is dropped**; a broken mapping config with files waiting, or any failed file, exits 1 (watchdog flags it). Generic mapper (the operator's call) over per-bank hardcoding; never writes GOALS until the first successful ingest, never edits outside its markers, `finance/` gitignored so bank data can't be committed. Setup recipe in vault `06 Company/Drafts/Jarvis Net Worth — Setup.md`.

## ✅ v1.6 — email triage, shipped 2026-07-11
- **Email triage agent** — `emailtriage` job, 06:40 daily: reads the operator's Gmail inbox **read-only** over IMAP (LOGIN / SELECT readonly / SEARCH / FETCH BODY.PEEK / LOGOUT only — never sends, marks read, or moves mail), claude classifies each message needs-reply/FYI/noise → self-pruning `## 📧 Inbox` section in the Morning Briefing + reply drafts into `06 Company/Drafts/` for the operator to approve and send himself. Stdlib-only (imaplib/email/ssl), zero new deps. **Dormant until `config/email.conf` exists** — 5-min app-password setup recipe waits in vault `06 Company/Drafts/Jarvis Email — Setup.md` (the operator's hands). Dormant exits 0 (watchdog quiet); configured-but-broken exits 1 (watchdog flags it).

## ✅ v1.5 — infra hardening 2, shipped 2026-07-11
The Jul 9 reboot crash-looped all 10 launchd jobs for ~2 days with `EX_CONFIG` (exit 78): launchd's `posix_spawn` couldn't open their stdout/err files under the TCC-protected, iCloud-synced `~/Documents` (stale `com.apple.macl` xattr). Two fixes so the class can't recur or hide again:
- **All logs moved out of `~/Documents` → `~/Library/Logs/Jarvis/`** — every plist (10 active + paused nightshift) and every app-level log path; `install.sh` creates the dir before bootstrapping. Outside TCC and iCloud, so posix_spawn can always open them: the EX_CONFIG poisoning class is eliminated at the root. Old logs stay archived under `~/Documents/Jarvis/logs`.
- **Watchdog now checks reality, not labels.** It parses `launchctl list` PID/exit-status columns: daemons (telegrambot, voiceserver) with PID `-` and any job exiting 78 are CRITICAL, other persistent non-zero exits are warnings, signal deaths ignored. Any CRITICAL is pushed straight to Telegram via the Bot API — a channel that survives even when the briefing-push job is itself down (the reason both past outages went unseen).

## ✅ v1.4.1 — infra hardening, shipped 2026-07-09
Full test pass over every v1.1–v1.4 feature (context7-verified Telegram Bot API + Ollama API usage — both current, no code changes needed) surfaced and fixed five real bugs, two of them silently breaking production for 46+ hours:
- **`dailysync` + `vaultsnapshot` were both broken for 2 days, undetected** — launchd-spawned `/bin/bash` gets silently denied reading `.sh` files under `~/Documents/*` (no TCC prompt possible headless), and `watchdog` — the thing that should have caught this — hit the *same* bug, so its own alerts never fired. Fixed all 5 plain-bash jobs via new `bin/run_sh.py`: python (which has proven vault access) reads the script source and hands it to bash as an in-memory `-c` string instead of a file path bash would open itself.
- **`vault_snapshot.sh` could hang indefinitely** on `git add -A` (iCloud "dataless" files take 2–10s each to materialize on first touch) and leave a stale `index.lock` that would permanently wedge every future run. Rewrote with a bounded timeout + self-healing lock cleanup on every invocation.
- **Intermittent `OSError: Resource deadlock avoided`** on vault reads while Obsidian has a note open (iCloud file coordination) — was surfacing as a misleading `/brief` 404 ("no briefing yet" when it very much existed) and crashing `dashboard.py` mid-render. Both now retry with backoff.
- **`watchdog` grew one duplicate briefing section per run, forever** — it's meant to be reset nightly by the 02:00 shift, but with night shift paused nothing resets it. Now prunes its own prior section before appending.
- **Dashboard's Decision Inbox count was wrong** — it counted the `- [ ] Approve` line inside the entry-format *template* as a real pending decision. Now scoped to the actual `## Pending` section.
- Backlog.md cleaned up: 4 shipped features (market radar, weekly draft, RAG, voice, dashboard) were never marked Done; the market-radar item was still listed as open future work.

## ✅ v1.4 — shipped 2026-07-08
- **Jarvis dashboard** — `dashboard` job (every 30 min): one-screen HTML at `dashboard/index.html` — deadline countdowns (Track A/B/C), 4-habit sparklines, Decision Inbox + Backlog counts, venture market trend, automation health. Phone view via voiceserver `/dash?key=…`. Habit charts fill once the operator builds the "Log Health" iOS Shortcut

## ✅ v1.3 — shipped 2026-07-08
- **Voice round-trip (Mac half)** — `voiceserver` job: authenticated LAN HTTP :8765; `/ask` = RAG + claude in ≤3 spoken sentences (~15s), `/brief` for the 7am read-aloud. Phone half = 5-min Shortcut recipe waiting in vault `06 Company/Drafts/Jarvis Voice — iOS Shortcut Setup.md` (the operator's hands)

## ✅ v1.2 — shipped 2026-07-08 (Tier 2 opened by the operator's call)
- **Vault RAG** — `ragindex` job 20:45: all 86 notes embedded locally (Ollama + nomic-embed-text) into `~/.jarvis-rag/`; `vault_rag.py search|ask` gives cited semantic answers; Telegram `/search` from the phone
- **Night shift PAUSED by the operator** until he picks the project it runs on — plist parked in `launchd/disabled/`; watchdog + `/status` know and stay quiet
- Fixed: telegram bot crash-loop (Xcode python TCC denial) — python jobs now exec through bash + homebrew python

## ✅ v1.1 — shipped 2026-07-07 (evening)
- **Venture market radar** — `marketradar` job, 01:30 nightly: arbeitnow.com scan → Berlin werkstudent stats + daily trend table in `06 Company/(C) Market Radar.md`; night-shift agents cite real numbers
- **Sunday auto-review draft** — `weekly_brain_sync.sh` now ends with a headless agent drafting the weekly review (4 habit numbers, git, plan adherence, one-track check, next-week priorities) into `06 Company/Drafts/`

## ✅ v1 — shipped 2026-07-07
- 13-agent company (charters in `~/.claude/agents/`) with draft-and-ratify protocol
- Night shift 02:00 (headless chief-of-staff, ≤3 backlog items, draft-only)
- Pocket Jarvis: @your_bot_name (any text → vault-grounded answer; /task /brief /status)
- Morning Briefing → Telegram 07:00; Watchdog 06:55; hourly local vault snapshots
- Brain sync → private GitHub → claude.ai Project (7 files, daily 21:00)
- Vault graph fully connected (🧠 HOME hub, 0 orphans)

## 🔜 Next up (approved, in order)
1. ~~**Briefing content spec** — the operator defines exactly what the 07:00 Telegram message must contain.~~ ✅ shipped in v1.8 — ratified spec assembled deterministically by `briefing_build.py`; `night_shift_prompt.md` + `briefing_push.sh` reshaped around it.

## 🧊 Tier 2 (after Track A momentum is safe, ≥20h/wk sustained)
*(Tier 2 opened early on the operator's 2026-07-08 instruction; Track A-hours gate waived by him.)*
- ~~**Vault RAG**~~ ✅ shipped in v1.2
- ~~**Voice round-trip**~~ ✅ Mac half shipped in v1.3 — awaiting the operator's 5-min iOS Shortcut build (recipe in vault Drafts)
- ~~**Jarvis dashboard**~~ ✅ shipped in v1.4
- ~~**Email triage agent**~~ ✅ shipped in v1.6 — inbox summary into briefing, drafted replies for ratification
- ~~**CFO net-worth tracker**~~ ✅ shipped in v1.7 — bank CSV drop-folder → per-account balances + monthly GOALS net-worth block

## 🌌 Tier 3 (December review)
- Decision-memory learning loop (agents learn the operator's ratification patterns)
- Multi-model council for big decisions (llm-council exists locally)
- Read-it-later pipeline (link → firecrawl → summarized into vault)
- Screen-time fog detector feeding COO
- Venture ops agents post-beta (signup monitoring, support drafts, DAU in briefing)

## Blocked on the operator's hands (only he can)
- `sudo pmset repeat wakeorpoweron MTWRFSU 01:55:00` — Mac auto-wake for the 02:00 shift
- iOS Shortcuts: "Jarvis Health" logging + voice capture (Apple sandboxes Health to on-device)
- ~~Briefing content spec~~ ✅ ratified 2026-07-11, shipped in v1.8 (deterministic builder). Remaining the operator-only step: the one-time icalBuddy Calendar grant so the 📅 line activates (recipe in vault Drafts).
