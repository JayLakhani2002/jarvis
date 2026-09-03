# Spec — Jarvis v3, Section 2: The Office

*Status: DRAFT — awaiting ratification. Companion to `JARVIS-V2-PRD.md`. Section 1 (the Jarvis shell) is specified separately.*

## Context

Jarvis today has an execution engine but no way to watch it work. `app/main.js:53` already
runs `@anthropic-ai/claude-agent-sdk` with a session that survives turns, and 84 agent
charters sit in `~/.claude/agents/` — but from the operator's side it is a text box that
goes quiet and eventually returns a wall of output. There is no answer to "who is working
on this, how far along are they, and what did they actually produce."

The Office is a top-down pixel-art floorplan, in the style of Gather.town, where those 84
agents are visible as characters in department rooms. A boss agent takes the operator's
prompt, writes a plan, and delegates to named specialists. Their status is legible at a
glance from where they sit and what glyph is on their name tag.

This is a working instrument, not a toy. The floorplan earns its place because 84 agents
in a card grid is a phone book, while 84 characters across furnished rooms is a map — the
spatial grouping does the work a list cannot.

## Current State (verified 2026-09-03)

| Fact | Evidence |
|---|---|
| Electron shell exists, Agent SDK wired | `app/main.js:53` imports `@anthropic-ai/claude-agent-sdk`, `app/package.json` pins `^0.3.211` |
| Session persists across turns | `app/main.js:18` holds `sessionId` |
| Renderer is small and additive-friendly | `app/renderer/app.js` 262 lines, `index.html` 99, `styles.css` 269 |
| Draft-only is actively enforced, not advisory | `app/guard.js:7` blocks `git push` / `git remote add` by regex |
| 84 agent charters | `~/.claude/agents/*.md` — engineering 49, security 10, project-management 8, product 5, C-suite + delivery 12 |
| 165 skill directories | `~/.claude/skills/*/` |
| Backend is healthy | 14 launchd jobs, all exit 0 as of 2026-09-03 |

## Ratified decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Extend the Electron app**, not a new web server | The agent runtime, vault access, and `guard.js` already live there. A browser page would need a new HTTP surface that can run Claude with the operator's credentials. |
| D2 | **All 84 agents, grouped by department** | Correct for a floorplan. My initial recommendation (13 core + on-demand) was right for a card grid and wrong for this layout — rooms absorb 84 characters without noise. |
| D3 | **Sandbox + diff approval** | Agents write freely inside a throwaway git worktree; nothing reaches a real branch until the operator approves a diff. Preserves draft-only where it matters without approving every keystroke. |
| D4 | **Spec everything, build Slice 1 now** | BSS is Sept 13. Slice 1 ships something real this week; Slice 2 needs no re-planning afterward. |

## What was missing from the original idea

These are the gaps that would have stalled implementation. Each is now decided.

1. **Concurrency cap.** 84 agents cannot run at once — cost and CPU both explode. Default
   **4 concurrent**, configurable. Everything else queues visibly, so the operator can see
   the backlog rather than wonder why nothing is happening.
2. **Cost budget.** Every agent run costs money (measured: ~$0.18 per judged call in
   `rag_eval.py`). The Office tracks spend per task and enforces a **per-task ceiling
   (default $2.00)** and a **daily ceiling (default $20)**. Hitting a ceiling pauses the
   queue and asks, rather than silently continuing to spend.
3. **The boss's plan must be a visible artifact.** Delegation that happens invisibly is
   indistinguishable from a hang. The plan renders as a card the operator can read and
   **reject before any worker spawns**.
4. **Task lifecycle.** `queued → planning → assigned → working → needs_review → done |
   failed | cancelled`. Anything else is unrepresentable.
5. **Interruption.** Every running agent has a stop control. An agent that cannot be
   killed is a bug, not a feature.
6. **Persistence.** Tasks survive restart in `~/.jarvis-office/tasks.db` (SQLite via
   `node:sqlite`, stdlib — no new dependency). The vault stays the source of truth for
   *outcomes*; the DB holds *run state*, which is machine bookkeeping and does not belong
   in an Obsidian note.
7. **Skill routing.** 165 skill directories cannot all be handed to every agent. The boss
   names the skills a task needs in its plan; the worker is spawned with only those.
8. **Failure semantics.** A worker that errors, times out (default 10 min), or returns
   unparseable output moves to `failed` with the reason on its card. It is never silently
   marked done — the same rule the eval harness already enforces.
9. **Art assets.** The reference is a licensed commercial product. See *Open question*.

## Architecture

```
Operator types a prompt in the Office
        │
        ▼
┌──────────────────────────────────────────────┐
│ BOSS — chief-of-staff, corner office         │
│ model: claude-fable-5-1                      │
│ Plans only. Never writes code, never edits.  │
│ Output: a strict JSON plan                   │
│   { summary, steps:[{agent, task, skills}] } │
└──────────────────────────────────────────────┘
        │  plan card rendered — operator approves or rejects
        ▼
┌──────────────────────────────────────────────┐
│ WORKERS — up to 4 concurrent                 │
│ model: claude-sonnet-5                       │
│ Spawned per step, scoped to named skills,    │
│ working inside a git worktree sandbox        │
└──────────────────────────────────────────────┘
        │
        ▼
   needs_review  →  operator reads output / diff  →  approve lands it, reject discards
```

**Boss cannot write.** It is spawned with planning tools only. A planner that can edit
files will eventually skip planning and just edit files.

**Spawn in-process via the Agent SDK, never by shelling out to `claude -p`.** Verified
live on 2026-09-03: both `claude-fable-5-1` and `claude-sonnet-5` respond correctly, but
CLI invocations run the operator's `UserPromptSubmit` hooks, and a failing hook silently
returns `"UserPromptSubmit operation blocked by hook"` **with exit code 0** — text that
looks like a model response. This was observed repeatedly during this session, caused by
claude-mem's memory observer failing 11 consecutive times (SIGKILL). An Office that
shelled out would have recorded those blocks as agent output. `app/main.js:53` already
uses the in-process SDK; the Office must stay on that path.

Regardless, every spawn result is validated before it is trusted — the same rule
`bin/rag_eval.py` enforces: a failed call is a failed *measurement*, never a result.

### Floorplan

| Room | Occupants | Count |
|---|---|---|
| Corner office | chief-of-staff (**the boss**) | 1 |
| Executive suite | ceo, cfo, cmo, coo, cto | 5 |
| Architecture | principal-architect, solution-architect | 2 |
| Engineering floor (6 pods) | `engineering-*` | 49 |
| Security wing | `security-*` | 10 |
| Project management | `project-management-*`, `project-manager*` | 8 |
| Product | `product-*` | 5 |
| Delivery | developer, deployer, tester, research-analyst | 4 |
| Lounge | idle agents drift here; **the operator's avatar spawns here** | — |

Engineering's 49 split into pods so no room exceeds ~10 desks: Web, Infra/DevOps, Data,
Mobile, Platform/API, Specialty.

### Status vocabulary (on the name tag, as in the reference)

| Glyph | State |
|---|---|
| Green dot | idle, available |
| Amber pulse | working |
| "..." bubble | streaming output right now |
| Clipboard | `needs_review` — waiting on the operator |
| Red dot | failed |
| Grey | never used this session |

### Data model

```sql
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  prompt        TEXT NOT NULL,
  plan_json     TEXT,
  state         TEXT NOT NULL,      -- queued|planning|assigned|working|needs_review|done|failed|cancelled
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  cost_usd      REAL DEFAULT 0
);
CREATE TABLE steps (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  agent         TEXT NOT NULL,      -- charter filename, e.g. engineering-frontend-developer
  instruction   TEXT NOT NULL,
  skills_json   TEXT,               -- only these skills are exposed to the worker
  state         TEXT NOT NULL,
  output        TEXT,
  diff_path     TEXT,               -- worktree diff, when the step wrote files
  error         TEXT,
  cost_usd      REAL DEFAULT 0,
  started_at    INTEGER,
  ended_at      INTEGER
);
```

### IPC surface (`app/preload.js` additions)

| Channel | Direction | Payload |
|---|---|---|
| `office:submit` | renderer → main | `{ prompt }` → returns `taskId` |
| `office:approvePlan` | renderer → main | `{ taskId, approved }` |
| `office:approveStep` | renderer → main | `{ stepId, approved }` — lands or discards the diff |
| `office:cancel` | renderer → main | `{ taskId \| stepId }` |
| `office:state` | main → renderer | full state snapshot on change (push, not poll) |
| `office:stream` | main → renderer | `{ stepId, chunk }` for live output |

## Acceptance criteria

1. Submitting a prompt creates a task in `queued` and renders it within 200ms.
2. The boss runs on `claude-fable-5-1` and returns a plan validated against the JSON
   schema; an unparseable plan retries once, then the task moves to `failed` with the raw
   output shown. It is never silently dropped.
3. The plan renders as a card. **No worker spawns until the operator approves it.**
4. Approving spawns workers on `claude-sonnet-5`, at most 4 concurrent; the 5th shows
   `queued` on its card.
5. Each working agent's avatar sits in its department room with an amber pulse, and its
   name tag shows the truncated task.
6. Clicking an agent opens the side panel: charter name, model, current instruction,
   granted skills, live output, cost so far, and a Stop control.
7. Stop terminates the worker within 2 seconds and moves the step to `cancelled`.
8. A step that wrote files shows a diff; approving lands it on the real branch, rejecting
   discards the worktree. **No file reaches a tracked branch without an explicit approval.**
9. `guard.js` still blocks `git push` from every agent, boss included.
10. Killing and relaunching the app restores all task and step state from SQLite.
11. A task exceeding $2.00, or the day exceeding $20, pauses the queue and asks.
12. Timeouts (10 min default) move the step to `failed` with `error='timeout'`.
13. The floorplan renders all 84 agents at 60fps on the operator's Mac.
14. Self-checks pass; no new runtime dependency is added.

## Testing plan

| Layer | What | Count |
|---|---|---|
| Unit | plan-JSON validation, state machine transitions, concurrency gate, budget ceiling, cost accumulation | +8 |
| Integration | submit → plan → approve → spawn → needs_review → land; and the reject path discards the worktree | +3 |
| Manual | 84 avatars render, click-to-inspect, stop kills a live agent | checklist |

Follows the existing convention: `node app/office.js` runs assert-based self-checks, wired
into `npm test` alongside `guard.js`, `jobs.js`, `voice.js`.

## Slices

**Slice 1 — this week.** The office, live and read-only.

Procedurally drawn floorplan with all 84 agents in department rooms; stable seating;
room heat; empty state. Operator submits a prompt; boss plans on Fable 5.1; plan card
approve/reject; workers spawn on Sonnet 5 behind the concurrency cap; delegation beams;
live status glyphs and streaming output; desk artifacts on completion; the waiting line;
click-to-inspect side panel with a stop control; avatar walk; `⌘K` jump-to-agent; `⌘L`
list view; burn display (**showing** spend, not yet enforcing); SQLite persistence.

Output is read-only — **no file writing yet**. Every state transition is persisted from
day one, so Slice 2's scrubber is a read over data Slice 1 already wrote.

**Slice 2 — after Sept 13.** Worktree sandbox, diff viewer, land/discard, budget ceiling
*enforcement* with the pause-and-ask flow, skill-scoped spawning, time scrubber.

Slice 1 is genuinely useful alone: it makes the engine you already have visible and
controllable. Slice 2 is what lets it write code.

## Files reference

| File | Change |
|---|---|
| `app/office.js` | NEW — state machine, boss/worker spawning, concurrency, SQLite, self-checks |
| `app/roster.js` | NEW — reads `~/.claude/agents/*.md`, maps charters to rooms and desks |
| `app/renderer/office.js` | NEW — canvas floorplan renderer, avatars, name tags, side panel |
| `app/renderer/office.css` | NEW — panel and tag styling, theme-aware |
| `app/main.js` | Register the `office:*` IPC handlers |
| `app/preload.js` | Expose the `office:*` bridge |
| `app/renderer/index.html` | Add the Office section container |
| `app/package.json` | Add `office.js` to the `test` script |

## Rollback

The Office is additive: a new section, new files, new IPC channels. Rollback is reverting
the commit — nothing existing changes behavior. Slice 2's worktree work is contained to a
scratch directory that can be deleted wholesale.

## Effort

Slice 1: ~5h procedural floorplan renderer (rooms, furniture primitives, seating, camera)
+ ~2h motion and affordances (beams, room heat, artifacts, waiting line, avatar walk)
+ ~3h orchestration and state machine + ~2h IPC and side panel + ~1h persistence
+ ~1h `⌘K` / `⌘L` + ~1h self-checks ≈ **15h**.

Slice 2: ~3h worktree and diff viewer + ~2h budget enforcement + ~2h time scrubber
+ ~1h skill-scoped spawning ≈ **8h**.

The Slice 1 number went up from 11h because the departures above are real work. They are
also most of what makes this an instrument rather than a screensaver, so the trade is
worth naming explicitly rather than absorbing quietly.

## Out of scope

- The Jarvis shell design (Section 1) — specified separately.
- Voice control of the Office.
- Agents talking to each other. The boss fans out; workers do not negotiate.
- Multi-user. One operator.
- Running this off-machine.

## Art direction — procedural, not a tileset

**Decided: rooms are drawn procedurally on canvas from the roster data.** No purchased or
downloaded tileset.

This is not the cheap option, it is the correct one. The floorplan is a *function of*
`~/.claude/agents/` — 84 charters today, more tomorrow, with department counts that shift
whenever a charter is added. A hand-placed tileset map goes stale the moment the roster
changes and every new agent becomes a map-editing chore. Generating rooms from counts
means the office rebuilds itself and can never disagree with what is actually installed.

Style: flat-shaded top-down at a fixed 32px grid, muted desaturated palette with saturation
reserved for status (an amber pulse has to read instantly against the furniture), 1px
darker edges for depth. Furniture is a small set of drawing primitives — desk, chair,
monitor, plant, table, shelf, door — composed per room. No pixel-art dithering; flat shapes
at this scale read cleaner and stay sharp on a Retina display.

## Beyond the reference

Gather is built for humans who are present. This office is watched by one operator
supervising machines, so the following depart from the reference deliberately.

**Delegation beams.** When the boss assigns a step, an animated line travels from the
corner office to the worker's desk and fades. Gather has no delegation to show. This makes
the org chart *live* and answers "what just happened" without reading anything.

**Room heat.** Idle rooms sit dimmed; a room with active work brightens. With 84 agents,
this is the single most valuable affordance on the screen — you locate work by looking,
before reading a single name tag.

**Desk artifacts.** A finished step leaves a document on the desk; a failure leaves a red
folder. Output has a physical location, so `needs_review` is discoverable by scanning
rather than by opening a queue.

**The waiting line.** Queued steps stand in a literal line outside the boss's office. A
backlog you can see the length of is better than a number, and it makes the concurrency
cap self-explanatory rather than a setting you have to remember.

**Burn display.** A wall panel in the lobby shows today's spend against the daily ceiling.
Cost is the failure mode most likely to surprise an operator running 84 agents, so it gets
permanent screen real estate rather than a menu.

**Time scrubber.** A timeline along the bottom replays office state at any past moment —
who was working, what they produced, where it failed. Every state transition is already
persisted in SQLite, so this is a read over existing data, not new bookkeeping. Debugging
multi-agent behavior after the fact is otherwise close to impossible.

**Stable seating.** An agent's desk is deterministic — derived from a hash of its charter
filename, so it never moves between sessions. With 84 characters, a map you can learn is
worth more than one that packs optimally.

**Jump-to-agent.** `⌘K` opens a fuzzy search over all 84; selecting one pans the camera and
opens its panel. Spatial memory fails past a few dozen entities and hunting visually
through six engineering pods is not a feature.

**List view toggle.** `⌘L` swaps the floorplan for a dense sortable table. Honest
admission: a floorplan is excellent for glanceable status and bad for reading detail. When
you need to compare twelve outputs, you need rows. Both views read the same state.

**Your avatar walks.** Clicking an agent walks the operator's character there rather than
teleporting the camera. Purely cosmetic, roughly ten lines, and it preserves the feeling of
the reference without making you navigate manually to get work done.

**Empty state.** On first open, before any prompt, the boss stands in the corner office and
every agent is grey. A visibly staffed but idle office reads as ready. An empty room reads
as broken.
