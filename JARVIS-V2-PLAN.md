# Jarvis v2 — Command Center: Plan & Master Prompt

*Refined from `prompt.md` rough notes, 2026-07-17. This file is the ratified spec source; `prompt.md` stays as the original scratch.*

---

## 1. Decision (recommendation, veto anytime)

**Wrap, don't rebuild.** Existing Jarvis (7 launchd jobs, Telegram bot, night shift, vault sync, claude-mem) is the proven backend. The new work is a **local Mac desktop app** that becomes the face of the same system.

| Decision | Choice | Why |
|---|---|---|
| Architecture | New app **on top of** existing Jarvis | Backend reliability already earned; app is a client of the vault + scripts, never a second brain |
| App stack | **Electron + React + TypeScript + Claude Agent SDK** | Agent SDK is native Node; direct vault file access; Deepgram/ElevenLabs JS SDKs; fastest solo iteration with an Apple-style UI |
| Voice in | **Deepgram** (speech→text) | Standard role; best latency for live transcription |
| Voice out | **ElevenLabs** (text→speech) | Standard role; best voice quality |
| Memory | Vault remains single source of truth; claude-mem keeps running | App reads/writes vault notes; no new database for knowledge |
| Boundary | Draft-only stays sacred | App never auto-sends/spends/deploys; everything lands as drafts for ratification |

---

## 2. Rough notes → refined features

| # | Rough note | Disposition |
|---|---|---|
| 1 | YC founder strategy .md | **Build** — one research doc in vault (Phase 0) |
| 2–3 | Business decision team (CEO, CTO, CMO…) that talks to each other | **Already exists** — company agents + chief-of-staff routing. Work = surface in UI (Phase 4) |
| 4–5, 7 | Jarvis → Claude Code → agents; memory → brain | **Architecture** — this IS the app design (Phase 1) |
| 6 | Every request classified (personal / routine / reminder / project) → right skill; voice.md, vault.md, metrics.md updated | **Build** — the Router (Phase 3) |
| 8a | Context of all projects/chats, synced to brain | **Partially exists** (claude-mem) — expose in UI (Phase 5) |
| 8b | Memory: raw → staging → wiki compiled knowledge | **Build** — memory pipeline (Phase 5) |
| 8c | Google Workspace: Gmail, Calendar, Drive, Docs, Sheets | **Partially exists** (MCP connectors, email triage) — wire into app (Phase 6) |
| 8d | "Mode armor" — password safekeeping + digital footprint removal | **Parked** — do NOT build a password manager (use 1Password/Keychain; rolling our own is a security liability). Footprint removal is a service, not a feature. Reduced to: quarterly security-hygiene checklist agent, if ever |
| 8e | Research skills (deep research, light query, NotebookLM) | **Mostly exists** (deep-research skill, research-analyst agent) — surface in skills panel (Phase 6) |
| 8f | Content skills (clipping, viral IG ideas, YT hooks, carousels) | **Build** — content skill pack (Phase 7) |
| 9 | CV rewriter suite (Diagnoser, Recruiter, Rewriter, Hiring Manager) | **Build** — 4-agent pack (Phase 7) |
| 10 | Grooming agent (color analysis, jewelry, skin tone) | **Build small** — one skill with vision, not an "agent" (Phase 7) |
| 11 | Skills panel: list all, run with button, usage observability | **Build** — skills panel (Phase 6) |
| 12 | Business dashboard: every business, stage, progress, last run | **Build** — reads from vault Company OS notes (Phase 4) |
| 13, 17 | Apple-design UI, Siri-like futuristic orb, left nav (command center, tasks, schedules, tools, pipelines, content, knowledge vault + Obsidian graph, agents, businesses), bottom status bar like VS Code terminal | **Build** — UI shell (Phase 1) + graph view (Phase 5) |
| 14–15 | ElevenLabs + Deepgram voice | **Build** — voice layer (Phase 2), roles corrected |
| 16 | Access to local files, vault, notes | **Build** — Phase 1 (trivial: vault is plain files on disk) |
| 18 | PRD for voice-first agent | **Build** — Phase 0 output |

---

## 3. Phased plan (small chunks, each independently shippable)

### Phase 0 — Paper (½ day)
- [ ] PRD: voice-first local Jarvis app (personas, flows, edge cases: mic permissions, offline, Claude rate limits, vault conflicts)
- [ ] YC founder-strategy research doc → vault
- [ ] Append architecture decision to `DECISIONS.md`
- **Done when:** PRD ratified by the operator.

### Phase 1 — Shell (the walking skeleton, ~1 weekend)
- [ ] Electron + React app boots, Apple-style dark UI: left nav, center Jarvis orb + chat, bottom status strip (launchd job health from watchdog)
- [ ] Chat wired to Claude Agent SDK (streamed responses, tool use visible)
- [ ] Vault access: browse/read/edit notes from app
- [ ] `/status` parity with Telegram bot
- **Done when:** you can type to Jarvis in the app, it executes via Claude Code, and the answer lands + memory updates in the vault.

### Phase 2 — Voice (~2–3 evenings)
- [ ] Push-to-talk → Deepgram live STT → chat input
- [ ] Replies spoken via ElevenLabs (toggleable)
- [ ] Orb animation states: idle / listening / thinking / speaking
- **Done when:** full spoken round-trip works.

### Phase 3 — Router (~2 evenings)
- [ ] Every request classified first: personal | daily routine | reminder/task | project work
- [ ] Routes to matching skill/agent; reminders → calendar/todo path; project work → company agents
- [ ] Updates `voice.md`, `metrics.md`, vault logs per interaction
- **Done when:** 10 mixed test prompts all route correctly and leave a trace.

### Phase 4 — Company in the app (~1 weekend)
- [ ] Agents page: existing company agents (chief-of-staff, ceo, cto, cmo, coo, …) each with an interface — chat, last run, outputs
- [ ] Business dashboard: every venture (content…), stage, deadline countdown, progress, last activity — read from vault Company OS notes
- **Done when:** one glance answers "what businesses am I running and where do they stand."

### Phase 5 — Memory pipeline (~1 weekend)
- [ ] Raw capture → staging area → compiled wiki notes (promotion runs via night shift, drafts only)
- [ ] Obsidian graph rendered in Knowledge Vault tab
- [ ] Project/chat context browser (claude-mem observations surfaced)
- **Done when:** a raw voice ramble ends up as a linked wiki note after ratification.

### Phase 6 — Tools & integrations (~1 weekend)
- [ ] Skills panel: all skills listed, run-with-button, usage/observability window
- [ ] Google Workspace surfaced: calendar, Gmail triage, Drive/Docs/Sheets via existing MCP connectors
- [ ] Research skills (deep-research, light query) exposed; NotebookLM export path
- **Done when:** skills are discoverable and runnable without the terminal.

### Phase 7 — Specialty packs (~1 weekend, cut freely)
- [ ] CV suite: Diagnoser → Recruiter (keyword analysis vs job posts) → Rewriter (XYZ formula) → Hiring Manager (mock interview)
- [ ] Grooming skill: photo → seasonal color analysis, wear/avoid palette, jewelry metal
- [ ] Content pack: clip capture, IG viral ideas, YT hooks, carousel drafts
- **Done when:** each pack produces one ratified real output (a real CV pass, a real color analysis).

**Sequencing rule:** phases ship in order 0→7; each is a stopping point. Per the one-track priority order (deadline-ranked workstreams), Phase 0 is safe to do now; Phases 1+ are weekend-sized and should be scheduled around the one-track priority order (deadline-ranked workstreams), not instead of it.

---

## 4. Master prompt (paste to start any phase)

> **Context:** You are working on Jarvis v2 — a local Mac command-center app (Electron + React + Claude Agent SDK) that wraps the existing Jarvis backend in `~/Documents/Jarvis` (launchd jobs, Telegram bot, vault sync, claude-mem). The Obsidian vault `~/Documents/J's AI Brain` is the single source of truth for memory and identity; the app is a client of it, never a second brain. Read `JARVIS-V2-PLAN.md`, `README.md`, `DECISIONS.md`, and the vault `CLAUDE.md` first.
>
> **Hard rules:** Draft-only boundary — nothing auto-sends, auto-spends, auto-deploys, or pushes without the operator's ratification. Never touch `~/Library/LaunchAgents` directly. Never commit secrets. Voice pipeline is Deepgram (STT) + ElevenLabs (TTS). Every interaction leaves a trace in the vault. Test before claiming done.
>
> **Task:** Execute Phase {N} of `JARVIS-V2-PLAN.md`. Build the smallest version that satisfies its "done when" line. Reuse existing scripts, agents, and skills before writing anything new. When a product decision is ambiguous, ask — don't assume. Finish by demonstrating the done-when criterion live and appending significant decisions to `DECISIONS.md`.

---

## 5. Open items (defaults chosen, veto anytime)
1. Voice roles corrected to standard (Deepgram in / ElevenLabs out) — confirm.
2. "Mode armor" password manager parked for security reasons — confirm.
3. Electron over Tauri/SwiftUI — confirm.
4. Start timing: Phase 0 now, Phase 1 on your "go."
