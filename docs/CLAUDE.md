# CLAUDE.md — docs/

**Two kinds of file live here, and they are read completely differently.**

## Live, user-facing (keep it current)

- **`server.md`** — looking after the companion server, for the person who installed it: the `shockwave` command, backups, certificates, `.env`, troubleshooting. **Linked from the README** and written for a user, not a contributor — plain language, no internal file paths, no reasoning about why the code is shaped as it is. That's what `api/CLAUDE.md` is for, and the two describe the same system at different altitudes: if you change how the server is operated, both need looking at.

  It exists because the README's install has to stay three steps. Anything an operator needs *after* the install goes here rather than growing that section back.

  **Facts in it are load-bearing** — `MASTER_KEY` losing every secret, ports 80/443 in the cloud firewall, `rotate-cert` forcing re-approval. Verify against `api/` before editing, the same as anywhere else.

## Historical design records (do NOT read as current)

`cron-server.md` and `rebuild-postgres.md` are pre-implementation plans that have since **shipped**, and each still opens in the future tense — `rebuild-postgres.md` literally says *"design agreed, not started"* about a companion that has been running in production for many releases. Nothing in the codebase reads or links them; they are kept for the reasoning, not the shape.

| File | Written to plan | Now |
|---|---|---|
| `rebuild-postgres.md` | replacing the local SQLite store with an Express + Postgres companion holding all shared data and the master key | **shipped** — see `api/CLAUDE.md`. It also supersedes a `docs/companion.md` that no longer exists. |
| `cron-server.md` | moving scheduled runs off the desktop onto the companion, by extracting a shared `agent-core/` both hosts import | **shipped** — see "Cron" in `api/CLAUDE.md` and `agent-core/CLAUDE.md`. The desktop scheduler it planned to delete is gone. |

Where they and the CLAUDE.md files disagree, **the CLAUDE.md files win.** These describe an intended design; the deep docs describe what was built, including the places the plan turned out to be wrong. Some names in them never existed or have since changed (`cronScheduler.js`, `agentTokensExtension`, a global `dataDir`), so they're a poor place to look up a symbol.

**Read them for one thing only: why the split exists.** `cron-server.md`'s argument that the desktop agent runtime was "nearly pure" — that only the scratch dir, the event sink, and the custom tools were host-specific — is the reasoning behind the `AgentHost` interface, and it's more legible here than it is spread across the two hosts that now implement it.

**Don't add a third one.** New design work belongs in the deep doc for the area it changes, written in the present tense once it lands; that's the convention the rest of the repo follows, and it's why these two are the only plans here. If a plan needs to exist before the code does, it can live in a chat or an issue — a design doc that ships and then isn't deleted becomes a second, wrong source of truth, which is exactly what these were on their way to being.

A **user-facing** page is a different thing and this directory is the right home for one: `server.md` is the worked example. The test is who it's for. If a contributor reads it to understand the code, it belongs in a `CLAUDE.md` beside that code; if someone running Shockwave reads it to get something done, it belongs here and gets linked from the README.
