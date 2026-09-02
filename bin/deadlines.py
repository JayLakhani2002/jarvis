#!/usr/bin/env python3
"""Single source of truth for the one-track deadlines.

Tracks are OPERATOR DATA, not code, so they live in `config/deadlines.json` (gitignored).
Copy `config/deadlines.json.example` and edit it; when a date moves, change it THERE and
nowhere else. Consumers (dashboard.py tiles, briefing_build.py countdown + top-3
weighting) iterate TRACKS and never hardcode a track name.

Falls back to neutral placeholder tracks when unconfigured, so a fresh clone runs.
"""
import json
import os
from datetime import date

_CONF = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "config", "deadlines.json")

# label, ISO date, keywords matched against backlog items, dashboard blurb
_FALLBACK = [
    {"label": "TRACK A", "date": "2099-01-01", "keywords": ["track-a"], "note": "priority #1"},
    {"label": "TRACK B", "date": "2099-01-01", "keywords": ["track-b"], "note": "hard deadline"},
    {"label": "TRACK C", "date": "2099-01-01", "keywords": ["track-c"], "note": ""},
]


def _load():
    try:
        with open(_CONF, encoding="utf-8") as f:
            raw = json.load(f)
        if not isinstance(raw, list) or not raw:
            raise ValueError("deadlines.json must be a non-empty list")
    except (OSError, ValueError, json.JSONDecodeError):
        raw = _FALLBACK
    out = []
    for t in raw:
        try:
            out.append({
                "label": str(t["label"]),
                "date": date.fromisoformat(t["date"]),
                "keywords": [str(k).lower() for k in t.get("keywords", [])],
                "note": str(t.get("note", "")),
            })
        except (KeyError, TypeError, ValueError):
            continue          # skip a malformed entry, never crash a caller
    return out or [{"label": t["label"], "date": date.fromisoformat(t["date"]),
                    "keywords": t["keywords"], "note": t["note"]} for t in _FALLBACK]


TRACKS = _load()


def demo():
    assert TRACKS, "TRACKS must never be empty"
    for t in TRACKS:
        assert isinstance(t["date"], date)
        assert isinstance(t["keywords"], list)
        assert t["label"]
    # a malformed entry is skipped, not fatal
    import tempfile, importlib
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump([{"label": "OK", "date": "2030-01-02", "keywords": ["x"]},
                   {"label": "BAD", "date": "not-a-date"}], f)
        tmp = f.name
    global _CONF
    keep, _CONF = _CONF, tmp
    got = _load()
    _CONF = keep
    os.unlink(tmp)
    assert [t["label"] for t in got] == ["OK"], got
    print(f"deadlines.py: all checks pass ({len(TRACKS)} tracks loaded)")


if __name__ == "__main__":
    demo()
