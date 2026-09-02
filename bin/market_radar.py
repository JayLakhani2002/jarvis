#!/usr/bin/env python3
"""Market radar — nightly scan of Berlin werkstudent postings.

Pulls the arbeitnow.com job-board API (free, no key), filters for
Berlin + werkstudent/working-student roles, and writes a stats note
into the vault so CMO/CTO agents cite real market data.
Draft-only boundary respected: writes into the vault, nothing leaves the machine.
"""
import json
import os
import re
import urllib.request
from collections import Counter
from datetime import datetime, date

VAULT = os.path.expanduser("~/Documents/J's AI Brain")
NOTE = os.path.join(VAULT, "06 Company", "(C) Market Radar.md")
API = "https://www.arbeitnow.com/api/job-board-api?page={}"
PAGES = 15  # ~1500 most recent postings

WS_RE = re.compile(r"werkstudent|working student|work(?:ing)?[- ]student", re.I)


# --- resilient vault I/O: iCloud can hold a vault file locked mid-sync (EDEADLK) for a few
# seconds — retry briefly instead of surfacing a transient lock as an error. (copied from
# email_triage.py so this job has no cross-file import dependency.)
def read_resilient(path):
    last = None
    for _ in range(8):
        try:
            with open(path) as f:
                return f.read()
        except FileNotFoundError:
            raise
        except OSError as e:
            last = e
            import time
            time.sleep(1)
    raise last


def fetch_jobs():
    jobs = []
    for page in range(1, PAGES + 1):
        req = urllib.request.Request(API.format(page), headers={"User-Agent": "jarvis-market-radar"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.load(r).get("data", [])
        except Exception as e:
            print(f"page {page} failed: {e}")
            break
        if not data:
            break
        jobs.extend(data)
    return jobs


def is_ws(j):
    hay = " ".join([j.get("title", ""), " ".join(j.get("job_types", []) or []), " ".join(j.get("tags", []) or [])])
    return bool(WS_RE.search(hay))


def main():
    today = date.today().isoformat()
    jobs = fetch_jobs()
    berlin = [j for j in jobs if "berlin" in (j.get("location") or "").lower()]
    ws_all = [j for j in jobs if is_ws(j)]
    ws_berlin = [j for j in berlin if is_ws(j)]
    remote_ws = sum(1 for j in ws_all if j.get("remote") or "remote" in [t.lower() for t in (j.get("tags") or [])])

    top_companies = Counter(j["company_name"] for j in ws_berlin).most_common(8)
    top_tags = Counter(t for j in ws_berlin for t in (j.get("tags") or [])).most_common(10)
    fresh = sorted(ws_berlin, key=lambda j: j.get("created_at", 0), reverse=True)[:10]

    stats_line = (f"| {today} | {len(jobs)} | {len(berlin)} | {len(ws_all)} | "
                  f"{len(ws_berlin)} | {remote_ws} |")

    # keep a rolling history table; rewrite header block, append today's row once
    history = []
    if os.path.exists(NOTE):
        for line in read_resilient(NOTE).splitlines():
            if re.match(r"^\| \d{4}-\d{2}-\d{2} \|", line) and not line.startswith(f"| {today} "):
                history.append(line.rstrip("\n"))
    history.append(stats_line)
    history = history[-90:]  # ~3 months of trend

    def bullets(items):
        return items if items else ["- none in sample"]

    lines = [
        "# (C) Market Radar — Berlin Werkstudent",
        "",
        "*Auto-updated nightly by `market_radar.py` (arbeitnow.com sample, last ~1500 postings).*",
        "*Part of [[🧠 HOME]] · serves [[(C) Company OS]] — CMO/CTO cite these numbers, they do not guess.*",
        "",
        f"## Latest scan — {today} {datetime.now().strftime('%H:%M')}",
        f"- Postings sampled: **{len(jobs)}** · Berlin: **{len(berlin)}**",
        f"- Werkstudent (all DE): **{len(ws_all)}** · **Berlin werkstudent: {len(ws_berlin)}** · remote-friendly WS: {remote_ws}",
        "",
        "### Top hiring companies (Berlin WS)",
        *bullets([f"- {c} ({n})" for c, n in top_companies]),
        "",
        "### Top tags / fields (Berlin WS)",
        *bullets([f"- {t} ({n})" for t, n in top_tags]),
        "",
        "### Freshest Berlin WS postings",
        *bullets([f"- [{j['title']}]({j.get('url','')}) — {j['company_name']}" for j in fresh]),
        "",
        "## Trend (daily)",
        "| date | sampled | Berlin | WS all | WS Berlin | WS remote |",
        "|---|---|---|---|---|---|",
        *history,
        "",
    ]
    os.makedirs(os.path.dirname(NOTE), exist_ok=True)
    with open(NOTE, "w") as f:
        f.write("\n".join(lines))
    print(f"radar written: {len(ws_berlin)} Berlin WS of {len(jobs)} sampled")


if __name__ == "__main__":
    main()
