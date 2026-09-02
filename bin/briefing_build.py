#!/usr/bin/env python3
"""Jarvis briefing builder (v1.8) — assembles the operator's ratified 07:00 "commander brief".

A deterministic, numbers-first, imperative brief (≤15 lines, operating-core.md style)
composed from vault sources that the night shift / other jobs already write. NO claude
call anywhere: every number is read straight from a file, so nothing is hallucinated and
the whole thing is unit-testable and free.

Design: one small parser per source, each wrapped so ANY exception omits just that line
(a broken source never kills the brief); compose() returns the final text. Every
empty/unavailable source OMITS its line — never a placeholder. Hard cap 15 lines; if over,
drop todos, then calendar, then radar (in that order).

Outputs: (a) prints the composed brief to stdout (briefing_push.sh sends this);
(b) also writes it as a self-pruning "## ⚡ 07:00 Brief (YYYY-MM-DD)" section inserted
directly under the note's H1 title, so /brief on Telegram leads with it.

Flags: --stdout-only  print the brief but do NOT touch the vault note (tests/preview).

Exit 0 with a best-effort partial brief even if several sources failed; exit 1 only if the
briefing note itself is unreadable/unwritable (so briefing_push.sh falls back to the raw note).
Stdlib only. App log: ~/Library/Logs/Jarvis/briefing_build.log."""
import os
import re
import sys
import time
import subprocess
import datetime

VAULT = os.path.expanduser("~/Documents/J's AI Brain")
BRIEFING = os.path.join(VAULT, "06 Company", "(C) Morning Briefing.md")
BACKLOG = os.path.join(VAULT, "06 Company", "(C) Backlog.md")
DECISION_INBOX = os.path.join(VAULT, "06 Company", "(C) Decision Inbox.md")
RADAR = os.path.join(VAULT, "06 Company", "(C) Market Radar.md")
LOG = os.path.expanduser("~/Library/Logs/Jarvis/briefing_build.log")  # outside ~/Documents (v1.5 TCC/iCloud rule)
ICALBUDDY = "/opt/homebrew/bin/icalBuddy"

TODAY = datetime.date.today()
TODAY_STR = TODAY.isoformat()
YESTERDAY = TODAY - datetime.timedelta(days=1)
# email triage's same-day drafts file (em dash matches email_triage.py exactly)
DRAFTS_FILE = os.path.join(VAULT, "06 Company", "Drafts", "Email Replies — %s.md" % TODAY_STR)

# --- Deadlines: shared with dashboard.py via bin/deadlines.py (single source of truth).
# Path insert so the import also works when this module is loaded by file path (tests/tools),
# not just when run as a script (where bin/ is already sys.path[0]). ---
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import deadlines as _dl
# Tracks, their dates, and their keyword sets all come from config/deadlines.json
# (gitignored operator data) via bin/deadlines.py — nothing personal is hardcoded here.
DEADLINES = [(t["label"], t["date"]) for t in _dl.TRACKS]
DEADLINE_BY_TRACK = dict(DEADLINES)

# keyword → track, tested case-insensitively; first track (in config order) whose keyword
# appears wins.
TRACK_KEYWORDS = [(t["label"], t["keywords"]) for t in _dl.TRACKS]

# daily-notes folder candidates probed for personal todos (none exist in the vault today;
# the todos line self-activates if the operator starts keeping dated daily notes in one of these).
DAILY_DIR_CANDIDATES = ["01 Daily", "00 Daily", "Daily", "Daily Notes", "Journal"]

MAX_LINES = 15

# self-pruning brief block: header line through its own planted "---" terminator. Bounded
# by that terminator (not "until next ##") because the block is inserted mid-note, above
# the note's own body — an until-next-## prune would eat the body. Non-greedy to the FIRST
# following "---" (the brief body never contains one).
BRIEF_BLOCK_RE = re.compile(r"\n## ⚡ 07:00 Brief \(\d{4}-\d{2}-\d{2}\)\n.*?\n---\n", re.S)


# --- resilient vault I/O -----------------------------------------------------
# iCloud can hold a vault file locked mid-sync (EDEADLK) for a few seconds. Copied from
# email_triage.py / dashboard.py so this job has no cross-script import dependency.
def read_resilient(path):
    """Retry on transient OSError; raise FileNotFoundError / the last OSError on failure.
    Used only for the briefing note write path, where a real failure must exit 1."""
    last = None
    for _ in range(8):
        try:
            with open(path) as f:
                return f.read()
        except FileNotFoundError:
            raise
        except OSError as e:
            last = e
            time.sleep(1)
    raise last


def write_resilient(path, content):
    last = None
    for _ in range(8):
        try:
            with open(path, "w") as f:
                f.write(content)
            return
        except OSError as e:
            last = e
            time.sleep(1)
    raise last


def read_text_or_empty(path):
    """Best-effort read for compose-time sources: '' on absence or persistent lock, so a
    transient failure omits that one line rather than failing the whole brief."""
    try:
        return read_resilient(path)
    except (FileNotFoundError, OSError):
        return ""


def read_lines_resilient(path):
    """Line-oriented best-effort read (mirrors dashboard.py) — [] on absence/lock."""
    for attempt in range(4):
        try:
            with open(path) as f:
                return f.readlines()
        except FileNotFoundError:
            return []
        except OSError:
            if attempt == 3:
                return []
            time.sleep(1)


def log(msg):
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a") as f:
        f.write("[%s] %s\n" % (datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg))


# --- shared parsing helpers --------------------------------------------------
def count_boxes_section(path, section):
    """Unchecked '- [ ]' boxes inside a '## <section>' block (mirrors dashboard.count_boxes)."""
    text = read_text_or_empty(path)
    m = re.search(r"## %s(.*?)(\n## |\Z)" % re.escape(section), text, re.S)
    body = m.group(1) if m else ""
    return len(re.findall(r"^\s*- \[ \]", body, re.M))


def quick_capture_path(d):
    """Same location dashboard.py reads: 01 Journals/2026 Journals/<M Month>/Quick Capture.md
    where the month is un-zero-padded (e.g. '7 July'), matching dashboard exactly."""
    return os.path.join(VAULT, "01 Journals", "2026 Journals",
                        "%d %s" % (d.month, d.strftime("%B")), "Quick Capture.md")


# --- source parsers (each returns a str line, a list of lines, or None/[]) ----
def header_line():
    return "⚡ JARVIS — %s %d" % (TODAY.strftime("%a %b"), TODAY.day)


def deadline_line():
    parts = []
    for name, dl in DEADLINES:
        parts.append("%s T-%dd" % (name, (dl - TODAY).days))
    return "🎯 " + " · ".join(parts)


def backlog_now_items():
    text = "".join(read_lines_resilient(BACKLOG))
    m = re.search(r"\n## Now \(one-track\)\n(.*?)(?=\n## |\Z)", text, re.S)
    if not m:
        m = re.search(r"\n## Now[^\n]*\n(.*?)(?=\n## |\Z)", text, re.S)
    if not m:
        return []
    items = []
    for line in m.group(1).splitlines():
        mm = re.match(r"\s*- \[ \] (.+)", line)
        if mm:
            items.append(mm.group(1).strip())
    return items


def match_track(raw):
    low = raw.lower()
    for track, kws in TRACK_KEYWORDS:
        if any(kw in low for kw in kws):
            return track
    return None


def clean_item(raw):
    """Drop the leading [role] tag so the line reads as an imperative task for the operator."""
    return re.sub(r"^\[[^\]]+\]\s*", "", raw).strip()


def top3_lines():
    """Deadline-weighted top 3: matched items sorted by their track's deadline (nearest
    first), ties keep backlog order; unmatched items follow in backlog order."""
    items = backlog_now_items()
    matched, unmatched = [], []
    for i, raw in enumerate(items):
        track = match_track(raw)
        if track:
            matched.append((DEADLINE_BY_TRACK[track], i, raw))
        else:
            unmatched.append(raw)
    matched.sort(key=lambda t: (t[0], t[1]))   # nearest deadline, then original order (stable)
    ordered = [t[2] for t in matched] + unmatched
    return ["%d. %s" % (i, clean_item(t)) for i, t in enumerate(ordered[:3], 1)]


def decision_line():
    n = count_boxes_section(DECISION_INBOX, "Pending")
    if n <= 0:
        return None
    return "📬 %d decision%s pending your ratification" % (n, "" if n == 1 else "s")


def health_rows():
    """Health lines from this + previous month's Quick Capture (dashboard.py's source)."""
    rows = []
    prev = TODAY.replace(day=1) - datetime.timedelta(days=1)
    for d in (prev, TODAY):
        p = quick_capture_path(d)
        if not os.path.exists(p):
            continue
        for line in read_lines_resilient(p):
            m = re.search(r"(\d{4}-\d{2}-\d{2}) Health —", line)
            if not m:
                continue
            row = {"date": m.group(1)}
            for key, pat in [("sleep", r"Sleep: ([\d.]+)"), ("steps", r"Steps: ([\d.]+)"),
                             ("workouts", r"Workouts: ([\d.]+)")]:
                mm = re.search(pat, line)
                row[key] = float(mm.group(1)) if mm else None
            rows.append(row)
    return rows


def habits_line():
    """Yesterday's logged habit numbers + current logged-day streak. Requires a row dated
    yesterday (the line is 'yesterday's'); self-activates once the iOS shortcut logs daily."""
    rows = health_rows()
    if not rows:
        return None
    by_date = {r["date"]: r for r in rows}
    y = by_date.get(YESTERDAY.isoformat())
    if not y:
        return None
    streak, d = 0, YESTERDAY
    while d.isoformat() in by_date:
        streak += 1
        d -= datetime.timedelta(days=1)
    parts = []
    if y.get("sleep") is not None:
        parts.append("%gh sleep" % y["sleep"])
    if y.get("steps") is not None:
        parts.append("%d steps" % int(y["steps"]))
    if y.get("workouts") is not None:
        parts.append("gym %d" % int(y["workouts"]))
    detail = " · ".join(parts) if parts else "logged"
    return "💪 Yesterday: %s · %dd streak" % (detail, streak)


def radar_line():
    """Latest Berlin-WS count + delta vs the previous scan (dashboard.radar_series parse)."""
    rows = []
    for line in read_lines_resilient(RADAR):
        m = re.match(r"^\| (\d{4}-\d{2}-\d{2}) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \|", line)
        if m:
            rows.append({"ws_all": int(m.group(4)), "ws_berlin": int(m.group(5))})
    if not rows:
        return None
    latest = rows[-1]
    if len(rows) >= 2:
        delta = latest["ws_berlin"] - rows[-2]["ws_berlin"]
        sign = "+%d" % delta if delta >= 0 else str(delta)
        return "📈 Berlin WS %d (%s vs prev) · %d DE-wide" % (latest["ws_berlin"], sign, latest["ws_all"])
    return "📈 Berlin WS %d · %d DE-wide" % (latest["ws_berlin"], latest["ws_all"])


def email_line():
    """Count headline (first content line) of the '## 📧 Inbox' section email_triage wrote
    into the note; append '(draft ready)' if today's reply-drafts file exists."""
    text = read_text_or_empty(BRIEFING)
    m = re.search(r"\n## 📧 Inbox[^\n]*\n(.*?)(?=\n## |\Z)", text, re.S)
    if not m:
        return None
    body = m.group(1).strip()
    if not body:
        return None
    headline = body.splitlines()[0].strip()
    if headline.startswith("📧"):
        headline = headline[1:].strip()
    line = "📧 " + headline
    if os.path.exists(DRAFTS_FILE):
        line += " (draft ready)"
    return line


def calendar_line():
    """Today's events via icalBuddy. Omit (and log once) on ANY failure or empty output —
    headless launchd has no Calendar TCC access until the operator's one-time manual grant (setup doc)."""
    if not os.path.exists(ICALBUDDY):
        log("calendar omitted: icalBuddy not installed at %s (brew install ical-buddy; see setup doc)" % ICALBUDDY)
        return None
    try:
        p = subprocess.run([ICALBUDDY, "-nc", "eventsToday"],
                           capture_output=True, text=True, timeout=10)
    except Exception as e:
        log("calendar omitted: icalBuddy error %s (needs one-time Calendar grant; see setup doc)" % type(e).__name__)
        return None
    out = (p.stdout or "").strip()
    if p.returncode != 0 or not out:
        log("calendar omitted: icalBuddy no output / nonzero exit (headless TCC? grant once — see setup doc)")
        return None
    titles = []
    for line in out.splitlines():
        if not line or line[0] in (" ", "\t"):   # indented lines are event details, not titles
            continue
        t = line.lstrip("•").strip()
        if t:
            titles.append(t)
    if not titles:
        return None
    shown = " · ".join(titles[:3])
    if len(titles) > 3:
        shown += " (+%d)" % (len(titles) - 3)
    return "📅 " + shown


def find_daily_note():
    """Today's (else newest) dated 'YYYY-MM-DD.md' note, at the vault root or in a daily
    folder. Returns None if no such convention exists (the todos line then omits)."""
    for base in [VAULT] + [os.path.join(VAULT, d) for d in DAILY_DIR_CANDIDATES]:
        if not os.path.isdir(base):
            continue
        today_note = os.path.join(base, TODAY_STR + ".md")
        if os.path.exists(today_note):
            return today_note
        dated = [fn for fn in os.listdir(base) if re.match(r"^\d{4}-\d{2}-\d{2}\.md$", fn)]
        if dated:
            return os.path.join(base, sorted(dated)[-1])
    return None


def todo_lines():
    note = find_daily_note()
    if not note:
        return []
    todos = []
    for line in read_lines_resilient(note):
        mm = re.match(r"\s*- \[ \] (.+)", line)
        if mm:
            todos.append("○ " + mm.group(1).strip())
            if len(todos) >= 2:
                break
    return todos


def live_jobs_health_line():
    """Fallback when there's no watchdog section today: same launchctl PID/exit parse the
    watchdog uses, reduced to a count (daemon with PID '-', exit 78, or other +ve exit = warn)."""
    jobs = ["telegrambot", "dailysync", "weeklysync", "vaultsnapshot", "briefingpush",
            "watchdog", "marketradar", "ragindex", "voiceserver", "dashboard",
            "emailtriage", "networth"]
    daemons = {"telegrambot", "voiceserver"}
    try:
        out = subprocess.run(["launchctl", "list"], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return None
    status = {}
    for line in out.splitlines():
        cols = line.split("\t")
        if len(cols) >= 3:
            status[cols[2].strip()] = (cols[0].strip(), cols[1].strip())
    warns, total = 0, 0
    for j in jobs:
        total += 1
        label = "com.jaysbrain.%s" % j
        if label not in status:
            warns += 1
            continue
        pid, ex = status[label]
        if j in daemons and pid == "-":
            warns += 1
            continue
        if ex == "78":
            warns += 1
            continue
        try:
            if int(ex) > 0:
                warns += 1
        except ValueError:
            pass
    if total == 0:
        return None
    if warns == 0:
        return "🩺 All %d jobs green" % total
    return "🩺 %d warning%s (see note)" % (warns, "" if warns == 1 else "s")


def system_health_line():
    """One-line health from today's watchdog section in the note; if absent, a live parse."""
    text = read_text_or_empty(BRIEFING)
    m = re.search(r"## 🩺 Watchdog \(%s\)(.*?)(?=\n## |\Z)" % re.escape(TODAY_STR), text, re.S)
    if m:
        body = m.group(1)
        warns = len(re.findall(r"^\s*- (?:⚠️|⛔)", body, re.M))
        if warns == 0 and "✅" in body:
            return "🩺 All jobs green"
        if warns > 0:
            return "🩺 %d warning%s (see note)" % (warns, "" if warns == 1 else "s")
    return live_jobs_health_line()


# --- compose -----------------------------------------------------------------
def _safe(name, fn, default):
    try:
        return fn()
    except Exception as e:
        log("source '%s' failed: %s: %s" % (name, type(e).__name__, e))
        return default


def compose():
    """Assemble the ordered brief, omit empty lines, enforce the 15-line cap."""
    sections = [
        ["header", [_safe("header", header_line, None) or ("⚡ JARVIS — %s" % TODAY_STR)]],
        ["deadlines", _as_lines(_safe("deadlines", deadline_line, None))],
        ["top3", _as_lines(_safe("top3", top3_lines, []))],
        ["decision", _as_lines(_safe("decision", decision_line, None))],
        ["habits", _as_lines(_safe("habits", habits_line, None))],
        ["radar", _as_lines(_safe("radar", radar_line, None))],
        ["email", _as_lines(_safe("email", email_line, None))],
        ["calendar", _as_lines(_safe("calendar", calendar_line, None))],
        ["todos", _as_lines(_safe("todos", todo_lines, []))],
        ["health", _as_lines(_safe("health", system_health_line, None))],
    ]

    def total():
        return sum(len(l) for _, l in sections)

    for dropkey in ("todos", "calendar", "radar"):   # drop order when over the cap
        if total() <= MAX_LINES:
            break
        for s in sections:
            if s[0] == dropkey:
                s[1] = []
    out = []
    for _, l in sections:
        out.extend(l)
    return "\n".join(out[:MAX_LINES])


def _as_lines(val):
    if val is None:
        return []
    if isinstance(val, list):
        return [x for x in val if x]
    return [val]


# --- vault note write (self-pruning, insert-after-title) ---------------------
def write_note_section(message):
    """Prune any prior brief block, then insert a fresh one directly under the note's H1."""
    text = read_resilient(BRIEFING)                 # raises → main() exits 1 (note unreadable)
    text = BRIEF_BLOCK_RE.sub("\n", text)           # idempotent: remove previous brief block(s)
    block = "## ⚡ 07:00 Brief (%s)\n%s\n\n---\n" % (TODAY_STR, message)
    m = re.search(r"^# .+$", text, flags=re.M)
    if m:
        idx = m.end()                               # just after the H1 title line
        new = text[:idx] + "\n\n" + block + text[idx:]
    else:
        new = block + "\n" + text                   # no title: prepend
    write_resilient(BRIEFING, new)


def main():
    stdout_only = "--stdout-only" in sys.argv[1:]
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    message = compose()
    print(message)
    if stdout_only:
        return 0
    try:
        write_note_section(message)
    except Exception as e:
        log("FATAL: briefing note unreadable/unwritable (%s: %s) — push will fall back to raw note"
            % (type(e).__name__, e))
        return 1
    log("brief composed (%d lines) and inserted into the Morning Briefing note" % len(message.splitlines()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
