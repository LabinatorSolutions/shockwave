# CLAUDE.md — main process

Main-process internals. Code under `src/main/`. Cross-cutting invariants (terminology, link-index rules, parser parity, save-before-mutate) live in the **root `CLAUDE.md`** — read that first.

## Files

- `main.ts` — entry point. Window lifecycle, every IPC handler, watcher orchestration, `app://` protocol.

**Chats live on the companion.** Chat sessions, messages, and transcripts are stored on the companion (Postgres); the desktop reads/writes them through `src/main/api/chats.ts`. Each chat carries provenance — `source` (`desktop` | `cron` | `telegram`), `source_id` (identity within that source: the cron job name, telegram chat id, null for desktop), and `machine` (`os.hostname()` at creation). See the `chat`/`message` tables in `api/CLAUDE.md`.
- `settingsStore.ts` — the settings facade over the companion + a machine-local file: `readSettings`/`writeSettings`, `patchAgentSecretOAuth`. See "Settings persistence" below.
- `settingsStrip.ts` — PURE `stripCredentials` (no electron import, unit-tested). The main→renderer strip, split out of `settingsStore.ts` for the same reason as `certPolicy.ts` and `workspaceRow.ts`: the decision is testable, the wiring isn't. See "Credentials never cross into the renderer" below.
- `src/main/api/` — the desktop's whole bridge to the companion. `client.ts` (the HTTP client: `api.get/patch/post/del`, `api.stream` for SSE; `ApiError` with kinds `unreachable | unauthorized | server | config | untrusted`; reads URL+key from `config.ts`). `net.ts` (`companionFetch` — a dedicated in-memory Electron `session` whose `setCertificateVerifyProc` **pins** the companion's cert; see "Companion TLS" below). `config.ts` (`<userData>/api.json` — companion URL + `safeStorage`-wrapped API key + the pinned `certFingerprint`). `localSettings.ts` (`<userData>/local-settings.json` — `LOCAL_SETTINGS`, window/view state, `activeWorkspaceId`, `chatSources` (which chat sources the history list shows; `null` ⇒ all), per-workspace `{path, syncEnabled}`, plus `updateSnoozedVersion` which is deliberately *not* in `LOCAL_KEYS` — `app:snoozeUpdate` writes it and the renderer never patches it through a settings save). `chats.ts` (chat persistence + list/search over HTTP, backing `chat:*` and the agent host). `workspaces.ts` (workspace identity + local checkout/sync). `cron.ts` (read-only cron view).
- `pathResolver.ts` — `isMdFile`, `uniquePath` (same-dir uniqueness), `walkMarkdownPaths`, and **two ignore predicates that must not be merged back into one**: `isWatchIgnored` (the watcher + the `.md` walks — machinery, never user-controlled) and `isTreeHidden` (the sidebar only — a display decision, overridable by the "Show hidden files" toggle). They carry the same rule today and answer different questions; one function serving both is what made a display toggle look like a change to what the app watches and indexes. Disambiguation is **same-folder only**: `fs:createFile` / `fs:renameFileLiteral` / `fs:moveItem` auto-suffix within one folder; duplicate basenames across different folders are allowed (the link resolver disambiguates). (`uniqueInWorkspace` / `collectMarkdownBasenamesLower` are still exported but no longer imported by `main.ts` — the workspace-wide-uniqueness era is over.)
- `workspaceRow.ts` — PURE `workspace` row → `WorkspaceEntry` projection (no electron import, unit-tested). The single place `sync_disabled` (0/absent = syncing) is negated into the renderer-facing `syncEnabled`; getting it backwards silently inverts every Sync switch with nothing failing, so all three polarity cases are pinned by tests.
- `workspaceFolder.ts` — PURE folder classification for the add-workspace flow (no electron import, unit-tested under `node --test`): `classifyFolder` → `empty` | `clone` | `occupied`, plus `parseGithubUrl` / `cloneUrlFor` / `repoMismatch` / `sameRepo` (case-insensitive, as GitHub is). No electron import — pure + testable, the wiring around it isn't. `sync.ts` re-exports these.
- `linkParser.ts` — ESM mirror of the wiki-link parser in `src/renderer/linkIndex.ts` (the two copies must stay byte-identical in behaviour — see the parser-parity rule in root, enforced by `tests/parserParity.test.js`).
- `renameCorrelator.ts` — pairs unlink+add events into rename events. See below.
- `watcherDispatch.ts` — maps a `@parcel/watcher` event batch to correlator/pending-state calls. Imported by BOTH `main.ts` (real sinks) and the correlator/e2e tests (tmp-dir sinks), so main and the tests exercise identical watcher logic — same parity discipline as `linkParser.ts`. Handles the parcel-specific shapes: atomic-save-as-`create`-of-known-path, folder-rename via directory expansion, deletes-before-creates batch ordering.
- `codingAgent.ts` — the **desktop host** for the shared `agent-core` runtime: builds the `AgentHost` (I/O, secret getters, chat persistence via `api/chats.ts`) and calls `createAgentRuntime(host)`, re-exporting `agentSend`/`agentAbort`/etc. It also owns the desktop's **agent scratch pad** — `<userData>/agent-scratch/<chatId>`, the directory named in the system prompt for files the agent is producing rather than keeping — with `sweepAgentScratch(ttlDays, pinned)` (fire-and-forget at startup, never awaited on the boot path) and `removeAgentScratch(chatId)` (called when a chat is deleted). The sweep rule is `agent-core/scratchSweep.ts`, shared with the companion's hourly sweeper: mtime-based, **except for pinned chats, which are never swept**. `pinned` comes from the companion (`GET /chats/pinned-ids`) because that flag exists nowhere else, so `main.ts` skips the sweep entirely when the server can't be reached — an empty set would mean an offline launch deletes exactly what pinning promised to keep, and the sweep runs once per launch, so skipping one costs nothing but disk. Deliberately outside the workspace, because the workspace is committed and synced. All turn logic lives in `agent-core` (see "Coding agent (desktop host)" below and `agent-core/CLAUDE.md`).
- `openFileExtension.ts` — the `open_file` custom pi tool (`OPEN_FILE_TOOL` + `installOpenFileBridge`), the one tool the desktop host adds to the shared `agent-core` runtime. (Cron, skills, agent-tokens, the system prompt, and the model catalog all moved to `agent-core/` / the companion — see "Coding agent (desktop host)" below.)
- `oauth.ts` — the interactive OAuth2 **connect** flow for `oauth`-kind agent secrets (arctic + a loopback callback server; BYO Desktop-app client). Token storage + refresh happen on the companion; this just runs the browser flow and posts the result. See "OAuth for agent secrets" below.
- `cliTools.ts` — generates per-CLI shim scripts (`firecrawl`, `playwright-cli`) into `<userData>/pi-agent/bin/` that run each bundled CLI via the app's own Electron binary in Node mode (`ELECTRON_RUN_AS_NODE=1` — the app ships no system Node), then `prependPath` puts that dir on `PATH` so the agent's bash inherits it. Regenerated every launch (`ensureCliShims` / `prependPath`) because the absolute paths change per install. Each shim sets `NODE_OPTIONS=--require <cli-tools/preload.js>`, which hides `process.versions.electron` so commander-based CLIs slice argv the normal Node way; **`NODE_OPTIONS` and not a wrapper entry, on purpose** — it's inherited, so a process the CLI re-execs (playwright-cli's browser daemon spawns the app binary again) gets the fix too. See `resources/built-in-skills/CLAUDE.md` for the skills that invoke them.
- `gitBinary.ts` — where `git` actually is, decided ONCE at startup. **`resolveGitBinary()` must be called from `whenReady` BEFORE `prependPath`**, and everything spawns `gitBinary()` (the absolute path) afterwards. See "Never spawn git by name" below.
- `sync.ts` — GitHub sync support: REST helpers (`verifyPat`, `createRepo`, `listRepos`), the `gitSpawn` wrapper that injects a PAT via a command-line credential helper plus the `guardArgs` hardening (see "Auth model" below), the git-presence check, and the workspace setup flows. **`ensureCheckout`** makes a folder BE a checkout of `owner/repo` whatever state it starts in — clone if empty, verify-and-leave-alone if it's already that repo, refuse otherwise — so adding a workspace and checking one out on this machine are one operation, not two implementations of it. `createWorkspaceRepo` stays separate because creating a repo also scaffolds it. Folder classification itself lives in `workspaceFolder.ts`; it is the one place that reads `.git/config`, ONCE at setup, to learn what a folder already is (not the per-tick re-derivation the row replaced). The old `setupLink` (git-init an arbitrary folder and force a remote onto it) is gone — adopting now requires the remote to already be there.
- `syncEngine.ts` — singleton per-workspace tick engine. Sequential ticks (pause-if-conflicts → flush → commit → fetch → **merge** if behind → push), status state machine (with a `conflicts[]` payload on pause), per-file + whole-tree conflict resolution (`resolveConflict`/`keepConflict`/`resetConflict`/`keepAll`/`resetToRemote`), flush-renderer-dirty bridge, drain-on-quit hook. **Every git op — the tick and each resolution op — runs through one serial chain (`exclusive`)**; the interval SKIPS when the chain is busy, user-driven ops QUEUE. Conflict ops also refuse any path the engine isn't currently bound to.

## File watcher

`@parcel/watcher` (native, N-API — ABI-stable across Electron bumps). One `subscribe()` per active workspace (lifecycle: started in `loadWorkspace`, stopped in `loadWorkspace`/`removeWorkspace`/`before-quit`), plus a second `subscribe()` on `.shockwave/` for `workspace.json`. parcel is always recursive and reports only changes after subscribe (no initial scan) — seeding is our only startup enumeration. Per-path events are coalesced within a 150ms window; `.md` adds/changes are read + parsed in main (reusing `linkParser.ts`).

parcel-specific handling (all in `watcherDispatch.ts`): events are `{type: 'create'|'update'|'delete', path}` with **no mtime and no file/dir discriminator**, so the dispatch stats each path (for the inode + to reject directories); a `create` of an already-known path is an atomic save (temp-write + rename-over) and is treated as a modification; a folder rename arrives as delete(oldDir)+create(newDir) and is expanded into per-file events (paired by inode → per-file renames); deletes in a batch are dispatched before creates so rename pairing always has the unlink buffered first. The `ignore` globs are a perf hint; the authoritative dotfile filter is `isIgnoredWatchPath` in the callback.

Events shipped to the renderer (via `fs:changed`):

- `{type:'add'|'change', path, mtime, outgoingLinks}` — `.md` file appeared or modified
- `{type:'add'|'change', path, mtime}` (no `outgoingLinks`) — a `.excalidraw` drawing or a non-`.md` **reloadable text/code file** (`isReloadableText` — everything in `OPENABLE_RE` except the `.md` family, images, video, drawings) changed. Bypasses the rename correlator (link-index machinery); the renderer re-reads the file to reload an open canvas/buffer, keyed by its own mtime store (`drawingMtimesRef` / `textMtimesRef`) for the self-echo guard.
- `{type:'unlink', path}` — `.md`/drawing/reloadable-text file removed (grace window already elapsed without a paired add)
- `{type:'rename', oldPath, newPath, mtime, outgoingLinks}` — paired by the correlator (inode primary, hash fallback); `.md` only (drawings/text surface as unlink+add)
- `{type:'tree'}` — folder change or a non-reloadable change (binaries, etc.) — tree refresh only

The watcher only sees inside the active workspace, and `isIgnoredWatchPath` skips any path with a dotfile segment (`.git`, `.obsidian`, `.shockwave`, etc.) — mirrors `buildTree`. The `.shockwave/` segment is how we store our own per-workspace data (bookmarks) without echoing back through the main watcher (a separate subscription watches it for `workspace.json`).

### End-to-end pipeline

The watcher is a state machine spread across `main.ts` (orchestration), `watcherDispatch.ts` (event mapping), and `renameCorrelator.ts` (rename pairing). The flow from a parcel event batch to the renderer:

```
@parcel/watcher subscribe(root) (fsevents on macOS)
   │
   ├── batch of {type: create|update|delete, path}
   ▼
onParcelEvents → watchDispatch.handleBatch(events)   (deletes first, then creates/updates)
   │
   ├─ drawing / reloadable-text path? → pend as add/change (mtime-only event; bypasses correlator)
   ├─ other non-.md path? → markTreeOnly() → pendingTreeOnly = true; scheduleFlush() (150ms debounce)
   ├─ directory? → create: walk .md inside and upsert each; delete: unlink every known .md under it
   └─ .md file? → stat ino + hash file, hand to correlator:
                    create (unknown path) → correlator.onPathAppeared(p, ino, hash)
                    create (known path) / update → onPathSeen(p, ino, hash); pendingByPath.set(p, 'change')
                    delete → correlator.onPathGone(p)  (buffered for 800ms grace)
   ▼
createRenameCorrelator
   │
   ├─ pairs `unlink(old)` + `add(new)` by inode (primary) or sha1 hash (fallback for FAT/SMB/etc.)
   └─ emits ONE of: { type: 'rename', oldPath, newPath } | { type: 'add', path } | { type: 'unlink', path }
        ▼
   setupCorrelator's emit callback:
        rename  → renameQueue.push(e); scheduleFlush()
        unlink  → pendingByPath.set(p, 'unlink'); scheduleFlush()
        add     → pendingByPath.set(p, prev === 'unlink' ? 'change' : 'add'); scheduleFlush()
   ▼
flushWatcher (fires 150ms after the first scheduleFlush since last flush)
   │
   ├─ renames first: read content + stat, send {type:'rename', oldPath, newPath, mtime, outgoingLinks}
   ├─ then per-path entries: unlink → send {type:'unlink', path}; add/change → read + parse + send
   └─ if treeOnly + nothing else: send {type:'tree'}
        ▼
win.webContents.send('fs:changed', evt)  →  renderer's onFsChanged
```

Pipeline invariants:

1. **The watcher windowId is captured at `watchStart`.** Subsequent flushes target that window via `BrowserWindow.fromId(watcherWindowId)`. If the window is destroyed and re-created (full reload), the watcher must be restarted to pick up the new id.
2. **Coalescing key is the path.** Multiple events for the same path within the 150ms window collapse to the latest type, with one special case: `unlink → add` for the same path collapses to `change` (atomic save pattern from vim/VS Code).
3. **The rename correlator buffers unlinks for `RENAME_GRACE_MS` (800ms).** If a paired add arrives in that window with matching inode or content hash, it's emitted as `rename` instead of separate unlink+add. After the grace period, buffered unlinks become real unlinks.
4. **Renames go through `renameQueue`, not `pendingByPath`.** They're already paired events and shouldn't be merged with per-path bursts.
5. **Self-echo guard is mtime-based.** `fs:writeFile` and `fs:createFile` return the file's `stat.mtimeMs` (sub-ms float) post-write. The renderer stores that exact value via `linkIndex.updateFile(path, text, mtime)`. The watcher's later flush re-stats and ships the same `stat.mtimeMs`. `evt.mtime > stored` is false → skip. Never substitute `Date.now()` for the renderer-side mtime — integer ms compared to a sub-ms float makes every save look fresh and the editor reloads mid-typing. See "Real mtimes everywhere" in the root invariants.
6. **Seeding runs synchronously on `watchStart`.** Every `.md` under the root is stat'd + sha1'd before `subscribe()` is awaited. Without this, an unlink fired immediately after startup couldn't be correlated (we'd have no prior identity to match against). It also feeds `correlator.isKnown` / `knownUnder`, which the dispatch relies on to classify atomic saves and expand folder deletes.

### Rename correlator (`renameCorrelator.ts`)

External actors — Finder, `mv`, `git checkout`, a coding agent shelling out to `fs.rename` — bypass the in-app rename flow. Without intervention, the watcher would see a rename as unrelated `unlink(old) + add(new)` events, references in other files would break, and the link index would lose the connection between the old and new paths.

The correlator buffers unlinks and pairs them with subsequent adds:

- **Primary key: inode.** `fs.stat(p, { bigint: true }).ino` is stable across `fs.rename` on every realistic filesystem (NTFS, APFS, ext4, btrfs, xfs). The correlator stores `{path → {ino, hash}}` for every known file; on `unlink`, it buffers the identity; on `add`, it stats the new file's ino and matches against buffered unlinks.
- **Fallback: content hash.** For filesystems where ino is unreliable (FAT, exFAT, some SMB shares), the correlator falls back to matching the SHA-1 of the file contents (computed eagerly on `onPathSeen` because the file is gone by the time `unlink` fires).
- **Grace window.** `RENAME_GRACE_MS = 800` in `main.ts` (beside `WATCH_DEBOUNCE_MS = 150`). Buffered unlinks that aren't claimed within that window are emitted as real `unlink` events.
- **Atomic saves** (vim/VS Code write-temp-then-rename-over-existing) come through parcel as `create` of the existing destination (+ a delete of the temp). The dispatch sees the destination is already known (`correlator.isKnown`) and treats it as a modification, not a rename — see `tests/correlator.integration.test.js`.

## Settings persistence

Settings have two homes, and `settingsStore.ts` hides the split behind `readSettings`/`writeSettings` — one flat `Settings` object, so every call site in `main.ts`/`oauth.ts` and the whole renderer is unchanged:

- **Synced settings** (agent config + provider keys, agent secrets, `sync.pat`, transcription, appearance, timezone, workspace *identity*) live on the **companion** (Postgres) — the single source of truth, which encrypts every credential. The desktop reaches them through the API client in `src/main/api/` (`readSettings` → `GET /settings`, `writeSettings` → `PATCH /settings`). See **`api/CLAUDE.md`** for the storage + encryption model.
- **Machine-local settings** (window/view state, the active workspace, each workspace's checkout path + sync toggle) live in `<userData>/local-settings.json` (`src/main/api/localSettings.ts`) and never sync.
- **The companion connection itself** — URL + API key — lives in `<userData>/api.json` (`src/main/api/config.ts`), the key `safeStorage`-wrapped. This is the **only** secret the desktop stores locally; all other secrets are on the companion.

### Companion TLS — verify, then pin

Every companion request carries the bearer API key, and `GET /settings` returns the whole **decrypted** secret store, so the certificate check is what stands between a hostile network and every credential the user has. `net.ts`:

- **Publicly-trusted cert** (`COMPANION_DOMAIN` + Let's Encrypt) → Chromium's own verification decides. A forged cert fails it, and renewals (a new key every ~90 days) are invisible because nothing is pinned.
- **Self-signed** (the no-domain default) → Chromium's verification always fails, so it can't tell the user's server from an impostor. The fingerprint the user approved is pinned in `api.json`; only that one is accepted.

**The decision itself is pure and unit-tested** — `src/main/api/certPolicy.ts` (`decideCert`, `toDisplayFingerprint`, `pendingApplies`), covered by `tests/certPolicy.test.js`. `net.ts` is only the Electron wiring around it. Same pure-`.js`-policy split as `keys.ts` vs `settingsStore.ts`.

**Nothing is ever approved automatically.** A fingerprint is stored in exactly one place — `approveFingerprint()`, behind `api:approveCert`, called when the user presses Approve on a fingerprint Settings has rendered for them. Two situations reach that point and both take the *same* path — hold the connection, remember what was offered, ask: nothing approved yet, or what's offered isn't what was approved. Only the wording differs, and the UI picks it from `certNeedsApproval.approved` (`null` ⇒ first connection).

`api:test` **reports and never approves** — probing a connection must not be able to approve one. Two explicit acts on the Companion page: **Connect** goes and looks, **Approve** records. Fields still store on blur like every other section, but storing is not connecting; editing either field drops the status back to "not connected" so a green line can't describe details that have since changed. A URL change also clears the stored fingerprint (`config.ts`) — different server, meaningless value. A *key* change deliberately does **not**: same server, same certificate, and re-asking approval for an identical fingerprint is a prompt with no decision in it, which is exactly what teaches a user to approve without reading.

> An earlier version adopted an un-approved fingerprint automatically inside a 30s window opened by `api:test`. It looked narrow — Settings only, never background traffic — but it decided **first approval on the user's behalf without ever showing them a fingerprint**, so a machine-in-the-middle present during first setup was recorded silently, permanently, and never warned about again. Narrowing *when* an auto-approve fires is not a substitute for not having one. `tests/certPolicy.test.js` pins this.

**Wording matters here and the code carries it.** The connection is **held**, not rejected: completing it means sending the API key, so the attempt stops, shows what it saw, and waits. `REJECT`/`lastRejection`/`CertRejection` used to be the names, which read as a verdict on something already approved and made the flow impossible to explain to anyone. Keep them describing what it is — `pendingApproval`, `PendingCert`, `DO_NOT_CONNECT`.

**Chromium caches its verdict, so the pin is re-checked on every use.** `setCertificateVerifyProc` runs once per host and the answer is cached for the session — so a decision made under one pin outlives that pin. `getCompanionSession()` therefore compares the live session's `sessionFingerprint` against the stored pin on **every** call and retires the whole session (a fresh, monotonically-named in-memory partition) the moment they differ. One mechanism, not a set of call sites that each remember to retire.

> This is what closed the hole where changing the companion URL cleared the pin (`config.ts`) without going through approve or forget: the session — and Chromium's cached "accept" — survived, so the app connected happily with **nothing approved** and the panel showed Connected with no fingerprint. Pinning was effectively off until a restart. Any change to the pin now invalidates the cached verdict, whoever made it.

**Comparing the fingerprint needs a second source.** Chromium reports `sha256/<base64>`, openssl prints uppercase hex pairs; `toDisplayFingerprint` converts to openssl's form so the app's value matches what `shockwave-fingerprint` prints on the server. Without that the two can never match and approving is theatre. The installer prints it at setup; the status row shows the approved one while connected, with **Forget it** (`api:forgetCert`) so a mismatch has a way out.

### One request gets a deadline: the health probe

`health()` aborts at `HEALTH_TIMEOUT_MS` (20s). **Nothing else in `client.ts` has a timeout**, deliberately.

A blanket 8s deadline used to sit on every call, and it was the wrong shape twice over. It was **total wall-clock, not idle** — the timer started before the request and was only cleared when it finished, so it fired whether or not bytes were moving. And it was applied to the two calls that legitimately carry megabytes: `PATCH /chat/:id/transcript` (pi's whole session JSONL, re-sent every turn) and `POST /chat/:id/messages` (a message's images, base64). A healthy upload was aborted for being large.

`fetch` offers no idle timeout, and a bound on total time is not a substitute for one — so those calls now have none, and a dead peer surfaces through the transport. The probe keeps its bound because that is exactly what a probe is for: an un-bounded health fetch once hung forever on a connection the restarting companion half-closed (no RST, socket just sits), leaving the Connect flow waiting with nothing to show.

**A parked certificate is matched to its host.** There is one slot, written by any companion request including background traffic, so `getPendingCert(host)` filters. Without it, changing the server URL could surface the *previous* server's certificate for approval — its retries are still in flight, its pin was just cleared — and approving it would store the wrong server's fingerprint. Cleared on any successful response (`client.ts`).

On a held connection the request throws `ApiError('needsApproval')`, **not** `unreachable` — the server is up and answering, so reporting an outage would both misstate it and hide the only screen that fixes it. Main broadcasts `companion:cert-needs-approval` on **every** held connection; the renderer's toast carries a fixed `id`, so while it's on screen a repeat updates in place and once dismissed the next held connection brings it back. (Deduping in main got this wrong: dismissing meant it never returned, and everything silently stopped syncing with nothing on screen.)

> This replaced `verificationResult === 'net::OK' ? cb(-3) : cb(0)` — "if the cert is invalid, trust it anyway" — which accepted any forged cert on **both** deployment types, so anyone able to intercept the connection got the API key on the first request. A comment claimed a Settings opt-in gated it; no such setting existed. Don't reintroduce an unconditional `cb(0)`.
>
> Also load-bearing: the companion creates its self-signed certificate **once, at boot** (`settleTls` in `api/src/server.ts`), never in `/telegram/connect`. It used to be created there, so a fresh install had no certificate of ours at all — Traefik served its own throwaway, the desktop approved *that*, and connecting Telegram replaced it. The fingerprint changed on a routine action, and a user who sees the identity-changed warning during normal setup learns to click through the one prompt that catches a real attack.

### Credentials never cross into the renderer

`readSettings` / `readSettingsSafe` return **live credentials** — provider keys, the GitHub PAT, agent tokens. They exist for main's own use: running the agent, pushing to git, minting the voice token. `readSettingsForRenderer` is the stripped read, and it substitutes a presence flag for each credential (`hasPat`, `hasProviderKey`, `hasVoiceKey`) so Settings can render dots without ever holding a value.

> **An IPC handler may only return the stripped read.** `settings:read` uses it, and so does the `settings:changed` push (`emitChanged`). Nothing in the language stops a future handler returning the wrong one and the leak would be silent — the app would work perfectly while handing every key to the renderer. This was a comment once, which is the same shape of mistake as the certificate check that trusted anything: a policy nobody enforces. `tests/rendererSettingsDoor.test.js` now scans `main.ts` for it (verified by introducing the leak deliberately and watching it fail).

Which fields are credentials is declared once, in `agent-core/credentials.ts`; this strip and the renderer's send guard both derive from it. See the root `CLAUDE.md`.

**A flag never conjures the object that would have held it.** The flag is written at the credential's own path (`oauth.clientSecret` → `oauth.hasClientSecret`), and `setPathCopy` builds missing parents — so every static-token agent secret came out of the strip wearing an empty `oauth: {}`. The renderer classifies by `!!s.oauth`, so **every pasted token rendered as an OAuth connection**: a "Reconnect" button that could only ever fail (`No OAuth connection named …`, since main's unstripped copy has no `oauth` at all), and no way to reach the token dialog and actually paste the key. The empty slots `ensureBuiltinSecretSlots` provisions showed it first — they arrive with nothing but a name, so the phantom was all the renderer had to go on — but it was never about them. Nested flags now apply only when their container already exists; root-level ones (`token` → `hasToken`) always do, there being nothing to invent. Pinned by `tests/settingsStrip.test.js`, which is why the strip is a separate pure module: `settingsStore.ts` imports electron, so `node --test` can't load it.

### DB is the source of truth — nothing faked on read

`readSettings` returns the companion's settings **verbatim**, then overlays the machine-local values (`overlayLocal`). It does **not** merge a defaults object over them, so an unset synced value reads as unset, never faked. The only desktop defaults are `LOCAL_SETTINGS` in `api/localSettings.ts`, and they cover **machine-local keys only**.

This matters because the companion is read by more than the desktop — the Telegram and cron runners read it directly. A desktop-side default that filled an unset value would make a setting *look* configured while those runners saw the hole and failed. That is exactly what a former `DEFAULT_SETTINGS` merge did to `codingAgent.provider`: the desktop showed `anthropic` from its default while the DB had no row, so the server-side agent threw "provider not configured". Required synced settings therefore have **no default** and error at their consumer; optional ones fall back **at the point of use** (see `api/CLAUDE.md`). `readSettingsSafe` never throws — on an unreachable companion it returns machine-local settings only, so the app boots to a "connect your companion" state.

### Writes are disjoint + pushed

- **`writeSettings` writes only the keys in the patch**, split by destination: machine-local keys → the local file, `workspaces` → the workspace endpoint, everything else → `PATCH /settings`. The renderer's `persistSettings` sends just what changed (diffed against its in-memory cache in `settingsDiff.ts`), so a credential it happens to hold isn't republished on an unrelated save.
- **`settings:changed` carries a COMPLETE snapshot, never a key list.** It used to name the changed keys and the renderer applied only those, which meant the same disk→state mapping existed twice — complete in `hydrateSettings` (run at every boot) and partial in the listener (seven keys) — and a field added to one and missed in the other worked at startup and was stale forever after. The renderer now re-seeds through the same function boot uses, so every key is covered by construction and a field nobody wires up breaks loudly on day one. **`windowBounds` writes with `notify: false`**: it fires on a 400ms debounce for the whole of a window drag, and re-seeding several times a second during a resize is the one case where a snapshot is expensive — the renderer has no use for the value anyway (it is in `MAIN_OWNED_KEYS` so nothing there may author it). The `settings:write` IPC also passes `notify: false` (the renderer already has what it just wrote). The renderer's `settingsRef` is a render cache, not the truth.
- **The companion announces its OWN settings changes on the live feed.** `/voice` and `/workspace` from the bot, and OAuth tokens refreshing mid-run, all change settings with no desktop involved — and main only pushes after its own writes, so the app showed a stale value until a reconnect. The feed handler now treats `{type:'settings_changed'}` as "re-read and push a snapshot". The event carries no payload on purpose: one route for the data, one for the notification.

Adding a persisted **synced** field: extend the `Settings` type in `src/shared/settings.ts`, add a slice + setter in the renderer's `useSettings` hook, and — if it holds a credential — declare it in `agent-core/credentials.ts` (the one declaration; the companion's `keys.ts`, this process's strip, and the renderer's send guard all derive from it). There is **no** desktop `DEFAULT_SETTINGS` to update; a synced field with no value is simply unset, handled at its consumer (required → error, optional → point-of-use fallback). A **machine-local** field is ONE edit: add `key: default` to `LOCAL_SETTINGS` in `api/localSettings.ts` (plus its optional field on the `LocalSettings` interface). Write routing (`LOCAL_KEYS` → `isLocalKey`) and the read overlay (`overlayLocal` in `settingsStore.ts`) both derive from that map, so they can't disagree. They used to be two hand-maintained lists in two files, and both ways of getting it half-right fail silently — routed but undefaulted reads as `undefined` on a fresh machine; defaulted but unrouted goes to `PATCH /settings`, so the value syncs across machines and the write throws while the companion is unreachable. Same one-declaration discipline as `agent-core/credentials.ts`.

> **Legacy note.** The pre-companion build stored settings in a local sqlite `shockwave.db` with a desktop master key (`masterkey.enc`) and routed secrets via `settingsKeys.js`. That's gone: `masterKey.ts` and `settingsKeys.js` were deleted, all storage + secret encryption moved to the companion (`api/src/{store,crypto,keys}.ts`), and `importLegacySettingsIfNeeded()` is now a no-op (its `whenReady` call site is vestigial).

### OAuth for agent secrets

An `agentSecrets[]` entry is either `kind: 'static'` (a pasted token, in `.token`) or `kind: 'oauth'` (an OAuth2 connection, in `.oauth` — see `AgentSecretOAuth` in `src/shared/settings.ts`). `oauth.ts` runs the whole flow in main:

- **BYO client, RFC 8252 loopback.** The user creates their own OAuth client in the provider console (Google → "Desktop app" client type) and pastes `clientId`/`clientSecret`. `startConnect` opens the **system browser** (`shell.openExternal`) to the consent URL and catches the redirect on a throwaway `http` server bound to `127.0.0.1:<ephemeral port>`. No embedded webview; the app never sees credentials. Ephemeral port ⇒ Google works (it accepts any loopback port); exact-match providers like GitHub do not (see each preset's `hint`).
- **arctic** (`arctic@^3.7.0`, ESM — externalized, resolved by the ESM main at runtime) is used **only for the pure authorize-URL + PKCE building** (`createAuthorizationURLWithPKCE`, `CodeChallengeMethod.S256`, `generateState`, `generateCodeVerifier`). The **token exchange + refresh are our own `fetch`** (`postToken`), NOT arctic's `validateAuthorizationCode`/`refreshAccessToken`: arctic 3.7.0 manually sets a `Content-Length` header on its token request, which Electron's undici rejects with `UND_ERR_INVALID_ARG` "invalid content-length header" — the request never leaves the app. Our `postToken` sends a `URLSearchParams` string body with only `Content-Type`/`Accept` (undici computes Content-Length) and puts `client_id`+`client_secret` in the body. `PROVIDER_PRESETS` bakes in endpoints/scopes/quirks (Google's `access_type=offline` + `prompt=consent` guarantees a refresh token).
- **State/verifier live in-memory** for the flow's lifetime (a webapp would use httpOnly cookies; we have neither). `state` is checked on the callback (CSRF). 5-min timeout.
- **Token refresh/minting for the agent happens on the companion**, not here — `oauth.ts` no longer has `getFreshToken`. The desktop agent host's `getToken` calls `GET /agent-secret/:name/token`, and the companion refreshes an OAuth access token (rotating the refresh token) or returns the static token. This desktop `oauth.ts` only runs the interactive connect/disconnect and posts the result to the companion (`patchAgentSecretOAuth` → `POST /oauth/:name`).
- **Settings reads are injected** via `initOAuth({ readSettings })` (called once at startup, before any `oauth:*` IPC) to avoid a circular import back into `main.ts`. Writes don't need injecting — `patchSecret` calls `patchAgentSecretOAuth` (`settingsStore.ts`), which `POST`s to the companion's `/oauth/:name`; the companion writes **only** this connection's token rows in `secret_value` plus its OAuth status columns on `agent_secret`, in one transaction. (Token storage — and refreshing/minting fresh tokens for **server-side** Telegram/cron runs — lives on the companion; see `api/CLAUDE.md`. The desktop still runs the interactive connect flow below.) It used to read-modify-write the entire `agentSecrets` array, which raced the renderer's own array write: the renderer's copy was built from pre-refresh state, so it could overwrite a token main had just rotated, and Google rotates refresh tokens on every refresh — a lost write killed the connection permanently. Two guards now: the writes are disjoint, and `OAUTH_OWNED_FIELDS` (`oauth.accessToken`, `oauth.refreshToken`) + `OAUTH_OWNED_COLUMNS` (`oauthExpiresAt`, `oauthStatus`, `oauthAccountEmail`) bar any bulk `writeSettings` from authoring them at all, so a stale echo can't win even in principle. `clientId`/`clientSecret` are deliberately NOT owned — the user enters those in Settings. `patchAgentSecretOAuth` also emits `settings:changed(['agentSecrets'])`, so the renderer picks up fresh status on its own; the explicit `reloadAgentSecrets` call after Connect/Disconnect is now a belt rather than the mechanism.
- IPC: `oauth:listPresets`, `oauth:startConnect`, `oauth:disconnect`.

## `app://` protocol — two hosts

Registered before `app.ready` via `registerSchemesAsPrivileged({scheme: 'app', privileges: {standard, secure, supportFetchAPI, stream}})` so the renderer can fetch it with `webSecurity` intact. One handler, dispatching on `url.host`:

- **`app://media/<rel>`** — a file in the workspace. Resolves `<rel>` against `watcherRootDir` (the active workspace), rejects path traversal outside it with 403, and streams via `net.fetch(file://…)`. `<img src="app://media/…">` in the live-preview decoration loads with no extra wiring.
- **`app://attachment/<id>`** — a chat image, proxied from the companion's `GET /attachment/:id` via `api.getRaw`. **This exists because the API key lives in main**: the renderer can't authenticate to the companion, so it writes a URL and main does the fetching. `getRaw` is a separate client method because `request()` parses JSON and unwraps `.result`, which is meaningless for image bytes. A companion that's away answers 503 — the picture is missing for now, which is not worth breaking the chat over. Ids are immutable, so the response is cached and re-opening a chat re-downloads nothing.

## Window bounds persistence

`attachWindowBoundsPersistence` tracks the last-known unmaximized bounds and persists `{ x, y, width, height, maximized }` to `settings.windowBounds` on a 400ms debounce, with a final flush on `close`. The `will-quit` handler `event.preventDefault`s once, drains the **sync engine**, then calls `app.exit()`. It no longer drains a settings queue: `windowBounds` is machine-local, so its write is a synchronous local-file write (`local-settings.json`, tmp+rename) that has completed by the time `writeSettings` resolves, and a fast Cmd+Q can't lose it. On restore, `boundsAreVisible` checks the saved rect against currently-attached displays and falls back to the default 1200×800 if it no longer intersects any display.

## Coding agent (desktop host)

**All the turn logic lives in `agent-core/`** (session lifecycle, steering, system prompt, tools, skills, model resolution, the failed-image splice — see `agent-core/CLAUDE.md`). `codingAgent.ts` is a thin desktop **host**: it builds the `AgentHost` and calls `agent-core`'s `createAgentRuntime(host)`, then re-exports `agentSend` / `agentAbort` / `agentDisposeChat` / `agentDisposeAll` / `agentRunningChats` / `listThinkingLevels`. (Those last two are named for **chats**, not sessions — the terminology rule in the root `CLAUDE.md` is enforced in the API, so don't reach for `agentDisposeSession`.) Everything else in the file is the scratch-pad lifecycle described above.

What the desktop host supplies to `agent-core`:

- `builtinDir` (bundled built-in skills), `machine: os.hostname()`, `extraTools: [OPEN_FILE_TOOL, SEND_MESSAGE_TOOL]`, `extraTools` as a FUNCTION of the session (`({workspacePath}) => [open_file, send_message]`), because the reply mode `send_message` reads and writes is per WORKSPACE and the host is built once per process, `dataDir: () => app.getPath('userData')` (one global pi scratch dir — the companion uses a per-run dir instead), `scratchDir: (chatId) => <userData>/agent-scratch/<chatId>` (the AGENT's own directory, named in the prompt — distinct from `dataDir`, which is pi's working memory).
- Chat persistence closures from `src/main/api/chats.ts` — `getChat`, `upsertChat`, `appendMessages`, `setChatTitle`, `setRunning`, `getTranscript`, `putTranscript`. So **chats are stored on the companion**, not locally; the runtime just calls these.
- `chatSearch` — `{ searchChats, readChat, recentChats }`, also from `api/chats.ts`, backing the one `search_chats` tool. The field is optional on `AgentHost`; omit it and the tool simply isn't offered.
- `getVoiceConfig()` — the voice settings as one value (which vendor listens, which speaks, the per-vendor keys), for the `transcribe` tool and for speaking.
- Secret getters (`getAgentSecrets` / `getToken`), injected by `initDesktopAgent()` in `main.ts`. `getToken` calls the companion (`GET /agent-secret/:name/token`), so OAuth refresh happens server-side; the desktop only runs the interactive connect flow (`oauth.ts`).

Chats run concurrently (one live pi session per chat). Events forwarded to the renderer (`agent:event` / `agent:error`) are stamped with `chatId`; `agent:runningChats` returns in-flight ids (the renderer reseeds after a window reload).

### Live feed — one always-on stream

`startLiveFeed()` (called once in `whenReady`, stopped on `before-quit`) holds **one** SSE connection to the companion's `GET /events` for the life of the app, carrying every chat's events — Telegram, cron, and the same chat open on another machine — and forwards them into the same `agent:event` channel a local turn uses, so a remote turn draws identically. It reconnects forever with backoff; on reconnect it fires `chat:feedResync` so the renderer re-reads its loaded chats (anything during the outage was missed).

Events **this machine produced** are dropped (`e.machine === os.hostname()`; `agent-core` stamps every event it emits): they already reached the renderer over IPC, and we POST every one of them up to `/chat/:id/events` so other clients see them — the copy coming back would double-render.

> **The filter is origin, not liveness.** It used to be `agentRunningChats().includes(e.chatId)`, which is a race it loses: `entry.running` flips false the moment `session.prompt` resolves, while that turn's own events are still round-tripping over HTTP. Every echo that landed after the flag cleared was forwarded, and the renderer drew the assistant's reply a second time — `message_end` opens a fresh bubble when no streaming cursor is live. A short turn round-tripped entirely after the flag cleared, so the whole reply doubled. It read as stored duplication and wasn't: re-opening the chat re-read the rows and the copies vanished, which is the tell that the transcript was fine and the live path wasn't.

**It is always on by design.** This used to be a per-chat subscription (`chat:watchStart`/`watchStop`) started from the renderer when you clicked a chat that happened to be running elsewhere *at that instant* — so a Telegram turn was never watched, and a chat already on screen could never start listening at all. Don't reintroduce a per-chat subscription: the point is hearing about chats the desktop doesn't yet know exist.

### Connection state — one rule refreshes companion-owned data

The feed is also the app's **reachability signal**. Its stream opening means the companion answered; its `done()` means we lost it. `setCompanionOnline(online)` is edge-triggered on those two points and is the ONLY place companion-owned renderer state is refreshed: going online calls `notifyWorkspacesChanged()`, which re-reads and pushes `workspaces` + `activeWorkspaceId` down the existing `settings:changed` channel. It also broadcasts `companion:state` so the UI can distinguish "couldn't ask" from "nothing there".

**Do not add a refresh call to any new site that changes connectivity — route it through the feed instead.** `api:write` (Settings → Connect) is the worked example: it doesn't refetch anything, it calls `stopLiveFeed()` + `startLiveFeed()`, and the reopen does the refresh. That also makes connecting immediate, since the retry loop backs off to 30s. `api:test` does the same on a successful probe while offline — the settings-nav gate follows `companionOnline`, so a probe that succeeds must not leave the feed parked in its backoff.

> This replaced a single refresh site — the renderer's boot read. Workspaces live only on the companion, so a desktop that started while it was down held an empty list for the whole session: neither the companion coming back (including from its own upgrade restart) nor connecting one in Settings asked again, and quitting the app was the only recovery. The fix is deliberately *not* a refresh call at each of those places; that's the pattern that missed them. Adding a fourth would miss the fifth.
>
> **Going offline must not push a settings payload.** A degraded read (`readSettingsSafe`) returns an empty workspace list, so broadcasting one would clear the renderer's good copy — the original bug, inverted. Offline pushes the flag and nothing else.

**Desktop tools** (both supplied via `extraTools`):

- **`open_file`** (`openFileExtension.ts`) — `OPEN_FILE_TOOL` + `installOpenFileBridge`, opens a file in the app from a turn. Scoped `only: ['desktop']` in `agent-core`'s `TOOL_CATALOG`: cron and Telegram runs have no UI to open a tab in.
- **`send_message`** (`codingAgent.ts`, built from `agent-core/sendMessage.ts`) — DMs the user on Telegram by `POST /telegram/send` to the companion. The desktop holds no bot token; it asks. Without it, a chat started in Telegram and continued in the app couldn't reply on Telegram.

The agent-tokens tools (`list_agent_secrets` / `get_agent_secret`) and the whole `TOOL_CATALOG` live in `agent-core`. Anything added to `extraTools` **must** also be named in that catalog — pi drops unlisted custom tools silently (see `agent-core/CLAUDE.md`).

**Model/provider discovery IPC** — handlers stay in `main.ts`, logic in `agent-core/modelCatalog.ts`: `agent:listProviders` (pi's list filtered to `SUPPORTED_PROVIDER_SLUGS` in `src/shared/constants.ts`), `agent:listModels` (the models.dev catalog), `agent:listThinkingLevels`, `agent:validateConnection` (checks an openai-compatible `{baseUrl}/models`). `initModelCatalog` is called once in `whenReady`.

**`ensureBuiltinSecretSlots()`** (`main.ts`): auto-provisions empty agent-secret slots on the companion for the `required-secrets` a workspace's enabled built-in skills declare — adds missing names, never overwrites.

## Workspace default files

The manifest (`SOUL.md`, `AGENTS.md`, `MEMORY.md`, `USER.md`, `.ignore`, `.gitignore`) and `ensureWorkspaceFiles` live in **`agent-core/defaults/files.ts`** (see `agent-core/CLAUDE.md`). Main only *calls* it, from two IPC paths — `workspace:ensureFiles` (manual; `overwrite` replaces all, renderer confirms first) and `createWorkspaceRepo` (automatic, for a fresh repo the user made here) — plus `workspace:listFiles` to report what's missing. It deliberately does **not** scaffold on clone/adopt (`ensureCheckout`) or on workspace switch: pushing files into a repo the user may not own, or writing on every activation, would be surprising. A cloned workspace with no `SOUL.md` falls back to `DEFAULT_SOUL` in memory.

> **`MEMORY.md` and `USER.md` are seeded EMPTY, and `overwrite` empties them.** They are the agent's memory (see "Memory" in `agent-core/CLAUDE.md`), written by the `memory` tool as `§`-delimited entries — so a stub with prose in it would parse as the agent's first memory and ride in every prompt until something removed it. Being in the manifest means the renderer's "Reset to defaults" blanks them along with the rest, which is why that confirmation names them explicitly: everything else in the set is text the user wrote and could write again, and these two are not. A workspace that predates them needs no migration — the tool creates the file on first write.

## Scheduled runs (cron) — companion-side

Cron **runs on the companion** now (`api/src/scheduler.ts` + `cronRun.ts` — see `api/CLAUDE.md`), not in main. `cron.json` at the workspace root is still the job source of truth. The desktop keeps only two thin pieces:

- A **read-only view** — `src/main/api/cron.ts` composes job definitions from the active workspace's local `cron.json` with run status from `GET /workspace/:id/cron/state`.
- Two IPC channels: `cron:read` and `cron:runNow` (→ `POST /workspace/:id/cron/:name/run`). There are no `cron:setEnabled`/`setMaxCatchupHours`/`setMaxRunMinutes` handlers and no `cron:state`/`cron:chatsChanged` push events.

There is **no `settings.cron`** and no cron settings page. The master toggle and refresh cadence are the companion's env (`CRON_ENABLED`, `CRON_REFRESH_SCHEDULE`) — the desktop cannot write them, so a local copy could only ever lie. (The run time limit is no longer among them: it is `codingAgent.maxRunMinutes`, a synced setting on the Agent Chat page, because it bounds Telegram turns too and the desktop is where you'd go to change it.) One did: after the desktop scheduler was deleted, `settings.cron` stayed in `local-settings.json` with nothing reading it, `cronRead` hardcoded `enabled: true`, and the panel kept an "it's off — turn it on…" banner wired to a page with no switch. The dead `cron` key itself outlived that cleanup by two more releases (it was still in `LOCAL_KEYS` and on the `LocalSettings` interface, written and read by nothing) and is now gone.

## GitHub sync

Per-workspace background sync to GitHub. Two files: `sync.ts` (one-shot helpers + setup) and `syncEngine.ts` (the singleton tick loop).

### Auth model

PAT is stored encrypted in `sync.pat` **on the companion** (`secret_value`, owner `settings` — see `api/CLAUDE.md`); the desktop reads the decrypted value through `readSettings`. For shell git, the decrypted PAT is set on the child process's `GITHUB_PAT` env and answered by a credential helper passed **on the command line** (`CREDENTIAL_HELPER` in `sync.ts`, a one-line shell function). The PAT lives in process memory only for the lifetime of that one git child. **Never written to `.git/config`**; remote URLs stay plain `https://github.com/owner/repo.git`. REST calls use a `Bearer` header with the same memory-only lifetime.

> There is **no askpass script on disk**, and reintroducing one is a regression. It was a file at a fixed path, owned by the user the coding agent runs as, that git executed with the PAT in its environment — so the agent could rewrite it once and collect the token on every sync afterwards. Nothing on disk means nothing to tamper with.

#### Never spawn `git` by name (`gitBinary.ts`)

Spawning `git` bare asks the OS to search `PATH` and run the first match — and main **prepends `<userData>/pi-agent/bin` to its own PATH at startup** (`cliTools.ts`, so the agent's bash inherits the bundled CLI shims). That directory is writable by the agent, which runs as the same user, and it is searched *first*. A file named `git` dropped there is what main would then execute, with `GITHUB_PAT` in its environment.

So `resolveGitBinary()` runs in `whenReady` **ahead of `prependPath`**, and `sync.ts` spawns `gitBinary()` — the absolute path — from then on. Ordering is the whole mechanism: resolve after the prepend and it resolves to the planted file. It falls back to the bare name if resolution fails, because sync working matters more than this hardening.

Honest limit, so nobody over-claims it: this closes the one directory that exists because of us, is writable by the agent by design, and is searched first. It cannot help if `git` was already hijacked elsewhere on PATH before the app started (`/usr/local/bin`, `/opt/homebrew/bin` are user-writable too) — but a planted `git` there compromises the user's own shell, which is a wider problem than this module.

#### The guards (`guardArgs`) — git must not execute what the workspace names

The git child's environment holds the PAT, and the workspace is a directory the coding agent has full write access to (editing it is the agent's job). Command-line `-c` beats repository config, which is the whole point. Every entry closes one route:

| Guard | What it closes |
|---|---|
| `credential.helper=` (empty, **first**) | the setting is a LIST; assigning empty resets it, so a helper planted in the workspace's `.git/config` can't run ahead of ours |
| `credential.https://github.com.helper=…` | **host-scoped on purpose.** `url.<base>.insteadOf` in the workspace config rewrites the URL *after* any pin, and no `-c` can clear it (the subsection name is the agent's to choose) — so the request can leave for any host. Scoping means git asks that host's credentials and finds nobody to ask. A bare `credential.helper` answered everyone, because the helper echoes the PAT without reading the host git hands it on stdin |
| `core.hooksPath=/dev/null` (`NUL` on Windows) | **not a directory.** Git looks up `<hooksPath>/<hookname>`; under the null device that is ENOTDIR, always. This used to name an empty directory, which is only empty until the agent drops a file in — and `--no-verify` covers `pre-push` only, not `post-checkout` (clone) or `reference-transaction` (fetch) |
| `core.fsmonitor=` / `core.sshCommand=` | both name a command git runs |
| `protocol.ext.allow=never` | `ext::sh -c …` is a command, not an address |

`gitSpawn` also inserts `--no-verify` after `push`/`commit`/`merge`, so two independent things would have to be wrong for a planted hook to see the PAT. `tests/gitGuards.test.js` pins all of it against **real git** — it plants each attack and runs an actual push, because the claim is "git does not execute the agent's code while holding the token", and only git can settle that.

### Tick (sequential, never overlapping)

0. **`git diff --name-only --diff-filter=U -z` → if any unmerged files exist, emit `paused` + the conflict list and RETURN — before step 2.** `git add -A` on a conflicted tree stages the marker-laden files and git treats them resolved, so push would ship `<<<<<<<` garbage. This bail is the entire defense; it must run first. (`-z` / NUL-split is required — the default output escapes spaces/unicode paths.)
1. `sync:flushRequest(token)` → renderer flushes dirty editor tabs → `sync:flushDone(token)`. **1 s timeout** so a hung renderer can't stall the engine.
2. `git status --porcelain`; if dirty → `git add -A` + commit (message `Shockwave sync: <ISO>`). A `git commit` here with `MERGE_HEAD` present also **concludes a resolved-but-open merge** — that's how the engine stays *stateless* about the pause (once conflicts are gone, the normal commit finishes the merge).
3. `git fetch origin <branch>`, then `git rev-list --count HEAD..origin/<branch>` to see if the remote is ahead. Fetch failing with "couldn't find remote ref" = no remote branch yet (fresh init) → skip to push.
4. If the remote is ahead → **`git merge origin/<branch>`** (NOT rebase — merge touches only genuinely-differing files and resolves in one pass; rebase replayed every auto-commit and churned the tree). On conflict the merge leaves unmerged files + `MERGE_HEAD`; emit `paused` + the list and return.
5. If local is ahead → `git push --set-upstream origin <branch>`.

### Conflict resolution (driven by the renderer's conflict view)

While paused, the renderer surfaces the conflict list and lets the user resolve. All of these stage the index (serialized with the tick via the `ticking` guard), re-list conflicts, and — when the list hits empty — kick a tick immediately so the merge commit + push happen at once:

- `resolveConflict(ws, rel)` — accept the file as hand-edited: `git add <rel>`.
- `keepConflict(ws, rel)` — keep ours: `git checkout --ours -- <rel>` + add.
- `resetConflict(ws, rel)` — take remote: `git checkout --theirs -- <rel>` + add.
- `keepAll(ws)` — whole tree, keep ours: `git checkout --ours .` + `git add -A` (then the merge completes; remote's non-conflicting changes still come in).
- `resetToRemote(ws)` — whole tree, take remote: `git merge --abort` + fetch + `git reset --hard origin/<branch>` (discards ALL local divergence — the renderer confirms first).

### Status state machine

`sync:status` push event carries `{ status, detail, lastSyncAt, repoUrl, conflicts }`. `conflicts` is the workspace-relative path list, present only on `paused`-for-conflicts (every other emit resets it to `[]` — see `emitStatus`):

- `unconfigured` — sync not set up (no origin / no PAT), or a benign engine stop (workspace switch / window reload). **Renderer hides the icon.**
- `idle` — synced. `lastSyncAt === null` = "not synced yet" (gray cloud); set = synced (cloud-check).
- `syncing` — a tick is in progress; `detail` describes the current step.
- `paused` — **merge conflicts** (carries `conflicts[]`). The engine is stateless — once unmerged files are gone, the next tick completes the merge and resumes (see the per-file / whole-tree resolution above).
- `offline` — **a transient/network error. Sync is NOT off — it backs off (10s → 30s → 1m) and keeps retrying forever.** `state.retryAt` gates ticks during backoff; a confirmed fetch clears it.
- `disabled` — **stopped**: the user turned it off (`userDisable`), or a *terminal* error stopped it (`disableOnError` — clears the interval). Both carry a reason + **Enable** (→ `setWorkspaceDisabled(false)` → `engineStart`), but they are **not the same news**, so `userDisable` also sets **`disabledByUser: true`** and the renderer paints them differently: a choice is the quiet gray **stop** icon, a failure is a red **!**. `emitStatus` resets `disabledByUser` on every emit for the same reason it resets `conflicts` — sticky is the failure mode, and a leftover `true` would paint a sync that died of a real error as one you had parked.

**Network NEVER disables sync.** Only `isTerminalGitError` (an allowlist: big file `GH001`, secret `GH013`, protected branch, auth/perms, repo-not-found) routes a failure to `disabled`. Anything unrecognized → `offline` + retry. Bias is intentional: when unsure, keep trying, don't turn off.

### Lifecycle

- `start({ workspacePath, pat, intervalSeconds, windowId })` — stops any previous instance, looks the workspace row up by path and takes repo + branch FROM THE ROW (no `git remote get-url`, no per-tick `rev-parse`), then kicks the interval. **First tick fires immediately** so a workspace switch doesn't wait up to `intervalSeconds` before picking up remote changes.
- `stop()` — clears the interval and awaits the in-flight tick (so a partial commit/push never leaks).
- `drainBeforeQuit()` — called from `before-quit`. Same as `stop()` minus the disabled-status emit. Without this, a fast Cmd+Q could kill a child mid-push.

### Flush bridge

`requestFlush()` posts a token to the renderer and resolves either when the renderer acks via `sync:flushDone(token)` or when the 1 s timeout fires. Pending flushes are tracked in a `Map` keyed by token. The renderer subscribes once on mount (not per workspace) and reads `writeNow` via a ref — same discipline as the `fs:changed` listener.

The flush runs at the head of every tick, so on a fast-typing user the engine's `git add` + `git commit` will see and stage the just-flushed buffer — but `writeNow` records the file's real `stat.mtimeMs` in the link index as the canonical "last self-write." When chokidar fires its echo for the same write ~350ms later, the watcher's `evt.mtime` equals the stored value and the self-echo guard skips it. Without that exact-mtime match the watcher would treat the renderer's own save as an external change and reload the editor mid-typing. See "Real mtimes everywhere" in the root `CLAUDE.md` — this is the chain that broke in v1.0.1 when a wrapper dropped the mtime arg.

### Platform support

One credential helper works everywhere: git runs `!`-prefixed helpers through a shell, and Git for Windows ships its own, so the single `CREDENTIAL_HELPER` string covers all three platforms where the old `.sh`/`.cmd` pair needed two. The only platform branch left is `NO_HOOKS` (`NUL` on Windows, `/dev/null` elsewhere). `gitSpawn` is otherwise platform-agnostic, so sync runs anywhere `git` is on PATH.

## App updates

**Checking is automatic; downloading and installing are not.** `runUpdateCheck()` fires 8s after launch and daily thereafter, and reports what it found. Nothing else happens until the user presses something.

Both of electron-updater's self-driving flags are **off** and must stay off:

- `autoDownload` — every check used to pull ~100MB the moment it found a release, 8 seconds after launch.
- `autoInstallOnAppQuit` — the one nothing surfaced: once a download had landed, the **next ordinary Cmd+Q installed a different version**. No pill click, no toast, no consent at any point.

Turning off only the first moves the download decision to the user while leaving the *install* decision to whenever they happen to quit, which is why both are off. The cost is intended: someone who never presses the button stays behind indefinitely.

**Status is a phase, not a pair of booleans**: `idle → available → downloading → ready`, plus `error`. Three places render it (the pill, the toast, Settings → Updates) and five states across two flags is how they drift — same reasoning as the sync status machine. `pushUpdateStatus` **merges**, so an error mid-download still knows which version it was after; `current` / `canDownload` / `snoozedVersion` are re-derived on every push rather than stored. `runUpdateCheck` returns early while `downloading` or `ready` — a re-check would walk the phase back to `available` and lose the Restart button.

`canDownload` is `app.isPackaged`. Dev has no `app-update.yml` and so no downloader at all: the notify-only GitHub API poll fills the same shape and the UI offers the release page instead of pretending a Download button would work.

**Release notes come from the GitHub releases API, not `info.releaseNotes`** — electron-updater's GitHub provider returns HTML in a shape that varies with `fullChangelog`, while the API's `body` is raw markdown the renderer already draws (so nothing has to sanitize HTML). `app:getReleaseNotes` returns **every** version newer than the running one, newest first: someone four releases behind should see all four, and it's one list request either way. Cached per running version.

> Those bodies were **empty for every release through v1.0.36** — electron-builder creates the draft with no body and the workflow's publish step only flipped the draft flag, so nothing ever wrote notes. Invisible on github.com (the commit list is right there), fatal to a dialog that reads `body`. `.github/workflows/release.yml` now writes them before publishing, best-effort (`|| true` + an emptiness check) so a hiccup there can never strand a fully-built release as a draft.
>
> **The notes are commit subjects, not GitHub's `generate-notes`.** That endpoint summarizes merged pull requests, and this repo commits straight to main — asked for v1.0.36 it returns a compare link and nothing else. The commit subjects are already written as changelog lines, so they are the source. The previous tag comes from `git tag --sort=-v:refname`, not `releases/latest`: at that point in the run our own release is still a draft, so "latest" *happens* to mean the previous one — true today and quietly wrong the first time a release doesn't get published.

`app:snoozeUpdate` writes `updateSnoozedVersion` to `local-settings.json` — machine-local, because installing an update is a per-machine act. It silences the **toast** for that version only; the pill is a state and keeps showing. It is deliberately not in `LOCAL_KEYS`: the renderer never patches it through a settings save.

`app:restartToUpdate` only acts while `ready`, and **the renderer confirms first** — it quits, which kills a running agent turn.

## Voice IPC

`voice:getToken` mints a short-lived streaming token from whichever vendor `settings.transcription.provider` names — AssemblyAI's `/v3/token`, Deepgram's `/v1/auth/grant`, or ElevenLabs' `/v1/single-use-token/realtime_scribe`. **One handler covers all three because all three offer exactly this**, which is why the desktop can switch engines without weakening anything: the long-lived key never leaves main, and only the session credential crosses to the renderer.

It returns **`{ token, provider, tokenTtlMs, singleUse }`**. The provider has to come back with the token — the renderer needs it to pick the socket URL and to read what comes back, and inferring it from a second settings read would be a second answer that can disagree with the one the token was minted against. **`tokenTtlMs` and `singleUse` travel for the same reason and are not decoration**: AssemblyAI and Deepgram issue reusable 60-second tokens, which is what the renderer's cache was built around, while **ElevenLabs' is good for 15 minutes and is consumed on first use**. A constant cache window is wrong for both — it throws away a good ElevenLabs token, and reusing one fails the SECOND microphone click at connect time with a bare `onerror` that says nothing about why the first worked.

`voice:listVoices` returns the voices the SPEAKING vendor offers, for the picker in Settings — in main because listing needs the API key. ElevenLabs pages ten at a time by default, so the handler asks for 100 and follows the page token (a user with a full voice library would otherwise see the first ten and no sign there were more) and supplies a `preview` URL per voice; **Deepgram has no voice endpoint at all** — its voices ARE models, so `GET /v1/models`'s `tts` half is the list, and there is nothing to preview. Nothing is cached: the page asks rarely, and a stale catalogue is worse than a second of waiting.

Which vendor, and which key that implies, is `agent-core/voiceProviders.ts`'s job — main never branches on a provider string itself. That table replaced four `provider === 'deepgram'` ternaries here.

**`voice:verifyKey` is a separate question and must stay separate.** The one transcription key feeds three consumers — the microphone, Telegram voice notes, the agent's `transcribe` tool — and **Deepgram gates them differently**: transcribing needs any valid key, minting a streaming token needs Member or higher. So the mint is not a proxy for "is this key good". It asks `GET /v1/auth/token` and then the grant, returning `{ ok, canStream }`; AssemblyAI has one credential with one capability, so there the mint is still the whole answer.

> **Read `/v1/auth/token`'s `scopes` — the 200 means nothing.** That endpoint accepts any valid key and only reports whose it is, so treating the status code as "this key transcribes" is wrong: a key scoped `account:write` answers 200 and cannot transcribe a syllable. It shipped that way for an afternoon and told a user their unusable key was fine. The response body carries the key's own `scopes`, which is the actual answer — `usage:write` (or a `member`/`admin`/`owner` role, which bundle it) transcribes; only the roles can mint. Both failure messages name the scopes they found, because that string is what turns "insufficient permissions" into a console click. **Deepgram's key-creation default is `usage:write`, which lands exactly in the can't-mint case** — Member is behind the "Advanced" toggle.

`ok: true, canStream: false` is a **restricted Deepgram key** — genuinely fine for everything but the microphone. Settings paints that green with a note rather than red; treating it as a failure tells the user to replace a key that works. Both handlers share `resolveVoiceEngine` / `mintVoiceToken` / `voiceFailure`, so the reason string can't drift between the thing that starts the mic and the thing that reports on it.

The actual WebSocket + audio pipeline lives in the renderer; see `src/renderer/CLAUDE.md`.

## IPC surface

| Group | Handlers |
|---|---|
| Dialogs | `dialog:openFolder` |
| FS | `fs:readTree`, `fs:readAllMarkdown`, `fs:readFile`, `fs:writeFile`, `fs:createFile`, `fs:renameFileLiteral`, `fs:duplicateFile`, `fs:trashFolder`, `fs:trashFile`, `fs:trashFiles`, `fs:createFolder`, `fs:ensureDir`, `fs:moveItem`, `fs:renameFolder`, `fs:writeImage`, `fs:pathExists`, `fs:importFiles`, `fs:rebuildLinkCache`, `fs:watchStart`, `fs:watchStop` |
| Shell | `shell:revealInFolder`, `shell:openExternal` |
| Context menus | `context:fileMenu` (`conflictMode` → Conflict resolved / Keep our file / Reset to remote), `context:conflictCloudMenu` (whole-tree keep/reset), `context:folderMenu`, `context:editorMenu` |
| Settings | `settings:read`, `settings:write` (writes only the keys present), `settings:deleteCredential` (the only way to *remove* a stored credential — gated on `isDeletableCredential` from `agent-core/credentials.ts`, then writes `''` so the companion's `putSecret` drops the row; clearing the input box deliberately cannot do this, see `settings/CLAUDE.md`); plus push event `settings:changed` (`{keys, settings}`, main-initiated writes only) |
| OAuth | `oauth:listPresets`, `oauth:startConnect`, `oauth:disconnect` |
| Bookmarks | `bookmarks:read`, `bookmarks:write` |
| Theme | `theme:getInitial`; plus `theme:systemChanged` push event |
| Agent Voice | `voice:getToken` (also reports the token's lifetime + whether it survives use), `voice:verifyKey` (per-capability key check — see below), `voice:listVoices` (the speaking vendor's voices, for the picker) |
| Agent | `agent:send` (takes `chatId`; steers if that chat is mid-turn), `agent:abort` (per chatId), `agent:runningChats`, `agent:listProviders`, `agent:listModels`, `agent:listThinkingLevels`, `agent:validateConnection` (checks an openai-compatible `{baseUrl}/models`); plus push events `agent:event` / `agent:error` (stamped with `chatId`) |
| Chat (all over HTTP to the companion) | `chat:list`, `chat:listPinned`, `chat:setPinned`, `chat:search`, `chat:getMessages` (optional `after` seq), `chat:open` (returns the row + messages + this machine's `workspacePath` for the chat's workspace), `chat:delete`, `chat:rename`; plus push event `chat:feedResync` (the live feed reconnected — re-read loaded chats) |
| Skills | `skills:list`, `skills:libraryDir`, `skills:importPicker`, `skills:importFromPath`, `skills:remove` |
| Workspaces | `workspace:inspectFolder`, `workspace:createWithRepo`, `workspace:addFromRepo` (covers both clone-into-empty and adopt-a-clone), `workspace:setUpHere`, `workspace:remove`, `workspace:forgetLocal`, `workspace:listFiles`, `workspace:ensureFiles` |
| Workspace settings | `workspaceSettings:read`, `workspaceSettings:update` (per-workspace `.shockwave/workspace.json` — daily-note config, templates, built-in-skill toggles) |
| Cron | `cron:read`, `cron:runNow` (the desktop's read-only view; cron runs on the companion) |
| Telegram | `telegram:status`, `telegram:connect`, `telegram:disconnect`, `telegram:setWorkspace` (thin passthroughs to the companion `/telegram/*`; the companion owns the bot) |
| Companion config | `api:read`, `api:write`, `api:test` (the "connect to your server" form — URL + key, key `safeStorage`-wrapped; `api:test` also returns the companion's release version), `api:checkVersion` (classify desktop-vs-companion via `versionCompare.ts` — `companion-older` is the only status that offers an upgrade), `api:upgradeCompanion` (`POST /update` with this desktop's version — the companion's updater sidecar does the pull + restart; fire-and-forget, sets `pendingUpgradeTag`); the certificate trio `api:pendingCert` (what identity is being offered + what was approved before, `null` ⇒ first connection), `api:approveCert` (**the one place a fingerprint is ever stored**), `api:forgetCert`; `companion:getState` (is the companion reachable right now); push events `api:companionUpdated` (the live feed reconnected on the requested version — the feed's `onOpen` fires when the stream's HTTP response arrives, NOT on the first event, so a quiet server still announces) and `companion:state` (reachability changed — see "Connection state" below) |
| App / updates | `app:machineId`, `app:checkForUpdates`, `app:getUpdateStatus`, `app:downloadUpdate`, `app:restartToUpdate`, `app:snoozeUpdate`, `app:getReleaseNotes` (electron-updater + the GitHub releases API); plus update-status push events. See "App updates" below |
| Sync | `sync:verifyPat`, `sync:checkGit`, `sync:listRepos`, `sync:setWorkspaceDisabled`, `sync:engineStart`, `sync:engineStop`, `sync:engineStatus`, `sync:flushDone`, `sync:listConflicts`, `sync:resolveConflict`, `sync:keepConflict`, `sync:resetConflict`, `sync:keepAll`, `sync:resetToRemote`; plus push events `sync:status` (carries `conflicts[]` when paused), `sync:flushRequest` |

The renderer reaches every one of these via `window.api.*` — see `src/preload/preload.cjs`. The renderer never touches Node directly.
