#!/usr/bin/env python3
"""Net-worth tracker (CFO) — Jay drops bank CSV exports into finance/inbox/; this daily job
parses each with a per-bank column mapping (config/banks.json), maintains a per-account +
monthly-history state file, and rewrites a marker-delimited Net-worth block inside the vault's
GOALS.md. Draft-only is sacred: it never sends, never spends, never touches anything in GOALS.md
outside its own markers, and writes nothing to GOALS until the first successful ingest. Bank data
stays out of logs (counts + derived balances only, never row contents). Stdlib only."""
import csv, json, datetime, os, re, shutil, sys

FIN = os.path.expanduser("~/Documents/Jarvis/finance")
INBOX = os.path.join(FIN, "inbox")
PROCESSED = os.path.join(FIN, "processed")
FAILED = os.path.join(FIN, "failed")
STATE = os.path.join(FIN, "state.json")
BANKS = os.path.expanduser("~/Documents/Jarvis/config/banks.json")
GOALS = os.path.expanduser("~/Documents/J's AI Brain/GOALS.md")
LOG = os.path.expanduser("~/Library/Logs/Jarvis/networth.log")  # outside ~/Documents: TCC/iCloud can poison log files (see README EX_CONFIG gotcha)

MARK_START = "<!-- jarvis:networth:start -->"
MARK_END = "<!-- jarvis:networth:end -->"


class FailedFile(Exception):
    """Raised when a CSV can't be ingested — moves the file to failed/ and forces exit 1."""


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


def write_resilient(path, content):
    last = None
    for _ in range(8):
        try:
            with open(path, "w") as f:
                f.write(content)
            return
        except OSError as e:
            last = e
            import time
            time.sleep(1)
    raise last


def log(msg):
    # counts + derived balances only — NEVER raw row contents from the bank exports
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a") as f:
        f.write(f"[{datetime.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}\n")


def money(v):
    """Plain English formatting — €12,345.67 (the vault is English, NOT German 12.345,67)."""
    return f"€{v:,.2f}"


# --- config / state --------------------------------------------------------
def load_banks():
    """Return (mapping_dict, None) or (None, reason) — distinguishes missing from invalid JSON."""
    try:
        raw = open(BANKS).read()
    except FileNotFoundError:
        return None, "missing"
    except OSError as e:
        return None, f"unreadable ({type(e).__name__})"
    try:
        d = json.loads(raw)
    except ValueError as e:
        return None, f"invalid JSON: {e}"
    if not isinstance(d, dict):
        return None, "not a JSON object"
    return d, None


def load_state():
    try:
        raw = read_resilient(STATE)
    except (FileNotFoundError, OSError):
        raw = None
    st = {}
    if raw:
        try:
            st = json.loads(raw)
        except ValueError:
            log("state.json corrupt — starting fresh")
            st = {}
    if not isinstance(st, dict):
        st = {}
    st.setdefault("accounts", {})
    st.setdefault("history", {})
    return st


def save_state(state):
    write_resilient(STATE, json.dumps(state, indent=2, ensure_ascii=False))


def pick_mapping(filename, banks):
    """First key whose 'match' substring is in the lowercased filename → (key, mapping)."""
    low = filename.lower()
    for key, m in banks.items():
        if not isinstance(m, dict):
            continue
        sub = (m.get("match") or "").lower()
        if sub and sub in low:
            return key, m
    return None, None


# --- number parsing --------------------------------------------------------
def parse_number(raw, decimal):
    """Strip currency symbols/whitespace, apply the bank's decimal convention, return float.
    decimal ',' = German (1.234,56 → strip dots, comma→dot); '.' = US (1,234.56 → strip commas)."""
    s = (raw or "").strip()
    s = re.sub(r"(?i)eur", "", s)
    s = re.sub(r"[€$£]", "", s)
    s = s.replace("\xa0", "").replace(" ", "").strip()
    if decimal == ",":
        s = s.replace(".", "").replace(",", ".")
    else:
        s = s.replace(",", "")
    if s in ("", "-", "+", ".", "-.", "+."):
        raise ValueError("empty/non-numeric")
    return float(s)


# --- per-file parse --------------------------------------------------------
def process_csv(path, mapping):
    """Return (balance, newest_date, parsed_count, skipped_count) or raise FailedFile."""
    date_col = mapping.get("date_col")
    date_fmt = mapping.get("date_fmt")
    amount_col = mapping.get("amount_col")
    balance_col = mapping.get("balance_col")
    decimal = mapping.get("decimal") or "."
    delim = mapping.get("delimiter") or ","
    if not date_col or not date_fmt:
        raise FailedFile("mapping missing date_col/date_fmt")
    if not balance_col and not amount_col:
        raise FailedFile("mapping has neither balance_col nor amount_col")

    enc = (mapping.get("encoding") or "utf-8")
    # utf-8-sig strips a leading BOM; fall back to the declared encoding otherwise. errors=replace
    # so a stray byte degrades a cell instead of crashing the whole file.
    open_enc = "utf-8-sig" if enc.lower() in ("utf-8", "utf8") else enc

    parsed = skipped = 0
    total = 0.0
    newest_date = None
    bal_at_newest = None
    try:
        with open(path, encoding=open_enc, errors="replace", newline="") as f:
            reader = csv.DictReader(f, delimiter=delim)
            if reader.fieldnames:  # getter consumes the header row once
                reader.fieldnames = [(h or "").strip().lstrip("\ufeff") for h in reader.fieldnames]
            for row in reader:
                dtxt = (row.get(date_col) or "").strip()
                try:
                    d = datetime.datetime.strptime(dtxt, date_fmt).date()
                except ValueError:
                    skipped += 1  # unparseable date → drop the row, keep going
                    continue
                if balance_col:
                    try:
                        val = parse_number(row.get(balance_col), decimal)
                    except (ValueError, TypeError):
                        skipped += 1
                        continue
                    # newest-dated row's balance IS the account balance; on a same-date tie the
                    # last such row in file order wins (>=).
                    if newest_date is None or d >= newest_date:
                        newest_date = d
                        bal_at_newest = val
                    parsed += 1
                else:
                    try:
                        amt = parse_number(row.get(amount_col), decimal)
                    except (ValueError, TypeError):
                        skipped += 1
                        continue
                    total += amt
                    if newest_date is None or d > newest_date:
                        newest_date = d
                    parsed += 1
    except (csv.Error, OSError, UnicodeError) as e:
        raise FailedFile(f"csv/decode error: {type(e).__name__}: {e}")

    if parsed == 0:
        raise FailedFile("zero parseable rows")
    if balance_col:
        balance = bal_at_newest
    else:
        start = mapping.get("starting_balance") or 0
        balance = float(start) + total
    return balance, newest_date, parsed, skipped


# --- file moves ------------------------------------------------------------
def move_to(path, dest_dir):
    """Move path into dest_dir; on a same-name collision suffix -1, -2, … Return final path."""
    os.makedirs(dest_dir, exist_ok=True)
    base = os.path.basename(path)
    target = os.path.join(dest_dir, base)
    if os.path.exists(target):
        root, ext = os.path.splitext(base)
        i = 1
        while os.path.exists(os.path.join(dest_dir, f"{root}-{i}{ext}")):
            i += 1
        target = os.path.join(dest_dir, f"{root}-{i}{ext}")
    shutil.move(path, target)
    return target


# --- GOALS.md block --------------------------------------------------------
def build_block(state):
    accounts = state["accounts"]
    history = state.get("history", {})
    total = sum(a["balance"] for a in accounts.values())
    as_ofs = [a["as_of"] for a in accounts.values() if a.get("as_of")]
    as_of = max(as_ofs) if as_ofs else "?"

    lines = [
        MARK_START,
        "## 📊 Net worth (Jarvis-tracked)",
        "*Auto-maintained by the networth job from bank CSV drops — edit anything outside the markers, never inside.*",
        "",
        f"**{money(total)} as of {as_of}**",
        "",
    ]
    for name in sorted(accounts):
        a = accounts[name]
        lines.append(f"- {name}: {money(a['balance'])} (as of {a.get('as_of', '?')})")
    lines += ["", "| Month | Total | Δ vs prev |", "|---|---|---|"]
    prev = None
    for m in sorted(history):
        t = history[m]["total"]
        if prev is None:
            delta = "—"
        else:
            d = t - prev
            delta = f"{'+' if d >= 0 else '-'}{money(abs(d))}"
        lines.append(f"| {m} | {money(t)} | {delta} |")
        prev = t
    lines.append(MARK_END)
    return "\n".join(lines)


def write_goals(block):
    """Replace strictly between markers if present; else append at file end with one blank line
    before. Everything outside the markers is preserved byte-for-byte."""
    try:
        text = read_resilient(GOALS)
    except FileNotFoundError:
        text = ""
    if MARK_START in text:
        start = text.index(MARK_START)
        # end marker must FOLLOW the start marker — an out-of-order/missing pair would make the
        # splice duplicate GOALS content. Corrupt pair → leave GOALS alone and say so.
        end = text.find(MARK_END, start)
        if end == -1:
            log("GOALS markers corrupt (no end marker after start) — GOALS left untouched, fix markers manually")
            return
        new = text[:start] + block + text[end + len(MARK_END):]
    elif text.strip():
        new = text.rstrip("\n") + "\n\n" + block + "\n"
    else:
        new = block + "\n"
    write_resilient(GOALS, new)


# --- main ------------------------------------------------------------------
def main():
    for d in (FIN, INBOX, PROCESSED, FAILED):
        os.makedirs(d, exist_ok=True)

    files = sorted(
        f for f in os.listdir(INBOX)
        if not f.startswith(".") and f.lower().endswith(".csv")
        and os.path.isfile(os.path.join(INBOX, f))
    )

    # DORMANT: empty inbox (with or without banks.json) → one line, exit 0 (watchdog stays quiet)
    if not files:
        log("networth dormant — inbox empty (drop bank CSVs into finance/inbox/; setup recipe in vault Drafts)")
        return 0

    banks, berr = load_banks()
    # Files present but no usable mapping config → real breakage. Leave the files in inbox so the
    # next run (after Jay fixes banks.json) ingests them; exit 1 so the watchdog flags it.
    if banks is None:
        log(f"networth: {len(files)} file(s) in inbox but banks.json {berr} — files left in place, nothing processed (setup recipe in vault Drafts)")
        return 1

    state = load_state()
    failures = 0

    for fname in files:
        src = os.path.join(INBOX, fname)
        key, mapping = pick_mapping(fname, banks)
        if mapping is None:
            move_to(src, FAILED)
            log(f"FAILED {fname}: no bank mapping matched → failed/")
            failures += 1
            continue
        account = mapping.get("account") or key
        try:
            balance, as_of, parsed, skipped = process_csv(src, mapping)
        except FailedFile as e:
            move_to(src, FAILED)
            log(f"FAILED {fname}: {e} → failed/")
            failures += 1
            continue
        except Exception as e:  # defensive: one weird file must never crash the whole job
            move_to(src, FAILED)
            log(f"FAILED {fname}: unexpected {type(e).__name__}: {e} → failed/")
            failures += 1
            continue

        mode = "balance" if mapping.get("balance_col") else "sum"
        state["accounts"][account] = {
            "balance": round(balance, 2),
            "as_of": as_of.isoformat(),
            "source": fname,
            "updated": datetime.datetime.now().isoformat(timespec="seconds"),
        }
        dest = move_to(src, PROCESSED)
        log(f"{account}: {mode} mode, {money(balance)}, {parsed} rows parsed, {skipped} skipped "
            f"(source {fname} → {os.path.basename(dest)})")

    accounts = state["accounts"]
    # Recompute THIS month's history as the sum of all current account balances — latest run wins
    # for the current month; past months are never rewritten (we only touch the current key).
    if accounts:
        month = datetime.date.today().strftime("%Y-%m")
        total = round(sum(a["balance"] for a in accounts.values()), 2)
        as_ofs = [a["as_of"] for a in accounts.values() if a.get("as_of")]
        as_of = max(as_ofs) if as_ofs else datetime.date.today().isoformat()
        state["history"][month] = {"total": total, "as_of": as_of}

    save_state(state)

    # GOALS.md written ONLY when state has ≥1 account — never touched on a run that leaves it empty.
    if accounts:
        try:
            write_goals(build_block(state))
            log(f"totals: {money(total)} across {len(accounts)} account(s); "
                f"{len(files) - failures} ingested, {failures} failed; GOALS block updated")
        except OSError as e:
            # Never clobber GOALS on a transient vault lock — skip the write, still report result.
            log(f"totals: {money(total)} across {len(accounts)} account(s); "
                f"GOALS update SKIPPED (vault I/O {type(e).__name__}: {e})")
    else:
        log(f"no accounts in state — GOALS untouched; {failures} file(s) failed")

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
