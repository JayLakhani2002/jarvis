#!/usr/bin/env python3
"""Jarvis dashboard (Tier 2) — one screen: habits, timeline, decisions, venture market.

JARVIS HUD skin: near-black slate surface, arc-reactor cyan, mono numerals,
glow-not-brightness for the sci-fi feel (series colors validated on #020617).
Self-contained HTML (inline CSS/SVG, system mono stack, no CDN — works offline)
at ~/Documents/Projects/Jarvis/dashboard/index.html. Contains health data → dashboard/
is gitignored; the voice server serves it on the LAN with key auth (/dash).
"""
import os
import re
import subprocess
import time
from datetime import date, datetime

VAULT = os.path.expanduser("~/Documents/J's AI Brain")
OUT = os.path.expanduser("~/Documents/Projects/Jarvis/dashboard/index.html")

# palette: series pair #08a4c7/#c17708 validated (six checks) on surface #020617
CSS = """
:root{--surface:#020617;--panel:rgba(8,22,41,.72);--line:#12314a;--line2:#1c4a6e;
--ink:#e6f7ff;--ink2:#8fb0c4;--accent:#67e8f9;--s1:#08a4c7;--s2:#c17708;
--good:#34d399;--warn:#fbbf24;--crit:#f87171}
*{box-sizing:border-box;margin:0}
body{background:var(--surface);color:var(--ink);padding:28px 24px;max-width:1100px;margin:0 auto;
font:15px/1.5 ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
background-image:radial-gradient(ellipse 90% 50% at 50% -10%,rgba(8,164,199,.14),transparent),
linear-gradient(rgba(18,49,74,.22) 1px,transparent 1px),
linear-gradient(90deg,rgba(18,49,74,.22) 1px,transparent 1px);
background-size:100% 100%,44px 44px,44px 44px}
header{display:flex;align-items:center;gap:14px;margin-bottom:6px}
.reactor{filter:drop-shadow(0 0 6px rgba(103,232,249,.55))}
@keyframes spin{to{transform:rotate(360deg)}}
.reactor .ring{transform-origin:24px 24px;animation:spin 14s linear infinite}
h1{font-size:19px;font-weight:600;letter-spacing:.34em;color:var(--accent);
text-shadow:0 0 12px rgba(103,232,249,.4)}
.sub{color:var(--ink2);font-size:12.5px;letter-spacing:.06em;margin-bottom:22px;overflow-wrap:anywhere}
.sub b{color:var(--ink);font-weight:500}
h2{font-size:12px;color:var(--accent);margin:26px 0 10px;letter-spacing:.28em;font-weight:600}
h2::before{content:"// "}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:4px;
padding:14px 16px;position:relative;transition:border-color .2s}
.card:hover{border-color:var(--line2)}
.card::before,.card::after{content:"";position:absolute;width:14px;height:14px;pointer-events:none}
.card::before{top:-1px;left:-1px;border-top:2px solid var(--accent);border-left:2px solid var(--accent);opacity:.65}
.card::after{bottom:-1px;right:-1px;border-bottom:2px solid var(--accent);border-right:2px solid var(--accent);opacity:.35}
.k{font-size:11px;color:var(--ink2);letter-spacing:.16em}
.v{font-size:32px;font-weight:650;margin:3px 0;letter-spacing:.02em}
.d{font-size:12.5px;color:var(--ink2)}
.ok{color:var(--good);text-shadow:0 0 10px rgba(52,211,153,.35)}
.warn{color:var(--warn);text-shadow:0 0 10px rgba(251,191,36,.35)}
.crit{color:var(--crit);text-shadow:0 0 10px rgba(248,113,113,.4)}
svg text{fill:var(--ink);font:11.5px ui-monospace,Menlo,monospace}
table{border-collapse:collapse;width:100%;font-size:13px}
td,th{padding:6px 10px;text-align:left;border-bottom:1px solid var(--line)}
th{color:var(--ink2);font-weight:500;font-size:11px;letter-spacing:.18em}
td:first-child{color:var(--ink)}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:8px;vertical-align:1px}
.dot.g{background:var(--good);box-shadow:0 0 6px var(--good)}
.dot.r{background:var(--crit);box-shadow:0 0 6px var(--crit)}
.dot.y{background:var(--warn);box-shadow:0 0 6px var(--warn)}
footer{color:var(--ink2);font-size:11px;letter-spacing:.1em;margin-top:26px;opacity:.7}
@media(prefers-reduced-motion:reduce){.reactor .ring{animation:none}}
@media(max-width:480px){.v{font-size:26px}body{padding:18px 14px}
.sub{font-size:10.5px;letter-spacing:.01em}h1{font-size:16px;letter-spacing:.22em}}
"""

REACTOR = """<svg class="reactor" width="34" height="34" viewBox="0 0 48 48" role="img" aria-label="Jarvis">
<circle cx="24" cy="24" r="21" fill="none" stroke="#0e3a52" stroke-width="2"/>
<g class="ring"><circle cx="24" cy="24" r="16" fill="none" stroke="#67e8f9" stroke-width="2.5"
stroke-dasharray="14 7" stroke-linecap="round"/></g>
<circle cx="24" cy="24" r="7" fill="#67e8f9" opacity=".22"/>
<circle cx="24" cy="24" r="4" fill="#67e8f9"/></svg>"""

GLOW = ('<filter id="glow" x="-30%" y="-30%" width="160%" height="160%">'
        '<feGaussianBlur stdDeviation="2.2" result="b"/>'
        '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>')


def read_lines_resilient(path):
    """iCloud can hold a vault file locked mid-sync (EDEADLK) for a few seconds —
    retry briefly instead of letting the whole render crash on a transient lock."""
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


def health_series():
    """Parse 'Health —' lines from this + previous month's Quick Capture."""
    rows = []
    for delta in ("-1m", ""):
        cmd = f"date {'-v-1m' if delta else ''} '+%m %B' | sed 's/^0//'"
        mon = subprocess.run(["bash", "-c", cmd], capture_output=True, text=True).stdout.strip()
        p = os.path.join(VAULT, "01 Journals", "2026 Journals", mon, "Quick Capture.md")
        if not os.path.exists(p):
            continue
        for line in read_lines_resilient(p):
            m = re.search(r"(\d{4}-\d{2}-\d{2}) Health —", line)
            if not m:
                continue
            row = {"date": m.group(1)}
            for key, pat in [("sleep", r"Sleep: ([\d.]+)"), ("steps", r"Steps: ([\d.]+)"),
                             ("rhr", r"RHR: ([\d.]+)"), ("hrv", r"HRV: ([\d.]+)"),
                             ("workouts", r"Workouts: ([\d.]+)")]:
                mm = re.search(pat, line)
                row[key] = float(mm.group(1)) if mm else None
            rows.append(row)
    return rows[-30:]


def radar_series():
    rows = []
    p = os.path.join(VAULT, "06 Company", "(C) Market Radar.md")
    if os.path.exists(p):
        for line in read_lines_resilient(p):
            m = re.match(r"^\| (\d{4}-\d{2}-\d{2}) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \|", line)
            if m:
                rows.append({"date": m.group(1), "ws_berlin": int(m.group(5)), "ws_all": int(m.group(4))})
    return rows[-30:]


def count_boxes(path, section=None):
    if not os.path.exists(path):
        return 0
    text = "".join(read_lines_resilient(path))
    if section:
        m = re.search(rf"## {section}(.*?)(\n## |\Z)", text, re.S)
        text = m.group(1) if m else ""
    return len(re.findall(r"^\s*- \[ \]", text, re.M))


def jobs_status():
    out = subprocess.run(["launchctl", "list"], capture_output=True, text=True).stdout
    jobs = ["telegrambot", "voiceserver", "watchdog", "briefingpush", "marketradar",
            "ragindex", "dailysync", "weeklysync", "vaultsnapshot", "dashboard"]
    paused = os.path.exists(os.path.expanduser(
        "~/Documents/Projects/Jarvis/launchd/disabled/com.jaysbrain.nightshift.plist"))
    rows = [(j, f"com.jaysbrain.{j}" in out) for j in jobs]
    return rows, paused


def sparkline(vals, w=280, h=58, color="var(--s1)", fmt="{:g}"):
    """Single-series glowing sparkline, direct label on the latest value."""
    pts = [(i, v) for i, v in enumerate(vals) if v is not None]
    if len(pts) < 2:
        return '<div class="d" style="padding:14px 0">▍AWAITING DATA</div>'
    lo = min(v for _, v in pts); hi = max(v for _, v in pts)
    span = (hi - lo) or 1
    n = len(vals) - 1 or 1
    xy = [(6 + x * (w - 64) / n, h - 10 - (v - lo) / span * (h - 24)) for x, v in pts]
    line = "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in xy)
    area = line + f" L{xy[-1][0]:.1f},{h - 6} L{xy[0][0]:.1f},{h - 6} Z"
    lx, ly = xy[-1]
    return (f'<svg width="{w}" height="{h}" role="img"><defs>{GLOW}</defs>'
            f'<path d="{area}" fill="{color}" opacity=".12"/>'
            f'<path d="{line}" fill="none" stroke="{color}" stroke-width="2" filter="url(#glow)" '
            f'stroke-linecap="round" stroke-linejoin="round"/>'
            f'<circle cx="{lx:.1f}" cy="{ly:.1f}" r="3.5" fill="{color}" filter="url(#glow)"/>'
            f'<text x="{lx + 8:.1f}" y="{ly + 4:.1f}">{fmt.format(pts[-1][1])}</text></svg>')


def tile(k, v, d, cls=""):
    return (f'<div class="card"><div class="k">{k}</div>'
            f'<div class="v {cls}">{v}</div><div class="d">{d}</div></div>')


def main():
    today = date.today()
    health = health_series()
    radar = radar_series()

    import deadlines as DL  # bin/deadlines.py — the one place deadline dates live
    tiles = ""
    for t in DL.TRACKS:
        name, dl = t["label"], t["date"]
        note = f"{dl:%b %d}" + (f" — {t['note']}" if t["note"] else "")
        days = (dl - today).days
        cls = "crit" if days < 30 else ("warn" if days < 60 else "ok")
        tiles += tile(name, f"T−{days}d", note, cls)

    pending = count_boxes(os.path.join(VAULT, "06 Company", "(C) Decision Inbox.md"), section="Pending")
    backlog = count_boxes(os.path.join(VAULT, "06 Company", "(C) Backlog.md"))
    tiles += tile("DECISION INBOX", pending, "pending your ratification", "warn" if pending else "ok")
    tiles += tile("BACKLOG OPEN", backlog, "unchecked items")
    week = [r for r in health if (today - date.fromisoformat(r["date"])).days <= 7]
    gym = sum(r["workouts"] or 0 for r in week)
    tiles += tile("GYM THIS WEEK", f"{int(gym)}/3", f"{len(week)} health days logged",
                  "ok" if gym >= 3 else "warn")

    sparks = ""
    for key, label, fmt in [("sleep", "SLEEP (H) — KEYSTONE #1", "{:.1f}"), ("steps", "STEPS / DAY", "{:.0f}"),
                            ("rhr", "RESTING HR (BPM)", "{:.0f}"), ("hrv", "HRV (MS)", "{:.0f}")]:
        vals = [r[key] for r in health]
        sparks += (f'<div class="card"><div class="k">{label}</div>{sparkline(vals)}'
                   f'<div class="d">{len([v for v in vals if v is not None])} logged days</div></div>')

    ws = [r["ws_berlin"] for r in radar]
    market = (f'<div class="card"><div class="k">TRACKED JOB POSTINGS — NIGHTLY SAMPLE</div>'
             f'{sparkline(ws, color="var(--s2)")}'
             f'<div class="d">{len(radar)} scans · latest {ws[-1] if ws else "—"} Berlin WS '
             f'/ {radar[-1]["ws_all"] if radar else "—"} DE-wide</div></div>')

    rows, paused = jobs_status()
    jobs_html = "".join(
        f'<tr><td>{j}</td><td class="{"ok" if up else "crit"}">'
        f'<span class="dot {"g" if up else "r"}"></span>{"ONLINE" if up else "OFFLINE"}</td></tr>'
        for j, up in rows)
    if paused:
        jobs_html += '<tr><td>nightshift</td><td class="warn"><span class="dot y"></span>PAUSED BY OPERATOR</td></tr>'

    track_line = " → ".join(f"{t['label']} {t['date']:%b %d}" for t in DL.TRACKS)
    now = datetime.now()
    doc = f"""<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>J.A.R.V.I.S.</title><style>{CSS}</style>
<header>{REACTOR}<h1>J.A.R.V.I.S.</h1></header>
<div class="sub">SYSTEMS BRIEF · <b id="clock">{now.strftime('%Y-%m-%d %H:%M')}</b><br>
ONE TRACK: {track_line}</div>
<div class="grid">{tiles}</div>
<h2>HABITS — LAST 30 LOGGED DAYS</h2><div class="grid">{sparks}</div>
<h2>VENTURE MARKET</h2><div class="grid">{market}</div>
<h2>AUTOMATION</h2><div class="card"><table>
<tr><th>SUBSYSTEM</th><th>STATE</th></tr>{jobs_html}</table></div>
<footer>RENDERED {now.strftime('%H:%M:%S')} · REGENERATES EVERY 30 MIN · DATA NEVER LEAVES THIS MACHINE</footer>
<script>setInterval(()=>{{document.getElementById("clock").textContent=
new Date().toLocaleString("sv-SE").slice(0,16)}},30000)</script>
"""
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, "w").write(doc)
    print(f"dashboard written: {OUT} ({len(doc)} bytes, {len(health)} health rows, {len(radar)} radar rows)")


if __name__ == "__main__":
    main()
