# Decision Log

Why Jarvis is built the way it is. Each entry: the call, the reason, what was rejected. New significant decisions get appended here — this file is the memory a fresh session can't get from code alone.

## 2026-07-07 — v1 architecture

**Full 13-role org, not a lean 6-agent team.** Jay's explicit call, overriding Claude's lean recommendation. Mitigation: idle roles cost nothing until summoned; only the night shift consumes tokens on schedule.

**Draft-and-ratify, never auto-decide.** Agents prepare decisions (Recommendation/Why/Cost/Deadline) into the Decision Inbox; Jay ticks Approve. Rejected: "auto-decide small, escalate big" — blast radius and trust weren't worth the minutes saved. Unattended agents may write ONLY inside the vault: no sends, no commits/pushes, no deploys, no spend, no deletion of Jay's notes.

**Local Mac (launchd) runtime, not cloud routines.** Cloud agents can't touch the local vault — the whole system's ground truth. Cost: Mac must be awake at 02:00 (`sudo pmset repeat wakeorpoweron MTWRFSU 01:55:00`, still pending Jay). Cloud stays an option as Mac-off backup later.

**"24/7" = scheduled bursts, not a continuous loop.** A literal loop burns Max-plan limits idling and drifts unsupervised. Shifts: 02:00 work, 06:55 watchdog, 07:00 push, hourly snapshots, 21:00 sync — plus the always-on Telegram bot for on-demand.

**Night shift caps at ≤3 backlog items, one-track order.** Thesis → BSS (Sept 13) → Agora beta → funding → growth. Off-track items get skipped with a reason. Empty backlog → 3-line briefing, stop. Token discipline is a feature, not a limitation.

**Telegram over iMessage for push (pivot).** iMessage-to-self sent without error but never surfaced on Jay's phone (handle/sync ambiguity — unresolved, not worth debugging). Telegram bot (@Jarvis_for_Jay_bot) proved delivery instantly AND doubles as the two-way pocket interface. iMessage remains a silent fallback in `briefing_push.sh`.

**Bot answers ONLY Jay's chat_id.** The bot is publicly findable; any other chat is logged and ignored. The bot never initiates external contact — it replies to Jay and writes to the vault.

**Vault snapshots are local-only by design.** `~/.jarvis-vault-backup.git` (bare, outside iCloud) — because journals/health/faith content must never leave the machine. Only the 7 curated files (CLAUDE, GOALS, operating-core, Toolbox, Company OS, Briefing, Decision Inbox) sync to GitHub → claude.ai. Rejected: pushing full vault to a private GitHub repo — private ≠ on-machine.

**Excludes live in `$GIT_DIR/info/exclude`, not pathspecs.** Git's `:!**` pathspec glob silently failed to exclude nested dirs; repo-level ignore patterns match at any depth reliably. Also: iCloud can evict files (dataless) and crash `git add` — snapshot script triggers `brctl download` and retries next hour instead of failing loudly at 3am.

**Vault lives in Obsidian's own iCloud container.** `iCloud~md~obsidian/Documents/` — the only location iOS Obsidian auto-detects. `~/Documents/J's AI Brain` is a symlink into it so every script/agent path keeps working. History: the vault spent a day duplicated (local + generic iCloud Drive) and diverged; the symlink pattern ended that class of bug.

**One project home: `~/Documents/Jarvis`.** All scripts/plists/configs consolidated from 4 hidden dirs; plist sources are versioned, `install.sh` deploys them. Rule: never edit `~/Library/LaunchAgents` directly. Secrets in `config/` (gitignored); repo pushed private (github.com/JayLakhani2002/jarvis) with token verified absent.

**Jarvis features never outrank the one track.** Tool-collecting is Jay's documented procrastination pattern (vault CLAUDE.md). Tier-2 features wait until thesis runs ≥20h/wk sustained. Any feature request mid-crunch gets the trade-off flagged once, then Jay decides.

## 2026-07-07 — earlier same day, context layer

**operating-core.md is the model-agnostic behavior layer.** Loaded via vault CLAUDE.md pointer + claude.ai Project files + this repo's CLAUDE.md. Precedence: Jay live > CLAUDE.md identity > operating-core. Includes §0 read-the-ask (restate intent, sharpen weak prompts) and §0.5 skill routing (route via the vault's Claude Toolbox, weighed against the one track).

**Brain graph must stay one connected component.** 🧠 HOME is the hub; automations self-link their outputs (shift reports, monthly Quick Capture) so no note is born an orphan. Verified 85 notes / 0 orphans / 1 component at ship time.

## 2026-07-07 — v1.1, market radar + weekly review draft

**Market radar uses arbeitnow.com's free API, not firecrawl/Apify.** The roadmap suggested firecrawl/Apify, but both need API keys/credits in an unattended launchd job; arbeitnow is keyless, JSON, covers German postings, and stdlib-python parses it — zero new dependencies or secrets. Trade-off accepted: it's a ~1500-posting sample, not exhaustive LinkedIn/Indeed coverage — good enough for trend + top-companies signal. Revisit Apify if the sample proves too thin. Radar runs 01:30 so numbers are fresh for the 02:00 shift; note keeps a 90-day trend table and self-links to [[🧠 HOME]].

**Weekly review is drafted, never written, by the machine.** `weekly_brain_sync.sh` ends with a `claude -p` call that writes `06 Company/Drafts/Weekly Review Draft <date>.md` from the week's Quick Capture, journals, and GOALS. Unknown numbers are written as "?? (fill in)" — the agent must not invent habit data. Jay edits ~5 min and ratifies; the draft-only boundary holds.

## 2026-07-08 — v1.2, Tier 2 opened + night shift paused

**Night shift paused by Jay's explicit call, mechanism = `launchd/disabled/`.** Jay ordered the 02:00 run held until he picks its project. Pattern: paused plists move to `launchd/disabled/`; `install.sh` unloads them, watchdog and `/status` check the marker and stay silent instead of false-alarming daily. Re-enable is a `git mv` + `./install.sh`.

**Tier 2 gate waived by founder.** The ≥20h/wk thesis gate was Jay's own rule; he overrode it explicitly ("start working on tier 2"). Trade-off flagged once per protocol, then built. Vault RAG chosen first (voice round-trip needs his iOS hands).

**Vault RAG is fully local: Ollama + nomic-embed-text, index in `~/.jarvis-rag/` (0600, outside vault/git).** Same privacy rule as snapshots — embeddings of journals/health never leave the machine. Incremental by mtime; ~273 chunks over 86 notes. `ask` mode retrieves top-8 chunks and pipes them to `claude -p` for a cited answer. Rejected: cloud embedding APIs (privacy + new secret) and pip/torch stacks (2GB dep for no gain).

**Python launchd jobs must exec via bash + `/opt/homebrew/bin/python3`.** `/usr/bin/python3` shims to Xcode's python, which has no TCC disk access under launchd — the telegram bot crash-looped with "Operation not permitted" after a reload. Bash is already TCC-approved (all bash jobs work), so python jobs run as `/bin/bash -c "exec /opt/homebrew/bin/python3 …"`.
