# Jarvis Roadmap

What's next, in order. Operational task queue = the vault's `06 Company/(C) Backlog.md` (night shift eats from there); this file is the feature-level plan. Founder (Jay) ratifies scope changes.

## ✅ v1 — shipped 2026-07-07
- 13-agent company (charters in `~/.claude/agents/`) with draft-and-ratify protocol
- Night shift 02:00 (headless chief-of-staff, ≤3 backlog items, draft-only)
- Pocket Jarvis: @Jarvis_for_Jay_bot (any text → vault-grounded answer; /task /brief /status)
- Morning Briefing → Telegram 07:00; Watchdog 06:55; hourly local vault snapshots
- Brain sync → private GitHub → claude.ai Project (7 files, daily 21:00)
- Vault graph fully connected (🧠 HOME hub, 0 orphans)

## 🔜 Next up (approved, in order)
1. **Agora market radar** — nightly firecrawl/Apify scrape of Berlin werkstudent postings → stats note in vault → CMO/CTO agents cite real market data. *Directly serves the one track.* (~2-3h)
2. **Sunday auto-review draft** — extend `bin/weekly_brain_sync.sh`: agent drafts the full weekly review (4 habit numbers, git, calendar adherence); Jay edits 5 min instead of writing 30. (~1h)
3. **Briefing content spec** — Jay will define exactly what the 07:00 Telegram message must contain (personal items included). Reshape `night_shift_prompt.md` + `briefing_push.sh` around it. *(waiting on Jay's spec)*

## 🧊 Tier 2 (after thesis momentum is safe, ≥20h/wk sustained)
- **Voice round-trip** — "Hey Siri, ask Jarvis…" → Mac → spoken answer; plus Shortcut that reads the briefing aloud at 7am
- **Vault RAG** — embeddings over all notes+books; semantic search with sources (doubles as Jay's RAG education)
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
