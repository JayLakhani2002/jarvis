#!/usr/bin/env python3
"""RAG eval harness — turns "the vault search feels okay" into numbers that move.

Measures two things against a golden set (evals/goldens.json, gitignored because the
questions are vault-specific):

  RETRIEVAL  deterministic, free, no LLM. For each question, rank the SOURCE FILES the
             retriever surfaced and check where the known-correct file lands.
               hit@k  fraction of questions with >=1 gold source in the top k files
               MRR    mean of 1/rank of the FIRST gold source (0 if absent)
  ANSWER     optional LLM judge. Generates an answer from the retrieved context, then
             grades it reference-guided against the gold sources.

Retrieval and answer quality are reported separately on purpose: a bad answer caused by
bad retrieval is a different bug from a bad answer despite good retrieval.

Usage:
  rag_eval.py                     retrieval + judge, writes a timestamped report
  rag_eval.py --retrieval-only    skip the judge (fast, free, fully deterministic)
  rag_eval.py --fail-under 0.70   exit 1 if hit@5 falls below this (for CI)
  rag_eval.py --limit 2           only the first N goldens (cheap judge smoke test)
  rag_eval.py --selftest          built-in checks, touches nothing
"""
import json
import os
import subprocess
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GOLDENS = os.path.join(ROOT, "evals", "goldens.json")
RESULTS = os.path.join(ROOT, "evals", "results")
K_VALUES = (1, 3, 5)
RETRIEVE_K = 10          # chunks pulled before collapsing to files
JUDGE_TIMEOUT = 180


# ---------- retrieval scoring (pure, no I/O — this is what the self-check exercises) ----------

def ranked_files(hits):
    """Chunk hits -> file ranking, best rank per file, order preserved.

    top_k returns CHUNKS and one file can own several of them; a file that appears
    three times is still one retrieved document, so collapse before ranking.
    """
    seen, out = set(), []
    for _score, chunk in hits:
        f = chunk["file"]
        if f not in seen:
            seen.add(f)
            out.append(f)
    return out


def first_gold_rank(files, gold):
    """1-based rank of the first gold source, or None. Gold sources are equally
    acceptable (known-item retrieval), so the earliest one wins."""
    gold = set(gold)
    for i, f in enumerate(files, 1):
        if f in gold:
            return i
    return None


def score_one(files, gold):
    rank = first_gold_rank(files, gold)
    return {
        "rank": rank,
        "rr": (1.0 / rank) if rank else 0.0,
        "hit": {k: bool(rank and rank <= k) for k in K_VALUES},
        "found": [f for f in files if f in set(gold)],
    }


def aggregate(rows):
    n = len(rows) or 1
    return {
        "n": len(rows),
        "mrr": round(sum(r["retrieval"]["rr"] for r in rows) / n, 3),
        # rate AND count: a bare percentage implies more precision than n=20 supports
        **{f"hit@{k}": f"{sum(r['retrieval']['hit'][k] for r in rows)}/{len(rows)}"
           for k in K_VALUES},
    }


# ---------- answer generation + judge ----------

def claude_bin():
    p = subprocess.run(["bash", "-lc", "command -v claude"],
                       capture_output=True, text=True).stdout.strip()
    return p or os.path.expanduser("~/.local/bin/claude")


# The judge and the answerer both run with NO tools: they only ever read text we hand
# them, so any tool access would be capability they cannot need — same posture as the
# email triage job.
NO_TOOLS = ["--tools", "", "--strict-mcp-config", "--max-turns", "1"]

JUDGE_SCHEMA = json.dumps({
    "type": "object",
    "properties": {
        "reasoning": {"type": "string"},
        "faithful_to_context": {"type": "boolean"},
        "verdict": {"type": "string", "enum": ["correct", "partial", "incorrect"]},
    },
    "required": ["reasoning", "faithful_to_context", "verdict"],
})


# A CLI invocation can fail while still exiting 0 and printing something — a hook can
# refuse the prompt, or the harness can be run from inside another session. That text is
# NOT an answer, and grading it would quietly corrupt the run (and pay to do it). Treat
# any of these as a failed MEASUREMENT and return None so the caller can exclude the row.
CLI_FAILURE_MARKERS = ("operation blocked by hook", "Execution error",
                       "Invalid API key", "Credit balance is too low")


def run_claude(prompt, schema=None):
    """Returns (text_or_dict_or_None, cost_usd). None means the call did not produce a
    usable result. With a schema, the CLI validates the shape server-side, so we read the
    parsed object instead of scraping free text."""
    cmd = [claude_bin(), "-p", prompt] + NO_TOOLS
    if schema:
        cmd += ["--output-format", "json", "--json-schema", schema]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=JUDGE_TIMEOUT)
    except subprocess.TimeoutExpired:
        return None, 0.0
    if out.returncode != 0:
        return None, 0.0
    if not schema:
        text = (out.stdout or out.stderr).strip()
        if not text or any(m in text[:400] for m in CLI_FAILURE_MARKERS):
            return None, 0.0
        return text, 0.0
    try:
        d = json.loads(out.stdout)
        return d.get("structured_output"), float(d.get("total_cost_usd") or 0.0)
    except (ValueError, TypeError):
        return None, 0.0


JUDGE_PROMPT = """You are grading one answer from a retrieval-augmented QA system.

Grade the SYSTEM ANSWER against the REFERENCE SOURCES, not your own outside knowledge.
If the retrieved context does not support the reference, that is a RETRIEVAL failure —
record it via faithful_to_context, do not punish the answer twice for it.

Verdict (choose exactly one):
  correct    - matches the reference's key facts, no material error
  partial    - some key facts missing, or one unsupported claim added
  incorrect  - contradicts the reference, or fails to answer the question

Do not reward length or fluency. A short correct answer beats a long padded one.
Do not penalise different wording that preserves meaning. An honest "the excerpts do
not contain this" is faithful_to_context=true and verdict=incorrect.

Reason through the comparison FIRST, then commit to the verdict.

QUESTION:
{q}

REFERENCE SOURCES (ground truth):
{gold}

RETRIEVED CONTEXT (what the system actually saw):
{ctx}

SYSTEM ANSWER:
{answer}"""


def judge(q, answer, gold_texts, ctx):
    """Reference-guided grading with a discrete verdict.

    Discrete over a 1-5 Likert scale deliberately: a single-turn judge's noise lives
    exactly between adjacent Likert points, and at n=20 that noise swamps the signal.
    Coarser, but reproducible run to run — which is the whole point of a trend line.

    Known limitation, not solved here: a Claude judge grading Claude-generated answers
    carries self-preference bias. Reference-guided grading is the available mitigation
    without a second model; it is reported, not eliminated.
    """
    prompt = JUDGE_PROMPT.format(q=q, answer=answer,
                                 gold="\n\n".join(gold_texts), ctx=ctx[:6000])
    cost = 0.0
    for attempt in (1, 2):                     # one retry: a flaky call is not a bad answer
        v, c = run_claude(prompt, schema=JUDGE_SCHEMA)
        cost += c
        if isinstance(v, dict) and "verdict" in v:
            return {"verdict": v["verdict"],
                    "faithful": bool(v.get("faithful_to_context")),
                    "reasoning": str(v.get("reasoning", ""))[:300],
                    "parsed": True, "cost_usd": round(cost, 6)}
    return {"verdict": None, "faithful": None, "reasoning": "judge_error after retry",
            "parsed": False, "cost_usd": round(cost, 6)}


def gold_text(rel_paths, vault, limit=4000):
    out = []
    for rel in rel_paths:
        try:
            with open(os.path.join(vault, rel), encoding="utf-8", errors="ignore") as f:
                out.append(f"[{rel}]\n{f.read()[:limit]}")
        except OSError as e:
            out.append(f"[{rel}] (unreadable: {e})")
    return out


# ---------- run ----------

def main(argv):
    retrieval_only = "--retrieval-only" in argv
    fail_under = None
    if "--fail-under" in argv:
        fail_under = float(argv[argv.index("--fail-under") + 1])
    # --limit exists so the (paid) judge path can be smoke-tested for cents
    limit = int(argv[argv.index("--limit") + 1]) if "--limit" in argv else None

    if not os.path.exists(GOLDENS):
        print(f"dormant: no golden set at {GOLDENS} "
              f"(copy evals/goldens.example.json and fill it in)")
        return 0                                    # dormant, not broken

    with open(GOLDENS, encoding="utf-8") as f:
        goldens = json.load(f)
    if not goldens:
        print("dormant: golden set is empty")
        return 0
    if limit:
        goldens = goldens[:limit]

    sys.path.insert(0, HERE)
    import vault_rag as R                           # imported late: needs Ollama up

    rows = []
    for g in goldens:
        files = ranked_files(R.top_k(g["q"], RETRIEVE_K))
        row = {"id": g["id"], "q": g["q"], "gold": g["sources"],
               "retrieved": files[:5], "retrieval": score_one(files, g["sources"])}

        if not retrieval_only:
            hits = R.top_k(g["q"], 8)
            ctx = "\n\n".join(f"[Source: {c['file']}]\n{c['text']}" for _, c in hits)
            answer, _ = run_claude(
                f"Answer the question using ONLY these excerpts. Cite sources as "
                f"[[note name]]. If the excerpts do not contain the answer, say so.\n\n"
                f"{ctx}\n\nQuestion: {g['q']}")
            row["answer"] = (answer or "")[:1500]
            if answer is None:
                row["judge"] = {"verdict": None, "faithful": None, "parsed": False,
                                "reasoning": "generation_error — not judged",
                                "cost_usd": 0.0}
            else:
                row["judge"] = judge(g["q"], answer, gold_text(g["sources"], R.VAULT), ctx)

        rows.append(row)
        mark = "✓" if row["retrieval"]["rank"] else "✗"
        print(f"  {mark} {g['id']}  rank={row['retrieval']['rank'] or '—'}  {g['q'][:58]}")

    summary = aggregate(rows)
    if not retrieval_only:
        judged = [r for r in rows if r["judge"]["parsed"]]
        summary["judged"] = f"{len(judged)}/{len(rows)}"
        summary["judge_errors"] = len(rows) - len(judged)
        if judged:
            for v in ("correct", "partial", "incorrect"):
                summary[v] = sum(r["judge"]["verdict"] == v for r in judged)
            summary["faithful"] = f"{sum(bool(r['judge']['faithful']) for r in judged)}/{len(judged)}"
        summary["cost_usd"] = round(sum(r["judge"]["cost_usd"] for r in rows), 4)
        summary["judge_caveat"] = "Claude judging Claude — self-preference bias mitigated by reference-guided grading, not eliminated"

    os.makedirs(RESULTS, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d_%H%M")
    path = os.path.join(RESULTS, f"{stamp}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"when": stamp, "summary": summary, "rows": rows}, f, indent=2)

    print("\n" + " · ".join(f"{k}={v}" for k, v in summary.items()))
    print(f"report: {path}")

    if fail_under is not None:
        hit5 = sum(r["retrieval"]["hit"][5] for r in rows) / (len(rows) or 1)
        if hit5 < fail_under:
            print(f"FAIL: hit@5 {hit5:.2f} < {fail_under}")
            return 1
    return 0


# ---------- self-check ----------

def selftest():
    hits = [(0.9, {"file": "a.md"}), (0.8, {"file": "a.md"}), (0.7, {"file": "b.md"})]
    assert ranked_files(hits) == ["a.md", "b.md"], "must dedupe files, keep best rank"

    assert first_gold_rank(["a.md", "b.md"], ["b.md"]) == 2
    assert first_gold_rank(["a.md"], ["z.md"]) is None
    # multiple gold sources: the earliest acceptable one sets the rank
    assert first_gold_rank(["a.md", "b.md", "c.md"], ["c.md", "b.md"]) == 2

    s = score_one(["a.md", "b.md", "c.md"], ["c.md"])
    assert s["rank"] == 3 and abs(s["rr"] - 1 / 3) < 1e-9
    assert s["hit"][1] is False and s["hit"][3] is True and s["hit"][5] is True

    miss = score_one(["x.md"], ["y.md"])
    assert miss["rr"] == 0.0 and not any(miss["hit"].values())

    agg = aggregate([{"retrieval": score_one(["a.md"], ["a.md"])},
                     {"retrieval": score_one(["x.md"], ["y.md"])}])
    assert agg["n"] == 2 and agg["mrr"] == 0.5 and agg["hit@1"] == "1/2"

    # a judge whose output cannot be parsed is excluded from the rate, never counted
    # as a pass — otherwise a broken judge would silently look like a perfect score
    rows = [{"judge": {"verdict": "correct", "parsed": True}},
            {"judge": {"verdict": None, "parsed": False}}]
    judged = [r for r in rows if r["judge"]["parsed"]]
    assert len(judged) == 1, "a judge_error row must be excluded, not counted as a pass"
    assert sum(r["judge"]["verdict"] == "correct" for r in judged) == 1

    # a blocked/failed CLI call must never be mistaken for a real answer
    for bad in ("UserPromptSubmit operation blocked by hook: ...", "", "   "):
        assert not bad.strip() or any(m in bad for m in CLI_FAILURE_MARKERS), \
            f"failure marker not detected in {bad!r}"

    print("rag_eval.py: all checks pass")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        sys.exit(main(sys.argv[1:]))
