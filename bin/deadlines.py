#!/usr/bin/env python3
"""Single source of truth for the one-track deadlines (Thesis → BSS Sep 13 → Agora Oct beta).
Imported by dashboard.py (tiles) and briefing_build.py (countdown line + top-3 weighting) —
when a date moves, change it HERE and nowhere else."""
from datetime import date

THESIS = date(2026, 9, 30)
BSS = date(2026, 9, 13)
AGORA = date(2026, 10, 1)
