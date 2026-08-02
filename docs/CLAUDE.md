# CLAUDE.md — docs/

**Historical design records. Do not read these as documentation of the current system.**

Both files here are pre-implementation plans that have since **shipped**, and each still opens in the future tense — `rebuild-postgres.md` literally says *"design agreed, not started"* about a companion that has been running in production for many releases. Nothing in the codebase reads or links them; they are kept for the reasoning, not the shape.

| File | Written to plan | Now |
|---|---|---|
| `rebuild-postgres.md` | replacing the local SQLite store with an Express + Postgres companion holding all shared data and the master key | **shipped** — see `api/CLAUDE.md`. It also supersedes a `docs/companion.md` that no longer exists. |
| `cron-server.md` | moving scheduled runs off the desktop onto the companion, by extracting a shared `agent-core/` both hosts import | **shipped** — see "Cron" in `api/CLAUDE.md` and `agent-core/CLAUDE.md`. The desktop scheduler it planned to delete is gone. |

Where they and the CLAUDE.md files disagree, **the CLAUDE.md files win.** These describe an intended design; the deep docs describe what was built, including the places the plan turned out to be wrong. Some names in them never existed or have since changed (`cronScheduler.js`, `agentTokensExtension`, a global `dataDir`), so they're a poor place to look up a symbol.

**Read them for one thing only: why the split exists.** `cron-server.md`'s argument that the desktop agent runtime was "nearly pure" — that only the scratch dir, the event sink, and the custom tools were host-specific — is the reasoning behind the `AgentHost` interface, and it's more legible here than it is spread across the two hosts that now implement it.

**Don't extend this directory.** New design work belongs in the deep doc for the area it changes, written in the present tense once it lands; that's the convention the rest of the repo follows, and it's why these two are the only files here. If a plan needs to exist before the code does, it can live in a chat or an issue — a design doc that ships and then isn't deleted becomes a second, wrong source of truth, which is exactly what these were on their way to being.
