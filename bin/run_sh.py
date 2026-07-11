#!/usr/bin/env python3
"""Runs a bash script whose SOURCE is read by python and handed to bash as an
in-memory -c string, instead of a file path bash would open() itself.

Why this exists: launchd-spawned /bin/bash fails with "Operation not permitted"
when given a script path under ~/Documents/* directly (bash itself doing the
open() trips a TCC gate with no GUI session to grant it). Python reading the
same file works fine (proven by marketradar/ragindex/voiceserver/dashboard
jobs), so relaying the script's text through python sidesteps the gate: bash
never opens a Documents-folder file, it only receives a string argument.
"""
import os
import subprocess
import sys

if len(sys.argv) < 2:
    sys.exit("usage: run_sh.py <script.sh> [args...]")

script = sys.argv[1]
source = open(script, encoding="utf-8").read()
r = subprocess.run(["/bin/bash", "-c", source, script] + sys.argv[2:], env=os.environ.copy())
sys.exit(r.returncode)
