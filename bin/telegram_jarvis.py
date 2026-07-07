#!/usr/bin/env python3
"""Pocket Jarvis — two-way Telegram bridge to the vault-grounded Claude on this Mac.
Long-polling daemon: only answers Jay's own chat_id; everything else is ignored.
Zero external dependencies (stdlib only)."""
import json, os, subprocess, time, urllib.request, urllib.parse, datetime

CONF = os.path.expanduser("~/Documents/Jarvis/config/telegram.conf")
VAULT = os.path.expanduser("~/Documents/J's AI Brain")
CLAUDE = os.path.expanduser("~/.local/bin/claude")
LOG = os.path.expanduser("~/Documents/Jarvis/logs/telegram_jarvis.log")
BACKLOG = os.path.join(VAULT, "06 Company", "(C) Backlog.md")
BRIEFING = os.path.join(VAULT, "06 Company", "(C) Morning Briefing.md")

PREAMBLE = (
    "You are Jarvis answering Jay via Telegram from his phone. Ground every answer in this vault "
    "(CLAUDE.md, GOALS.md, 06 Company/). Be blunt, concrete, numbers over adjectives, per operating-core.md. "
    "Keep replies under 300 words unless Jay asks for depth. You may read the vault and web, and write INSIDE "
    "the vault only. Never send anything anywhere, never commit/push, never spend. If a request needs a "
    "decision, add it to '06 Company/(C) Decision Inbox.md' in its entry format and say so.\n\nJay's message: "
)

def conf():
    d = {}
    for line in open(CONF):
        if "=" in line:
            k, v = line.strip().split("=", 1)
            d[k] = v
    return d

def log(msg):
    with open(LOG, "a") as f:
        f.write(f"[{datetime.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}\n")

def api(token, method, **params):
    url = f"https://api.telegram.org/bot{token}/{method}"
    data = urllib.parse.urlencode(params).encode()
    try:
        with urllib.request.urlopen(url, data, timeout=70) as r:
            return json.load(r)
    except Exception as e:
        log(f"api error {method}: {e}")
        return {"ok": False}

def send(token, chat_id, text):
    text = text.strip() or "(empty reply)"
    for i in range(0, len(text), 4000):  # Telegram 4096-char limit
        api(token, "sendMessage", chat_id=chat_id, text=text[i:i+4000])

def ask_claude(text):
    try:
        p = subprocess.run(
            [CLAUDE, "-p", PREAMBLE + text, "--permission-mode", "acceptEdits", "--max-turns", "25"],
            cwd=VAULT, capture_output=True, text=True, timeout=600,
        )
        out = p.stdout.strip()
        return out if out else f"(no output — stderr: {p.stderr.strip()[:300]})"
    except subprocess.TimeoutExpired:
        return "⏱ That took over 10 minutes and was stopped. Try a smaller ask."
    except Exception as e:
        return f"⚠️ Jarvis error: {e}"

def handle(token, chat_id, text):
    t = text.strip()
    if t.startswith("/start") or t.startswith("/help"):
        return send(token, chat_id,
            "🧠 Pocket Jarvis\n"
            "• any message → answered from the brain\n"
            "• /task <thing> → added to company Backlog (night shift picks it up)\n"
            "• /brief → current Morning Briefing\n"
            "• /search <query> → semantic search over the whole vault (RAG)\n"
            "• /status → are all systems running?")
    if t.startswith("/search"):
        q = t[7:].strip()
        if not q:
            return send(token, chat_id, "Usage: /search <query>")
        send(token, chat_id, "🔎 searching the brain…")
        p = subprocess.run(["/opt/homebrew/bin/python3", os.path.expanduser("~/Documents/Jarvis/bin/vault_rag.py"), "search", q, "4"],
                           capture_output=True, text=True, timeout=120)
        return send(token, chat_id, (p.stdout.strip() or p.stderr.strip())[:3900])
    if t.startswith("/task"):
        item = t[5:].strip()
        if not item:
            return send(token, chat_id, "Usage: /task <what you want done>")
        stamp = datetime.date.today().isoformat()
        content = open(BACKLOG).read()
        marker = "## Now (one-track)\n\n"
        content = content.replace(marker, f"{marker}- [ ] [via-telegram {stamp}] {item}\n", 1)
        open(BACKLOG, "w").write(content)
        return send(token, chat_id, f"✅ Added to Backlog:\n“{item}”\nNight shift or a day session will pick it up.")
    if t.startswith("/brief"):
        return send(token, chat_id, open(BRIEFING).read()[:3900])
    if t.startswith("/status"):
        jobs = subprocess.run(["launchctl", "list"], capture_output=True, text=True).stdout
        expected = ["dailysync","weeklysync","vaultsnapshot","watchdog","briefingpush","telegrambot","marketradar","ragindex"]
        if not os.path.exists(os.path.expanduser("~/Documents/Jarvis/launchd/disabled/com.jaysbrain.nightshift.plist")):
            expected.append("nightshift")
        loaded = [j for j in expected if f"com.jaysbrain.{j}" in jobs]
        note = "" if "nightshift" in expected else " (night shift paused by Jay)"
        return send(token, chat_id, f"🩺 {len(loaded)}/{len(expected)} jobs loaded: {', '.join(loaded)}{note}")
    send(token, chat_id, "🧠 thinking…")
    send(token, chat_id, ask_claude(t))

def main():
    c = conf()
    token, my_chat = c["TOKEN"], int(c["CHAT_ID"])
    offset = 0
    log("pocket jarvis started")
    while True:
        r = api(token, "getUpdates", offset=offset, timeout=60)
        if not r.get("ok"):
            time.sleep(10)
            continue
        for u in r.get("result", []):
            offset = u["update_id"] + 1
            m = u.get("message") or {}
            if m.get("chat", {}).get("id") != my_chat:
                log(f"ignored message from foreign chat {m.get('chat', {}).get('id')}")
                continue
            text = m.get("text", "")
            if not text:
                send(token, my_chat, "I only read text for now.")
                continue
            log(f"in: {text[:120]}")
            try:
                handle(token, my_chat, text)
            except Exception as e:
                log(f"handle error: {e}")
                send(token, my_chat, f"⚠️ error: {e}")

if __name__ == "__main__":
    main()
