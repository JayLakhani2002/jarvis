# PRD — Jarvis v2: Voice-First Command Center

*Status: DRAFT — awaiting the operator's ratification. Companion to `JARVIS-V2-PLAN.md` (phases) and `DECISIONS.md` (2026-07-17 entry).*

---

## 1. Summary

A local Mac desktop app (Electron + React + Claude Agent SDK) that becomes the face of the existing Jarvis system. The operator talks or types to it; it routes every request through a classifier, executes via Claude Code and the existing company agents, and reads/writes the Obsidian vault — which remains the single source of truth. Nothing existing is rebuilt: the 10 launchd jobs, Telegram bot, voice server, dashboard, and claude-mem keep running unchanged underneath.

## 2. Problem

Jarvis today has five disconnected faces: Telegram chat, a static HTML dashboard, Siri voice (read-only), the terminal, and Obsidian itself. There is no single place to talk to the whole system, see the company/business state, run skills, or watch memory grow. Voice is currently one-way (ask, hear ≤3 sentences) with no hands-free workflow for real work.

## 3. User

One user: the operator. Two modes:
- **At desk** — typed chat, dashboards, skills panel, reviewing drafts to ratify.
- **Hands-free** — push-to-talk voice, spoken replies, capturing raw ideas while away from keyboard.

## 4. Goals & success metrics

| Goal | Metric (measured after Phase 3) |
|---|---|
| One front door | ≥80% of Jarvis interactions happen in the app (vs Telegram/terminal) within 2 weeks of Phase 3 |
| Voice round-trip | Speak → transcribed → answered → spoken in <10s median |
| Correct routing | 10-prompt mixed test set routes 10/10 (personal / routine / reminder / project) |
| Memory trace | Every interaction leaves a vault or claude-mem trace; spot-check 100% |
| Zero regression | All existing launchd jobs stay green in watchdog for 14 days post-launch |

## 5. Non-goals (explicit)

- **No password manager, no digital-footprint removal** ("mode armor" — parked; see plan §2).
- **No auto-send/spend/deploy** — draft-and-ratify boundary is unchanged; the app adds an *Approve* button UX, not new autonomy.
- **No second brain** — no app-private database of knowledge; vault + claude-mem only. App state (window size, prefs) is the only local app data.
- **Not replacing Telegram** — the pocket interface stays; the app is the desk interface.
- **No cloud backend** — the app runs entirely on the Mac, same as everything else.

## 6. Architecture

```
The operator (voice/text)
   │
   ▼
Electron app (React UI)
   ├─ Deepgram STT (mic → text)            ├─ ElevenLabs TTS (reply → speech)
   ▼
Router (classify: personal | routine | reminder/task | project)
   │
   ▼
Claude Agent SDK  ──► Claude Code session (tools, skills, MCP)
   │                        │
   │                        ├─► Company agents (chief-of-staff, ceo, cto, cmo, …)
   │                        └─► Skills (deep-research, content, CV suite, …)
   ▼
Vault  ~/Documents/J's AI Brain   (single source of truth)
   ▲
   └─ Existing backend, untouched: launchd jobs, Telegram bot,
      voice_server, dashboard.py, claude-mem, watchdog
```

Key boundaries:
- **Main process** holds API keys (read from `config/`, gitignored) and does all file I/O; the renderer never sees secrets.
- **Vault writes** follow the established idioms: marker-managed blocks / self-pruning sections for notes the app doesn't own; atomic temp-file+rename for notes it does; `read_resilient` retry-with-backoff for every read (EDEADLK is a known, real condition).
- **launchd jobs are read-only from the app's perspective** — the status strip parses `launchctl list` + watchdog output; the app never loads/unloads jobs.

## 7. UI specification

Apple-style dark UI, single window.

- **Left nav:** Command Center · Tasks · Schedules · Tools (Skills) · Pipelines · Content · Knowledge Vault (Obsidian graph) · Agents · Businesses.
- **Center:** Jarvis orb (idle / listening / thinking / speaking animation states) above a streamed chat thread showing tool use inline. Push-to-talk button + hotkey.
- **Bottom status strip** (VS Code-terminal style): launchd job health (from watchdog logic), last briefing time, active Claude session state, token/rate-limit indicator.
- **Decision Inbox surface:** pending decisions render as cards with Approve/Reject — ticking Approve edits the vault checkbox exactly as the operator would by hand. (Approve = vault edit only; any resulting send/spend still happens by the operator's hand, same as today.)

## 8. Core flows

**F1 — Typed request.** Type → Router classifies → routed session streams response + tool calls → trace written (claude-mem observation; vault note if the task produced one).

**F2 — Voice request.** Hold PTT → Deepgram streams transcript live into the input → release → same as F1 → reply optionally spoken via ElevenLabs (toggle).

**F3 — Routing.** Classification is a fast, cheap first pass (single Haiku call): `personal` → identity/vault context; `routine/habit` → COO paths + metrics.md; `reminder/task` → Backlog/calendar draft; `project` → chief-of-staff → right company agent. Misroutes are correctable in-thread ("route this to CTO"), and corrections are logged to improve the router prompt.

**F4 — Business dashboard.** Businesses tab renders one card per venture discovered in `06 Company` + `03 Projects` notes: stage, deadline countdown (from `bin/deadlines.py`), last activity, progress. Read-only view over vault files — no separate database.

**F5 — Memory pipeline (Phase 5).** Raw capture (voice ramble or quick note) → `00 Notes` staging → night shift drafts a compiled wiki note → the operator ratifies → note promoted and linked (never orphaned; links to [[🧠 HOME]] hub per graph rule).

**F6 — Skills panel (Phase 6).** All skills listed with description, Run button (opens a pre-filled chat invocation), and a usage log (when, what, outcome) sourced from claude-mem.

## 9. Edge cases & failure behavior

| Case | Behavior |
|---|---|
| Mic permission denied (TCC) | Orb shows muted state with a one-tap link to System Settings; typed chat fully functional. Never crash, never re-prompt loop. |
| Offline / Claude API unreachable | Honest banner; input queues locally (visible, cancelable); vault browsing/dashboards still work (all local files). |
| Rate limit hit (Max plan) | Status strip shows limit state + reset time; no silent retry storms. Router's Haiku call fails open to "project" route. |
| Vault file locked (EDEADLK — Obsidian/iCloud) | `read_resilient` retry ≤8s; then honest "vault busy" toast. Never a false "file missing", never a blank render (v1.4.1 lesson). |
| iCloud dataless files | Materialize via `brctl download` with a visible loading state; never hang the UI thread (v1.4.1 lesson: bounded timeout). |
| Concurrent writers (launchd job or Obsidian mid-write) | App writes are atomic (temp + rename) and scoped to marker-managed blocks in shared notes; whole-note writes only on notes the app owns. |
| Deepgram/ElevenLabs down or key missing | Degrade to text silently for TTS; STT failure shows "voice unavailable — type instead". Voice is an enhancement, never a dependency. |
| Long-running agent task | Streamed progress + Cancel button; task continues logging to vault so a canceled view ≠ lost work. |
| App crash mid-conversation | No state lives only in memory: transcript persisted incrementally (claude-mem + session log). Relaunch restores last session read-only. |
| Someone else at the Mac | Same trust model as today (local machine = the operator). No auth layer in v1; revisit if the app ever listens on the network. |

## 10. Privacy & security

- **Voice is a cloud tradeoff and must be explicit:** Deepgram receives mic audio; ElevenLabs receives reply text. The never-leaves-the-machine rule (journals, health, faith) therefore applies to the *voice output path*: replies containing journal/health content are not sent to TTS (spoken as "answer's on screen" instead). Local fallbacks (whisper.cpp STT, macOS `say`) are a settings toggle for fully-local mode.
- API keys in `config/voice-app.conf` (gitignored, 0600), main-process only, never logged.
- App telemetry: none.
- The app adds **no new network listeners** (unlike voice_server, it's outbound-only).

## 11. Rollout

Phases 1–7 per `JARVIS-V2-PLAN.md`, each independently shippable, each ending with its done-when criterion demonstrated live. New-job checklist (watchdog + /status + README) applies if any phase adds a launchd job.

## 12. Open questions (answer before Phase 1 code)

1. App location: new repo or `app/` inside this repo? (Default: `app/` here — one project home rule.)
2. Hotkey for push-to-talk? (Default: hold `⌥Space`.)
3. Should Telegram `/task` and app tasks share the same Backlog section? (Default: yes — one backlog.)
