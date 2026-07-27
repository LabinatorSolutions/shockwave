# Server-side cron — plan

Move **scheduled agent runs (cron) from the desktop to the companion server** so they run
even when no desktop is open. The desktop keeps the cron *UI*; the companion does the
*execution*. The agent turn-code is **shared, not duplicated**.

Supersedes the desktop-only "Scheduled runs (cron)" model. Builds on the Postgres companion
(`docs/rebuild-postgres.md`) and the shipped live-feed / running-flag work.

## Why this is tractable

The desktop agent runtime is **nearly pure**: settings, secrets, provider keys, and chat
persistence already go through the companion. Only three things are desktop-specific, and
they're already injected: pi's scratch-dir path, the event `emit` callback, and the
custom-tool handlers. The system-prompt build (`defaults/*`), tool catalog (`tools.ts`),
tool definitions (`agentTokensExtension`), model resolution (`modelCatalog.ts`), and the
pi boot/run body of `codingAgent.ts` have no Electron import.

`cronScheduler.js` / `cron.ts` are **NOT** in the shared set — they're the desktop's custom
catch-up scheduler, deleted at the end (the desktop has no cron). Scheduling is server-only.

## Architecture: one shared core, two host adapters

Extract a **`agent-core/`** (shared source dir at the repo root) that both the desktop
(`src/main`) and companion (`api/`) import. Both build systems bundle relative imports and
resolve `.js`→`.ts`, so no npm-workspaces restructure.

`agent-core` holds **everything that runs one turn** and **all the logic around it**:
- system-prompt assembly, tool catalog, custom-tool definitions, model resolution,
- pi session boot / resume / run, the event subscription,
- **the pi-message→row mapping**, the **upload-before-clear-running ordering**, resume
  (download transcript if the local copy is absent), auto-title, and the **steer decision**.

Crucial anti-drift rule: **all logic lives in the core; each host provides only dumb I/O.**
The mapping + ordering currently sit in the desktop's HTTP layer (`api/chats.ts`) — they
**move into the core**, so both hosts become pure I/O and can't diverge. Two guarantees:
one physical copy of the logic, and one shared TypeScript host-contract type — if the core
needs a new capability, *both* builds fail until both hosts implement it.

### Host contract

```ts
interface AgentHost {
  builtinDir: string;                       // bundled built-in skills
  machine: string;                          // running_machine / provenance stamp
  extraTools: ToolDefinition[];             // desktop: [open_file]; server: []
  // dumb persistence — the core does the mapping/ordering, the host just does I/O:
  getSession(id): Promise<Row | null>;
  upsertSession(row): Promise<void>;
  persistMessages(id, rows): Promise<number>;   // rows already mapped by the core
  setSessionTitle(id, title): Promise<void>;
  setRunning(id, machine | null): Promise<void>;
  getTranscript(id): Promise<string | null>;
  putTranscript(id, content): Promise<void>;
  // secrets for the agent-tokens tools:
  getAgentSecrets(): Promise<AgentSecret[]>;
  getToken(name): Promise<string>;          // static → stored token; oauth → fresh token
}
// The core's entry point. `emit` is per-call (desktop must follow window reloads);
// `agentDir` is per-call so the server can isolate each run (see "skills race" below).
runTurn(opts, { host, emit, agentDir }): Promise<void>
```

| Capability | Desktop host | Companion host |
|---|---|---|
| `emit(event)` | **IPC to the renderer AND POST to the companion feed** (one call, both sinks) | **direct in-process SSE fan-out** (the feed's subscriber map) |
| persistence | HTTP `api/chats` (now dumb — no mapping) | direct drizzle `store` calls |
| `getAgentSecrets` / `getToken` | HTTP `/settings` + desktop OAuth refresh | direct `store` + server-side OAuth refresh (Phase D) |
| `extraTools` | `[open_file]` | `[]` |
| `agentDir` | one global `<userData>/pi-agent` | **per-run** dir under the server data dir |

**`workspaceId` is passed in `opts`** — the core no longer calls `findWorkspaceByPath`
(that reads desktop machine-local state). The desktop resolves the id from its active
workspace; the server already knows it (it's iterating workspaces).

### Free synergy with the live feed

A server cron run is just another **producer**: its host `emit` fans events into the SSE
feed and it calls `setRunning(machine = "<companion host>")`, so the desktop **watches cron
runs live** over the existing SSE path, and cron chats appear in the list as `source: 'cron'`.
Consistent with the freeze rule: while a cron chat is running, the desktop composer is
**frozen** for it (you can't steer a cron run from the desktop — its live session lives on
the server).

## Server-side git — checkout + check-in (companion-only, not in the core)

The agent's cwd *is* the workspace — it reads `SOUL.md` / `AGENTS.md` / `.shockwave/skills/`
and can modify files. The core doesn't know about git; this is companion code. Two jobs,
plain `git` CLI. Pattern confirmed against `../knack`; adapted for pi + a long-lived server.

### Discovery — read `cron.json` over the API, never clone

The **refresh cron** (below) reads each workspace's root `cron.json` via the **GitHub
Contents API with ETag / `If-None-Match`** (a `304` is free — not rate-limited). The
workspace list is the Postgres `workspace` table. GitHub is the source of truth. No checkout
is involved in discovery.

### A job fires — fresh checkout per run, then check back in

1. **Fresh shallow clone** into a temp dir: `git clone --depth=1` with the PAT in the remote
   (`https://x-access-token:<sync.pat>@github.com/owner/repo.git`). The companion already
   stores `sync.pat`. (**Requires** that PAT to have access to every workspace repo.)
2. **Run the turn** through `agent-core` with `cwd = <checkout>`, a **per-run `agentDir`**
   under the server data dir (NOT under the checkout), `source:'cron'`, `unattended:true`,
   a fresh `sessionId`, and settings (provider/model/thinking) read from the store. This
   mints the `chat_session`, streams to the feed, and persists messages + transcript.
3. **Check-in — a separate step from the turn agent.** After the turn returns: `git add -A`;
   nothing changed → stop. Else commit (`Shockwave cron: <job> — <ISO>`), `git fetch`,
   `git merge --no-edit` if the remote moved, `git push HEAD:<default-branch>` (no PR).
   Transport errors retry ×2.
   - **Conflict recovery = a separate git-fixer agent.** On a real conflict or a still-
     rejected push, a *bounded* LLM tool-loop (single `run_git` tool, ~12-step cap) resolves
     markers / `--unshallow`s a missing merge base / aborts hopeless states / re-pushes. It's
     a *different* agent from the one that ran the turn. Success is gated by **independent
     verification** (re-check `git status` empty, no conflict markers, ahead-count 0) — never
     trust the model. Still failing → record `lastError`. Never throws.
4. **Delete the checkout and the per-run `agentDir`.** The transcript is already uploaded, so
   nothing is lost.

Running reflects the **turn** (chat), cleared at turn end; the git check-in is the async
post-step after that. Simpler than `syncEngine.ts` — no in-app conflict UI, no persistent
state, no watcher.

## Scheduler — croner, server-only

Library: **croner** (v10, MIT, zero-dep, Node ≥18). Chosen over node-cron for three built-ins
we need: `protect` (skip a fire while the same job's previous run is in progress — our
per-job dedup), timezone support, and per-job `stop()` (for non-destructive refresh).

Two crons:
- **Fire:** one croner job per `cron.json` entry, held in the long-lived process, `protect:
  true`, fires at its exact time. On fire → the checkout/run/check-in/cleanup above.
- **Refresh:** one internal croner job on `CRON_REFRESH_SCHEDULE` (default every minute).
  Re-reads every workspace's `cron.json` (ETag) and **reconciles non-destructively**, keyed
  by job name: new → schedule; schedule changed → `stop()` old + schedule new; removed or
  disabled → `stop()`; unchanged → leave untouched. An in-flight run is never interrupted —
  only its future schedule changes. This is the *only* way `cron.json` edits propagate
  (desktop push, a cron run editing it, or a direct GitHub edit) — no webhooks.

**Concurrency:** `protect` gives per-job dedup only; **different** jobs run concurrently
(accepted — no global cap/queue for now; add a FIFO semaphore later if the box gets hammered).

**Boot:** croner registrations are in-memory, so on companion start the scheduler re-reads
every workspace's `cron.json` and re-registers all jobs. Jobs whose time passed during the
restart window are **not** caught up (always-on assumption; a brief restart can miss a fire).

**Timezone:** one **unified system timezone** — a synced app setting (`settings.timezone`,
default UTC), NOT server-local and NOT per-job. Everything uses it: croner's schedules (its
`timezone` option), run/display times, and pi's "current date." It's a new persisted setting
(add to the `Settings` type + a UI control). The companion reads it from the store when
registering jobs; the desktop reads it for display.

## `cron_state` (Postgres) — run history only

croner computes next-run in memory (`job.nextRun()`), so we do **not** persist scheduling
state. `cron_state` is just run history for the UI, keyed by `(workspaceId, jobName)`:
`lastRunAt`, `lastError`, `lastSessionId`. Written by the runner after each attempt.

## Env (all defaulted in code — the env file is optional)

```
CRON_ENABLED           → true          # server-wide master: register + fire, or don't
CRON_REFRESH_SCHEDULE  → "* * * * *"   # croner expression for the refresh job
CRON_MAX_RUN_MINUTES   → 30            # per-run watchdog; abort a hung turn
```

(`CRON_MAX_CONCURRENT` intentionally absent — no global cap until we add the queue.)

## Endpoints (companion) + desktop UI

- `GET /workspace/:id/cron/state` — per-job run history (`cron_state`) + croner `nextRun()`.
- `POST /workspace/:id/cron/:job/run` — manual "Run now" → fire the job immediately.

The desktop `CronSection` reads job *definitions* from its **local** `cron.json` (a workspace
file it already has) and overlays run-status from the companion via the state endpoint;
"Run now" hits the run endpoint. The machine-local master toggle + timing settings
(`settings.cron`) are removed — the server owns those via env.

## What stays desktop-only

- `open_file` tool — dropped from the server catalog (no UI to open).
- Interactive OAuth *connect* (`shell.openExternal` + loopback); only the *refresh* path
  (pure fetch) is needed server-side.
- File watcher, IPC/`BrowserWindow`, `safeStorage`, `nativeTheme`.
- The cron **UI** (`CronSection`), now reading server state.

## Decisions (locked)

1. **Sharing:** shared source dir `agent-core/`, not npm workspaces.
2. **Scheduler:** croner (per-job `protect` dedup, per-job `stop()` refresh, timezone-aware);
   no global concurrency cap (per-job dedup only).
3. **Checkout:** no persistent checkouts — discovery over the Contents API, ephemeral shallow
   clone only when a job fires, deleted after.
4. **Master toggle:** the *desktop's* machine-local toggle is gone; the *server* master is
   `CRON_ENABLED`. Per-job `enabled` in `cron.json` remains the per-job control.
5. **All logic in the core, hosts are dumb I/O** (mapping + ordering move into the core).

## Phasing

- **A — Extract `agent-core`.** Pure DI refactor: move the electron-free modules + the pi
  boot/run body, pull the message-mapping + ordering out of `api/chats.ts` into the core,
  define the host contract, make `codingAgent.ts` a thin desktop host. Fold the desktop's
  IPC-emit + feed-POST into the desktop host's `emit`. Zero behavior change; guarded by
  existing tests + new host tests.
- **B — Companion host + one manual run.** Add pi deps to `api/`; implement the companion
  host (direct store, direct feed emit, per-run `agentDir`); build the checkout + check-in
  + git-fixer; add `POST …/cron/:job/run`. Prove one job end-to-end, watched live.
- **C — Scheduler.** croner fire-jobs + the refresh job + boot re-register; `cron_state`
  history; the state endpoint; desktop `CronSection` reads server state.
- **D — Server-side OAuth refresh** (port `getFreshToken`). Static-token jobs already work
  from B.
- **E — Retire desktop cron.** Delete `cron.ts` / `cronScheduler.js`; keep the UI.

## Open items / risks

- **Skills settings race (fixed by design):** pi writes the effective skills list to
  `<agentDir>/settings.json` at boot. Concurrent cron runs for *different* workspaces would
  race a shared file — hence the **per-run `agentDir`** in the host contract. (Benign on the
  desktop: one active workspace ⇒ same skills ⇒ same content.)
- **Restart miss** — a fire during a companion restart is dropped (no catch-up).
- **PAT scope** — the single `sync.pat` must reach every workspace repo.
- **Model/provider egress** — the server needs outbound to `models.dev` + the provider APIs
  (pi's bundled list is the offline fallback).
- **Secret exposure** — running the agent server-side means its tools read decrypted secrets
  in-process; same trust boundary as `get_agent_secret` today, just on the server.
