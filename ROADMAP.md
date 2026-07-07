# Jarvis Roadmap

What's next, in order. Operational task queue = the vault's `06 Company/(C) Backlog.md` (night shift eats from there); this file is the feature-level plan. Founder (Jay) ratifies scope changes.

## ✅ v1.3 — shipped 2026-07-08
- **Voice round-trip (Mac half)** — `voiceserver` job: authenticated LAN HTTP :8765; `/ask` = RAG + claude in ≤3 spoken sentences (~15s), `/brief` for the 7am read-aloud. Phone half = 5-min Shortcut recipe waiting in vault `06 Company/Drafts/Jarvis Voice — iOS Shortcut Setup.md` (Jay's hands)

## ✅ v1.2 — shipped 2026-07-08 (Tier 2 opened by Jay's call)
- **Vault RAG** — `ragindex` job 20:45: all 86 notes embedded locally (Ollama + nomic-embed-text) into `~/.jarvis-rag/`; `vault_rag.py search|ask` gives cited semantic answers; Telegram `/search` from the phone
- **Night shift PAUSED by Jay** until he picks the project it runs on — plist parked in `launchd/disabled/`; watchdog + `/status` know and stay quiet
- Fixed: telegram bot crash-loop (Xcode python TCC denial) — python jobs now exec through bash + homebrew python

## ✅ v1.1 — shipped 2026-07-07 (evening)
- **Agora market radar** — `marketradar` job, 01:30 nightly: arbeitnow.com scan → Berlin werkstudent stats + daily trend table in `06 Company/(C) Market Radar.md`; night-shift agents cite real numbers
- **Sunday auto-review draft** — `weekly_brain_sync.sh` now ends with a headless agent drafting the weekly review (4 habit numbers, git, plan adherence, one-track check, next-week priorities) into `06 Company/Drafts/`

## ✅ v1 — shipped 2026-07-07
- 13-agent company (charters in `~/.claude/agents/`) with draft-and-ratify protocol
- Night shift 02:00 (headless chief-of-staff, ≤3 backlog items, draft-only)
- Pocket Jarvis: @Jarvis_for_Jay_bot (any text → vault-grounded answer; /task /brief /status)
- Morning Briefing → Telegram 07:00; Watchdog 06:55; hourly local vault snapshots
- Brain sync → private GitHub → claude.ai Project (7 files, daily 21:00)
- Vault graph fully connected (🧠 HOME hub, 0 orphans)

## 🔜 Next up (approved, in order)
1. **Briefing content spec** — Jay will define exactly what the 07:00 Telegram message must contain (personal items included). Reshape `night_shift_prompt.md` + `briefing_push.sh` around it. *(waiting on Jay's spec)*

## 🧊 Tier 2 (after thesis momentum is safe, ≥20h/wk sustained)
*(Tier 2 opened early on Jay's 2026-07-08 instruction; thesis-hours gate waived by him.)*
- ~~**Vault RAG**~~ ✅ shipped in v1.2
- ~~**Voice round-trip**~~ ✅ Mac half shipped in v1.3 — awaiting Jay's 5-min iOS Shortcut build (recipe in vault Drafts)
- **Jarvis dashboard** — habit trends, timeline progress, Decision Inbox count, Agora metrics on one screen
- **Email triage agent** — inbox summary into briefing, drafted replies for ratification
- **CFO net-worth tracker** — bank CSV drop-folder → monthly GOALS numbers update

## 🌌 Tier 3 (December review)
- Decision-memory learning loop (agents learn Jay's ratification patterns)
- Multi-model council for big decisions (llm-council exists locally)
- Read-it-later pipeline (link → firecrawl → summarized into vault)
- Screen-time fog detector feeding COO
- Agora ops agents post-beta (signup monitoring, support drafts, DAU in briefing)

## Blocked on Jay's hands (only he can)
- `sudo pmset repeat wakeorpoweron MTWRFSU 01:55:00` — Mac auto-wake for the 02:00 shift
- iOS Shortcuts: "Jarvis Health" logging + voice capture (Apple sandboxes Health to on-device)
- Briefing content spec (item 3 above)
