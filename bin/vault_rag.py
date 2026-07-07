#!/usr/bin/env python3
"""Vault RAG — semantic search over the whole brain (Tier 2).

Local end to end: nomic-embed-text via Ollama (localhost:11434), index on disk
at ~/.jarvis-rag/ (OUTSIDE the vault and git — journals/health never leave the
machine). Incremental: only changed files re-embed.

Usage:
  vault_rag.py index                 rebuild/refresh the index (nightly job)
  vault_rag.py search "query" [k]    top-k chunks with sources
  vault_rag.py ask "question"        search + claude -p answer with citations
"""
import json
import os
import re
import subprocess
import sys
import urllib.request

VAULT = os.path.expanduser("~/Documents/J's AI Brain")
RAG_DIR = os.path.expanduser("~/.jarvis-rag")
INDEX = os.path.join(RAG_DIR, "index.json")
OLLAMA = "http://localhost:11434/api/embed"
MODEL = "nomic-embed-text"
SKIP_DIRS = {".obsidian", ".trash", ".git"}
CHUNK_CHARS = 1500


def embed(texts):
    """Batch-embed a list of strings → list of vectors."""
    body = json.dumps({"model": MODEL, "input": texts}).encode()
    req = urllib.request.Request(OLLAMA, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)["embeddings"]


def vault_files():
    for root, dirs, files in os.walk(VAULT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if f.endswith(".md"):
                yield os.path.join(root, f)


def chunk_file(path):
    """Split a note into ~CHUNK_CHARS pieces on heading/paragraph boundaries."""
    text = open(path, encoding="utf-8", errors="ignore").read()
    blocks = re.split(r"\n(?=#{1,6} )|\n\n+", text)
    chunks, cur = [], ""
    for b in blocks:
        if len(cur) + len(b) > CHUNK_CHARS and cur.strip():
            chunks.append(cur.strip())
            cur = b
        else:
            cur += "\n\n" + b
    if cur.strip():
        chunks.append(cur.strip())
    return [c for c in chunks if len(c) > 40]


def load_index():
    if os.path.exists(INDEX):
        return json.load(open(INDEX))
    return {"files": {}, "chunks": []}


def cmd_index():
    os.makedirs(RAG_DIR, mode=0o700, exist_ok=True)
    idx = load_index()
    seen = set()
    changed = 0
    for path in vault_files():
        rel = os.path.relpath(path, VAULT)
        seen.add(rel)
        mtime = os.path.getmtime(path)
        if idx["files"].get(rel) == mtime:
            continue
        idx["chunks"] = [c for c in idx["chunks"] if c["file"] != rel]
        pieces = chunk_file(path)
        if pieces:
            for i in range(0, len(pieces), 16):
                batch = pieces[i:i + 16]
                for text, vec in zip(batch, embed(batch)):
                    idx["chunks"].append({"file": rel, "text": text, "vec": vec})
        idx["files"][rel] = mtime
        changed += 1
    # drop deleted notes
    gone = set(idx["files"]) - seen
    if gone:
        idx["chunks"] = [c for c in idx["chunks"] if c["file"] not in gone]
        for g in gone:
            del idx["files"][g]
    json.dump(idx, open(INDEX, "w"))
    os.chmod(INDEX, 0o600)
    print(f"indexed: {changed} files changed, {len(gone)} removed, "
          f"{len(idx['files'])} files / {len(idx['chunks'])} chunks total")


def top_k(query, k=6):
    idx = load_index()
    if not idx["chunks"]:
        sys.exit("index empty — run: vault_rag.py index")
    qv = embed([query])[0]
    qn = sum(x * x for x in qv) ** 0.5

    def cos(v):
        dot = sum(a * b for a, b in zip(qv, v))
        n = sum(x * x for x in v) ** 0.5
        return dot / (qn * n) if n else 0.0

    scored = sorted(((cos(c["vec"]), c) for c in idx["chunks"]), key=lambda t: -t[0])
    return scored[:k]


def cmd_search(query, k=6):
    for score, c in top_k(query, k):
        print(f"\n— {c['file']}  ({score:.3f})")
        print(c["text"][:400].replace("\n", " "))


def cmd_ask(question):
    hits = top_k(question, 8)
    context = "\n\n".join(f"[Source: {c['file']}]\n{c['text']}" for _, c in hits)
    claude = subprocess.run(["bash", "-lc", "command -v claude"], capture_output=True, text=True).stdout.strip() \
        or os.path.expanduser("~/.local/bin/claude")
    prompt = (f"Answer Jay's question using ONLY these excerpts from his vault. "
              f"Cite sources as [[note name]]. If the excerpts don't contain the answer, say so.\n\n"
              f"{context}\n\nQuestion: {question}")
    out = subprocess.run([claude, "-p", prompt, "--max-turns", "1"], capture_output=True, text=True, timeout=180)
    print(out.stdout.strip() or out.stderr.strip())


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "index"
    if cmd == "index":
        cmd_index()
    elif cmd == "search":
        cmd_search(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 6)
    elif cmd == "ask":
        cmd_ask(sys.argv[2])
    else:
        sys.exit(__doc__)
