#!/usr/bin/env python3
"""Jarvis voice server — the Mac half of "Hey Siri, ask Jarvis" (Tier 2).

Tiny stdlib HTTP server on the LAN. The iOS Shortcut dictates a question,
POSTs it here, and speaks the reply. Read-only: answers come from the vault
via RAG + claude; nothing is written, sent, or executed on behalf of a caller.

Endpoints (all require the shared key from config/voice.conf):
  GET /health          → "ok" (Shortcut connectivity test)
  GET /brief           → Morning Briefing text (7am read-aloud Shortcut)
  GET /ask?q=...       → concise vault-grounded answer (Siri speaks it)
"""
import json
import os
import subprocess
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VAULT = os.path.expanduser("~/Documents/J's AI Brain")
BRIEFING = os.path.join(VAULT, "06 Company", "(C) Morning Briefing.md")
CONF = os.path.expanduser("~/Documents/Jarvis/config/voice.conf")
PORT = 8765

KEY = ""
for line in open(CONF):
    if line.startswith("VOICE_KEY="):
        KEY = line.split("=", 1)[1].strip()
assert KEY, "VOICE_KEY missing in config/voice.conf"


def answer(question):
    """RAG-grounded, speech-length answer."""
    rag = os.path.expanduser("~/Documents/Jarvis/bin/vault_rag.py")
    hits = subprocess.run(["/opt/homebrew/bin/python3", rag, "search", question, "6"],
                          capture_output=True, text=True, timeout=60).stdout
    claude = subprocess.run(["bash", "-lc", "command -v claude"], capture_output=True, text=True).stdout.strip() \
        or os.path.expanduser("~/.local/bin/claude")
    prompt = (f"You are Jarvis answering Jay BY VOICE — Siri will read this aloud. "
              f"Answer in at most 3 short spoken sentences, no markdown, no lists, no citations. "
              f"Use only these vault excerpts; if they don't contain the answer, say so briefly.\n\n"
              f"{hits[:6000]}\n\nQuestion: {question}")
    p = subprocess.run([claude, "-p", prompt, "--max-turns", "1"],
                       capture_output=True, text=True, timeout=120)
    return p.stdout.strip() or "Sorry, I couldn't produce an answer."


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, text):
        body = text.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(url.query)
        if q.get("key", [""])[0] != KEY:
            return self.reply(403, "forbidden")
        if url.path == "/health":
            return self.reply(200, "ok")
        if url.path == "/brief":
            try:
                text = open(BRIEFING).read()
            except OSError:
                return self.reply(404, "no briefing yet")
            return self.reply(200, text[:6000])
        if url.path == "/ask":
            question = q.get("q", [""])[0].strip()
            if not question:
                return self.reply(400, "missing q")
            try:
                return self.reply(200, answer(question))
            except Exception as e:
                return self.reply(500, f"jarvis error: {e}")
        return self.reply(404, "unknown endpoint")

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.client_address[0], fmt % args))


if __name__ == "__main__":
    print(f"voice server on 0.0.0.0:{PORT}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
