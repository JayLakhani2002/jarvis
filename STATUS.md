# Jarvis — Build Status (as of 2026-08-12)

## What we're building
Jarvis is Jay's personal AI-company automation ("life OS"): a set of unattended launchd jobs plus a Telegram bot that read/write an Obsidian vault (`~/Documents/J's AI Brain`), and a new desktop app (Jarvis v2) that puts a voice-first UI on top of that same backend. Hard rule throughout: draft-only — nothing auto-sends, auto-deploys, or auto-spends without Jay ratifying it.

## Done — v1 backend (shipped, v1 → v1.8.1; restored 2026-08-12 after a repo-move outage)
12 launchd jobs, all live in `bin/` + `launchd/`:
- `telegrambot`, `nightshift` (**paused** by Jay), `watchdog`, `briefingpush`, `vaultsnapshot`, `dailysync`, `weeklysync`, `marketradar`, `voiceserver`, `dashboard`, `ragindex`, `emailtriage`, `networth`
- 13-agent company (charters in `~/.claude/agents/`), draft-and-ratify Decision Inbox
- Deterministic 07:00 commander-brief builder (v1.8), CFO net-worth tracker (v1.7), email triage (v1.6), infra hardening for iCloud/TCC log-path issues (v1.4.1, v1.5), overnight-cycle fix + doc audit (v1.8.1)
- **v1.9 (2026-08-12):** repo moved `~/Documents/Jarvis` → `~/Documents/Projects/Jarvis` on Aug 2 broke every job silently for ~10 days (all 32 hardcoded path references fixed); external healthchecks.io dead-man switch added to `watchdog.sh` (dormant until `config/heartbeat.conf` exists) so a whole-stack outage alerts Jay from outside the Mac; `marketradar`/`vault_rag.py` gained the `read_resilient()` retry pattern for iCloud lock errors that dashboard.py/voice_server.py already had
- Full history in `ROADMAP.md` and `DECISIONS.md`

## Done — Jarvis v2 desktop app (Phases 0–2 of 8; still uncommitted)
Lives in `app/` (Electron, untracked in git as of this writing — see loose ends).
- **Phase 0 (paper):** PRD + plan ratified — `JARVIS-V2-PRD.md`, `JARVIS-V2-PLAN.md`
- **Phase 1 (shell):** Electron app boots, chat wired to Claude Agent SDK, vault browse/read, draft-only `canUseTool` guard (`app/guard.js`), job-health status strip (`app/jobs.js`). Shipped as vanilla HTML/CSS/JS, **not** React as the PRD specified — logged as a deliberate, revisit-later deviation (DECISIONS.md, 2026-07-17); reconfirmed 2026-08-12, staying vanilla until a phase needs real component state
- **Phase 2 (voice + UI):** Deepgram STT + ElevenLabs TTS fully wired (`app/voice.js`), dark OLED design system, TTS privacy gate for journal/health/faith content. Ships its own hand-rolled SVG/CSS orb (`renderer/index.html` + `styles.css`), audio-reactive off real mic amplitude — **not** the standalone `jarvis-orb/` web component, which exists in the repo but is never loaded by the app (kept as-is, unused, by Jay's call 2026-08-12)
- All three self-checks pass (`npm test` runs `guard.js`, `jobs.js`, **and** `voice.js` — not two as previously stated here)
- **2026-08-12 fixes:** two hardcoded `~/Documents/Jarvis` paths (`main.js` Agent SDK `cwd`, `voice.js` config path) that pointed at a dead directory; a TTS privacy-gate race where a second turn starting before the first reply finished speaking could clear the first turn's taint (fixed by threading the taint set through `jarvis:done`/`voice:speak` per-turn instead of a shared module global)
- **Phase 2 has still never been run live** — `config/voice-app.conf` was never created; blocked on Jay signing up for Deepgram + ElevenLabs free tiers (recipe ready in vault `06 Company/Drafts/Jarvis Voice v2 — Setup.md`, paths corrected)

## Open / not started — Jarvis v2 Phases 3–7
From `JARVIS-V2-PLAN.md`, waiting on Jay's explicit "go" each time (weekend-sized, scheduled around thesis work). Confirmed: 7 of 9 left-nav items (Tasks, Schedules, Tools, Pipelines, Content, Agents, Businesses) are `disabled` stubs with no backing view yet.
- **Phase 3 — Router:** classify every request (personal / routine / reminder / project) and route to the right skill/agent
- **Phase 4 — Company in the app:** agent chat pages + business dashboard (Agora, BSS, thesis stage/progress) in the UI
- **Phase 5 — Memory pipeline:** raw capture → staging → compiled wiki notes; Obsidian graph view in-app; claude-mem context browser
- **Phase 6 — Tools & integrations:** skills panel (list/run/observe), Google Workspace surfaced (Gmail/Calendar/Drive), research skills exposed
- **Phase 7 — Specialty packs:** CV rewriter suite, grooming/color-analysis skill, content pack (clips, IG/YT hooks, carousels)

## Started-but-not-finished loose ends
- **`app/` and `jarvis-orb/` are still untracked in git** — Phases 0–2 exist only in the working tree; committing them is the next immediate step
- **`vaultsnapshot` has produced zero commits in ~4 weeks despite reporting exit 0 every hour** — discovered 2026-08-12: `git add -A` on the vault hangs past the script's own 240s safety cap, and that timeout path exits 0 without ever committing. The local backup safety net has been silently non-functional since mid-July. Root cause not yet diagnosed (needs its own investigation) — flagged, not fixed blind
- **`ragindex` fails because Ollama isn't installed** on this Mac at all (not a code bug) — Jay's hands if he wants vault RAG search back
- **Phase 2 voice round-trip unverified live** — code is complete and unit-tested but has never actually spoken to Deepgram/ElevenLabs; blocked on Jay's API key signups
- **Night shift remains paused** — parked until Jay picks the project it should run on
- **iOS Shortcuts** (voice capture, health logging, one-time Calendar TCC grant for the 📅 briefing line) — blocked on Jay's hands, not code
- Root also has two uncommitted planning docs (`JARVIS-V2-PLAN.md`, `JARVIS-V2-PRD.md`) plus `prompt.md`, all still untracked

## Immediate next decision
Commit the `app/` + `jarvis-orb/` work (Phases 0–2), then either: Jay does the voice signups so Phase 2 can be verified live end-to-end, or Jay says "go" on Phase 3 (Router) in parallel. Separately: the `vaultsnapshot` silent-failure discovery needs its own look before it's trusted again as a backup.
