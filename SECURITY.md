# Security Model

This repository automates an operator's personal knowledge base with LLM agents running
unattended on a schedule. That combination — autonomous agents, untrusted input, private
data — is where most of the interesting design decisions in this project live. This
document states the security model explicitly so it can be audited rather than assumed.

## 1. The draft-only boundary

**No unattended process may send, spend, deploy, publish, or push.**

Every scheduled job writes into the local knowledge vault and stops there. Anything with
an external effect — an email reply, a weekly review, a business decision — is written as
a *draft* into a review folder, and a human ratifies it before it leaves the machine.

This is enforced structurally, not by prompt instruction:

- Agents are invoked with restricted tool sets, not asked politely to behave.
- The email job opens IMAP with a read-only `SELECT` and `BODY.PEEK`, so it is incapable
  of sending, marking read, moving, or deleting mail at the protocol level.
- Decisions accumulate in a Decision Inbox for human ratification. Machines never decide.

The rationale: a capability that does not exist cannot be misused by a confused model, a
prompt injection, or a bug.

## 2. Untrusted input handling

Email bodies are attacker-controlled text. A message can contain instructions aimed at the
model that reads it. The triage job treats every inbox message as hostile:

- The classification call runs **single-turn with zero tools** (`--tools ''` plus
  `--strict-mcp-config`). Even a perfectly crafted injection has no tool to reach for.
- No file-edit permissions are granted to that invocation.
- Message fetches are capped (partial fetch) so a huge message cannot exhaust context or
  cost.

The general rule: content the operator did not write is never processed by an agent that
holds credentials or write access.

## 3. Secrets

- `config/` is gitignored in its entirety; only `config/*.example` templates are tracked.
- Real credentials are read from disk at runtime and are never logged, echoed, or included
  in error output.
- No secret has ever been committed to this repository. This is verifiable:

  ```bash
  git rev-list --all | while read c; do
    git grep -InE '([0-9]{8,10}:[A-Za-z0-9_-]{30,})|(sk-[A-Za-z0-9-]{20,})|(xox[baprs]-)' $c --
  done
  ```

  Expect zero output.

## 4. Data that never leaves the machine

Some categories of vault content are treated as strictly local:

| Data | Where it lives | Why local |
|---|---|---|
| Journals, health logs, private notes | Vault + a **bare local git repo** for snapshots | Never pushed to any remote, by design |
| Vault embeddings (RAG index) | `~/.jarvis-rag/`, mode `0600` | Embeddings of private notes are private notes |
| Financial CSVs and balances | `finance/`, gitignored | Bank data stays on disk; logs record derived counts only, never row contents |
| Generated dashboard HTML | `dashboard/`, gitignored | Embeds health and financial figures |

Only a small, explicitly curated set of files syncs to a private remote. "Private repo" was
rejected as a substitute for "on this machine" — they are not the same guarantee.

## 5. Network exposure

The voice server binds to the local network only and is **read-only by design**: it exposes
answer endpoints and no write, task, or send paths. A device on the LAN holding the shared
key can learn things; it can never change things.

Accepted risk, stated plainly: plain HTTP on a home LAN with a shared-key check. If this
ever answers off-network, the fix is a private overlay network (e.g. Tailscale), not port
forwarding.

## 6. Known limitations

Honesty is more useful than a clean bill of health:

- **Absolute paths are hardcoded** in the launchd plists and several scripts, including the
  operator's home directory name. This is a portability and privacy wart, and it has caused
  a real multi-day outage (documented in `DECISIONS.md`).
- **The LAN voice endpoint is unencrypted.** See above.
- **No automated secret scanning in CI.** The audit above is currently run manually.
- **This is single-operator software.** There is no multi-user authorization model because
  there is exactly one user.

## Reporting a vulnerability

This is a personal-infrastructure project, not a product with users at risk. If you find
something, please open a GitHub issue — or, if you would rather not disclose it publicly,
open an issue asking for a private contact and one will be provided.
