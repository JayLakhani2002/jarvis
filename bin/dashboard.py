#!/usr/bin/env python3
"""Jarvis dashboard (Tier 2) — one screen: habits, timeline, decisions, Agora market.

Generates a self-contained HTML file (inline CSS/SVG, no CDN, works offline) at
~/Documents/Jarvis/dashboard/index.html. Contains health data → dashboard/ is
gitignored and stays on the machine; the voice server serves it on the LAN with
key auth so the phone can see it too.
"""
import html
import os
import re
import subprocess
from datetime import date, datetime

VAULT = os.path.expanduser("~/Documents/J's AI Brain")
OUT = os.path.expanduser("~/Documents/Jarvis/dashboard/index.html")

# validated reference palette (dataviz skill) — roles, light/dark
CSS = """
:root{--surface:#fcfcfb;--card:#ffffff;--ink:#0b0b0b;--ink2:#52514e;--line:#e4e3df;
--s1:#2a78d6;--s2:#1baf7a;--good:#008300;--warn:#eda100;--crit:#e34948}
@media(prefers-color-scheme:dark){:root{--surface:#1a1a19;--card:#242422;--ink:#ffffff;
--ink2:#c3c2b7;--line:#3a3936;--s1:#3987e5;--s2:#199e70;--good:#3aa53a;--warn:#c98500;--crit:#e66767}}
*{box-sizing:border-box;margin:0}body{background:var(--surface);color:var(--ink);
font:15px/1.45 -apple-system,system-ui,sans-serif;padding:24px;max-width:1100px;margin:0 auto}
h1{font-size:20px;margin-bottom:2px}.sub{color:var(--ink2);font-size:13px;margin-bottom:20px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.k{font-size:12px;color:var(--ink2);text-transform:uppercase;letter-spacing:.04em}
.v{font-size:30px;font-weight:650;margin:2px 0}.d{font-size:13px;color:var(--ink2)}
.ok{color:var(--good)}.warn{color:var(--warn)}.crit{color:var(--crit)}
h2{font-size:14px;color:var(--ink2);margin:26px 0 10px;text-transform:uppercase;letter-spacing:.05em}
svg text{fill:var(--ink2);font:11px -apple-system,system-ui,sans-serif}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{padding:4px 8px;text-align:left;
border-bottom:1px solid var(--line)}th{color:var(--ink2);font-weight:500}
"""


def health_series():
    """Parse 'Health —' lines from this + previous month's Quick Capture."""
    rows = []
    for delta in ("-1m", ""):
        cmd = f"date {'-v-1m' if delta else ''} '+%m %B' | sed 's/^0//'"
        mon = subprocess.run(["bash", "-c", cmd], capture_output=True, text=True).stdout.strip()
        p = os.path.join(VAULT, "01 Journals", "2026 Journals", mon, "Quick Capture.md")
        if not os.path.exists(p):
            continue
        for line in open(p):
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
        for line in open(p):
            m = re.match(r"^\| (\d{4}-\d{2}-\d{2}) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \|", line)
            if m:
                rows.append({"date": m.group(1), "ws_berlin": int(m.group(5)), "ws_all": int(m.group(4))})
    return rows[-30:]


def count_boxes(path, section=None):
    if not os.path.exists(path):
        return 0
    text = open(path).read()
    if section:
        m = re.search(rf"## {section}(.*?)(\n## |\Z)", text, re.S)
        text = m.group(1) if m else ""
    return len(re.findall(r"^\s*- \[ \]", text, re.M))


def jobs_status():
    out = subprocess.run(["launchctl", "list"], capture_output=True, text=True).stdout
    jobs = ["telegrambot", "voiceserver", "watchdog", "briefingpush", "marketradar",
            "ragindex", "dailysync", "weeklysync", "vaultsnapshot", "dashboard"]
    paused = os.path.exists(os.path.expanduser(
        "~/Documents/Jarvis/launchd/disabled/com.jaysbrain.nightshift.plist"))
    rows = [(j, f"com.jaysbrain.{j}" in out) for j in jobs]
    return rows, paused


def sparkline(vals, w=280, h=56, color="var(--s1)", fmt="{:g}"):
    """Single-series SVG sparkline with direct label on the latest value."""
    pts = [(i, v) for i, v in enumerate(vals) if v is not None]
    if len(pts) < 2:
        return '<span class="d">not enough data yet</span>'
    lo = min(v for _, v in pts); hi = max(v for _, v in pts)
    span = (hi - lo) or 1
    n = len(vals) - 1 or 1
    xy = [(6 + x * (w - 60) / n, h - 8 - (v - lo) / span * (h - 20)) for x, v in pts]
    path = "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in xy)
    lx, ly = xy[-1]
    return (f'<svg width="{w}" height="{h}" role="img">'
            f'<path d="{path}" fill="none" stroke="{color}" stroke-width="2" '
            f'stroke-linecap="round" stroke-linejoin="round"/>'
            f'<circle cx="{lx:.1f}" cy="{ly:.1f}" r="4" fill="{color}"/>'
            f'<text x="{lx + 8:.1f}" y="{ly + 4:.1f}">{fmt.format(pts[-1][1])}</text></svg>')


def tile(k, v, d, cls=""):
    return (f'<div class="card"><div class="k">{k}</div>'
            f'<div class="v {cls}">{v}</div><div class="d">{d}</div></div>')


def main():
    today = date.today()
    health = health_series()
    radar = radar_series()

    deadlines = [("Thesis submit", date(2026, 9, 30), "priority #1 — protect 25h/wk"),
                 ("BSS application", date(2026, 9, 13), "hard deadline"),
                 ("Agora beta live", date(2026, 10, 1), "Wintersemester wave")]
    tiles = ""
    for name, dl, note in deadlines:
        days = (dl - today).days
        cls = "crit" if days < 30 else ("warn" if days < 60 else "ok")
        tiles += tile(name, f"{days}d", f"{dl.strftime('%b %d')} — {note}", cls)

    pending = count_boxes(os.path.join(VAULT, "06 Company", "(C) Decision Inbox.md"))
    backlog = count_boxes(os.path.join(VAULT, "06 Company", "(C) Backlog.md"))
    tiles += tile("Decision Inbox", pending, "pending your ratification", "warn" if pending else "ok")
    tiles += tile("Backlog open", backlog, "unchecked items")
    week = [r for r in health if (today - date.fromisoformat(r["date"])).days <= 7]
    gym = sum(r["workouts"] or 0 for r in week)
    tiles += tile("Gym this week", f"{int(gym)}/3", f"{len(week)} health days logged",
                  "ok" if gym >= 3 else "warn")

    sparks = ""
    for key, label, fmt in [("sleep", "Sleep (h) — keystone #1", "{:.1f}"), ("steps", "Steps/day", "{:.0f}"),
                            ("rhr", "Resting HR (bpm)", "{:.0f}"), ("hrv", "HRV (ms)", "{:.0f}")]:
        vals = [r[key] for r in health]
        sparks += (f'<div class="card"><div class="k">{label}</div>{sparkline(vals)}'
                   f'<div class="d">{len([v for v in vals if v is not None])} logged days</div></div>')

    ws = [r["ws_berlin"] for r in radar]
    agora = (f'<div class="card"><div class="k">Berlin werkstudent postings (nightly sample)</div>'
             f'{sparkline(ws, color="var(--s2)")}'
             f'<div class="d">{len(radar)} scans · latest {ws[-1] if ws else "—"} Berlin WS '
             f'/ {radar[-1]["ws_all"] if radar else "—"} DE-wide</div></div>')

    rows, paused = jobs_status()
    jobs_html = "".join(
        f'<tr><td>{j}</td><td class="{ "ok" if up else "crit"}">{"● running" if up else "○ NOT LOADED"}</td></tr>'
        for j, up in rows)
    jobs_html += f'<tr><td>nightshift</td><td class="warn">◐ paused by Jay</td></tr>' if paused else ""

    doc = f"""<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jarvis Dashboard</title><style>{CSS}</style>
<h1>🧠 Jarvis</h1><div class="sub">generated {datetime.now().strftime('%Y-%m-%d %H:%M')} ·
one track: Thesis → BSS Sept 13 → Agora Oct 1</div>
<div class="grid">{tiles}</div>
<h2>Habits — last 30 logged days</h2><div class="grid">{sparks}</div>
<h2>Agora market</h2><div class="grid">{agora}</div>
<h2>Automation</h2><div class="card"><table><tr><th>job</th><th>state</th></tr>{jobs_html}</table></div>
"""
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, "w").write(doc)
    print(f"dashboard written: {OUT} ({len(doc)} bytes, {len(health)} health rows, {len(radar)} radar rows)")


if __name__ == "__main__":
    main()
